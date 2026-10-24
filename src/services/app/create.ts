import { FastifyReply, FastifyRequest } from "fastify";
import { createAppSchema } from "../../zod/app-schema.js";
import { prisma } from "../../lib/prisma.js";
import { formatApp } from "../../lib/formatters/app.js";
import { encryptEnvMap } from "@explita/infra-protocol";

export async function createApp(request: FastifyRequest, reply: FastifyReply) {
  const input = createAppSchema.parse(request.body);

  const existingApp = await prisma.app.findFirst({
    where: { name: input.name },
  });

  if (existingApp) {
    return reply.code(409).send({
      success: false,
      error: `Application "${input.name}" already exists, check apps list for details.`,
    });
  }

  const domainList = input.domains
    .map(
      (d) =>
        d
          .trim()
          .toLowerCase()
          .replace(/^https?:\/\//i, "")
          .split("/")[0]
          .split(":")[0],
    )
    .filter(Boolean);

  const tunnelEnabled = input.tunnel ?? input.tunnelEnabled ?? false;
  const tunnelSubdomain = input.subdomain?.trim().toLowerCase();
  const encryptedEnvs =
    input.env && Object.keys(input.env).length > 0
      ? encryptEnvMap(input.env)
      : null;

  const createdApp = await prisma.app.create({
    data: {
      name: input.name,
      port: input.port,
      metadata: {
        tunnelEnabled,
        tunnel: {
          enabled: tunnelEnabled,
          ...(tunnelSubdomain ? { subdomain: tunnelSubdomain } : {}),
        },
        preDeploy: input.preDeploy,
        healthCheck: input.healthCheck,
        volumes: input.volumes,
        notify: input.notify,
      },
      domains: {
        create: domainList.map((hostname) => ({ hostname })),
      },
      crons: {
        create: input.crons.map((c, i) => ({
          name: c.name || `cron-${i + 1}`,
          schedule: c.schedule,
          command: c.command,
          timeout: c.timeout,
          paused: c.paused ?? false,
        })),
      },
      envs: encryptedEnvs
        ? {
            create: Object.entries(encryptedEnvs).map(([key, value]) => ({
              key,
              value,
            })),
          }
        : undefined,
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

  return reply.code(201).send({ success: true, data: formatApp(createdApp) });
}
