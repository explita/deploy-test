import { randomUUID } from "node:crypto";
import { prisma } from "./prisma.js";
import { run } from "./runner.js";
import {
  AppCronInfo,
  CronExecutionRecord,
  CronJobConfig,
  describeCron,
  getNextCronRun,
  matchesCron,
} from "@explita/protocol/deploy";
import { logger } from "@explita/protocol";
import { findAppByIdOrName } from "./app-helpers.js";
import { cron } from "./constants.js";
import { notificationService } from "./notification-service.js";

interface ActiveCronJob extends CronJobConfig {
  id: string;
  name: string;
  schedule: string;
  command: string;
  running?: boolean;
}

interface AppCronState {
  appId: string;
  jobs: Map<string, ActiveCronJob>;
  lastExecutions: Map<string, CronExecutionRecord>;
}

class CronScheduler {
  private appStates = new Map<string, AppCronState>();
  private tickInterval: NodeJS.Timeout | null = null;
  private isTicking = false;

  public async start(): Promise<void> {
    if (this.tickInterval) return;

    logger.always("Initializing scheduled jobs runner...");
    await this.syncAllApps();

    // Align ticker to start cleanly on the next second boundary, then run every 60s
    const now = new Date();
    const delay = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();

    setTimeout(
      () => {
        this.tick();
        this.tickInterval = setInterval(() => this.tick(), 60_000);
      },
      Math.max(delay, 500),
    );

    logger.always("Scheduled jobs runner active (checking every minute)");
  }

  public stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  public async syncAllApps(): Promise<void> {
    try {
      const apps = await prisma.app.findMany({
        where: {
          currentDeploymentId: { not: null },
        },
        include: {
          currentDeployment: true,
        },
      });

      for (const app of apps) {
        if (app.currentDeployment?.status === "LIVE") {
          await this.syncApp(app.id);
        } else {
          this.removeApp(app.id);
        }
      }
    } catch (err) {
      logger.warn("[cron] Error syncing apps during startup:", err);
    }
  }

  public async syncApp(appId: string): Promise<void> {
    const app = await findAppByIdOrName(appId);

    if (
      !app ||
      !app.currentDeployment ||
      app.currentDeployment.status !== "LIVE"
    ) {
      this.removeApp(appId);
      return;
    }

    const rawCrons = app.crons;

    let state = this.appStates.get(appId);
    if (!state) {
      state = {
        appId,
        jobs: new Map(),
        lastExecutions: new Map(),
      };
      this.appStates.set(appId, state);
    }

    const nextJobs = new Map<string, ActiveCronJob>();
    for (let i = 0; i < rawCrons.length; i++) {
      const c = rawCrons[i];
      if (!c || typeof c !== "object") continue;
      const schedule = String(c.schedule || "").trim();
      const command = String(c.command || "").trim();
      if (!schedule || !command) continue;

      const id = String(c.id || `cron-${i + 1}`).trim();
      const name = String(c.name || `cron-${i + 1}`).trim();
      const timeout = typeof c.timeout === "number" ? c.timeout : undefined;
      const existing = state.jobs.get(id);
      const paused =
        typeof c.paused === "boolean" ? c.paused : existing?.paused || false;

      nextJobs.set(id, {
        id,
        name,
        schedule,
        command,
        timeout,
        paused,
        running: existing?.running || false,
      });
    }

    state.jobs = nextJobs;
    if (nextJobs.size > 0) {
      logger.info(
        `[cron] Synced ${nextJobs.size} cron job(s) for app "${app.name}" (${app.id})`,
      );
    }

    // Populate last executions from DB so last run info persists across restarts
    try {
      const latestExecs = await prisma.cronExecution.findMany({
        where: { appId: app.id },
        orderBy: { createdAt: "desc" },
        distinct: ["cronId"],
      });
      for (const rec of latestExecs) {
        state.lastExecutions.set(rec.cronId, {
          id: rec.id,
          appId: rec.appId,
          cronId: rec.cronId,
          cronName: rec.cronName,
          command: rec.command,
          startedAt: rec.startedAt.toISOString(),
          finishedAt: rec.finishedAt ? rec.finishedAt.toISOString() : undefined,
          durationMs: rec.durationMs ?? undefined,
          exitCode: rec.exitCode ?? undefined,
          status: rec.status as "running" | "success" | "failed",
          output: rec.output,
          manual: rec.manual,
        });
      }
    } catch (err) {
      logger.warn(
        `[cron] Failed to fetch latest executions for ${app.id}:`,
        err,
      );
    }
  }

  public removeApp(appId: string): void {
    if (this.appStates.has(appId)) {
      this.appStates.delete(appId);
    }
  }

