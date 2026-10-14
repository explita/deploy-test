import { FastifyReply, FastifyRequest } from "fastify";
import { cronScheduler } from "../../lib/cron-scheduler.js";

export async function getCrons(request: FastifyRequest, reply: FastifyReply) {
  const app = request.ctx.app;
  const crons = await cronScheduler.listAppCrons(app.id);

  return reply.send({
    success: true,
    data: crons,
  });
}

export async function getCronHistory(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const history = await cronScheduler.getHistory(app.id);

  return reply.send({
    success: true,
    data: history,
  });
}
