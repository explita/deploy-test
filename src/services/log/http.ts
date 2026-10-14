import { FastifyRequest, FastifyReply } from "fastify";
import { run } from "../../lib/runner.js";
import { RuntimeLogsQuery } from "@explita/protocol/deploy";

export async function getRuntimeLogsHttp(
  request: FastifyRequest<{
    Querystring: RuntimeLogsQuery;
  }>,
  reply: FastifyReply,
) {
  const app = request.ctx.app;

  const deployment = app.currentDeployment;

  if (!deployment?.containerName) {
    return reply.code(400).send({
      success: false,
      error: `Application "${app.name}" is not currently running. Deploy the app first.`,
    });
  }

  const tailNum = request.query.tail ? parseInt(request.query.tail, 10) : 50;
  const safeTail =
    Number.isInteger(tailNum) && tailNum > 0 ? String(tailNum) : "50";

  const result = await run("docker", [
    "logs",
    "--tail",
    safeTail,
    deployment.containerName,
  ]);

  if (result.code !== 0) {
    return reply.code(500).send({
      success: false,
      error: result.stderr || `docker logs exited with code ${result.code}`,
    });
  }

  const combined =
    result.stdout +
    (result.stderr ? (result.stdout ? "\n" : "") + result.stderr : "");
  const lines = combined.split(/\r?\n/).filter(Boolean);

  return reply.code(200).send({
    success: true,
    data: {
      appId: app.id,
      containerName: deployment.containerName,
      tail: safeTail,
      logs: lines,
    },
  });
}
