import { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { formatDeployment } from "../../lib/formatters/deployment.js";

export async function getDeployment(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const id = request.params?.id;
  const deployment = await prisma.deployment.findUnique({
    where: { id },
    include: {
      log: true,
    },
  });

  if (!deployment) {
    return reply
      .code(404)
      .send({ success: false, error: "Deployment not found" });
  }

  const meta = (deployment.metadata ?? {}) as Record<string, any>;
  const previewUrl = meta.previewUrl as string | undefined;
  const formatted = {
    ...formatDeployment(deployment),
    previewUrl,
  };

  return reply.code(200).send({ success: true, data: formatted });
}
