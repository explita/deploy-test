import { FastifyReply, FastifyRequest } from "fastify";
import { run, stream } from "../../lib/runner.js";
import { logger } from "@explita/infra-protocol";

interface ExecBody {
  command?: string | string[];
}

export async function execApp(
  request: FastifyRequest<{ Body?: ExecBody }>,
  reply: FastifyReply,
) {
  const app = request.ctx.app;

  const rawCommand = request.body?.command;
  if (!rawCommand || (Array.isArray(rawCommand) && rawCommand.length === 0)) {
    return reply.code(400).send({
      success: false,
      error: "Command is required to execute.",
    });
  }

  const commandString = Array.isArray(rawCommand)
    ? rawCommand.join(" ")
    : String(rawCommand).trim();

  if (!commandString) {
    return reply.code(400).send({
      success: false,
      error: "Command string cannot be empty.",
    });
  }

  const dep = app.currentDeployment;

  if (!dep?.containerName) {
    return reply.code(400).send({
      success: false,
      error: `Application "${app.name}" has no active deployment container to execute commands in. Deploy the app first with "eda".`,
    });
  }

  const inspect = await run("docker", [
    "inspect",
    "--format",
    "{{.State.Running}}",
    dep.containerName,
  ]);

  if (inspect.code !== 0 || inspect.stdout.trim() !== "true") {
    return reply.code(400).send({
      success: false,
      error: `Application container "${dep.containerName}" is not currently running. Start it with "eda start -a ${app.id}".`,
    });
  }

  reply.raw.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "transfer-encoding": "chunked",
    "x-accel-buffering": "no",
    "cache-control": "no-cache",
  });

  const abortController = new AbortController();
  request.raw.on("close", () => {
    abortController.abort();
  });

  const sendEvent = (event: object) => {
    if (!reply.raw.writableEnded) {
      reply.raw.write(JSON.stringify(event) + "\n");
    }
  };

  try {
    const streamPromise = stream(
      "docker",
      ["exec", dep.containerName, "sh", "-c", commandString],
      {
        signal: abortController.signal,
        onStdout: (data) => sendEvent({ type: "stdout", data }),
        onStderr: (data) => sendEvent({ type: "stderr", data }),
      },
    );

    const result = await streamPromise;
    sendEvent({ type: "exit", code: result.code });
  } catch (err) {
    if (!abortController.signal.aborted) {
      logger.error(
        `[exec] Error executing command in ${dep.containerName}:`,
        err,
      );
      sendEvent({
        type: "stderr",
        data: `Execution error: ${err instanceof Error ? err.message : String(err)}\n`,
      });
      sendEvent({ type: "exit", code: 1 });
    }
  } finally {
    if (!reply.raw.writableEnded) {
      reply.raw.end();
    }
  }
}