  public async listAppCrons(appId: string): Promise<AppCronInfo[]> {
    const app = await findAppByIdOrName(appId);
    if (!app) return [];

    // Ensure state is loaded
    if (!this.appStates.has(appId)) {
      await this.syncApp(appId);
    }

    const state = this.appStates.get(appId);
    if (!state || state.jobs.size === 0) return [];

    const result: AppCronInfo[] = [];
    const now = new Date();

    for (const job of state.jobs.values()) {
      const nextDate = getNextCronRun(job.schedule, now);
      const lastExec = state.lastExecutions.get(job.id);

      result.push({
        id: job.id,
        name: job.name,
        schedule: job.schedule,
        command: job.command,
        timeout: job.timeout,
        paused: job.paused || false,
        description: describeCron(job.schedule),
        nextRun: job.paused ? null : nextDate ? nextDate.toISOString() : null,
        lastRun: lastExec ? lastExec.startedAt : null,
        lastStatus: job.running
          ? "running"
          : job.paused
            ? "paused"
            : lastExec
              ? lastExec.status
              : null,
        lastDurationMs: lastExec ? lastExec.durationMs : null,
      });
    }

    return result;
  }

  public async getHistory(appId: string): Promise<CronExecutionRecord[]> {
    const records = await prisma.cronExecution.findMany({
      where: { appId },
      orderBy: { createdAt: "desc" },
      take: cron.historyLimit,
    });

    return records.map((r) => ({
      id: r.id,
      appId: r.appId,
      cronId: r.cronId,
      cronName: r.cronName,
      command: r.command,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : undefined,
      durationMs: r.durationMs ?? undefined,
      exitCode: r.exitCode ?? undefined,
      status: r.status as "running" | "success" | "failed",
      output: r.output,
      manual: r.manual,
    }));
  }

  public async pauseJob(
    appId: string,
    cronSelector: string,
  ): Promise<ActiveCronJob> {
    if (!this.appStates.has(appId)) {
      await this.syncApp(appId);
    }

    const state = this.appStates.get(appId);
    if (!state) {
      throw new Error(`Application "${appId}" has no cron jobs configured.`);
    }

    const targetJob = this.resolveJob(state, cronSelector, appId);
    targetJob.paused = true;

    await this.persistJobPauseState(appId, targetJob.id, true);
    logger.info(
      `[explita-deploy] Paused cron job "${targetJob.name}" (${targetJob.id}) for app "${appId}"`,
    );

    return targetJob;
  }

  public async resumeJob(
    appId: string,
    cronSelector: string,
  ): Promise<ActiveCronJob> {
    if (!this.appStates.has(appId)) {
      await this.syncApp(appId);
    }

    const state = this.appStates.get(appId);
    if (!state) {
      throw new Error(`Application "${appId}" has no cron jobs configured.`);
    }

    const targetJob = this.resolveJob(state, cronSelector, appId);
    targetJob.paused = false;

    await this.persistJobPauseState(appId, targetJob.id, false);
    logger.info(
      `[cron] Resumed cron job "${targetJob.name}" (${targetJob.id}) for app "${appId}"`,
    );

    return targetJob;
  }

  public async runCron(
    appId: string,
    cronSelector: string,
    manual = true,
  ): Promise<CronExecutionRecord> {
    if (!this.appStates.has(appId)) {
      await this.syncApp(appId);
    }

    const state = this.appStates.get(appId);
    if (!state) {
      throw new Error(`Application "${appId}" has no cron jobs configured.`);
    }

    const targetJob = this.resolveJob(state, cronSelector, appId);
    return this.executeJob(state, targetJob, manual);
  }

  private resolveJob(
    state: AppCronState,
    cronSelector: string,
    appId: string,
  ): ActiveCronJob {
    // Match by ID, name, or index (1-based or 0-based)
    let targetJob: ActiveCronJob | undefined = state.jobs.get(cronSelector);
    if (!targetJob) {
      for (const job of state.jobs.values()) {
        if (
          job.name.toLowerCase() === cronSelector.toLowerCase() ||
          job.id.toLowerCase() === cronSelector.toLowerCase()
        ) {
          targetJob = job;
          break;
        }
      }
    }
    if (!targetJob && /^\d+$/.test(cronSelector)) {
      const idx = parseInt(cronSelector, 10);
      const jobsArr = Array.from(state.jobs.values());
      targetJob = jobsArr[idx - 1] ?? jobsArr[idx];
    }

    if (!targetJob) {
      const available = Array.from(state.jobs.values())
        .map((j) => `"${j.name}"`)
        .join(", ");
      throw new Error(
        `Cron job "${cronSelector}" not found for app "${appId}". Available jobs: ${available || "none"}`,
      );
    }

    return targetJob;
  }

  private async persistJobPauseState(
    appId: string,
    jobId: string,
    paused: boolean,
  ): Promise<void> {
    await prisma.appCron.updateMany({
      where: {
        appId,
        OR: [{ id: jobId }, { name: jobId }],
      },
      data: { paused },
    });
  }

  private async tick(): Promise<void> {
    if (this.isTicking) return;
    this.isTicking = true;

    try {
      const now = new Date();
      for (const state of this.appStates.values()) {
        for (const job of state.jobs.values()) {
          if (job.paused) continue;
          if (matchesCron(job.schedule, now)) {
            // Trigger asynchronous job execution without blocking the tick loop
            this.executeJob(state, job, false).catch((err) => {
              logger.error(
                `[cron] Unexpected error executing ${job.name} for ${state.appId}:`,
                err,
              );
            });
          }
        }
      }
    } finally {
      this.isTicking = false;
    }
  }

