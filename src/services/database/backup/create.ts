import { FastifyReply, FastifyRequest } from "fastify";
import { RequestParams } from "../../../types/misc.js";
import { executeDatabaseBackup } from "./helpers/exec.js";

export async function createBackup(
  request: FastifyRequest<{
    Params: RequestParams;
    Querystring: { key?: string; s3?: string; force?: string };
    Body?: { key?: string; s3?: boolean; force?: boolean };
  }>,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const key = request.query.key || request.body?.key;
  const s3 = request.query.s3 === "true" || request.body?.s3 === true;
  const force = request.query.force === "true" || request.body?.force === true;

  const backup = await executeDatabaseBackup(app.id, key, { s3, force });

  return reply.code(200).send({
    success: true,
    message: backup.skipped
      ? (backup.message || `Database content unchanged since last backup. Skipped saving duplicate backup.`)
      : `Database backup "${backup.filename}" created successfully.`,
    data: backup,
  });
}
