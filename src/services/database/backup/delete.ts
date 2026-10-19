import { existsSync, unlinkSync } from "node:fs";
import { FastifyReply, FastifyRequest } from "fastify";
import { RequestParams } from "../../../types/misc.js";
import { resolveSafeBackupPath } from "../lib/utils.js";
import { logger } from "@explita/protocol";
import { FormattedApp } from "../../../lib/formatters/app.js";
import { deleteS3Backup } from "./helpers/s3.js";
import { prisma } from "../../../lib/prisma.js";

interface BackupRequestParams extends RequestParams {
  backupId?: string;
}

export async function deleteBackup(
  request: FastifyRequest<{ Params: BackupRequestParams }>,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const backupId = request.params.backupId;

  if (!backupId) {
    return reply.code(400).send({
      success: false,
      error: "Backup ID or filename is required.",
    });
  }

  await deleteDatabaseBackupFile(app, backupId);
  return reply.code(200).send({
    success: true,
    message: `Backup "${backupId}" deleted successfully.`,
    data: { deleted: true, backup: backupId },
  });
}

export async function deleteDatabaseBackupFile(
  app: FormattedApp,
  backupId: string,
): Promise<boolean> {
  const filePath = resolveSafeBackupPath(app.id, backupId);
  let localDeleted = false;

  if (existsSync(filePath)) {
    unlinkSync(filePath);
    localDeleted = true;
    logger.info(`Deleted local backup file "${backupId}" for app "${app.id}"`);
  }

  let s3Deleted = false;
  try {
    if (app) {
      s3Deleted = await deleteS3Backup(app, backupId);
    }
  } catch {
    // S3 delete failure should not block local deletion
  }

  if (!localDeleted && !s3Deleted) {
    throw new Error(`Backup file not found on local disk or S3: "${backupId}"`);
  }

  // Delete record from DatabaseBackup table
  await prisma.databaseBackup
    .deleteMany({
      where: {
        appId: app.id,
        filename: backupId,
      },
    })
    .catch((dbErr) => {
      logger.warn(
        `Failed to delete DatabaseBackup record for "${backupId}":`,
        dbErr,
      );
    });

  return true;
}
