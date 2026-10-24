import { FastifyReply, FastifyRequest } from "fastify";
import { RequestParams } from "../../../types/misc.js";
import { prisma } from "../../../lib/prisma.js";
import { findAppByIdOrName } from "../../../lib/app-helpers.js";
import {
  DatabaseBackupSchedule,
  isValidCron,
} from "@explita/infra-protocol/deploy";
import { logger } from "@explita/infra-protocol";
import { FormattedApp } from "../../../lib/formatters/app.js";

export const DEFAULT_BACKUP_SCHEDULE: DatabaseBackupSchedule = {
  schedule: "0 2 * * *", // Daily at 02:00 UTC
  keep: 7,
  enabled: false,
};

export function getScheduleForDb(
  databaseBackup: any,
  key: string = "default",
): DatabaseBackupSchedule {
  if (!databaseBackup) return DEFAULT_BACKUP_SCHEDULE;

  if (databaseBackup[key] && typeof databaseBackup[key] === "object") {
    return { ...DEFAULT_BACKUP_SCHEDULE, ...databaseBackup[key] };
  }

  // Single schedule object fallback
  if (key === "default" && databaseBackup.schedule) {
    return { ...DEFAULT_BACKUP_SCHEDULE, ...databaseBackup };
  }
  return { ...DEFAULT_BACKUP_SCHEDULE };
}

export function getAllSchedules(
  databaseBackup: any,
  databases: Array<{ key: string }> = [],
): Record<string, DatabaseBackupSchedule> {
  const result: Record<string, DatabaseBackupSchedule> = {};
  for (const db of databases) {
    result[db.key] = getScheduleForDb(databaseBackup, db.key);
  }
  return result;
}

export async function getBackupSchedule(
  request: FastifyRequest<{
    Params: RequestParams;
    Querystring: { key?: string; all?: string };
  }>,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const requestedKey = request.query.key?.trim().toLowerCase();
  const showAll = request.query.all === "true" || requestedKey === "all";

  const allSchedules = getAllSchedules(
    app.metadata?.databaseBackup,
    app.databases || [],
  );

  if (showAll) {
    return reply.code(200).send({
      success: true,
      data: {
        schedules: allSchedules,
        databases: (app.databases || []).map((d) => d.key),
      },
    });
  }

  const effectiveKey = requestedKey || "default";
  const targetDb = app.databases?.find((d) => d.key === effectiveKey);

  if (!targetDb) {
    return reply.code(404).send({
      success: false,
      error: `Application "${app.name}" does not have a managed database configured for key "${effectiveKey}".`,
    });
  }

  const schedule = getScheduleForDb(app.metadata?.databaseBackup, targetDb.key);
  return reply.code(200).send({
    success: true,
    data: {
      ...schedule,
      key: targetDb.key,
      dbName: targetDb.name,
      all: allSchedules,
    },
  });
}

export async function setBackupSchedule(
  request: FastifyRequest<{
    Params: RequestParams;
    Querystring: { key?: string };
    Body: {
      key?: string;
      schedule?: string;
      keep?: number;
      enabled?: boolean;
      s3?: boolean;
    };
  }>,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const body = request.body;
  const key = body.key || request.query.key;

  const updated = await saveAppBackupSchedule(app, { ...body, key });
  return reply.code(200).send({
    success: true,
    message: `Backup schedule for database key "${updated.key}" updated successfully.`,
    data: updated,
  });
}

export async function getAppBackupSchedule(
  appId: string,
  key?: string,
): Promise<DatabaseBackupSchedule & { key: string; dbName: string }> {
  const app = await findAppByIdOrName(appId);
  if (!app) {
    throw new Error(`Application "${appId}" not found.`);
  }

  const effectiveKey = key?.trim().toLowerCase() || "default";
  const db = app.databases?.find((d) => d.key === effectiveKey);

  if (!db?.name) {
    throw new Error(
      `Application "${app.name}" does not have a managed database configured for key "${effectiveKey}".`,
    );
  }

  const schedule = getScheduleForDb(app.metadata?.databaseBackup, db.key);
  return {
    ...schedule,
    key: db.key,
    dbName: db.name,
  };
}

export async function saveAppBackupSchedule(
  app: FormattedApp,
  update: {
    key?: string;
    schedule?: string;
    keep?: number;
    enabled?: boolean;
    s3?: boolean;
  },
) {
  const effectiveKey = update.key?.trim().toLowerCase() || "default";
  const db = app.databases?.find((d) => d.key === effectiveKey);

  if (!db?.name) {
    throw new Error(
      `Application "${app.name}" does not have a managed database configured for key "${effectiveKey}".`,
    );
  }

  const meta = app.metadata;
  const allSchedules = getAllSchedules(
    meta.databaseBackup,
    app.databases || [],
  );
  const current = allSchedules[db.key] || { ...DEFAULT_BACKUP_SCHEDULE };

  const nextScheduleStr =
    update.schedule !== undefined ? update.schedule.trim() : current.schedule;

  if (nextScheduleStr && !isValidCron(nextScheduleStr)) {
    throw new Error(
      `Invalid cron expression "${nextScheduleStr}". Must be standard 5-part cron syntax (e.g. "0 2 * * *").`,
    );
  }

  const nextKeep =
    update.keep !== undefined
      ? Math.max(1, Number(update.keep) || 1)
      : current.keep;

  const nextEnabled =
    update.enabled !== undefined ? Boolean(update.enabled) : current.enabled;

  const nextS3 = update.s3 !== undefined ? Boolean(update.s3) : current.s3;

  const updatedSchedule: DatabaseBackupSchedule = {
    ...current,
    schedule: nextScheduleStr,
    keep: nextKeep,
    enabled: nextEnabled,
    s3: nextS3,
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
    `Updated backup schedule for app "${app.name}" (key: "${db.key}", db: "${db.name}"): schedule="${updatedSchedule.schedule}", keep=${updatedSchedule.keep}, enabled=${updatedSchedule.enabled}`,
  );

  return {
    ...updatedSchedule,
    key: db.key,
    dbName: db.name,
  };
}
