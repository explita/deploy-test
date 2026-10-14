import {
  DatabaseBackupFile,
  formatSize,
  logger,
  decryptValue,
  POSTGRES_CONTAINER_NAME,
  MARIADB_CONTAINER_NAME,
} from "@explita/protocol";
import { postgres, mariadb } from "../../../../lib/constants.js";
import { findAppByIdOrName } from "../../../../lib/app-helpers.js";
import { ensureBackupDir, generateBackupFilename } from "../../lib/utils.js";
import { stream } from "../../../../lib/runner.js";
import { createWriteStream, statSync, unlinkSync } from "node:fs";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { pruneOldDatabaseBackups } from "./prune.js";
import { prisma } from "../../../../lib/prisma.js";
import { resolve } from "node:path";
import { DEFAULT_BACKUP_SCHEDULE, getAllSchedules } from "../schedule.js";
import { replicateBackupToS3, pruneS3DatabaseBackups } from "./s3.js";
import { isMysqlOrMariaDb } from "../../../../lib/mariadb.js";

export async function executeDatabaseBackup(
  appId: string,
  key?: string,
  options?: { s3?: boolean },
): Promise<DatabaseBackupFile> {
  const app = await findAppByIdOrName(appId);
  if (!app) {
    throw new Error(`Application "${appId}" not found.`);
  }

  const targetKey = key?.trim().toLowerCase() || "default";
  const db = app.databases?.find((d) => d.key === targetKey);

  if (!db?.name) {
    throw new Error(
      `Application "${app.name}" does not have a managed database configured for key "${targetKey}".`,
    );
  }

  let isMysql = false;
  if (db.url) {
    try {
      const decrypted = decryptValue(db.url);
      isMysql = isMysqlOrMariaDb(decrypted);
    } catch {
      // Default to postgres
    }
  }

  const dir = ensureBackupDir(app.id);
  const filename = generateBackupFilename(db.key);
  const filePath = resolve(dir, filename);

  logger.info(
    `Starting automated backup for database "${db.name}" (key: "${db.key}", type: "${isMysql ? "mysql" : "postgres"}", app: ${app.name})...`,
  );

  const proc = isMysql
    ? stream("docker", [
        "exec",
        MARIADB_CONTAINER_NAME,
        "mariadb-dump",
        "-u",
        "root",
        `-p${mariadb.rootPassword}`,
        "--single-transaction",
        "--quick",
        db.name,
      ])
    : stream("docker", [
        "exec",
        "-e",
        `PGPASSWORD=${postgres.password || ""}`,
        POSTGRES_CONTAINER_NAME,
        "pg_dump",
        "-U",
        postgres.user,
        "-p",
        String(postgres.port),
        "-d",
        db.name,
      ]);

  if (!proc.child.stdout) {
    try {
      unlinkSync(filePath);
    } catch {
      // Ignore
    }
    throw new Error("Unable to read stdout from pg_dump process.");
  }

  const gzip = createGzip();
  const fileOut = createWriteStream(filePath);

  try {
    await pipeline(proc.child.stdout, gzip, fileOut);
  } catch (err) {
    try {
      unlinkSync(filePath);
    } catch {
      // Ignore cleanup error
    }
    throw new Error(
      `Failed to stream and compress database dump: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = await proc;
  if (result.code !== 0) {
    try {
      unlinkSync(filePath);
    } catch {
      // Ignore cleanup error
    }
    throw new Error(
      `pg_dump failed with exit code ${result.code}: ${result.stderr}`,
    );
  }

  const stats = statSync(filePath);
  const meta = app.metadata;
  const allSchedules = getAllSchedules(
    meta.databaseBackup,
    app.databases || [],
  );
  const currentSchedule = allSchedules[db.key] || {
    ...DEFAULT_BACKUP_SCHEDULE,
  };
  const keep = currentSchedule.keep ?? 7;

  // Prune rolling archives for this key beyond keep limit
  await pruneOldDatabaseBackups(app.id, keep, undefined, db.key);

  // Replicate to S3 only if explicitly requested (--s3) or enabled on the schedule
  const shouldReplicate =
    options?.s3 !== undefined
      ? Boolean(options.s3)
      : Boolean(currentSchedule.s3);

  let s3Result: { s3Url?: string; error?: string } | undefined;
  if (shouldReplicate) {
    try {
      const s3Upload = await replicateBackupToS3(
        app,
        filePath,
        filename,
        db.key,
      );
      if (s3Upload) {
        s3Result = { s3Url: s3Upload.s3Url };
        await pruneS3DatabaseBackups(app, keep, db.key).catch((pruneErr) => {
          logger.warn(
            `Failed to prune remote S3 backups for "${app.name}" (${db.key}):`,
            pruneErr,
          );
        });
      }
    } catch (s3Err: any) {
      logger.warn(`Failed to replicate backup "${filename}" to S3:`, s3Err);
      s3Result = { error: s3Err?.message || String(s3Err) };
    }
  }

  const updatedSchedule = {
    ...currentSchedule,
    lastRunAt: new Date().toISOString(),
    lastStatus: "success" as const,
    lastError: undefined,
  };

  const updatedMap = {
    ...allSchedules,
    [db.key]: updatedSchedule,
  };

  await prisma.app.update({
    where: { id: app.id },
    data: {
      metadata: {
        ...meta,
        databaseBackup: updatedMap,
      } as any,
    },
  });

  logger.info(
    `Successfully created backup "${filename}" (${formatSize(stats.size)}) for app "${app.name}" (key: "${db.key}")${s3Result?.s3Url ? ` [replicated: ${s3Result.s3Url}]` : ""}`,
  );

  return {
    id: filename,
    filename,
    sizeBytes: stats.size,
    sizeFormatted: formatSize(stats.size),
    createdAt: stats.mtime.toISOString(),
    key: db.key,
    dbName: db.name,
    storage: s3Result?.s3Url ? "both" : "local",
    s3Url: s3Result?.s3Url,
  };
}
