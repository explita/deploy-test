import { FastifyReply, FastifyRequest } from "fastify";
import { findAppByIdOrName } from "../lib/app-helpers.js";
import { stripIdPrefix } from "../lib/id.js";

export async function validateRequestId(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const identifier = request.params?.id ?? request.params?.appId;

  if (!identifier) {
    return reply.code(400).send({
      success: false,
      error: "App ID or name is required",
    });
  }

  const app = await findAppByIdOrName(identifier);

  if (!app) {
    return reply
      .code(404)
      .send({ success: false, error: "Application not found" });
  }

  request.ctx = {
    app: {
      ...app,
      id: stripIdPrefix(app.id),
      currentDeploymentId: app.currentDeploymentId
        ? stripIdPrefix(app.currentDeploymentId)
        : null,
      currentDeployment: app.currentDeployment
        ? {
            ...app.currentDeployment,
            id: stripIdPrefix(app.currentDeployment.id),
          }
        : null,
    },
  };
}
