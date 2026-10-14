import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { encryptEnvMap } from "@explita/protocol";
import { setEnvSchema } from "../../zod/env-schema.js";

export async function setEnv(request: FastifyRequest, reply: FastifyReply) {
  const app = request.ctx.app;

  const parsed = setEnvSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({
      success: false,
      error:
        parsed.error.issues[0]?.message ||
        "Invalid environment variables format",
    });
  }

  const incoming = parsed.data.env;
  if (Object.keys(incoming).length === 0) {
    return reply.code(400).send({
      success: false,
      error: "No environment variables provided",
    });
  }

  const encryptedNew = encryptEnvMap(incoming);

  await prisma.$transaction(
    Object.entries(encryptedNew).map(([key, value]) =>
      prisma.appEnv.upsert({
        where: {
          appId_key: { appId: app.id, key },
        },
        create: {
          appId: app.id,
          key,
          value,
        },
        update: {
          value,
        },
      }),
    ),
  );

  const allEnvs = await prisma.appEnv.findMany({
    where: { appId: app.id },
    select: { key: true },
  });

  return reply.code(200).send({
    success: true,
    message: `Updated ${Object.keys(incoming).length} environment variable(s)`,
    data: {
      totalCount: allEnvs.length,
      keys: allEnvs.map((e) => e.key),
    },
  });
}
