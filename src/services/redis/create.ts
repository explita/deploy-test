import { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { ensureRedis, getAppRedisUrl } from "../../lib/redis.js";
import { resolveRedisConfig } from "../../lib/utils.js";
import { encryptValue, PRODUCT_NAME } from "@explita/infra-protocol";

export async function createRedis(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const config = resolveRedisConfig();

  if (!config.enabled) {
    return reply.code(400).send({
      success: false,
      error: `Managed Redis is disabled. Set REDIS_ENABLED=true in your ${PRODUCT_NAME.deploy} server .env to enable.`,
    });
  }

  const existingRedis = app.redis;

  if (existingRedis) {
    return reply.code(409).send({
      success: false,
      error: `Application already has a Redis database configured (DB index ${existingRedis.dbIndex}). Use "eda redis url -a ${app.id}" to view its connection string or "eda redis rm -a ${app.id}" to remove it.`,
    });
  }

  // Ensure Redis container is running
  await ensureRedis();

  // Find lowest available index starting at 1
  const lastIndex = await prisma.appRedis.findMany({
    select: { dbIndex: true },
    orderBy: { dbIndex: "desc" },
    take: 1,
  });

  const dbIndex = (lastIndex[0]?.dbIndex ?? 0) + 1;

  if (dbIndex >= config.maxDatabases) {
    return reply.code(400).send({
      success: false,
      error: `Maximum number of Redis databases reached (${config.maxDatabases}). Increase REDIS_MAX_DATABASES in your server .env.`,
    });
  }

  const redisUrl = getAppRedisUrl(dbIndex);

  const createdRedis = await prisma.appRedis.create({
    data: {
      appId: app.id,
      dbIndex,
      url: encryptValue(redisUrl),
    },
  });

  return reply.code(201).send({
    success: true,
    message: `Redis database (index ${dbIndex}) created for app "${app.name}"`,
    data: {
      id: createdRedis.id,
      appId: app.id,
      dbIndex,
      url: redisUrl,
      createdAt: createdRedis.createdAt.toISOString(),
    },
  });
}
