import { prisma } from "./prisma.js";
import { matchesCron, DumpManifest } from "@explita/infra-protocol/deploy";
import { logger } from "@explita/infra-protocol";
import { formatApp, FormattedApp } from "./formatters/app.js";
import { stripAppPrefixes } from "./id.js";
import { stageAppDump } from "../services/dump/dump.js";
import {
  uploadDumpToS3,
  pruneS3Dumps,
} from "../services/database/backup/helpers/s3.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";

class DumpScheduler {
  private tickInterval: NodeJS.Timeout | null = null;
  private isTicking = false;
  private runningApps = new Set<string>();

  public async start(): Promise<void> {
    if (this.tickInterval) return;

    logger.info("Initializing automated dump scheduler...");

    const now = new Date();
    const delay = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();

    setTimeout(
      () => {
        this.tick();
        this.tickInterval = setInterval(() => this.tick(), 60_000);
      },
      Math.max(delay, 500),
    );

    logger.info("Automated dump scheduler active (checking every minute)");
  }

  public stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  public async tick(): Promise<void> {
    if (this.isTicking) return;
    this.isTicking = true;

    try {
      const apps = await prisma.app.findMany({
        include: {
          currentDeployment: true,
          domains: true,
          databases: true,
          redis: true,
        },
      });

      const formattedApps = apps.map((app) => stripAppPrefixes(formatApp(app)));
      const now = new Date();

      for (const app of formattedApps) {
        const schedule = app.metadata?.dumpSchedule;
        if (!schedule || !schedule.enabled || !schedule.schedule) {
          continue;
        }

        if (this.runningApps.has(app.id)) {
          logger.warn(
            `Dump for app "${app.name}" is already in progress. Skipping.`,
          );
          continue;
        }

        if (matchesCron(schedule.schedule, now)) {
          this.triggerDump(app, schedule).catch((err) => {
            logger.error(
              `Error triggering scheduled dump for app "${app.name}":`,
              err,
            );
          });
        }
      }
    } catch (err) {
      logger.warn("Error checking dump schedules:", err);
    } finally {
      this.isTicking = false;
    }
  }

  private async triggerDump(app: FormattedApp, schedule: any): Promise<void> {
    this.runningApps.add(app.id);
    const tempDir = await mkdtemp(
      join(tmpdir(), `explita-sched-dump-${app.id}-`),
    );

    try {
      logger.info(`Scheduled dump trigger executing for app "${app.name}"`);

      const options = {
        includeDb: true,
        includeFiles: true,
        includeEnv: true,
        revealSecrets: true,
      };

      const appDir = join(tempDir, app.name || app.id);
      const summary = await stageAppDump(app, appDir, options);

      const manifest: DumpManifest = {
        version: "1.0",
        timestamp: new Date().toISOString(),
        scope: "app",
        appsCount: 1,
        options,
        apps: [
          {
            id: app.id,
            name: app.name,
            ...summary,
          },
        ],
      };

      await writeFile(
        join(tempDir, "manifest.json"),
        JSON.stringify(manifest, null, 2),
        "utf8",
      );

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `explita-dump-${app.name || app.id}-${timestamp}.tar.gz`;
      const archivePath = join(tempDir, filename);

      await tar.c(
        {
          gzip: { level: 9 },
          file: archivePath,
          cwd: tempDir,
        },
        ["manifest.json", app.name || app.id],
      );

      let s3Url: string | undefined;
      if (schedule.s3) {
        const s3Upload = await uploadDumpToS3(app, archivePath, filename);
        s3Url = s3Upload.s3Url;
        await pruneS3Dumps(app, schedule.keep || 4).catch((pruneErr) => {
          logger.warn(
            `Failed to prune remote S3 dumps for "${app.name}":`,
            pruneErr,
          );
        });
      }

      const meta = app.metadata || {};
      const updatedSchedule = {
        ...schedule,
        lastRunAt: new Date().toISOString(),
        lastStatus: "success" as const,
        lastError: undefined,
        lastS3Url: s3Url,
        lastFilename: filename,
      };

      await prisma.app.update({
        where: { id: app.id },
        data: {
          metadata: {
            ...meta,
            dumpSchedule: updatedSchedule,
          } as any,
        },
      });

      logger.info(
        `Scheduled dump completed for app "${app.name}": ${filename}${s3Url ? ` [replicated to ${s3Url}]` : ""}`,
      );
    } catch (err) {
      logger.error(`Scheduled dump failed for app "${app.name}":`, err);

      try {
        const meta = app.metadata || {};
        const updatedSchedule = {
          ...schedule,
          lastRunAt: new Date().toISOString(),
          lastStatus: "failed" as const,
          lastError: err instanceof Error ? err.message : String(err),
        };

        await prisma.app.update({
          where: { id: app.id },
          data: {
            metadata: {
              ...meta,
              dumpSchedule: updatedSchedule,
            } as any,
          },
        });
      } catch (updateErr) {
        logger.warn("Failed to update dump failure metadata:", updateErr);
      }
    } finally {
      this.runningApps.delete(app.id);
      await rm(tempDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}

export const dumpScheduler = new DumpScheduler();
