import type { FastifyRequest, FastifyReply } from "fastify";
import { run } from "../../lib/runner.js";
import { docker } from "../../lib/constants.js";
import { prisma } from "../../lib/prisma.js";
import { saveDeploymentLogs } from "../../lib/log-helpers.js";
import { ensureDockerNetwork } from "../../lib/docker-network.js";
import { syncAppCaddy } from "../../lib/caddy.js";
import { syncAppTunnel } from "../../lib/tunnel.js";
import { logger } from "@explita/protocol";

import { deployer } from "../../lib/deployer.js";
import { findDeployment, findAppByIdOrName } from "../../lib/app-helpers.js";
import { formatDeploymentId, formatAppId } from "../../lib/id.js";
import { cronScheduler } from "../../lib/cron-scheduler.js";

export async function rollbackDeployment(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const deploymentId = request.params?.id ?? request.params?.deploymentId;

  if (!deploymentId) {
    return reply.code(400).send({
      success: false,
      error: "Deployment ID is required",
    });
  }

  const target = await findDeployment(deploymentId);

  if (!target || !target.app) {
    return reply.code(404).send({
      success: false,
      error: "Target deployment not found",
    });
  }

  const query = (request.query || {}) as { purge?: string | boolean };
  const body = (request.body || {}) as { purge?: boolean };
  const purge =
    query.purge === "true" || query.purge === true || body.purge === true;

  // Handle discarding/rolling back a preview deployment without disrupting production
  if (target.status === "PREVIEW") {
    await deployer.rollbackPreview(target, { purge });
    return reply.code(200).send({
      success: true,
      data: {
        ok: true,
        deploymentId: formatDeploymentId(target.id),
        appId: formatAppId(target.app.id),
        isPreview: true,
        purged: purge,
        message: purge
          ? "Preview container discarded and deployment record permanently purged."
          : "Preview container discarded cleanly. Zero production disruption.",
      },
    });
  }

  if (!target.image || !target.containerName) {
    return reply.code(400).send({
      success: false,
      error: "Target deployment not deployable (missing image or container)",
    });
  }

  const app = target.app;

  const logs: string[] = [
    `Initiated rollback to deployment ${target.id} (${target.image})`,
  ];

  if (app.currentDeploymentId && app.currentDeploymentId !== target.id) {
    const current = app.currentDeployment;
    if (current?.containerName) {
      await run("docker", ["rm", "-f", current.containerName]);
      logs.push(`Stopped previous container ${current.containerName}`);
    }
  }

  await ensureDockerNetwork(docker.network);

  const newContainerName = `${target.containerName}-rollback-${Date.now()}`;
  const meta = app.metadata;
  const databases = app.databases;
  const defaultDb = app.databasesMap.get("default");
  const dbUrl = defaultDb?.url;

  const redisUrl = app.redis?.url;

  const runArgs = [
    "run",
    "-d",
    "--restart",
    "unless-stopped",
    "--network",
    docker.network,
    "--name",
    newContainerName,
  ];

  if (dbUrl) {
    runArgs.push("-e", `DATABASE_URL=${dbUrl}`);
  }

  for (const db of databases) {
    if (db.key !== "default" && db.url) {
      const envKey = `${db.key.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}_DATABASE_URL`;
      runArgs.push("-e", `${envKey}=${db.url}`);
    }
  }

  if (redisUrl) {
    runArgs.push("-e", `REDIS_URL=${redisUrl}`);
  }

  if (app.envs && app.envs.length > 0) {
    for (const e of app.envs) {
      if (e.key && e.value) {
        runArgs.push("-e", `${e.key}=${e.value}`);
      }
    }
  }

  const resources = meta.resources;
  if (resources?.memory) {
    runArgs.push(`--memory=${resources.memory}`);
  }
  if (resources?.cpus) {
    runArgs.push(`--cpus=${resources.cpus}`);
  }

  runArgs.push(target.image);

  const started = await run("docker", runArgs);
  if (started.code !== 0) {
    logs.push(`Rollback failed: ${started.stderr || "Unknown error"}`);
    await saveDeploymentLogs(target.id, logs).catch(() => undefined);
    return reply
      .code(500)
      .send({ success: false, error: started.stderr || "Rollback failed" });
  }

  logs.push(
    `Started rollback container ${newContainerName} on ${docker.network}`,
  );
  logs.push("Rollback complete: deployment is LIVE");

  await prisma.$transaction(async (trx) => {
    await trx.app.update({
      where: { id: app.id },
      data: { currentDeploymentId: target.id, status: "RUNNING" },
    });

    await trx.deployment.update({
      where: { id: target.id },
      data: {
        status: "LIVE",
        containerName: newContainerName,
      },
    });
  });

  const liveApp = await findAppByIdOrName(app.id, true);

  await syncAppCaddy(app.id).catch((err) => {
    logger.warn(`[rollback] Warning: Failed to sync Caddy domains:`, err);
  });

  const tunnelUrl = await syncAppTunnel(liveApp!, newContainerName).catch(
    (err) => {
      logger.warn(`[rollback] Warning: Failed to sync tunnel:`, err);
      return null;
    },
  );

  await cronScheduler.syncApp(app.id).catch((err) => {
    logger.warn(`[rollback] Warning: Failed to sync cron scheduler:`, err);
  });

  await saveDeploymentLogs(target.id, logs).catch((err) => {
    logger.warn(`[rollback] Warning: Failed to insert rollback logs:`, err);
  });

  return reply.code(200).send({
    success: true,
    data: {
      ok: true,
      deploymentId: formatDeploymentId(target.id),
      appId: formatAppId(app.id),
      tunnelUrl: tunnelUrl || null,
    },
  });
}
