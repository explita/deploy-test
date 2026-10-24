import { createReadStream, existsSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { postgres, mariadb } from "../../../lib/constants.js";
import { stream } from "../../../lib/runner.js";
import { FastifyReply, FastifyRequest } from "fastify";
import { RequestParams } from "../../../types/misc.js";
import {
  logger,
  decryptValue,
  POSTGRES_CONTAINER_NAME,
  MARIADB_CONTAINER_NAME,
} from "@explita/infra-protocol";
import {
  extractKeyFromBackupFilename,
  resolveSafeBackupPath,
} from "../lib/utils.js";
import { FormattedApp } from "../../../lib/formatters/app.js";
import { isMysqlOrMariaDb } from "../../../lib/mariadb.js";

interface BackupRequestParams extends RequestParams {
  backupId?: string;
}

export async function restoreBackup(
  request: FastifyRequest<{
    Params: BackupRequestParams;
    Querystring: { key?: string };
    Body?: { key?: string };
  }>,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const backupId = request.params.backupId;
  const key = request.query.key || request.body?.key;

  if (!backupId) {
    return reply.code(400).send({
      success: false,
      error: "Backup ID or filename is required.",
    });
  }

  const result = await restoreDatabaseFromBackup(app, backupId, key);

  return reply.code(200).send({
    success: true,
    message: `Database "${result.database}" (key: "${result.key}") restored successfully from backup "${backupId}".`,
    data: result,
  });
}

export async function restoreDatabaseFromBackup(
  app: FormattedApp,
  backupId: string,
  targetKey?: string,
) {
  const inferredKey =
    targetKey?.trim().toLowerCase() || extractKeyFromBackupFilename(backupId);

  const db = app.databases?.find((d) => d.key === inferredKey);

  if (!db?.name) {
    throw new Error(
      `Application "${app.name}" does not have a managed database configured for key "${inferredKey}".`,
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

  const filePath = resolveSafeBackupPath(app.id, backupId);
  if (!existsSync(filePath)) {
    const { downloadBackupFromS3 } = await import("./helpers/s3.js");
    const downloaded = await downloadBackupFromS3(
      app,
      backupId,
      filePath,
      db.key,
    );
    if (!downloaded || !existsSync(filePath)) {
      throw new Error(
        `Backup file not found on server or remote S3 storage: "${backupId}"`,
      );
    }
  }

  logger.info(
    `Restoring database "${db.name}" (key: "${db.key}", type: "${isMysql ? "mysql" : "postgres"}") from backup archive "${backupId}"...`,
  );

  const fileStream = createReadStream(filePath);
  const gunzip = createGunzip();
  const unzippedStream = fileStream.pipe(gunzip);

  const result = isMysql
    ? await stream(
        "docker",
        [
          "exec",
          "-i",
          MARIADB_CONTAINER_NAME,
          "mariadb",
          "-u",
          "root",
          `-p${mariadb.rootPassword}`,
          db.name,
        ],
        {
          stdin: unzippedStream,
        },
      )
    : await stream(
        "docker",
        [
          "exec",
          "-i",
          "-e",
          `PGPASSWORD=${postgres.password || ""}`,
          POSTGRES_CONTAINER_NAME,
          "psql",
          "-U",
          postgres.user,
          "-p",
          String(postgres.port),
          "-d",
          db.name,
        ],
        {
          stdin: unzippedStream,
        },
      );

  if (result.code !== 0) {
    logger.error(
      `Database restore exited with code ${result.code}: ${result.stderr}`,
    );
    throw new Error(
      result.stderr || `Database restore failed with exit code ${result.code}`,
    );
  }

  logger.info(
    `Successfully restored database "${db.name}" (key: "${db.key}") from "${backupId}"`,
  );

  return {
    restored: true,
    backup: backupId,
    database: db.name,
    key: db.key,
  };
}
