import { rm, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type {
  Deployment,
  DeploymentStatus,
} from "../generated/prisma/client.js";
import { prisma } from "./prisma.js";
import { saveDeploymentLogs } from "./log-helpers.js";
import { run, stream } from "./runner.js";
import { docker, caddy, server } from "./constants.js";
import { ensureDockerNetwork } from "./docker-network.js";
import { syncAppCaddy, syncPreviewCaddy, removePreviewCaddy } from "./caddy.js";
import {
  syncAppTunnel,
  syncPreviewTunnel,
  removePreviewTunnel,
} from "./tunnel.js";
import { cronScheduler } from "./cron-scheduler.js";
import { formatApp, FormattedApp } from "./formatters/app.js";
import { notificationService } from "./notification-service.js";
import {
  ActiveDeploymentState,
  DEFAULT_CONTAINER_PORT,
  AppDbEntry,
  isTerminalStatus,
} from "@explita/infra-protocol/deploy";
import { logger } from "@explita/infra-protocol";
import { findDeployment, getAppEnvironment } from "./app-helpers.js";
import { stripAppPrefixes } from "./id.js";
import {
  cloneDatabaseForPreview,
  dropPreviewDatabase,
} from "./database-clone.js";

export class Deployer {
  private running = new Set<string>();
  private activeDbClones = new Set<string>();
  private active = new Map<string, ActiveDeploymentState>();
  private abortControllers = new Map<string, AbortController>();
  public readonly events = new EventEmitter();

  constructor(
    private readonly baseDir: string = server.deployBaseDir,
    private readonly network: string = docker.network,
  ) {}

  getActive(id: string): ActiveDeploymentState | undefined {
    return this.active.get(id);
  }

  async prepareDeployment(
    app: FormattedApp,
    options?: {
      preview?: boolean;
      cloneDbs?: AppDbEntry[];
      previewSubdomain?: string;
      previewDomains?: string[];
      previewAuth?: string;
      sourceHash?: string;
      tunnelPreference?: boolean;
      tag?: string;
    },
  ): Promise<Deployment> {
    if (this.running.has(app.id))
      throw new Error("A deployment is already running for this app");
    this.running.add(app.id);

    const isPreview = Boolean(options?.preview);
    const meta = app.metadata;
    const preDeploy = meta.preDeploy;
    const cloneDbs = options?.cloneDbs || [];
    const previewSubdomain = options?.previewSubdomain;
    const previewDomains = options?.previewDomains;
    const sourceHash = options?.sourceHash;
    const tag = options?.tag;

    const record = await prisma.deployment.create({
      data: {
        appId: app.id,
        tag,
        status: "QUEUED",
        metadata: {
          preDeploy,
          isPreview,
          ...(sourceHash ? { sourceHash } : {}),
          ...(previewSubdomain ? { previewSubdomain } : {}),
          ...(options?.previewAuth ? { previewAuth: options.previewAuth } : {}),
          ...(previewDomains && previewDomains.length > 0
            ? { previewDomains }
            : {}),
          ...(cloneDbs.length > 0 ? { cloneDbs: cloneDbs as any } : {}),
          ...(options?.tunnelPreference !== undefined
            ? { tunnelPreference: options.tunnelPreference }
            : {}),
        },
      },
    });

    const state: ActiveDeploymentState = {
      id: record.id,
      appId: record.appId,
      tag: record.tag,
      status: record.status,
      startedAt: record.startedAt.toISOString(),
      logs: [],
      isPreview,
      sourceHash,
      cloneDbs,
      previewSubdomain,
      previewDomains,
      previewAuth: options?.previewAuth,
      tunnelPreference: options?.tunnelPreference,
    };
    this.active.set(record.id, state);
    this.abortControllers.set(record.id, new AbortController());

    return record;
  }

  startDeployment(app: FormattedApp, deploymentId: string, dir: string): void {
    const state = this.active.get(deploymentId);
    if (!state) return;

    void this.executeDeployment(app, deploymentId, dir, state).catch((err) => {
      logger.error(
        `[deployer] Background execution error for ${deploymentId}:`,
        err,
      );
    });
  }

  private async executeDeployment(
    app: FormattedApp,
    deploymentId: string,
    dir: string,
    state: ActiveDeploymentState,
  ): Promise<void> {
    const stateLog = async (line: string) => {
      state.logs.push(line);
      this.events.emit(`update:${deploymentId}`, state);
    };

    const updateStatus = async (
      status: DeploymentStatus,
      extra?: {
        image?: string;
        containerName?: string;
        finishedAt?: Date;
        error?: string;
      },
    ) => {
      state.status = status;
      if (extra?.image) state.image = extra.image;
      if (extra?.containerName) state.containerName = extra.containerName;
      if (extra?.finishedAt) state.finishedAt = extra.finishedAt.toISOString();
      if (extra?.error) state.error = extra.error;

      this.events.emit(`update:${deploymentId}`, state);

      await prisma.deployment.update({
        where: { id: deploymentId },
        data: {
          status,
          ...extra,
        },
      });
    };

    let image: string | undefined;
    let containerName: string | undefined;
    let previousContainer: string | undefined;

    const abortCtrl = this.abortControllers.get(deploymentId);

    try {
      if (abortCtrl?.signal.aborted || state.status === "CANCELLED") {
        await this.handleCancellation(
          app,
          deploymentId,
          dir,
          undefined,
          undefined,
          previousContainer,
          stateLog,
          updateStatus,
          state,
        );
        return;
      }

      await stateLog(
        "Source archive extracted. Preparing build environment...",
      );

      const previousDeployment = app.currentDeployment;
      previousContainer = previousDeployment?.containerName ?? undefined;

      const safeAppId = `app-${app.id.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
      const safeDeployId = `d-${deploymentId.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
      image = `explita/${safeAppId}:${safeDeployId}`;

      await updateStatus("BUILDING", { image });
      await this.buildImage(image, dir, stateLog, abortCtrl?.signal);

      containerName = `explita-${safeAppId}-${safeDeployId}`;
      await updateStatus("STARTING", { containerName });

      const clonedDbs: Array<any> = [];
      const overrideUrls = new Map<string, string>();

      const targetDbsToClone = state.cloneDbs || [];

      for (const targetDb of targetDbsToClone) {
        try {
          const cloneResult = await this.cloneDatabaseForPreview(
            app,
            deploymentId,
            targetDb,
            stateLog,
          );
          const enriched = { ...cloneResult, key: targetDb.key };
          clonedDbs.push(enriched);
          overrideUrls.set(targetDb.key, cloneResult.url);
          await stateLog(
            `✔ Preview database cloned for key "${targetDb.key}": ${cloneResult.name}`,
          );
        } catch (cloneErr) {
          throw new Error(
            `Database cloning failed for key "${targetDb.key}": ${cloneErr instanceof Error ? cloneErr.message : String(cloneErr)}`,
          );
        }
      }

      if (clonedDbs.length > 0) {
        state.previewDbs = clonedDbs;
      }

      const detectedPort = await this.runContainer(
        containerName,
        image,
        app,
        stateLog,
        overrideUrls,
        abortCtrl?.signal,
      );

      await updateStatus("HEALTH_CHECK");
      await stateLog("Verifying container process liveness...");
      await this.waitForLiveness(containerName, stateLog, abortCtrl?.signal);

      await this.runPreDeployHooks(
        containerName,
        app.metadata.preDeploy,
        stateLog,
        abortCtrl?.signal,
      );

      const appPort = detectedPort || app.port;
      const healthCheckPath =
        app.metadata.healthCheck !== undefined
          ? app.metadata.healthCheck
          : appPort
            ? "/"
            : null;

      if (healthCheckPath && appPort) {
        await this.waitForHttpHealthCheck(
          containerName,
          appPort,
          healthCheckPath,
          stateLog,
          abortCtrl?.signal,
        );
      }

      if (state.isPreview) {
        const effectivePort = appPort || DEFAULT_CONTAINER_PORT;
        await stateLog("Container health check passed.");

        const hasPreviewDomains = Boolean(
          state.previewDomains && state.previewDomains.length > 0,
        );
        const wantsTunnel =
          state.tunnelPreference === true || !hasPreviewDomains;

        let previewUrl: string | undefined = undefined;

        if (wantsTunnel) {
          await stateLog("Establishing private preview tunnel sidecar...");
          try {
            const tunnelResult = await syncPreviewTunnel(
              app,
              deploymentId,
              containerName,
              effectivePort,
              state.previewSubdomain,
              state.previewAuth,
            );

            if (tunnelResult) {
              previewUrl = tunnelResult;
              state.previewUrl = previewUrl;
            } else if (!hasPreviewDomains) {
              throw new Error(
                "Cannot establish preview deployment: automated tunnels are disabled or not configured on this server (ensure TUNNEL_ENABLED=true and TUNNEL_TOKEN are set in .env).",
              );
            } else {
              await stateLog(
                "[tunnel] Warning: Automated tunnel could not be established. Falling back to preview custom domain(s).",
              );
            }
          } catch (tunnelErr: any) {
            if (!hasPreviewDomains) {
              throw tunnelErr;
            }
            await stateLog(
              `[tunnel] Warning: Tunnel sidecar failed (${tunnelErr.message}). Accessible via custom preview domain(s).`,
            );
          }
        } else {
          await stateLog(
            "Custom preview domain(s) configured. Skipping public tunnel sidecar.",
          );
        }

        let previewDomainUrls: string[] = [];
        if (state.previewDomains && state.previewDomains.length > 0) {
          await stateLog("Configuring preview custom domains...");
          previewDomainUrls = await syncPreviewCaddy(
            deploymentId,
            state.previewDomains,
            containerName,
            effectivePort,
            state.previewAuth,
          );
          for (const dUrl of previewDomainUrls) {
            await stateLog(`Preview custom domain active: ${dUrl}`);
          }
          state.previewDomainUrls = previewDomainUrls;
        }

        await updateStatus("PREVIEW", {
          containerName,
          image,
        });

        const deploymentRecord = await prisma.deployment.findUnique({
          where: { id: deploymentId },
        });
        const currentMeta = (deploymentRecord?.metadata as any) || {};

        await prisma.deployment.update({
          where: { id: deploymentId },
          data: {
            metadata: {
              ...currentMeta,
              isPreview: true,
              ...(previewUrl ? { previewUrl } : {}),
              previewDomainUrls,
              previewSubdomain: state.previewSubdomain,
              previewDomains: state.previewDomains,
              detectedPort,
              containerName,
              ...(state.previewDbs ? { previewDbs: state.previewDbs } : {}),
            },
          },
        });

        if (previewUrl) {
          await stateLog(`✔ Preview container is live at: ${previewUrl}`);
        }
        if (previewDomainUrls.length > 0) {
          await stateLog(
            `✔ Preview custom domains: ${previewDomainUrls.join(", ")}`,
          );
        }
        await stateLog("Awaiting promotion to production...");
        return;
      }

      // If tunnel is requested, establish and verify tunnel sidecar on containerName before switching production traffic
      let tunnelUrl: string | null = null;
      const isTunnelRequested =
        state.tunnelPreference === true ||
        (state.tunnelPreference !== false &&
          (app.metadata.tunnel?.enabled === true ||
            app.metadata.tunnelEnabled === true));

      if (isTunnelRequested) {
        await stateLog("Establishing automated public HTTPS tunnel...");
        try {
          tunnelUrl = await syncAppTunnel(app, containerName);
          if (tunnelUrl) {
            await stateLog(`Public tunnel available at: ${tunnelUrl}`);
          }
        } catch (tunnelErr: any) {
          const hasCustomDomains = app.domains && app.domains.length > 0;

          if (!hasCustomDomains || state.tunnelPreference === true) {
            throw tunnelErr;
          }

          await stateLog(
            `[tunnel] Warning: Automated tunnel failed (${tunnelErr.message}). Accessible via configured custom domain(s).`,
          );
        }
      }

      await this.switchTraffic(
        app,
        deploymentId,
        containerName,
        detectedPort,
        previousContainer,
        stateLog,
        tunnelUrl,
      );
      await updateStatus("LIVE", { finishedAt: new Date() });
    } catch (error) {
      const isCancelled =
        state.status === "CANCELLED" || Boolean(abortCtrl?.signal.aborted);

      if (isCancelled) {
        await this.handleCancellation(
          app,
          deploymentId,
          dir,
          containerName,
          image,
          previousContainer,
          stateLog,
          updateStatus,
          state,
        );
      } else {
        await this.handleRollback(
          app,
          deploymentId,
          error,
          dir,
          containerName,
          image,
          previousContainer,
          stateLog,
          updateStatus,
          state,
        );
      }
    } finally {
      this.abortControllers.delete(deploymentId);
      if (state.status !== "PREVIEW") {
        this.finishDeployment(app.id, deploymentId, dir, state);
      } else {
        this.running.delete(app.id);
        void saveDeploymentLogs(deploymentId, state.logs).catch(() => {});
      }
    }
  }

  private async cloneDatabaseForPreview(
    app: FormattedApp,
    deploymentId: string,
    sourceDb: AppDbEntry,
    stateLog: (line: string) => Promise<void>,
  ) {
    return cloneDatabaseForPreview({
      app,
      deploymentId,
      sourceDb,
      stateLog,
      activeClonesSet: this.activeDbClones,
    });
  }

  private async dropPreviewDatabase(dbName: string): Promise<void> {
    return dropPreviewDatabase(dbName);
  }

  private async buildImage(
    image: string,
    dir: string,
    stateLog: (line: string) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const standardDockerfile = join(dir, "Dockerfile");
    const lowerDockerfile = join(dir, "dockerfile");
    if (!existsSync(standardDockerfile)) {
      if (existsSync(lowerDockerfile)) {
        await rename(lowerDockerfile, standardDockerfile).catch(() => {});
      } else {
        throw new Error(
          "No Dockerfile found in deployment archive. Explita Deploy requires a Dockerfile in your project root to build and run your application.",
        );
      }
    }

    await stateLog(`Building image ${image}`);
    const buildRes = await stream("docker", ["build", "-t", image, dir], {
      cwd: dir,
      onLine: stateLog,
      signal,
    });
    if (buildRes.code !== 0) {
      if (signal?.aborted) {
        throw new Error("Build cancelled by user");
      }
      throw new Error(`Build failed with exit code ${buildRes.code}`);
    }
  }

  private async runContainer(
    containerName: string,
    image: string,
    app: FormattedApp,
    stateLog: (line: string) => Promise<void>,
    overrideDbUrls?: Map<string, string> | string,
    signal?: AbortSignal,
  ): Promise<number | undefined> {
    await ensureDockerNetwork(this.network);
    await stateLog(`Starting container ${containerName} on ${this.network}`);

    const meta = app.metadata;

    const runArgs = [
      "run",
      "-d",
      "--restart",
      "unless-stopped",
      "--network",
      this.network,
      "--name",
      containerName,
    ];

    const { dockerArgs } = getAppEnvironment(app, { overrideDbUrls });
    runArgs.push(...dockerArgs);

    const resources = meta.resources;
    if (resources?.memory || resources?.cpus) {
      await stateLog(
        `Resource limits: memory=${resources.memory || "unlimited"}, cpus=${resources.cpus || "unlimited"}`,
      );
    }

    if (app.envs && app.envs.length > 0) {
      await stateLog(
        `Injecting ${app.envs.length} environment variable(s) into container`,
      );
    }

    if (meta.volumes && typeof meta.volumes === "object") {
      const volumeEntries = Object.entries(meta.volumes);
      if (volumeEntries.length > 0) {
        await stateLog(
          `Mounting ${volumeEntries.length} volume(s) into container`,
        );
      }
    }

    runArgs.push(image);

    const start = await run("docker", runArgs, { signal });
    if (start.code !== 0) {
      if (signal?.aborted) {
        throw new Error("Container run cancelled by user");
      }
      throw new Error(start.stderr || "docker run failed");
    }

    // Auto-detect exposed port from Docker image if not explicitly configured
    const detectedPort = await this.detectExposedPort(image);

    if (!app.port && detectedPort) {
      app.port = detectedPort;
      await prisma.app
        .update({
          where: { id: app.id },
          data: { port: detectedPort },
        })
        .catch(() => {});
    }

    return detectedPort;
  }

  private async runPreDeployHooks(
    containerName: string,
    preDeploy: string[] | undefined,
    stateLog: (line: string) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!preDeploy || preDeploy.length === 0) return;

    for (let i = 0; i < preDeploy.length; i++) {
      if (signal?.aborted) throw new Error("Pre-deploy cancelled by user");
      const hook = preDeploy[i];
      const step =
        preDeploy.length > 1 ? ` (${i + 1}/${preDeploy.length})` : "";
      await stateLog(`Running pre-deploy hook${step}: "${hook}"...`);

      const hookResult = await stream(
        "docker",
        ["exec", containerName, "sh", "-c", hook],
        {
          signal,
          onLine: async (line) => {
            await stateLog(`[pre-deploy${step}] ${line}`);
          },
        },
      );

      if (hookResult.code !== 0) {
        if (signal?.aborted) {
          throw new Error("Pre-deploy hook cancelled by user");
        }
        const detail = (hookResult.stderr || hookResult.stdout || "").trim();
        throw new Error(
          `Pre-deploy hook${step} failed with exit code ${hookResult.code}${detail ? `:\n${detail}` : ""}`,
        );
      }

      await stateLog(`Pre-deploy hook${step} completed successfully.`);
    }
  }

  private async waitForHttpHealthCheck(
    containerName: string,
    port: number,
    healthCheckPath: string,
    stateLog: (line: string) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const maxAttempts = 20; // up to 30 seconds (1.5s interval)
    const path = healthCheckPath.startsWith("/")
      ? healthCheckPath
      : `/${healthCheckPath}`;
    const isRootPath = path === "/";
    const targetUrl = `http://${containerName}:${port}${path}`;

    await stateLog(
      `Polling HTTP health check on port ${port} (GET ${path})...`,
    );

    let lastError = "No response";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) throw new Error("Health check cancelled by user");
      const probeRes = await run(
        "docker",
        [
          "exec",
          caddy.containerName,
          "wget",
          "-S",
          "-O",
          "-",
          "-T",
          "3",
          targetUrl,
        ],
        { signal },
      );

      const rawCombined =
        `${probeRes.stderr || ""}\n${probeRes.stdout || ""}`.trim();
      const statusMatches = Array.from(
        rawCombined.matchAll(/HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+([^\r\n]+))?/gi),
      );
      const lastStatus = statusMatches.length
        ? {
            code: Number(statusMatches[statusMatches.length - 1][1]),
            text: (statusMatches[statusMatches.length - 1][2] || "").trim(),
          }
        : null;

      const statusCode = lastStatus
        ? lastStatus.code
        : probeRes.code === 0
          ? 200
          : null;
      const statusText = lastStatus
        ? lastStatus.text
        : probeRes.code === 0
          ? "OK"
          : "";

      if (statusCode !== null) {
        // Standard check: 200-399 is universally accepted
        if (statusCode >= 200 && statusCode <= 399) {
          await stateLog(
            `HTTP health check passed: GET ${path} returned ${statusCode}${statusText ? ` ${statusText}` : ""}`,
          );
          return;
        }

        // On root path (/), also accept 401 Unauthorized & 403 Forbidden for auth-walled applications
        if (isRootPath && (statusCode === 401 || statusCode === 403)) {
          await stateLog(
            `HTTP health check passed: GET / returned ${statusCode}${statusText ? ` ${statusText}` : ""} (auth-protected endpoint verified responsive)`,
          );
          return;
        }

        lastError = `server returned HTTP ${statusCode}${statusText ? ` ${statusText}` : ""}${!isRootPath ? " (expected 200-399)" : ""}`;
      } else {
        const matchErr = rawCombined.match(/wget:\s*(.+)$/m);
        lastError = matchErr ? matchErr[1] : rawCombined || "Connection failed";
      }

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }

    throw new Error(
      `HTTP health check failed: GET ${path} on port ${port} did not succeed within 30s (${lastError})`,
    );
  }

  private async switchTraffic(
    rawApp: FormattedApp,
    deploymentId: string,
    containerName: string,
    detectedPort: number | undefined,
    previousContainer: string | undefined,
    stateLog: (line: string) => Promise<void>,
    tunnelUrl?: string | null,
  ) {
    const app = stripAppPrefixes(rawApp);
    const liveAppRecord = await prisma.app.update({
      where: { id: app.id },
      data: {
        currentDeploymentId: deploymentId,
        ...(detectedPort && !app.port ? { port: detectedPort } : {}),
      },
      include: { domains: true, currentDeployment: true },
    });
    const liveApp = stripAppPrefixes(formatApp(liveAppRecord));

    await syncAppCaddy(app.id).catch((err) => {
      stateLog(`[caddy] Warning: Failed to sync domains: ${err}`);
    });

    const finalTunnelUrl =
      tunnelUrl !== undefined
        ? tunnelUrl
        : await syncAppTunnel(liveApp, containerName).catch((err) => {
            stateLog(`[tunnel] Warning: Failed to sync tunnel: ${err}`);
            return null;
          });

    await cronScheduler.syncApp(app.id).catch((err) => {
      stateLog(`[cron] Warning: Failed to sync scheduled jobs: ${err}`);
    });

    await stateLog("Deployment is live");
    if (finalTunnelUrl) {
      await stateLog(`Public tunnel available at: ${finalTunnelUrl}`);
    }

    // Decommission previous container only after new deployment is live and serving traffic
    if (previousContainer && previousContainer !== containerName) {
      await stateLog(
        `Zero-downtime handoff: decommissioning previous container ${previousContainer}...`,
      );
      await run("docker", ["stop", "-t", "10", previousContainer]).catch(
        () => {},
      );
      await run("docker", ["rm", "-f", previousContainer]).catch(() => {});
    }

    await this.pruneOldImages(app, stateLog);

    const domains =
      liveAppRecord.domains?.map((d) => `https://${d.hostname}`) || [];
    return {
      tunnelUrl: finalTunnelUrl || undefined,
      domains,
    };
  }

  private async handleRollback(
    app: FormattedApp,
    deploymentId: string,
    error: unknown,
    dir: string,
    containerName: string | undefined,
    image: string | undefined,
    previousContainer: string | undefined,
    stateLog: (line: string) => Promise<void>,
    updateStatus: (
      status: DeploymentStatus,
      extra?: { finishedAt?: Date; error?: string },
    ) => Promise<void>,
    state?: ActiveDeploymentState,
  ): Promise<void> {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const finishedAt = new Date();

    // Clean up failed new container so it doesn't leak
    if (containerName) {
      await stateLog(`Cleaning up failed container ${containerName}...`);
      await run("docker", ["rm", "-f", containerName]).catch(() => {});
    }

    // Remove failed image to keep VPS disk clean
    if (image) {
      await run("docker", ["rmi", "-f", image]).catch(() => {});
    }

    // Clean up extracted source files on disk to prevent VPS disk bloat
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }

    // Drop failed preview database(s) if created
    if (state?.previewDbs && state.previewDbs.length > 0) {
      for (const clone of state.previewDbs) {
        if (clone?.name) {
          await stateLog(`Dropping failed preview database ${clone.name}...`);
          await this.dropPreviewDatabase(clone.name);
        }
      }
    }

    if (state?.isPreview) {
      await removePreviewTunnel(deploymentId).catch(() => {});
      await removePreviewCaddy(deploymentId).catch(() => {});
    }

    await updateStatus("FAILED", { finishedAt, error: errorMsg });
    await stateLog(`Deployment aborted. Error: ${errorMsg}`);

    // Dispatch incident alert notification with build error snippet
    const logSnippet = state?.logs?.slice(-25).join("\n") || "";
    await notificationService
      .notify(
        {
          event: "deployment_failed",
          title: `❌ Deployment Failed: ${app.name}`,
          level: "error",
          appName: app.name,
          appId: app.id,
          description: `Deployment ${deploymentId} failed: ${errorMsg}`,
          snippet: logSnippet,
          details: {
            deploymentId,
            container: containerName || "n/a",
            rollback: previousContainer
              ? `Rolled back to ${previousContainer}`
              : "No previous container",
          },
        },
        app,
      )
      .catch((err) => {
        logger.warn(`[deployer] Failed to send deployment failure alert:`, err);
      });

    if (previousContainer) {
      await stateLog(
        `Rollback complete: previous container remains healthy and active (${previousContainer})`,
      );
    } else {
      await stateLog("Rollback complete: no previous container was running.");
    }
  }

  private finishDeployment(
    appId: string,
    deploymentId: string,
    _dir: string,
    state: ActiveDeploymentState,
  ): void {
    this.running.delete(appId);

    // Persist all logs in single Log record with messages String[]
    void saveDeploymentLogs(deploymentId, state.logs).catch((err) => {
      logger.error(
        `[deployer] Failed to insert logs for ${deploymentId}:`,
        err,
      );
    });

    // Retain active state in memory for 15s to allow connected WebSocket clients to finish
    setTimeout(() => {
      this.active.delete(deploymentId);
    }, 15000);
  }

  private async detectExposedPort(image: string): Promise<number | undefined> {
    const inspect = await run("docker", [
      "inspect",
      "--format",
      "{{json .Config}}",
      image,
    ]);
    if (inspect.code === 0 && inspect.stdout.trim()) {
      try {
        const config = JSON.parse(inspect.stdout.trim());
        if (config && typeof config === "object") {
          // 1. Check Env for PORT=(\d+) (e.g. Next.js ENV PORT 4000 or ENV PORT=4000)
          if (Array.isArray(config.Env)) {
            for (const env of config.Env) {
              const match = String(env).match(/^PORT=(\d+)$/i);
              if (match && match[1]) {
                const port = Number(match[1]);
                if (port > 0 && port <= 65535) return port;
              }
            }
          }

          // 2. Check Cmd or Entrypoint for -p <port> or --port <port>
          const cmdArgs = [
            ...(Array.isArray(config.Entrypoint) ? config.Entrypoint : []),
            ...(Array.isArray(config.Cmd) ? config.Cmd : []),
          ];
          for (let i = 0; i < cmdArgs.length; i++) {
            const arg = String(cmdArgs[i]);
            if (arg === "-p" || arg === "--port") {
              const nextArg = cmdArgs[i + 1];
              if (nextArg) {
                const parsed = parseInt(String(nextArg), 10);
                if (!isNaN(parsed) && parsed > 0 && parsed <= 65535)
                  return parsed;
              }
            }
            const match = arg.match(/(?:-p|--port)[=\s](\d+)/i);
            if (match && match[1]) {
              const parsed = parseInt(match[1], 10);
              if (!isNaN(parsed) && parsed > 0 && parsed <= 65535)
                return parsed;
            }
          }

          // 3. Check ExposedPorts
          if (config.ExposedPorts && typeof config.ExposedPorts === "object") {
            const keys = Object.keys(config.ExposedPorts);
            if (keys.length > 0) {
              const match = keys[0].match(/^(\d+)/);
              if (match) {
                const port = Number(match[1]);
                if (port > 0 && port <= 65535) return port;
              }
            }
          }
        }
      } catch {
        // ignore
      }
    }
    return undefined;
  }

  private async waitForLiveness(
    containerName: string,
    log: (msg: string) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const requiredStableSeconds = 3;
    let consecutiveRunning = 0;
    const maxAttempts = 30; // 30 seconds max

    for (let i = 0; i < maxAttempts; i++) {
      if (signal?.aborted) throw new Error("Liveness check cancelled by user");
      const stateCheck = await run(
        "docker",
        ["inspect", "--format", "{{json .State}}", containerName],
        { signal },
      );

      if (stateCheck.code !== 0) {
        if (signal?.aborted) {
          throw new Error("Liveness check cancelled by user");
        }
        throw new Error(`Failed to inspect container ${containerName}`);
      }

      try {
        const state = JSON.parse(stateCheck.stdout.trim());
        if (state.Running === false) {
          const logs = await run("docker", [
            "logs",
            "--tail",
            "50",
            containerName,
          ]);
          const errorOutput = (logs.stderr || logs.stdout || "").trim();
          throw new Error(
            `Container exited unexpectedly with code ${state.ExitCode}${errorOutput ? `:\n${errorOutput}` : ""}`,
          );
        }

        if (state.Health?.Status === "unhealthy") {
          throw new Error("Docker container HEALTHCHECK failed");
        }

        if (state.Health?.Status === "healthy") {
          await log("Container Docker HEALTHCHECK passed");
          return;
        }

        consecutiveRunning++;
        if (consecutiveRunning >= requiredStableSeconds) {
          await log(
            `Container process is running stably (${requiredStableSeconds}s alive check)`,
          );
          return;
        }
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.startsWith("Container exited")
        ) {
          throw err;
        }
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    throw new Error("Container process failed to stabilize within timeout");
  }

  private async pruneOldImages(
    app: FormattedApp,
    log: (msg: string) => Promise<void>,
  ): Promise<void> {
    try {
      const appDeployments = await prisma.deployment.findMany({
        where: {
          appId: app.id,
          image: { not: null },
        },
        orderBy: { startedAt: "desc" },
      });

      const toKeep = new Set<string>();
      if (app.currentDeploymentId) {
        const current = appDeployments.find(
          (d: any) => d.id === app.currentDeploymentId,
        );
        if (current?.image) toKeep.add(current.image);
      }
      for (const d of appDeployments.slice(0, docker.imageRetentionLimit)) {
        if (d.image) toKeep.add(d.image);
      }

      const candidates = appDeployments.slice(docker.imageRetentionLimit);
      for (const old of candidates) {
        if (old.image && !toKeep.has(old.image)) {
          toKeep.add(old.image);
          await log(`Pruning old deployment image: ${old.image}`);
          const res = await run("docker", ["rmi", "-f", old.image]);
          if (res.code !== 0) {
            await log(
              `Notice: Could not prune image ${old.image} (${res.stderr.trim()})`,
            );
          }
          const oldDir = join(this.baseDir, app.id, old.id);
          void rm(oldDir, { recursive: true, force: true }).catch(
            () => undefined,
          );
        }
      }
    } catch {
      // Non-fatal if pruning fails
    }
  }

  async promoteDeployment(deploymentId: string) {
    const target = await findDeployment(deploymentId);

    if (!target) {
      throw new Error(`Deployment "${deploymentId}" was not found.`);
    }

    if (target.status !== "PREVIEW") {
      throw new Error(
        `Deployment "${deploymentId}" is currently in status "${target.status}". Only deployments in "PREVIEW" status can be promoted to production.`,
      );
    }

    if (!target.containerName) {
      throw new Error(
        `Deployment "${deploymentId}" has no running container to promote.`,
      );
    }

    const app = target.app;
    const previousContainer = app.currentDeployment?.containerName ?? undefined;
    const targetMetadata = (target.metadata ?? {}) as Record<string, any>;
    const detectedPort = targetMetadata.detectedPort ?? app.port;
    const previewDbs = (
      (targetMetadata.previewDbs as Array<{
        name: string;
        isClone?: boolean;
      }>) || []
    ).filter((d) => d && d.name);

    const hasClones = previewDbs.length > 0;

    const state = this.active.get(deploymentId);
    const stateLog = async (line: string) => {
      if (state) {
        state.logs.push(line);
        this.events.emit(`update:${deploymentId}`, state);
      }
    };

    await stateLog(
      `Promoting preview deployment ${deploymentId} to production...`,
    );

    let liveContainerName = target.containerName;

    if (hasClones && target.image) {
      await stateLog(
        "Transitioning container from preview database(s) to production database(s)...",
      );
      const safeAppId = `app-${app.id.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
      const safeDeployId = `d-${deploymentId.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
      const prodContainerName = `explita-${safeAppId}-${safeDeployId}-prod`;

      // Start production container with production database
      await this.runContainer(prodContainerName, target.image, app, stateLog);

      await this.waitForLiveness(prodContainerName, stateLog);

      if (app.metadata.preDeploy && app.metadata.preDeploy.length > 0) {
        await stateLog("Applying pre-deploy hooks to production container...");
        await this.runPreDeployHooks(
          prodContainerName,
          app.metadata.preDeploy,
          stateLog,
        );
      }

      const appPort = detectedPort || app.port;
      const hp =
        app.metadata.healthCheck !== undefined
          ? app.metadata.healthCheck
          : appPort
            ? "/"
            : null;
      if (hp && appPort) {
        await this.waitForHttpHealthCheck(
          prodContainerName,
          appPort,
          hp,
          stateLog,
        );
      }

      liveContainerName = prodContainerName;
    }

    // Zero-downtime switch of production domains, Caddy, tunnel, and crons
    const traffic = await this.switchTraffic(
      app,
      deploymentId,
      liveContainerName,
      detectedPort,
      previousContainer,
      stateLog,
    );

    // Decommission the private preview tunnel sidecar
    await removePreviewTunnel(deploymentId).catch((err) => {
      logger.warn(
        `[deployer] Warning: Failed to remove preview tunnel for ${deploymentId}:`,
        err,
      );
    });

    // Remove preview Caddy custom domain route
    await removePreviewCaddy(deploymentId).catch((err) => {
      logger.warn(
        `[deployer] Warning: Failed to remove preview Caddy route for ${deploymentId}:`,
        err,
      );
    });

    if (hasClones) {
      if (target.containerName && target.containerName !== liveContainerName) {
        await run("docker", ["rm", "-f", target.containerName]).catch(() => {});
      }
      for (const clone of previewDbs) {
        if (clone?.name) {
          await stateLog(
            `Dropping ephemeral preview database ${clone.name}...`,
          );
          await this.dropPreviewDatabase(clone.name);
        }
      }
    }

    const finishedAt = new Date();
    const updated = await prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        status: "LIVE",
        finishedAt,
        containerName: liveContainerName,
      },
    });

    if (state) {
      state.status = "LIVE";
      state.finishedAt = finishedAt.toISOString();
      this.events.emit(`update:${deploymentId}`, state);
    }

    await stateLog(
      `✔ Successfully promoted deployment ${deploymentId} to production.`,
    );

    const dir = join(this.baseDir, app.id, deploymentId);
    this.finishDeployment(
      app.id,
      deploymentId,
      dir,
      state || {
        id: deploymentId,
        appId: app.id,
        status: "LIVE",
        startedAt: target.startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        logs: [],
      },
    );

    return {
      ...updated,
      tunnelUrl: traffic.tunnelUrl,
      domains: traffic.domains,
    };
  }

  async rollbackPreview(
    target: {
      id: string;
      appId: string;
      containerName?: string | null;
      image?: string | null;
      metadata?: any;
    },
    options?: { purge?: boolean },
  ): Promise<void> {
    const deploymentId = target.id;
    const state = this.active.get(deploymentId);

    const stateLog = async (line: string) => {
      if (state) {
        state.logs.push(line);
        this.events.emit(`update:${deploymentId}`, state);
      }
    };

    await stateLog(`Discarding preview deployment ${deploymentId}...`);

    // Remove preview container
    if (target.containerName) {
      await stateLog(`Stopping preview container ${target.containerName}...`);
      await run("docker", ["rm", "-f", target.containerName]).catch(() => {});
    }

    // Remove preview tunnel container
    await removePreviewTunnel(deploymentId).catch(() => {});

    // Remove preview Caddy route
    await removePreviewCaddy(deploymentId).catch(() => {});

    // Drop ephemeral preview database(s) if present
    const meta = target.metadata ?? {};
    const clonesToDrop =
      (meta.previewDbs as Array<{ name: string; isClone?: boolean }>) || [];

    for (const clone of clonesToDrop) {
      if (clone?.name) {
        await stateLog(`Dropping ephemeral preview database ${clone.name}...`);
        await this.dropPreviewDatabase(clone.name);
      }
    }

    // Prune preview image if not in use
    if (target.image) {
      await run("docker", ["rmi", "-f", target.image]).catch(() => {});
    }

    const dir = join(this.baseDir, target.appId, deploymentId);
    await rm(dir, { recursive: true, force: true }).catch(() => {});

    if (options?.purge) {
      await prisma.deployment
        .delete({ where: { id: deploymentId } })
        .catch(() => {});
      this.running.delete(target.appId);
      this.active.delete(deploymentId);
      this.abortControllers.delete(deploymentId);
      return;
    }

    const finishedAt = new Date();
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        status: "ROLLED_BACK",
        finishedAt,
      },
    });

    if (state) {
      state.status = "ROLLED_BACK";
      state.finishedAt = finishedAt.toISOString();
      this.events.emit(`update:${deploymentId}`, state);
    }

    await stateLog(
      `Preview deployment discarded cleanly. Production remains untouched.`,
    );

    this.finishDeployment(
      target.appId,
      deploymentId,
      dir,
      state || {
        id: deploymentId,
        appId: target.appId,
        status: "ROLLED_BACK",
        startedAt: new Date().toISOString(),
        finishedAt: finishedAt.toISOString(),
        logs: [],
      },
    );
  }

  private async handleCancellation(
    app: FormattedApp,
    deploymentId: string,
    dir: string,
    containerName: string | undefined,
    image: string | undefined,
    previousContainer: string | undefined,
    stateLog: (line: string) => Promise<void>,
    updateStatus: (
      status: DeploymentStatus,
      extra?: { finishedAt?: Date; error?: string },
    ) => Promise<void>,
    state?: ActiveDeploymentState,
  ): Promise<void> {
    const finishedAt = new Date();

    if (containerName) {
      await stateLog(`Cleaning up aborted container ${containerName}...`);
      await run("docker", ["rm", "-f", containerName]).catch(() => {});
    }

    if (image) {
      await stateLog(`Removing build image ${image}...`);
      await run("docker", ["rmi", "-f", image]).catch(() => {});
    }

    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }

    if (state?.previewDbs && state.previewDbs.length > 0) {
      for (const clone of state.previewDbs) {
        if (clone?.name) {
          await stateLog(`Dropping aborted preview database ${clone.name}...`);
          await this.dropPreviewDatabase(clone.name);
        }
      }
    }

    if (state?.isPreview) {
      await removePreviewTunnel(deploymentId).catch(() => {});
      await removePreviewCaddy(deploymentId).catch(() => {});
    }

    await updateStatus("CANCELLED", {
      finishedAt,
      error: "Deployment cancelled by user.",
    });

    if (previousContainer) {
      await stateLog(
        `Cancellation complete: production container remains healthy and active (${previousContainer}).`,
      );
    } else {
      await stateLog("Cancellation complete: zero disruption to environment.");
    }
  }

  async cancelDeployment(deploymentId: string): Promise<boolean> {
    const state = this.active.get(deploymentId);
    if (!state) {
      const dep = await prisma.deployment.findUnique({
        where: { id: deploymentId },
      });
      if (!dep) {
        throw new Error(`Deployment "${deploymentId}" not found.`);
      }
      if (isTerminalStatus(dep.status)) {
        throw new Error(
          `Deployment ${deploymentId} already completed with status "${dep.status}".`,
        );
      }
      await prisma.deployment.update({
        where: { id: deploymentId },
        data: {
          status: "CANCELLED",
          finishedAt: new Date(),
        },
      });
      this.running.delete(dep.appId);
      return true;
    }

    if (isTerminalStatus(state.status)) {
      throw new Error(
        `Deployment ${deploymentId} already completed with status "${state.status}".`,
      );
    }

    state.status = "CANCELLED";
    state.logs.push("Deployment cancellation requested by user...");
    this.events.emit(`update:${deploymentId}`, state);

    const controller = this.abortControllers.get(deploymentId);
    if (controller) {
      controller.abort();
    }

    return true;
  }

  async recreateAppContainer(
    rawApp: FormattedApp,
    logFn?: (line: string) => Promise<void>,
  ): Promise<{ containerName: string; detectedPort?: number }> {
    const app = stripAppPrefixes(rawApp);
    if (this.running.has(app.id)) {
      throw new Error(
        "A deployment or container operation is already running for this app",
      );
    }
    this.running.add(app.id);

    const deployment = app.currentDeployment;
    if (!deployment || !deployment.image) {
      this.running.delete(app.id);
      throw new Error("Application has no active deployment to reload");
    }

    const stateLog = async (line: string) => {
      logger.info(`[deployer:recreate] ${line}`);
      if (logFn) {
        await logFn(line).catch(() => {});
      }
    };

    const deploymentId = deployment.id;
    const safeAppId = `app-${app.id.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
    const safeDeployId = `d-${deploymentId.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
    const newContainerName = `explita-${safeAppId}-${safeDeployId}-${Date.now().toString(36)}`;
    const previousContainer = deployment.containerName;
    let trafficSwitched = false;

    try {
      await stateLog(
        `Applying environment variables to ${app.name} (${app.id}) using existing image ${deployment.image}...`,
      );

      // Pre-cleanup any stale/dangling reload containers that leaked from previous attempts
      try {
        const stale = await run("docker", [
          "ps",
          "-a",
          "--filter",
          `name=explita-${safeAppId}-${safeDeployId}-`,
          "--format",
          "{{.Names}}",
        ]);
        if (stale.code === 0 && stale.stdout) {
          const names = stale.stdout
            .split("\n")
            .map((n) => n.trim())
            .filter(Boolean);
          for (const name of names) {
            if (name !== previousContainer && name !== newContainerName) {
              await run("docker", ["rm", "-f", name]).catch(() => {});
            }
          }
        }
      } catch {}

      // 1. Run new container with updated environment variables from existing image
      let detectedPort: number | undefined;
      try {
        detectedPort = await this.runContainer(
          newContainerName,
          deployment.image,
          app,
          stateLog,
        );
      } catch (err: any) {
        await stateLog(`Failed to start container: ${err.message}`);
        throw err;
      }

      // 2. Process liveness check
      try {
        await this.waitForLiveness(newContainerName, stateLog);
      } catch (err: any) {
        throw new Error(`Process liveness check failed: ${err.message}`);
      }

      // 3. HTTP health check (if configured)
      const appPort = detectedPort || app.port;
      const healthCheckPath =
        app.metadata.healthCheck !== undefined
          ? app.metadata.healthCheck
          : appPort
            ? "/"
            : null;

      if (healthCheckPath && appPort) {
        try {
          await this.waitForHttpHealthCheck(
            newContainerName,
            appPort,
            healthCheckPath,
            stateLog,
          );
        } catch (err: any) {
          throw new Error(`HTTP health check failed: ${err.message}`);
        }
      }

      // 4. Update deployment record to point to new container before switching traffic
      await prisma.deployment.update({
        where: { id: deploymentId },
        data: { containerName: newContainerName },
      });
      trafficSwitched = true;

      // 5. Zero-downtime traffic switch & cleanup of old container
      await this.switchTraffic(
        app,
        deploymentId,
        newContainerName,
        detectedPort,
        previousContainer || undefined,
        stateLog,
      );

      await stateLog(
        `Environment variables successfully applied. Running container: ${newContainerName}`,
      );

      return { containerName: newContainerName, detectedPort };
    } catch (err: any) {
      await stateLog(
        `Rollback triggered during container reload: ${err.message}`,
      );

      // Ensure failed new container is removed immediately so containers don't pile up
      if (newContainerName) {
        await stateLog(
          `Rollback: cleaning up failed container ${newContainerName}...`,
        );
        await run("docker", ["stop", "-t", "2", newContainerName]).catch(
          () => {},
        );
        await run("docker", ["rm", "-f", newContainerName]).catch(() => {});
      }

      // If traffic was switched before the failure, restore Caddy / tunnel back to previous container
      if (trafficSwitched && previousContainer) {
        await stateLog(
          `Rollback: restoring traffic route to previous container ${previousContainer}...`,
        );
        await prisma.deployment
          .update({
            where: { id: deploymentId },
            data: { containerName: previousContainer },
          })
          .catch(() => {});

        await syncAppCaddy(app.id).catch(() => {});
        await syncAppTunnel(app).catch(() => {});
        await cronScheduler.syncApp(app.id).catch(() => {});
      } else if (previousContainer) {
        await stateLog(
          `Rollback complete: previous container remains healthy and active (${previousContainer})`,
        );
      }

      throw err;
    } finally {
      this.running.delete(app.id);
    }
  }
}

export const deployer = new Deployer(server.deployBaseDir, docker.network);
