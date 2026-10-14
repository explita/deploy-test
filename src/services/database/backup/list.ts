import { readdirSync, statSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { FastifyReply, FastifyRequest } from "fastify";
import { RequestParams } from "../../../types/misc.js";
import { getAppDbBackupDir } from "../../../lib/constants.js";
import { DatabaseBackupFile, formatSize } from "@explita/protocol";
import { extractKeyFromBackupFilename } from "../lib/utils.js";

import { FormattedApp } from "../../../lib/formatters/app.js";
import { findAppByIdOrName } from "../../../lib/app-helpers.js";
import { listS3DatabaseBackups } from "./helpers/s3.js";

export async function listBackups(
  request: FastifyRequest<{
    Params: RequestParams;
    Querystring: { key?: string };
  }>,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const key = request.query.key;

  const backups = await listDatabaseBackups(app, key);
  return reply.code(200).send({
    success: true,
    data: backups,
  });
}

export async function listDatabaseBackups(
  app: FormattedApp,
  key?: string,
): Promise<DatabaseBackupFile[]> {
  const dir = getAppDbBackupDir(app.id);
  const files: DatabaseBackupFile[] = [];
  const localFilenames = new Set<string>();

  if (existsSync(dir)) {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".sql.gz")) continue;

      const fileKey = extractKeyFromBackupFilename(entry.name);
      if (key && key.trim().toLowerCase() !== fileKey.toLowerCase()) {
        continue;
      }

      try {
        const fullPath = resolve(dir, entry.name);
        const stats = statSync(fullPath);

        files.push({
          id: entry.name,
          filename: entry.name,
          sizeBytes: stats.size,
          sizeFormatted: formatSize(stats.size),
          createdAt: stats.mtime.toISOString(),
          key: fileKey,
          storage: "local",
        });
        localFilenames.add(entry.name);
      } catch {
        // Ignore files that disappeared or cannot be read
      }
    }
  }

  // Cross-reference with remote S3 storage if configured
  try {
    if (app) {
      const s3Items = await listS3DatabaseBackups(app, key);
      for (const item of s3Items) {
        const existing = files.find((f) => f.filename === item.filename);
        if (existing) {
          existing.storage = "both";
          existing.s3Url = item.s3Url;
        } else {
          files.push({
            id: item.filename,
            filename: item.filename,
            sizeBytes: item.sizeBytes,
            sizeFormatted: formatSize(item.sizeBytes),
            createdAt: item.createdAt,
            key: item.key,
            storage: "s3",
            s3Url: item.s3Url,
          });
        }
      }
    }
  } catch {
    // S3 listing failure should not break local listing
  }

  // Sort descending by date (newest first)
  files.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return files;
}
