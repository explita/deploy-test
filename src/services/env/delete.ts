import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { deleteEnvSchema } from "../../zod/env-schema.js";
import type { RequestParams } from "../../types/misc.js";

interface DeleteEnvQuery {
  key?: string;
}

export async function deleteEnv(
  request: FastifyRequest<{
    Params: RequestParams;
    Querystring: DeleteEnvQuery;
  }>,
  reply: FastifyReply,
) {
  const app = request.ctx.app;

  let keysToDelete: string[] = [];

  if (request.query.key) {
    keysToDelete = [request.query.key];
  } else if (request.body) {
    const parsed = deleteEnvSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        success: false,
        error: parsed.error.issues[0]?.message || "Invalid keys to delete",
      });
    }
    keysToDelete = parsed.data.keys;
  }

  if (keysToDelete.length === 0) {
    return reply.code(400).send({
      success: false,
      error: "No environment variable keys specified to delete",
    });
  }

  const deleteResult = await prisma.appEnv.deleteMany({
    where: {
      appId: app.id,
      key: { in: keysToDelete },
    },
  });

  const remaining = await prisma.appEnv.findMany({
    where: { appId: app.id },
    select: { key: true },
  });

  return reply.code(200).send({
    success: true,
    message: `Removed ${deleteResult.count} environment variable(s)`,
    data: {
      removedCount: deleteResult.count,
      totalCount: remaining.length,
      keys: remaining.map((e) => e.key),
    },
  });
}