  private async executeJob(
    state: AppCronState,
    job: ActiveCronJob,
    manual: boolean,
  ): Promise<CronExecutionRecord> {
    if (job.running) {
      logger.warn(
        `[cron] Job "${job.name}" (${job.id}) is already currently running for app "${state.appId}". Skipping concurrent trigger.`,
      );
      throw new Error(
        `Job "${job.name}" is already currently running. Please wait for the active run to finish.`,
      );
    }

    const app = await findAppByIdOrName(state.appId);
    const deployment = app?.currentDeployment;
    const containerName = deployment?.containerName;
    if (!containerName || !deployment || deployment.status !== "LIVE") {
      const msg = `Application "${state.appId}" has no active LIVE container to execute cron "${job.name}".`;
      logger.warn(`[cron] ${msg}`);
      throw new Error(msg);
    }

    job.running = true;
    const executionId = randomUUID();
    const startTime = Date.now();
    const startedAt = new Date(startTime).toISOString();

    const record: CronExecutionRecord = {
      id: executionId,
      appId: state.appId,
      cronId: job.id,
      cronName: job.name,
      command: job.command,
      startedAt,
      status: "running",
      output: "",
      manual,
    };

    // Record initial run in database
    await prisma.cronExecution
      .create({
        data: {
          id: executionId,
          appId: state.appId,
          cronId: job.id,
          cronName: job.name,
          command: job.command,
          startedAt: new Date(startTime),
          status: "running",
          output: "",
          manual,
        },
      })
      .catch((err) => {
        logger.warn(`[cron] Failed to record execution start in DB:`, err);
      });

    logger.info(
      `[cron] Running job "${job.name}" for app "${app.name}" in container ${containerName}: ${job.command} ${manual ? "(manual trigger)" : "(scheduled)"}`,
    );

    try {
      // Execute command inside container via docker exec
      const res = await run("docker", [
        "exec",
        containerName,
        "sh",
        "-c",
        job.command,
      ]);

      const durationMs = Date.now() - startTime;
      const combinedOutput = `${res.stdout}\n${res.stderr}`.trim();

      record.finishedAt = new Date().toISOString();
      record.durationMs = durationMs;
      record.exitCode = res.code;
      record.status = res.code === 0 ? "success" : "failed";
      record.output = combinedOutput;

      if (res.code === 0) {
        logger.info(
          `[cron] Job "${job.name}" completed successfully in ${durationMs}ms (exit code 0)`,
        );
      } else {
        logger.warn(
          `[cron] Job "${job.name}" failed with exit code ${res.code} in ${durationMs}ms: ${combinedOutput.slice(0, 200)}`,
        );
      }
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      record.finishedAt = new Date().toISOString();
      record.durationMs = durationMs;
      record.exitCode = 1;
      record.status = "failed";
      record.output = err?.message || String(err);
      logger.error(`[cron] Job "${job.name}" error:`, err);
    } finally {
      job.running = false;
      state.lastExecutions.set(job.id, record);

      // Update record in database
      await prisma.cronExecution
        .update({
          where: { id: executionId },
          data: {
            finishedAt: record.finishedAt
              ? new Date(record.finishedAt)
              : new Date(),
            durationMs: record.durationMs,
            exitCode: record.exitCode,
            status: record.status,
            output: record.output,
          },
        })
        .catch((err) => {
          logger.warn(`[cron] Failed to update execution in DB:`, err);
        });

      if (record.status === "failed") {
        notificationService
          .notify(
            {
              event: "cron_failed",
              title: `⏰ Cron Job Failed: ${job.name} (${app.name})`,
              level: "error",
              appName: app.name,
              appId: app.id,
              description: `Cron job "${job.name}" failed with exit code ${record.exitCode}`,
              snippet: record.output,
              details: {
                cronId: job.id,
                schedule: job.schedule,
                command: job.command,
                exitCode: record.exitCode,
                duration: `${record.durationMs}ms`,
              },
            },
            app,
          )
          .catch((notifyErr) => {
            logger.warn(`[cron] Failed to send cron failure alert:`, notifyErr);
          });
      }

      // Prune excess executions beyond user-configured cronHistoryLimit
      try {
        const excess = await prisma.cronExecution.findMany({
          where: { appId: state.appId },
          orderBy: { createdAt: "desc" },
          skip: cron.historyLimit,
          select: { id: true },
        });

        if (excess.length > 0) {
          await prisma.cronExecution.deleteMany({
            where: { id: { in: excess.map((e) => e.id) } },
          });
        }
      } catch (err) {
        logger.warn(
          `[cron] Failed to prune old executions for ${state.appId}:`,
          err,
        );
      }
    }

    return record;
  }
}

export const cronScheduler = new CronScheduler();
