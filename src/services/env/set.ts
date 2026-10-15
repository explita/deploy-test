import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { encryptEnvMap } from "@explita/protocol";
import { setEnvSchema } from "../../zod/env-schema.js";
import { findAppByIdOrName } from "../../lib/app-helpers.js";
import { deployer } from "../../lib/deployer.js";

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

  const query = request.query as Record<string, string> | undefined;
  const shouldApply = query?.apply === "true" || parsed.data.apply === true;
  const shouldStream =
    query?.stream === "true" ||
    request.headers.accept?.includes("application/x-ndjson");

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

  if (shouldApply && shouldStream) {
    reply.raw.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const sendEvent = (data: Record<string, any>) => {
      reply.raw.write(JSON.stringify(data) + "\n");
    };

    sendEvent({
      type: "saved",
      count: Object.keys(incoming).length,
      totalCount: allEnvs.length,
      keys: allEnvs.map((e) => e.key),
    });

    const refreshedApp = await findAppByIdOrName(app.id, true);
    if (refreshedApp?.currentDeployment?.image) {
      try {
        const reloadResult = await deployer.recreateAppContainer(
          refreshedApp,
          async (line) => {
            sendEvent({ type: "log", line });
          },
        );

        sendEvent({
          type: "done",
          applied: true,
          containerName: reloadResult.containerName,
          totalCount: allEnvs.length,
          keys: allEnvs.map((e) => e.key),
        });
      } catch (err: any) {
        sendEvent({
          type: "error",
          error: `Saved environment variables, but failed to reload container: ${err.message}`,
        });
      }
    } else {
      sendEvent({
        type: "done",
        applied: false,
        totalCount: allEnvs.length,
        keys: allEnvs.map((e) => e.key),
      });
    }

    reply.raw.end();
    return;
  }

  let reloadResult:
    | { containerName: string; detectedPort?: number }
    | undefined;
  let applied = false;

  if (shouldApply) {
    const refreshedApp = await findAppByIdOrName(app.id, true);
    if (refreshedApp?.currentDeployment?.image) {
      try {
        reloadResult = await deployer.recreateAppContainer(refreshedApp);
        applied = true;
      } catch (err: any) {
        return reply.code(500).send({
          success: false,
          error: `Saved environment variables, but failed to reload container: ${err.message}`,
        });
      }
    }
  }

  return reply.code(200).send({
    success: true,
    message: applied
      ? `Updated ${Object.keys(incoming).length} environment variable(s) and reloaded container`
      : `Updated ${Object.keys(incoming).length} environment variable(s)`,
    data: {
      totalCount: allEnvs.length,
      keys: allEnvs.map((e) => e.key),
      ...(shouldApply
        ? { applied, containerName: reloadResult?.containerName }
        : {}),
    },
  });
}
