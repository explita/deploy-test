import { FastifyReply, FastifyRequest } from "fastify";

export async function getAppById(request: FastifyRequest, reply: FastifyReply) {
  const { databasesMap, databases, cronsMap, envsMap, envs, redis, ...app } =
    request.ctx.app;

  return reply.code(200).send({ success: true, data: app });
}
