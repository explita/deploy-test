import type { FastifyReply, FastifyRequest } from "fastify";
import { deployer } from "../../lib/deployer.js";

export async function applyEnv(request: FastifyRequest, reply: FastifyReply) {
  const app = request.ctx.app;

  if (!app.currentDeployment || !app.currentDeployment.image) {
    return reply.code(400).send({
      success: false,
      error:
        "Application has no active deployment to reload. Deploy the application first with eda.",
    });
  }

  const query = request.query as Record<string, string> | undefined;
  const shouldStream =
    query?.stream === "true" ||
    request.headers.accept?.includes("application/x-ndjson");

  if (shouldStream) {
    reply.raw.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const sendEvent = (data: Record<string, any>) => {
      reply.raw.write(JSON.stringify(data) + "\n");
    };

    try {
      const reloadResult = await deployer.recreateAppContainer(
        app,
        async (line) => {
          sendEvent({ type: "log", line });
        },
      );

      sendEvent({
        type: "done",
        applied: true,
        containerName: reloadResult.containerName,
        detectedPort: reloadResult.detectedPort,
      });
    } catch (err: any) {
      sendEvent({
        type: "error",
        error: `Failed to reload container: ${err.message}`,
      });
    }

    reply.raw.end();
    return;
  }

  try {
    const reloadResult = await deployer.recreateAppContainer(app);

    return reply.code(200).send({
      success: true,
      message: `Environment variables successfully applied to ${app.name}`,
      data: {
        applied: true,
        containerName: reloadResult.containerName,
        detectedPort: reloadResult.detectedPort,
      },
    });
  } catch (err: any) {
    return reply.code(500).send({
      success: false,
      error: `Failed to reload container: ${err.message}`,
    });
  }
}
