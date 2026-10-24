import type { WebSocket } from "@fastify/websocket";
import { run, stream } from "./runner.js";
import { ContainerStat } from "@explita/infra-protocol/deploy";
import { logger } from "@explita/infra-protocol";

/**
 * Parses a single JSON line from `docker stats --format json`.
 * Strips ANSI escape sequences which Docker emits when streaming.
 */
export function parseContainerStat(
  raw: string,
  appContainerName?: string,
): ContainerStat | null {
  try {
    // Strip ANSI escape sequences and extract JSON boundaries
    const cleaned = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim();
    const startIdx = cleaned.indexOf("{");
    const endIdx = cleaned.lastIndexOf("}");
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
      return null;
    }

    const jsonStr = cleaned.slice(startIdx, endIdx + 1);
    const item = JSON.parse(jsonStr);
    const name = item.Name || item.Container || "";

    let role: "app" | "tunnel" | "service" = "service";
    if (
      (appContainerName && name === appContainerName) ||
      name.startsWith("explita-app-")
    ) {
      role = "app";
    } else if (name.startsWith("explita-tunnel-")) {
      role = "tunnel";
    }

    return {
      container: item.Container || "",
      id: item.ID || "",
      name,
      cpuPerc: item.CPUPerc || "0.00%",
      memUsage: item.MemUsage || "0B / 0B",
      memPerc: item.MemPerc || "0.00%",
      netIO: item.NetIO || "0B / 0B",
      blockIO: item.BlockIO || "0B / 0B",
      pids: item.PIDs || "0",
      role,
    };
  } catch {
    return null;
  }
}

/**
 * Fetches a one-shot snapshot of resource metrics for the given container names.
 */
export async function fetchDockerStats(
  containerNames: string[],
  appContainerName?: string,
): Promise<ContainerStat[]> {
  if (containerNames.length === 0) {
    return [];
  }

  const res = await run("docker", [
    "stats",
    "--no-stream",
    "--format",
    "json",
    ...containerNames,
  ]);

  if (res.code !== 0) {
    throw new Error(
      `Failed to fetch container stats: ${res.stderr || res.stdout}`,
    );
  }

  const stats: ContainerStat[] = [];
  const lines = res.stdout.trim().split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    const parsed = parseContainerStat(line.trim(), appContainerName);
    if (parsed) stats.push(parsed);
  }

  return stats;
}

/**
 * Streams real-time container metrics over a WebSocket.
 */
export async function streamDockerStatsWs(
  socket: WebSocket,
  containerNames: string[],
  options?: {
    appContainerName?: string;
    logLabel?: string;
  },
) {
  const abortController = new AbortController();
  const cleanup = () => {
    try {
      abortController.abort();
    } catch {}
  };

  socket.on("close", cleanup);
  socket.on("error", cleanup);

  const label = options?.logLabel || "containers";
  logger.info(
    `[stats] Streaming metrics for ${label} (${containerNames.join(", ")})`,
  );

  let buffer = "";

  const streamPromise = stream(
    "docker",
    ["stats", "--format", "json", ...containerNames],
    {
      signal: abortController.signal,
      onChunk: (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        // Keep remainder in buffer
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim() || socket.readyState !== socket.OPEN) continue;
          const parsed = parseContainerStat(line, options?.appContainerName);
          if (parsed) {
            socket.send(JSON.stringify({ type: "stat", data: parsed }));
          }
        }
      },
    },
  );

  return streamPromise
    .catch((err: unknown) => {
      if (!abortController.signal.aborted) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error(`[stats] Stream error: ${errorMsg}`);
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: "error", error: errorMsg }));
        }
      }
    })
    .finally(() => {
      if (socket.readyState === socket.OPEN) {
        socket.close();
      }
    });
}
