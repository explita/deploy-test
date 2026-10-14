import type { FastifyReply, FastifyRequest } from "fastify";
import type { RequestParams } from "../../types/misc.js";
import { cronScheduler } from "../../lib/cron-scheduler.js";

interface PauseCronBody {
  job?: string;
  name?: string;
  id?: string;
}

export async function pauseCron(
  request: FastifyRequest<{
    Params: RequestParams;
    Body: PauseCronBody;
  }>,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const selector =
    request.body?.job || request.body?.name || request.body?.id || "";

  if (!selector) {
    return reply.code(400).send({
      success: false,
      error:
        "Field 'job' (name or ID of the cron job) is required in request body.",
    });
  }

  const job = await cronScheduler.pauseJob(app.id, selector);
  return reply.send({
    success: true,
    data: job,
  });
}
