import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { deleteEnvSchema } from "../../zod/env-schema.js";
import type { RequestParams } from "../../types/misc.js";
import { findAppByIdOrName } from "../../lib/app-helpers.js";
import { deployer } from "../../lib/deployer.js";

interface DeleteEnvQuery {
  key?: string;
  apply?: string;
  stream?: string;
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
  let bodyApply = false;

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
    bodyApply = Boolean(parsed.data.apply);
  }

  if (keysToDelete.length === 0) {
    return reply.code(400).send({
      success: false,
      error: "No environment variable keys specified to delete",
    });
  }

  const shouldApply = request.query.apply === "true" || bodyApply;
  const shouldStream =
    request.query.stream === "true" ||
    request.headers.accept?.includes("application/x-ndjson");

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
      type: "deleted",
      removedCount: deleteResult.count,
      totalCount: remaining.length,
      keys: remaining.map((e) => e.key),
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
          totalCount: remaining.length,
          keys: remaining.map((e) => e.key),
        });
      } catch (err: any) {
        sendEvent({
          type: "error",
          error: `Removed environment variables, but failed to reload container: ${err.message}`,
        });
      }
    } else {
      sendEvent({
        type: "done",
        applied: false,
        totalCount: remaining.length,
        keys: remaining.map((e) => e.key),
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
          error: `Removed environment variables, but failed to reload container: ${err.message}`,
        });
      }
    }
  }

  return reply.code(200).send({
    success: true,
    message: applied
      ? `Removed ${deleteResult.count} environment variable(s) and reloaded container`
      : `Removed ${deleteResult.count} environment variable(s)`,
    data: {
      removedCount: deleteResult.count,
      totalCount: remaining.length,
      keys: remaining.map((e) => e.key),
      ...(shouldApply
        ? { applied, containerName: reloadResult?.containerName }
        : {}),
    },
  });
}
