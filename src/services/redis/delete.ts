import { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { execRedisCli } from "../../lib/redis.js";
import { logger } from "@explita/infra-protocol";

export async function deleteRedis(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const app = request.ctx.app;

  const redisRecord = app.redis;

  if (!redisRecord) {
    return reply.code(404).send({
      success: false,
      error: `No Redis database configured for application "${app.name}".`,
    });
  }

  try {
    await execRedisCli(["-n", String(redisRecord.dbIndex), "FLUSHDB"]);
  } catch (err) {
    logger.warn(
      `Failed to flush Redis database index ${redisRecord.dbIndex}:`,
      err,
    );
  }

  await prisma.appRedis.delete({
    where: { id: redisRecord.id },
  });

  return reply.code(200).send({
    success: true,
    message: `Redis database (index ${redisRecord.dbIndex}) removed successfully for app "${app.name}"`,
    data: {
      deleted: true,
      dbIndex: redisRecord.dbIndex,
    },
  });
}
