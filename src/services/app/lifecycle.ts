import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { run } from "../../lib/runner.js";
import { syncAppTunnel } from "../../lib/tunnel.js";
import { cronScheduler } from "../../lib/cron-scheduler.js";
import { FormattedApp } from "../../lib/formatters/app.js";
import { deployer } from "../../lib/deployer.js";

async function getActiveContainer(app: FormattedApp) {
  const deployment = app.currentDeployment;

  if (!deployment?.containerName) {
    return {
      success: false,
      error: "Application has no deployed container",
      status: 400,
    };
  }

  return {
    success: true,
    app,
    deployment,
    containerName: deployment.containerName,
    status: 200,
  };
}

export async function stopApp(request: FastifyRequest, reply: FastifyReply) {
  const result = await getActiveContainer(request.ctx.app);
  if ("error" in result) {
    return reply
      .code(result.status)
      .send({ success: false, error: result.error });
  }

  const { app, containerName } = result;

  const stopRes = await run("docker", ["stop", containerName]);
  if (stopRes.code !== 0) {
    return reply.code(500).send({
      success: false,
      error: `Failed to stop container: ${stopRes.stderr || stopRes.stdout}`,
    });
  }

  await prisma.app.update({
    where: { id: app.id },
    data: { status: "STOPPED" },
  });

  await syncAppTunnel(app).catch(() => null);
  cronScheduler.removeApp(app.id);

  return reply.code(200).send({
    success: true,
    data: { id: app.id, name: app.name, state: "STOPPED" },
    message: `Application ${app.name} stopped`,
  });
}

export async function startApp(request: FastifyRequest, reply: FastifyReply) {
  const result = await getActiveContainer(request.ctx.app);
  if ("error" in result) {
    return reply
      .code(result.status)
      .send({ success: false, error: result.error });
  }

  const { app, containerName } = result;

  // In-place start preserving container identity and container ID
  const startRes = await run("docker", ["start", containerName]);
  if (startRes.code !== 0) {
    return reply.code(500).send({
      success: false,
      error: `Failed to start container: ${startRes.stderr || startRes.stdout}`,
    });
  }

  await prisma.app.update({
    where: { id: app.id },
    data: { status: "RUNNING" },
  });

  await syncAppTunnel(app).catch(() => null);
  await cronScheduler.syncApp(app.id).catch(() => null);

  return reply.code(200).send({
    success: true,
    data: { id: app.id, name: app.name, state: "RUNNING" },
    message: `Application ${app.name} started`,
  });
}

export async function restartApp(request: FastifyRequest, reply: FastifyReply) {
  const result = await getActiveContainer(request.ctx.app);
  if ("error" in result) {
    return reply
      .code(result.status)
      .send({ success: false, error: result.error });
  }

  const { app, containerName } = result;
  const query = request.query as Record<string, string> | undefined;
  const body = (request.body as Record<string, any> | undefined) || {};

  const shouldRecreate =
    query?.recreate === "true" ||
    body?.recreate === true;

  // Re-pass environment variables using recreateAppContainer if explicitly requested with --recreate
  if (shouldRecreate && app.currentDeployment?.image) {
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

      await prisma.app.update({
        where: { id: app.id },
        data: { status: "RUNNING" },
      });

      sendEvent({
        type: "done",
        success: true,
        data: {
          id: app.id,
          name: app.name,
          state: "RUNNING",
          containerName: reloadResult.containerName,
          detectedPort: reloadResult.detectedPort,
        },
        message: `Application ${app.name} restarted`,
      });
    } catch (err: any) {
      sendEvent({
        type: "error",
        error: `Failed to restart application: ${err.message}`,
      });
    }

    reply.raw.end();
    return;
  }

  // Fast in-place restart preserving container identity and container ID
  const restartRes = await run("docker", ["restart", containerName]);
  if (restartRes.code !== 0) {
    return reply.code(500).send({
      success: false,
      error: `Failed to restart container: ${restartRes.stderr || restartRes.stdout}`,
    });
  }

  await prisma.app.update({
    where: { id: app.id },
    data: { status: "RUNNING" },
  });

  await syncAppTunnel(app).catch(() => null);
  await cronScheduler.syncApp(app.id).catch(() => null);

  return reply.code(200).send({
    success: true,
    data: { id: app.id, name: app.name, state: "RUNNING" },
    message: `Application ${app.name} restarted`,
  });
}
