import { prisma } from "./prisma.js";
import { run } from "./runner.js";
import { caddy } from "./constants.js";
import { notificationService } from "./notification-service.js";
import { logger } from "@explita/protocol";
import { formatApp, FormattedApp } from "./formatters/app.js";
import { stripAppPrefixes } from "./id.js";

interface UnhealthyTracker {
  reported: boolean;
  failCount: number;
}

export class ContainerHealthMonitor {
  private checkInterval: NodeJS.Timeout | null = null;
  private isChecking = false;
  private containerIncidents = new Map<string, UnhealthyTracker>();

  public start(intervalMs = 30_000): void {
    if (this.checkInterval) return;

    logger.always("Starting background container health & crash monitor...");

    // Stagger first check by 10 seconds to allow services to initialize
    setTimeout(() => {
      this.checkAllApps().catch((err) => {
        logger.warn("[health-monitor] Error during initial check:", err);
      });
    }, 10_000);

    this.checkInterval = setInterval(() => {
      this.checkAllApps().catch((err) => {
        logger.warn("[health-monitor] Error during periodic check:", err);
      });
    }, intervalMs);
  }

  public stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  public async checkAllApps(): Promise<void> {
    if (this.isChecking) return;
    this.isChecking = true;

    try {
      const apps = await prisma.app.findMany({
        where: {
          currentDeploymentId: { not: null },
        },
        include: {
          currentDeployment: true,
          domains: true,
        },
      });

      const formattedApps = apps.map((app) =>
        stripAppPrefixes(formatApp(app)),
      );

      for (const app of formattedApps) {
        if (app.currentDeployment?.status !== "LIVE") continue;
        const containerName = app.currentDeployment.containerName;
        if (!containerName) continue;

        await this.checkContainer(app, containerName);
      }
    } finally {
      this.isChecking = false;
    }
  }

