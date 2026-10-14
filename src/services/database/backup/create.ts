import { FastifyReply, FastifyRequest } from "fastify";
import { RequestParams } from "../../../types/misc.js";
import { executeDatabaseBackup } from "./helpers/exec.js";

export async function createBackup(
  request: FastifyRequest<{
    Params: RequestParams;
    Querystring: { key?: string; s3?: string };
    Body?: { key?: string; s3?: boolean };
  }>,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const key = request.query.key || request.body?.key;
  const s3 = request.query.s3 === "true" || request.body?.s3 === true;

  const backup = await executeDatabaseBackup(app.id, key, { s3 });

  return reply.code(200).send({
    success: true,
    message: `Database backup "${backup.filename}" created successfully.`,
    data: backup,
  });
}
