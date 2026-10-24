import { FastifyReply, FastifyRequest } from "fastify";
import { RequestParams } from "../../types/misc.js";
import { prisma } from "../../lib/prisma.js";
import {
  DumpScheduleConfig,
  isValidCron,
} from "@explita/infra-protocol/deploy";
import { logger } from "@explita/infra-protocol";

export const DEFAULT_DUMP_SCHEDULE: DumpScheduleConfig = {
  schedule: "0 3 * * 0", // Weekly on Sunday at 03:00 UTC
  keep: 4,
  enabled: false,
  s3: false,
};

export async function getAppDumpSchedule(
  request: FastifyRequest<{ Params: RequestParams }>,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const schedule: DumpScheduleConfig = {
    ...DEFAULT_DUMP_SCHEDULE,
    ...(app.metadata?.dumpSchedule || {}),
  };

  return reply.code(200).send({
    success: true,
    data: schedule,
  });
}

export async function setAppDumpSchedule(
  request: FastifyRequest<{
    Params: RequestParams;
    Body: {
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
  const meta = app.metadata || {};
  const current: DumpScheduleConfig = {
    ...DEFAULT_DUMP_SCHEDULE,
    ...(meta.dumpSchedule || {}),
  };

  const nextScheduleStr =
    body.schedule !== undefined ? body.schedule.trim() : current.schedule;

  if (nextScheduleStr && !isValidCron(nextScheduleStr)) {
    return reply.code(400).send({
      success: false,
      error: `Invalid cron expression "${nextScheduleStr}". Must be standard 5-part cron syntax (e.g. "0 3 * * 0").`,
    });
  }

  const nextKeep =
    body.keep !== undefined
      ? Math.max(1, Number(body.keep) || 1)
      : current.keep;

  const nextEnabled =
    body.enabled !== undefined ? Boolean(body.enabled) : current.enabled;

  const nextS3 = body.s3 !== undefined ? Boolean(body.s3) : current.s3;

  const updated: DumpScheduleConfig = {
    ...current,
    schedule: nextScheduleStr,
    keep: nextKeep,
    enabled: nextEnabled,
    s3: nextS3,
  };

  await prisma.app.update({
    where: { id: app.id },
    data: {
      metadata: {
        ...meta,
        dumpSchedule: updated,
      } as any,
    },
  });

  logger.info(
    `Updated dump schedule for app "${app.name}": schedule="${updated.schedule}", keep=${updated.keep}, enabled=${updated.enabled}, s3=${updated.s3}`,
  );

  return reply.code(200).send({
    success: true,
    message: `Automated dump schedule for application "${app.name}" updated successfully.`,
    data: updated,
  });
}
