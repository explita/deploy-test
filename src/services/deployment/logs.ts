import { FastifyRequest, FastifyReply } from "fastify";
import { getDeploymentLogsById } from "../../lib/log-helpers.js";

export async function getDeploymentLogs(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const id = request.params?.id;
  if (!id) {
    return reply
      .code(400)
      .send({ success: false, error: "Deployment not found" });
  }

  const logs = await getDeploymentLogsById(id);

  if (!logs) {
    return reply
      .code(404)
      .send({ success: false, error: "Deployment not found" });
  }

  return reply.code(200).send({
    success: true,
    data: { logs },
  });
}
