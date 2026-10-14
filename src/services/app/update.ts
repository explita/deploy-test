import { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { removeAppTunnel, syncAppTunnel } from "../../lib/tunnel.js";
import { updateAppSchema } from "../../zod/app-schema.js";
import { normalizeMemoryLimit, normalizeCpuLimit } from "@explita/protocol";
import { run } from "../../lib/runner.js";
import { cronScheduler } from "../../lib/cron-scheduler.js";
import { formatApp } from "../../lib/formatters/app.js";
import { JsonObject } from "../../generated/prisma/internal/prismaNamespace.js";

export async function updateApp(request: FastifyRequest, reply: FastifyReply) {
  const app = request.ctx.app;

  const input = updateAppSchema.parse(request.body);
  const meta = app.metadata;

  const tunnelPref = input.tunnel ?? input.tunnelEnabled;
  if (tunnelPref !== undefined) {
    meta.tunnelEnabled = tunnelPref;
  }

  if (input.memory !== undefined) {
    const normMem = normalizeMemoryLimit(input.memory);
    if (!meta.resources) meta.resources = {};
    if (normMem) {
      meta.resources.memory = normMem;
    } else {
      delete meta.resources.memory;
    }
  }

  if (input.cpus !== undefined) {
    const normCpu = normalizeCpuLimit(input.cpus);
    if (!meta.resources) meta.resources = {};
    if (normCpu) {
      meta.resources.cpus = normCpu;
    } else {
      delete meta.resources.cpus;
    }
  }

  if (input.preDeploy !== undefined) {
    meta.preDeploy = input.preDeploy;
  }

  if (input.healthCheck !== undefined) {
    meta.healthCheck = input.healthCheck;
  }

  if (input.crons !== undefined) {
    const existing = app.crons;
    const existingPausedMap = new Map<string, boolean>();
    for (const ec of existing) {
      existingPausedMap.set(ec.id, ec.paused);
      existingPausedMap.set(ec.name, ec.paused);
    }

    await prisma.$transaction(async (trx) => {
      await trx.appCron.deleteMany({ where: { appId: app.id } });
      if (input.crons && input.crons.length > 0) {
        await trx.appCron.createMany({
          data: input.crons.map((c, i) => {
            const name = c.name || `cron-${i + 1}`;
            const prevPaused =
              (c.id ? existingPausedMap.get(c.id) : undefined) ??
              existingPausedMap.get(name);
            return {
              appId: app.id,
              name,
              schedule: c.schedule,
              command: c.command,
              timeout: c.timeout,
              paused: c.paused ?? prevPaused ?? false,
            };
          }),
        });
      }
    });
  }

  if (input.volumes !== undefined) {
    if (input.volumes === null) {
      delete meta.volumes;
    } else {
      meta.volumes = input.volumes;
    }
  }

  if (input.notify !== undefined) {
    if (input.notify === null) {
      delete meta.notify;
    } else {
      meta.notify = input.notify;
    }
  }

  if (meta.resources && Object.keys(meta.resources).length === 0) {
    delete meta.resources;
  }

  const updated = await prisma.app.update({
    where: { id: app.id },
    data: {
      ...(input.name ? { name: input.name.trim() } : {}),
      ...(input.port ? { port: input.port } : {}),
      metadata: meta as JsonObject,
    },
    include: {
      domains: true,
      currentDeployment: true,
      databases: true,
      redis: true,
      crons: true,
      envs: true,
    },
  });

  const updatedApp = formatApp(updated, { showAll: true });

  let tunnelUrl: string | null = null;
  if (tunnelPref === false) {
    await removeAppTunnel(updatedApp);
  } else if (tunnelPref === true) {
    tunnelUrl = await syncAppTunnel(updatedApp);
  }

  if (input.crons !== undefined) {
    await cronScheduler.syncApp(app.id);
  }

  // Dynamically update limits on running container if deployed
  if (
    (input.memory !== undefined || input.cpus !== undefined) &&
    app.currentDeployment
  ) {
    const dep = app.currentDeployment;
    if (dep?.containerName) {
      const updateArgs = ["update"];
      if (meta.resources?.memory) {
        updateArgs.push(
          `--memory=${meta.resources.memory}`,
          `--memory-swap=${meta.resources.memory}`,
        );
      }
      if (meta.resources?.cpus) {
        updateArgs.push(`--cpus=${meta.resources.cpus}`);
      }
      if (updateArgs.length > 1) {
        await run("docker", [...updateArgs, dep.containerName]).catch(
          () => undefined,
        );
      }
    }
  }

  return reply.send({
    success: true,
    data: {
      ...updatedApp,
      tunnelUrl,
    },
  });
}
