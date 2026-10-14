import type { FastifyReply, FastifyRequest } from "fastify";

interface GetEnvQuery {
  show?: string;
}

export async function getEnv(
  request: FastifyRequest<{ Querystring: GetEnvQuery }>,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const showValues = request.query.show === "true";

  const processedEnv: Record<string, string> = {};
  for (const e of app.envs) {
    processedEnv[e.key] = showValues ? e.value : "••••••••";
  }

  return reply.code(200).send({
    success: true,
    data: {
      appId: app.id,
      env: processedEnv,
      count: app.envs.length,
    },
  });
}
