import type { FastifyReply, FastifyRequest } from "fastify";
import type { RequestParams } from "../../types/misc.js";

export async function listAppDomains(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const app = request.ctx.app;

  return reply.code(200).send({ success: true, data: app.domains });
}
