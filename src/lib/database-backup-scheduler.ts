import { prisma } from "./prisma.js";
import { matchesCron } from "@explita/protocol/deploy";
import { logger } from "@explita/protocol";
import { executeDatabaseBackup } from "../services/database/backup/helpers/exec.js";
import { notificationService } from "./notification-service.js";
import { formatApp, FormattedApp } from "./formatters/app.js";
import { stripAppPrefixes } from "./id.js";
import { getAllSchedules } from "../services/database/backup/schedule.js";

class DatabaseBackupScheduler {
  private tickInterval: NodeJS.Timeout | null = null;
  private isTicking = false;
  private runningApps = new Set<string>();

  public async start(): Promise<void> {
    if (this.tickInterval) return;

    logger.info("Initializing automated backup scheduler...");

    const now = new Date();
    const delay = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();

    setTimeout(
      () => {
        this.tick();
        this.tickInterval = setInterval(() => this.tick(), 60_000);
      },
      Math.max(delay, 500),
    );

    logger.info("Automated backup scheduler active (checking every minute)");
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
        if (app.databases.length === 0) continue;

        const scheduleMap = getAllSchedules(
          app.metadata?.databaseBackup,
          app.databases,
        );

        for (const db of app.databases) {
          const scheduleConfig = scheduleMap[db.key];
          if (
            !scheduleConfig ||
            !scheduleConfig.enabled ||
            !scheduleConfig.schedule
          ) {
            continue;
          }

          const lockKey = `${app.id}:${db.key}`;
          if (this.runningApps.has(lockKey)) {
            logger.warn(
              `Backup for app "${app.name}" (db: "${db.key}") is already in progress. Skipping.`,
            );
            continue;
          }

          if (matchesCron(scheduleConfig.schedule, now)) {
            this.triggerBackup(app, db, scheduleConfig).catch((err) => {
              logger.error(
                `Error triggering scheduled backup for app "${app.name}" (db: "${db.key}"):`,
                err,
              );
            });
          }
        }
      }
    } catch (err) {
      logger.warn("Error checking backup schedules:", err);
    } finally {
      this.isTicking = false;
    }
  }

  private async triggerBackup(
    app: FormattedApp,
    db: { key: string; name: string },
    scheduleConfig?: { s3?: boolean },
  ): Promise<void> {
    const lockKey = `${app.id}:${db.key}`;
    this.runningApps.add(lockKey);
    try {
      logger.info(
        `Scheduled trigger executing for app "${app.name}" (key: "${db.key}", db: "${db.name}")`,
      );
      const backupFile = await executeDatabaseBackup(app.id, db.key, {
        s3: Boolean(scheduleConfig?.s3),
      });

      if (backupFile.skipped) {
        logger.info(
          `Automated backup skipped for app "${app.name}" (key: "${db.key}"): database content unchanged.`,
        );
        return;
      }

      if (app) {
        await notificationService
          .notify(
            {
              event: "backup_completed",
              title: `🗄️ Database Backup Completed: ${app.name} (${db.key})`,
              level: "success",
              appName: app.name,
              appId: app.id,
              description: `Automated database backup created successfully for database "${db.name}" (key: "${db.key}").`,
              details: {
                key: db.key,
                database: db.name,
                filename: backupFile.filename,
                size: backupFile.sizeFormatted,
              },
            },
            app,
          )
          .catch((notifyErr) => {
            logger.warn(
              `Failed to dispatch backup success notification:`,
              notifyErr,
            );
          });
      }
    } catch (err) {
      logger.error(
        `Scheduled backup failed for app "${app.name}" (key: "${db.key}"):`,
        err,
      );
      // Update error status in metadata
      try {
        if (app) {
          const meta = app.metadata;
          const currentMap = getAllSchedules(
            meta.databaseBackup,
            app.databases,
          );
          if (currentMap[db.key]) {
            currentMap[db.key].lastStatus = "failed";
            currentMap[db.key].lastError =
              err instanceof Error ? err.message : String(err);
            await prisma.app.update({
              where: { id: app.id },
              data: {
                metadata: {
                  ...meta,
                  databaseBackup: currentMap,
                } as any,
              },
            });
          }

          // Send backup failed notification
          await notificationService
            .notify(
              {
                event: "backup_failed",
                title: `❌ Database Backup Failed: ${app.name} (${db.key})`,
                level: "error",
                appName: app.name,
                appId: app.id,
                description: `Automated database backup failed for database "${db.name}" (key: "${db.key}"): ${err instanceof Error ? err.message : String(err)}`,
                details: {
                  key: db.key,
                  database: db.name,
                  error: err instanceof Error ? err.message : String(err),
                },
              },
              app,
            )
            .catch((notifyErr) => {
              logger.warn(
                `Failed to dispatch backup failure notification:`,
                notifyErr,
              );
            });
        }
      } catch {
        // Ignore failure to write error
      }
    } finally {
      this.runningApps.delete(lockKey);
    }
  }
}

export const dbBackupScheduler = new DatabaseBackupScheduler();
