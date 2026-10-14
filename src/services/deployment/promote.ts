import { FastifyRequest, FastifyReply } from "fastify";
import { deployer } from "../../lib/deployer.js";
import { formatDeployment } from "../../lib/formatters/deployment.js";

export async function promoteDeployment(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const deploymentId = request.params?.id ?? request.params?.deploymentId;

  if (!deploymentId) {
    return reply.code(400).send({
      success: false,
      error: "Deployment ID is required",
    });
  }

  const deployment = await deployer.promoteDeployment(deploymentId);

  return reply.code(200).send({
    success: true,
    data: formatDeployment(deployment),
  });
}
