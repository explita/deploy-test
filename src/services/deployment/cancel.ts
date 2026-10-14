import { FastifyRequest, FastifyReply } from "fastify";
import { deployer } from "../../lib/deployer.js";
import { formatDeploymentId } from "../../lib/id.js";

export async function cancelDeployment(
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

  try {
    await deployer.cancelDeployment(deploymentId);
    return reply.code(200).send({
      success: true,
      data: {
        id: formatDeploymentId(deploymentId),
        status: "CANCELLED",
        message: `Deployment ${formatDeploymentId(deploymentId)} cancelled cleanly.`,
      },
    });
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = message.includes("not found") ? 404 : 400;
    return reply.code(statusCode).send({
      success: false,
      error: message,
    });
  }
}
