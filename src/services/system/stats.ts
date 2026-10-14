import { FastifyReply, FastifyRequest } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { run } from "../../lib/runner.js";
import {
  fetchDockerStats,
  streamDockerStatsWs,
} from "../../lib/docker-stats.js";

async function getRunningExplitaContainers(): Promise<string[]> {
  const psRes = await run("docker", [
    "ps",
    "--filter",
    "name=explita-",
    "--format",
    "{{.Names}}",
  ]).catch(() => ({ code: 1, stdout: "", stderr: "" }));

  if (psRes.code !== 0 || !psRes.stdout.trim()) {
    return [];
  }

  return psRes.stdout
    .trim()
    .split("\n")
    .map((n) => n.trim())
    .filter(Boolean);
}

export async function getSystemStatsHttp(
  _request: FastifyRequest,
  reply: FastifyReply,
) {
  const running = await getRunningExplitaContainers();

  if (running.length === 0) {
    return reply.send({
      success: true,
      data: {
        stats: [],
      },
    });
  }

  try {
    const stats = await fetchDockerStats(running);
    return reply.send({
      success: true,
      data: {
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

export async function streamSystemStatsWs(
  socket: WebSocket,
  _request: FastifyRequest,
) {
  const running = await getRunningExplitaContainers();

  if (running.length === 0) {
    socket.send(
      JSON.stringify({
        type: "error",
        error: "No running Explita containers found.",
      }),
    );
    socket.close(1000, "No running containers");
    return;
  }

  return streamDockerStatsWs(socket, running, {
    logLabel: "system containers",
  });
}
