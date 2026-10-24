import { FastifyReply, FastifyRequest } from "fastify";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "../../lib/prisma.js";
import { run } from "../../lib/runner.js";
import { server, getAppDbBackupDir } from "../../lib/constants.js";
import { removeAppCaddy, removePreviewCaddy } from "../../lib/caddy.js";
import { removeAppTunnel, removePreviewTunnel } from "../../lib/tunnel.js";
import {
  getAppTunnelContainerName,
  getPreviewTunnelContainerName,
} from "@explita/infra-protocol/deploy";
import { stripIdPrefix } from "../../lib/id.js";
import { execPostgres } from "../database/lib/exec.js";
import { execRedisCli } from "../../lib/redis.js";
import { cronScheduler } from "../../lib/cron-scheduler.js";
import { logger } from "@explita/infra-protocol";

export async function deleteApp(request: FastifyRequest, reply: FastifyReply) {
  const app = request.ctx.app;

  // 1. Fetch all deployments to discover containers, images, and preview resources
  const deployments = await prisma.deployment.findMany({
    where: { appId: app.id },
    select: { id: true, containerName: true, image: true, metadata: true },
  });

  const containerNames = new Set<string>();
  const images = new Set<string>();

  for (const dep of deployments) {
    if (dep.containerName) containerNames.add(dep.containerName);
    if (dep.image) images.add(dep.image);

    // Track preview tunnel containers for this deployment
    containerNames.add(getPreviewTunnelContainerName(dep.id));
    const rawDepId = stripIdPrefix(dep.id);
    if (rawDepId && rawDepId !== dep.id) {
      containerNames.add(getPreviewTunnelContainerName(rawDepId));
    }
  }

  // Also track main app tunnel container
  containerNames.add(getAppTunnelContainerName(app.id));
  const rawAppId = stripIdPrefix(app.id);
  if (rawAppId && rawAppId !== app.id) {
    containerNames.add(getAppTunnelContainerName(rawAppId));
  }

  // Also query Docker directly for any containers matching app id patterns
  const safeAppId = `app-${app.id.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
  const [psSafe, psRaw] = await Promise.all([
    run("docker", [
      "ps",
      "-a",
      "--filter",
      `name=${safeAppId}`,
      "--format",
      "{{.Names}}",
    ]).catch(() => null),
    run("docker", [
      "ps",
      "-a",
      "--filter",
      `name=${app.id}`,
      "--format",
      "{{.Names}}",
    ]).catch(() => null),
  ]);

  for (const res of [psSafe, psRaw]) {
    if (res?.stdout) {
      for (const name of res.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)) {
        containerNames.add(name);
      }
    }
  }

  const appDir = join(server.deployBaseDir, app.id);

  // Cleanup helper: Docker containers first, then built images
  const cleanupDocker = async () => {
    await Promise.all(
      Array.from(containerNames).map((cName) =>
        run("docker", ["rm", "-f", cName]).catch(() => undefined),
      ),
    );
    await Promise.all(
      Array.from(images).map((img) =>
        run("docker", ["rmi", "-f", img]).catch(() => undefined),
      ),
    );
  };

  const databases = app.databases;

  // Cleanup helper: PostgreSQL databases first, then user roles
  const cleanupDb = async () => {
    for (const db of databases) {
      if (db.name) {
        await execPostgres(
          `DROP DATABASE IF EXISTS "${db.name}" WITH (FORCE);`,
        ).catch((err) => {
          logger.warn(`Failed to drop database ${db.name}:`, err);
        });
      }
      if (db.user) {
        await execPostgres(`DROP ROLE IF EXISTS "${db.user}";`).catch((err) => {
          logger.warn(`Failed to drop role ${db.user}:`, err);
        });
      }
    }
  };

  // Cleanup helper: Redis database index flush
  const cleanupRedis = async () => {
    const redisRecord = app.redis;
    if (typeof redisRecord?.dbIndex === "number") {
      await execRedisCli(["-n", String(redisRecord.dbIndex), "FLUSHDB"]).catch(
        (err) => {
          logger.warn(
            `Failed to flush Redis database index ${redisRecord.dbIndex}:`,
            err,
          );
        },
      );
    }
  };

  // Cleanup helper: Preview tunnels, preview Caddyfiles, and ephemeral preview databases
  const cleanupPreviews = async () => {
    for (const dep of deployments) {
      const rawDepId = stripIdPrefix(dep.id);
      await Promise.all([
        removePreviewTunnel(dep.id).catch(() => null),
        rawDepId && rawDepId !== dep.id
          ? removePreviewTunnel(rawDepId).catch(() => null)
          : Promise.resolve(),
        removePreviewCaddy(dep.id).catch(() => null),
        rawDepId && rawDepId !== dep.id
          ? removePreviewCaddy(rawDepId).catch(() => null)
          : Promise.resolve(),
      ]);

      const meta = (dep.metadata as any) ?? {};
      const clonesToDrop = (meta.previewDbs as Array<{ name: string }>) || [];
      for (const clone of clonesToDrop) {
        if (clone?.name) {
          await execPostgres(
            `DROP DATABASE IF EXISTS "${clone.name}" WITH (FORCE);`,
          ).catch((err) => {
            logger.warn(`Failed to drop preview database ${clone.name}:`, err);
          });
        }
      }
    }
  };

  // Run all independent cleanup tasks concurrently
  await Promise.all([
    cleanupDocker(),
    cleanupPreviews(),
    rm(appDir, { recursive: true, force: true }).catch(() => undefined),
    rm(getAppDbBackupDir(app.id), { recursive: true, force: true }).catch(
      () => undefined,
    ),
    cleanupDb(),
    cleanupRedis(),
    prisma.app.delete({ where: { id: app.id } }),
    removeAppCaddy(app.name).catch((err) => {
      logger.warn(
        `Warning: Failed to clean up Caddy config for ${app.name}:`,
        err,
      );
    }),
    removeAppCaddy(app.id).catch(() => null),
    removeAppTunnel(app).catch((err) => {
      logger.warn(
        `Warning: Failed to clean up tunnel container for ${app.name}:`,
        err,
      );
    }),
  ]);

  cronScheduler.removeApp(app.id);

  return reply.code(200).send({
    success: true,
    data: {
      deleted: true,
      containersRemoved: Array.from(containerNames),
      imagesRemoved: Array.from(images),
      databasesRemoved: databases.map((d) => d.name),
    },
  });
}
