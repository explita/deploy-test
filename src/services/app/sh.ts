import net from "node:net";
import { FastifyRequest } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { run } from "../../lib/runner.js";
import { logger } from "@explita/protocol";
import {
  dockerApiRequest,
  startAndHijackExec,
  resizeDockerExec,
} from "../../lib/sh-helpers.js";

interface ShellQuery {
  shell?: string;
  cmd?: string;
}

export async function streamAppShellWs(
  socket: WebSocket,
  request: FastifyRequest<{
    Querystring: ShellQuery;
  }>,
): Promise<void> {
  const app = request.ctx.app;
  const dep = app.currentDeployment;

  if (!dep?.containerName) {
    socket.send(
      `\r\n\x1b[31m[explita] Error: Application "${app.name}" has no active deployment container to attach to.\x1b[0m\r\n`,
    );
    socket.close(1008, "No active container");
    return;
  }

  const inspect = await run("docker", [
    "inspect",
    "--format",
    "{{.State.Running}}",
    dep.containerName,
  ]);

  if (inspect.code !== 0 || inspect.stdout.trim() !== "true") {
    socket.send(
      `\r\n\x1b[31m[explita] Error: Application container "${dep.containerName}" is not currently running. Start it first with "eda start -a ${app.id}".\x1b[0m\r\n`,
    );
    socket.close(1008, "Container not running");
    return;
  }

  const requestedShell = request.query.shell?.trim();
  const requestedCmd = request.query.cmd?.trim();
  const cmd = requestedCmd ? requestedCmd.split(" ") : [requestedShell || "sh"];

  logger.info(
    `[shell] Opening interactive remote shell into ${dep.containerName} (${cmd.join(" ")}) for app ${app.name}`,
  );

  let execId: string | null = null;
  let dockerSocket: net.Socket | null = null;

  try {
    const createRes = await dockerApiRequest(
      `/containers/${dep.containerName}/exec`,
      "POST",
      {
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        Cmd: cmd,
      },
    );

    if (createRes.statusCode >= 400) {
      throw new Error(`Docker API exec create failed: ${createRes.data}`);
    }

    const parsed = JSON.parse(createRes.data);
    execId = parsed.Id;
    if (!execId) {
      throw new Error("No Exec ID returned from Docker API");
    }

    dockerSocket = await startAndHijackExec(execId);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[shell] Failed to initialize exec stream: ${errorMsg}`);
    socket.send(
      `\r\n\x1b[31m[explita] Error launching shell: ${errorMsg}\x1b[0m\r\n`,
    );
    socket.close(1011, errorMsg);
    return;
  }

  // Forward Docker TTY output to WebSocket
  dockerSocket.on("data", (chunk: Buffer) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(chunk);
    }
  });

  dockerSocket.on("error", (err) => {
    logger.warn(`[shell] Docker socket error: ${err.message}`);
    if (socket.readyState === socket.OPEN) {
      socket.close();
    }
  });

  dockerSocket.on("close", () => {
    if (socket.readyState === socket.OPEN) {
      socket.close();
    }
  });

  // Handle client input and control frames (resize)
  socket.on("message", (raw: any, isBinary: boolean) => {
    if (typeof raw === "string" || (!isBinary && Buffer.isBuffer(raw))) {
      const text = raw.toString();
      if (text.startsWith('{"type":"resize"')) {
        try {
          const payload = JSON.parse(text);
          if (
            payload.type === "resize" &&
            typeof payload.cols === "number" &&
            typeof payload.rows === "number" &&
            execId
          ) {
            resizeDockerExec(execId, payload.cols, payload.rows).catch(
              () => {},
            );
            return;
          }
        } catch {}
      }
    }

    if (dockerSocket && !dockerSocket.destroyed) {
      dockerSocket.write(raw);
    }
  });

  const cleanup = () => {
    if (dockerSocket && !dockerSocket.destroyed) {
      dockerSocket.destroy();
    }
  };

  socket.on("close", cleanup);
  socket.on("error", cleanup);
}
