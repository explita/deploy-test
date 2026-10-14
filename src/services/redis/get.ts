import { FastifyReply, FastifyRequest } from "fastify";

export async function getRedis(request: FastifyRequest, reply: FastifyReply) {
  const app = request.ctx.app;

  const redisRecord = app.redis;

  if (!redisRecord) {
    return reply.code(404).send({
      success: false,
      error: `No Redis database configured for application "${app.name}". Use "eda redis create -a ${app.id}" to provision one.`,
    });
  }

  return reply.code(200).send({
    success: true,
    data: {
      id: redisRecord.id,
      appId: app.id,
      dbIndex: redisRecord.dbIndex,
      url: redisRecord.url,
      createdAt: redisRecord.createdAt.toISOString(),
    },
  });
}
