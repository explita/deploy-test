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
import {
  createWriteStream,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { pruneOldDatabaseBackups } from "./prune.js";
import { prisma } from "../../../../lib/prisma.js";
import { resolve } from "node:path";
import { DEFAULT_BACKUP_SCHEDULE, getAllSchedules } from "../schedule.js";
import { replicateBackupToS3, pruneS3DatabaseBackups } from "./s3.js";
import { isMysqlOrMariaDb } from "../../../../lib/mariadb.js";
import { createHash } from "node:crypto";
import { Transform, TransformCallback } from "node:stream";

/**
 * Filter comments containing dynamic generation timestamps, server versions, or client banners.
 */
function isVolatileComment(line: string): boolean {
  if (!line.startsWith("--")) return false;
  return /^--\s*(Dump completed on|PostgreSQL database dump|Dumped (by|from)|MySQL dump|Host:|Server version)/i.test(
    line,
  );
}

/**
 * Streaming Transform that calculates a normalized SHA-256 hash of the uncompressed SQL stream
 * while transparently passing raw bytes downstream to gzip and disk.
 */
export class SqlContentHasher extends Transform {
  private hash = createHash("sha256");
  private remainder = "";

  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.push(chunk);

    const text = this.remainder + chunk.toString("utf8");
    const lines = text.split("\n");
    this.remainder = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || isVolatileComment(trimmed)) {
        continue;
      }
      this.hash.update(trimmed + "\n");
    }
    callback();
  }

  _flush(callback: TransformCallback): void {
    if (this.remainder) {
      const trimmed = this.remainder.trim();
      if (trimmed && !isVolatileComment(trimmed)) {
        this.hash.update(trimmed + "\n");
      }
    }
    callback();
  }

  getDigest(): string {
    return this.hash.digest("hex");
  }
}

export async function executeDatabaseBackup(
  appId: string,
  key?: string,
  options?: { s3?: boolean; force?: boolean },
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
  const tempFilename = `.tmp-${filename}`;
  const tempFilePath = resolve(dir, tempFilename);
  const finalFilePath = resolve(dir, filename);

  logger.info(
    `Starting backup for database "${db.name}" (key: "${db.key}", type: "${isMysql ? "mysql" : "postgres"}", app: ${app.name})...`,
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
        "--skip-comments",
        "--skip-dump-date",
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
      unlinkSync(tempFilePath);
    } catch {
      // Ignore
    }
    throw new Error("Unable to read stdout from database dump process.");
  }

  const hasher = new SqlContentHasher();
  const gzip = createGzip();
  const fileOut = createWriteStream(tempFilePath);

  try {
    await pipeline(proc.child.stdout, hasher, gzip, fileOut);
  } catch (err) {
    try {
      unlinkSync(tempFilePath);
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
      unlinkSync(tempFilePath);
    } catch {
      // Ignore cleanup error
    }
    throw new Error(
      `Database dump failed with exit code ${result.code}: ${result.stderr}`,
    );
  }

  const contentHash = hasher.getDigest();
  const meta = app.metadata;
  const allSchedules = getAllSchedules(
    meta.databaseBackup,
    app.databases || [],
  );
  const currentSchedule = allSchedules[db.key] || {
    ...DEFAULT_BACKUP_SCHEDULE,
  };
  const keep = currentSchedule.keep ?? 7;
  const isForce = Boolean(options?.force);

  // Check existing backup strictly from DatabaseBackup table
  const latestBackup = await prisma.databaseBackup.findFirst({
    where: { appId: app.id, key: db.key },
    orderBy: { createdAt: "desc" },
  }).catch(() => null);

  const previousHash = latestBackup?.contentHash;

  // Verify whether database data actually changed
  const isUnchanged =
    !isForce &&
    Boolean(latestBackup) &&
    Boolean(previousHash) &&
    previousHash === contentHash;

  if (isUnchanged && latestBackup) {
    try {
      unlinkSync(tempFilePath);
    } catch {
      // Ignore cleanup error
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
      `Database "${db.name}" (key: "${db.key}", app: "${app.name}") data has not changed since last backup (${latestBackup.filename}). Skipped duplicate backup.`,
    );

    return {
      id: latestBackup.filename,
      filename: latestBackup.filename,
      sizeBytes: Number(latestBackup.sizeBytes),
      sizeFormatted: latestBackup.sizeFormatted,
      createdAt: latestBackup.createdAt.toISOString(),
      key: latestBackup.key,
      dbName: latestBackup.dbName,
      storage: latestBackup.storage as any,
      s3Url: latestBackup.s3Url || undefined,
      contentHash: latestBackup.contentHash,
      skipped: true,
      unchanged: true,
      message: `Database content unchanged since last backup (${latestBackup.filename}). Skipped saving duplicate backup.`,
    };
  }

  // Atomically promote temporary file to final backup file
  renameSync(tempFilePath, finalFilePath);
  const stats = statSync(finalFilePath);

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
        finalFilePath,
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

  const backupRecord: DatabaseBackupFile = {
    id: filename,
    filename,
    sizeBytes: stats.size,
    sizeFormatted: formatSize(stats.size),
    createdAt: stats.mtime.toISOString(),
    key: db.key,
    dbName: db.name,
    storage: s3Result?.s3Url ? "both" : "local",
    s3Url: s3Result?.s3Url,
    contentHash,
    skipped: false,
    unchanged: false,
  };

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

  // Persist structured backup record in dedicated database table
  await prisma.databaseBackup.upsert({
    where: { filename },
    create: {
      appId: app.id,
      filename,
      key: db.key,
      dbName: db.name,
      sizeBytes: stats.size,
      sizeFormatted: formatSize(stats.size),
      contentHash,
      storage: s3Result?.s3Url ? "both" : "local",
      s3Url: s3Result?.s3Url,
      createdAt: stats.mtime,
    },
    update: {
      sizeBytes: stats.size,
      sizeFormatted: formatSize(stats.size),
      contentHash,
      storage: s3Result?.s3Url ? "both" : "local",
      s3Url: s3Result?.s3Url,
    },
  }).catch((dbErr) => {
    logger.warn(`Failed to insert DatabaseBackup model for "${filename}":`, dbErr);
  });

  // Prune excess database backup records beyond retention limit
  const excessRows = await prisma.databaseBackup.findMany({
    where: { appId: app.id, key: db.key },
    orderBy: { createdAt: "desc" },
    skip: keep,
    select: { id: true },
  }).catch(() => []);

  if (excessRows.length > 0) {
    await prisma.databaseBackup.deleteMany({
      where: { id: { in: excessRows.map((r) => r.id) } },
    }).catch(() => {});
  }

  logger.info(
    `Successfully created backup "${filename}" (${formatSize(stats.size)}) for app "${app.name}" (key: "${db.key}")${s3Result?.s3Url ? ` [replicated: ${s3Result.s3Url}]` : ""}`,
  );

  return backupRecord;
}
