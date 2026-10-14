import { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { notifySchema } from "../../zod/app-schema.js";
import { notificationService } from "../../lib/notification-service.js";
import { JsonObject } from "../../generated/prisma/internal/prismaNamespace.js";

export async function getAppNotify(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const meta = app.metadata;
  return reply.send({
    success: true,
    data: meta.notify || null,
  });
}

export async function setAppNotify(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const input = notifySchema.parse(request.body);

  const meta = app.metadata;
  if (input === null || !input) {
    delete meta.notify;
  } else {
    meta.notify = {
      ...(meta.notify || {}),
      ...input,
    };
  }

  await prisma.app.update({
    where: { id: app.id },
    data: {
      metadata: meta,
    },
  });

  return reply.send({
    success: true,
    data: meta.notify || null,
  });
}

export async function removeAppNotify(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const meta = app.metadata;
  delete meta.notify;

  await prisma.app.update({
    where: { id: app.id },
    data: {
      metadata: meta,
    },
  });

  return reply.send({
    success: true,
    data: null,
  });
}

export async function testAppNotify(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const meta = app.metadata;
  let config = meta.notify;

  if (request.body && typeof request.body === "object") {
    const parsed = notifySchema.parse(request.body);
    if (parsed) {
      config = parsed;
    }
  }

  if (!config || (!config.discord && !config.slack && !config.telegram)) {
    return reply.code(400).send({
      success: false,
      error: "No notification destinations configured for this application.",
    });
  }

  const result = await notificationService.sendTest(config, app);

  return reply.send({
    success: true,
    data: result,
  });
}
