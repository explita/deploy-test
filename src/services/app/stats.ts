import { FastifyReply, FastifyRequest } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { run } from "../../lib/runner.js";
import { FormattedApp } from "../../lib/formatters/app.js";
import {
  fetchDockerStats,
  streamDockerStatsWs,
} from "../../lib/docker-stats.js";
import { getAppTunnelContainerName } from "@explita/infra-protocol/deploy";

async function getRunningAppContainers(app: FormattedApp): Promise<string[]> {
  const candidates: string[] = [];
  if (app.currentDeployment?.containerName) {
    candidates.push(app.currentDeployment.containerName);
  }
  const tunnelName = getAppTunnelContainerName(app.id);
  candidates.push(tunnelName);

  const running: string[] = [];
  for (const name of candidates) {
    const check = await run("docker", [
      "inspect",
      "--format",
      "{{.State.Running}}",
      name,
    ]).catch(() => ({ code: 1, stdout: "", stderr: "" }));

    if (check.code === 0 && check.stdout.trim() === "true") {
      running.push(name);
    }
  }

  return running;
}

export async function getAppStatsHttp(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const running = await getRunningAppContainers(app);

  if (running.length === 0) {
    return reply.code(400).send({
      success: false,
      error: `Application "${app.name}" is not currently running. Deploy or start the app first.`,
    });
  }

  try {
    const stats = await fetchDockerStats(
      running,
      app.currentDeployment?.containerName || undefined,
    );

    return reply.send({
      success: true,
      data: {
        app: {
          id: app.id,
          name: app.name,
          status: app.currentDeployment?.status || "STOPPED",
        },
        stats,
      },
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return reply.code(500).send({
      success: false,
      error: errorMsg,
    });
  }
}

export async function streamAppStatsWs(
  socket: WebSocket,
  request: FastifyRequest,
) {
  const app = request.ctx.app;
  const running = await getRunningAppContainers(app);

  if (running.length === 0) {
    socket.send(
      JSON.stringify({
        type: "error",
        error: `Application "${app.name}" is not currently running.`,
      }),
    );
    socket.close(1008, "App not running");
    return;
  }

  return streamDockerStatsWs(socket, running, {
    appContainerName: app.currentDeployment?.containerName || undefined,
    logLabel: `app ${app.name}`,
  });
}
