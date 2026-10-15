import { FastifyReply, FastifyRequest } from "fastify";
import z from "zod";
import { prisma } from "../../lib/prisma.js";
import { syncAppCaddy } from "../../lib/caddy.js";
import { syncAppTunnel } from "../../lib/tunnel.js";
import { formatApp } from "../../lib/formatters/app.js";
import { stripAppPrefixes } from "../../lib/id.js";
import { InputJsonValue } from "../../generated/prisma/internal/prismaNamespace.js";
import { resolveCustomMaintenancePage } from "../../lib/maintenance-helpers.js";

export const maintenanceSchema = z.object({
  enabled: z.boolean(),
});

export async function getMaintenance(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const meta = app.metadata;
  const maintenance = meta.maintenance;
  const customPage = Boolean(resolveCustomMaintenancePage(app.id));

  return reply.send({
    success: true,
    data: {
      enabled: Boolean(maintenance?.enabled),
      message: maintenance?.message || null,
      enabledAt: maintenance?.enabledAt || null,
      customPage,
    },
  });
}

export async function setMaintenance(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const input = maintenanceSchema.parse(request.body);

  const meta = app.metadata;

  if (input.enabled) {
    const existingAt = meta.maintenance?.enabledAt;
    meta.maintenance = {
      enabled: true,
      enabledAt: existingAt || new Date().toISOString(),
    };
  } else {
    delete meta.maintenance;
  }

  const updatedRawApp = await prisma.app.update({
    where: { id: app.id },
    data: {
      metadata: meta as InputJsonValue,
    },
    include: {
      domains: true,
      currentDeployment: true,
    },
  });

  // Re-sync Caddy routes and Tunnel routing
  await syncAppCaddy(app.id);
  await syncAppTunnel(stripAppPrefixes(formatApp(updatedRawApp)));

  const customPage = Boolean(resolveCustomMaintenancePage(app.id));

  return reply.send({
    success: true,
    data: {
      enabled: Boolean(input.enabled),
      enabledAt: input.enabled ? meta.maintenance?.enabledAt || null : null,
      customPage,
    },
  });
}