  public async checkContainer(
    app: FormattedApp,
    containerName: string,
  ): Promise<void> {
    const meta = app.metadata;
    const inspectRes = await run("docker", ["inspect", containerName]).catch(
      () => ({ code: 1, stdout: "", stderr: "" }),
    );

    if (inspectRes.code !== 0) {
      // Container missing / removed unexpectedly
      await this.handleUnhealthy(
        app,
        containerName,
        "Container process not found or stopped unexpectedly.",
        "Missing container",
        { status: "missing" },
      );
      return;
    }

    let inspectData: any;
    try {
      const parsed = JSON.parse(inspectRes.stdout);
      inspectData = Array.isArray(parsed) ? parsed[0] : parsed;
    } catch {
      return;
    }

    const state = inspectData?.State;
    if (!state) return;

    const isRunning = Boolean(state.Running);
    const exitCode = state.ExitCode ?? 0;
    const oomKilled = Boolean(state.OOMKilled);
    const isDead = Boolean(state.Dead);
    const dockerHealthStatus = state.Health?.Status as string | undefined;

    // 1. Container crashed or dead
    if (!isRunning || isDead || exitCode !== 0 || oomKilled) {
      const logRes = await run("docker", [
        "logs",
        "--tail",
        "25",
        containerName,
      ]).catch(() => ({ stdout: "", stderr: "" }));
      const logSnippet = `${logRes.stdout}\n${logRes.stderr}`.trim();

      const reason = oomKilled
        ? "Container terminated by Out-Of-Memory (OOM) killer."
        : exitCode !== 0
          ? `Container crashed with exit code ${exitCode}.`
          : "Container is not running.";

      await this.handleUnhealthy(app, containerName, reason, logSnippet, {
        exitCode,
        oomKilled,
        dead: isDead,
        container: containerName,
      });
      return;
    }

    // 2. Docker internal healthcheck status
    if (dockerHealthStatus === "unhealthy") {
      const logRes = await run("docker", [
        "logs",
        "--tail",
        "25",
        containerName,
      ]).catch(() => ({ stdout: "", stderr: "" }));
      const logSnippet = `${logRes.stdout}\n${logRes.stderr}`.trim();

      await this.handleUnhealthy(
        app,
        containerName,
        "Container Docker health check reported UNHEALTHY.",
        logSnippet,
        {
          healthStatus: dockerHealthStatus,
          container: containerName,
        },
      );
      return;
    }

    // 3. Optional HTTP Health Check probe
    const port = app.port;
    const healthCheckPath =
      meta.healthCheck !== undefined ? meta.healthCheck : port ? "/" : null;

    if (healthCheckPath && port) {
      const path = healthCheckPath.startsWith("/")
        ? healthCheckPath
        : `/${healthCheckPath}`;
      const targetUrl = `http://${containerName}:${port}${path}`;

      const probeRes = await run("docker", [
        "exec",
        caddy.containerName,
        "wget",
        "-S",
        "-O",
        "-",
        "-T",
        "3",
        targetUrl,
      ]).catch(() => ({ code: 1, stdout: "", stderr: "" }));

      const isRootPath = path === "/";
      const rawCombined =
        `${probeRes.stderr || ""}\n${probeRes.stdout || ""}`.trim();
      const statusMatches = Array.from(
        rawCombined.matchAll(/HTTP\/\d(?:\.\d)?\s+(\d{3})/gi),
      );
      const statusCode = statusMatches.length
        ? Number(statusMatches[statusMatches.length - 1][1])
        : probeRes.code === 0
          ? 200
          : null;

      const isHealthy =
        statusCode !== null &&
        (statusCode < 400 ||
          (isRootPath && (statusCode === 401 || statusCode === 403)));

      if (!isHealthy) {
        const tracker = this.containerIncidents.get(containerName) || {
          reported: false,
          failCount: 0,
        };
        tracker.failCount++;
        this.containerIncidents.set(containerName, tracker);

        // Require 2 consecutive failures to prevent false positives from transient blips
        if (tracker.failCount >= 2) {
          const logRes = await run("docker", [
            "logs",
            "--tail",
            "25",
            containerName,
          ]).catch(() => ({ stdout: "", stderr: "" }));
          const logSnippet = `${logRes.stdout}\n${logRes.stderr}`.trim();

          await this.handleUnhealthy(
            app,
            containerName,
            `HTTP health check (GET ${path}) failed${statusCode ? ` with HTTP ${statusCode}` : ""}.`,
            logSnippet,
            {
              path,
              port,
              statusCode: statusCode ?? "No response",
              container: containerName,
            },
          );
          return;
        }
      }
    }

    // Container is healthy - check if it just recovered from a previous incident
    const previous = this.containerIncidents.get(containerName);
    if (previous && previous.reported) {
      this.containerIncidents.delete(containerName);
      logger.info(
        `[health-monitor] Container "${containerName}" for app "${app.name}" has recovered to HEALTHY.`,
      );

      await notificationService
        .notify(
          {
            event: "container_healthy",
            title: `✅ Container Recovered: ${app.name}`,
            level: "success",
            appName: app.name,
            appId: app.id,
            description: `Container ${containerName} is healthy and serving traffic again.`,
            details: {
              container: containerName,
              port: app.port ?? "n/a",
            },
          },
          app,
        )
        .catch((err) => {
          logger.warn(
            "[health-monitor] Failed to send recovery notification:",
            err,
          );
        });
    } else if (previous) {
      this.containerIncidents.delete(containerName);
    }
  }

  private async handleUnhealthy(
    app: FormattedApp,
    containerName: string,
    reason: string,
    snippet?: string,
    details?: Record<string, any>,
  ): Promise<void> {
    const tracker = this.containerIncidents.get(containerName) || {
      reported: false,
      failCount: 1,
    };

    if (tracker.reported) {
      // Already alerted user for this incident, avoid spamming
      return;
    }

    tracker.reported = true;
    this.containerIncidents.set(containerName, tracker);

    logger.warn(
      `[health-monitor] Container "${containerName}" for app "${app.name}" is UNHEALTHY/CRASHED: ${reason}`,
    );

    await notificationService
      .notify(
        {
          event: "container_unhealthy",
          title: `⚠️ Container Crashed / Unhealthy: ${app.name}`,
          level: "error",
          appName: app.name,
          appId: app.id,
          description: reason,
          snippet,
          details,
        },
        app,
      )
      .catch((err) => {
        logger.warn(
          "[health-monitor] Failed to send incident notification:",
          err,
        );
      });
  }
}

export const containerHealthMonitor = new ContainerHealthMonitor();
