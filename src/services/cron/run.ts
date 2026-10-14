import type { FastifyReply, FastifyRequest } from "fastify";
import type { RequestParams } from "../../types/misc.js";
import { cronScheduler } from "../../lib/cron-scheduler.js";

interface RunCronBody {
  job?: string;
  name?: string;
  id?: string;
}

export async function runCron(
  request: FastifyRequest<{
    Params: RequestParams;
    Body: RunCronBody;
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

  try {
    const execution = await cronScheduler.runCron(app.id, selector, true);
    return reply.send({
      success: true,
      data: execution,
    });
  } catch (err: any) {
    return reply.code(400).send({
      success: false,
      error: err.message || String(err),
    });
  }
}
