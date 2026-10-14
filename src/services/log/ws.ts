import { FastifyRequest } from "fastify";
import { logger } from "@explita/protocol";
import type { WebSocket } from "@fastify/websocket";
import { stream } from "../../lib/runner.js";
import { RuntimeLogsQuery } from "@explita/protocol/deploy";

export async function streamRuntimeLogsWs(
  socket: WebSocket,
  request: FastifyRequest<{
    Querystring: RuntimeLogsQuery;
  }>,
) {
  const app = request.ctx.app;

  const deployment = app.currentDeployment;

  if (!deployment?.containerName) {
    socket.send(
      `\n[explita] Error: Application "${app.name}" is not currently running. Deploy the app first.\n`,
    );
    socket.close();
    return;
  }

  const tailNum = request.query.tail ? parseInt(request.query.tail, 10) : 100;
  const safeTail =
    Number.isInteger(tailNum) && tailNum >= 0 ? String(tailNum) : "100";
  const follow = request.query.follow !== "false";

  const args = ["logs", "--tail", safeTail];
  if (follow) {
    args.push("-f");
  }
  args.push(deployment.containerName);

  logger.info(
    `[runtime-logs] Streaming logs for ${app.name} (${deployment.containerName})`,
  );

  const abortController = new AbortController();

  const cleanup = () => {
    try {
      abortController.abort();
    } catch {}
  };

  socket.on("close", cleanup);
  socket.on("error", cleanup);

  const streaming = stream("docker", args, {
    signal: abortController.signal,
    onChunk: (chunk) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(chunk);
      }
    },
  });

  streaming
    .catch((err: unknown) => {
      if (!abortController.signal.aborted) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error(`[runtime-logs] stream error: ${errorMsg}`);
        if (socket.readyState === socket.OPEN) {
          socket.send(`\n[explita] Process error: ${errorMsg}\n`);
        }
      }
    })
    .finally(() => {
      if (socket.readyState === socket.OPEN) {
        socket.close();
      }
    });
}
