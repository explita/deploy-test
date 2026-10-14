import type { FastifyReply, FastifyRequest } from "fastify";
import { syncAppCaddy } from "../../lib/caddy.js";
import { prisma } from "../../lib/prisma.js";
import type { RequestParams } from "../../types/misc.js";
import { logger } from "@explita/protocol";
import { verifyDomainDns } from "../../lib/domain-verifier.js";
import { cleanDomain, normalizeDomains } from "@explita/protocol";

interface AddDomainBody {
  domains?: string[];
}

export async function addAppDomain(
  request: FastifyRequest<{ Params: RequestParams; Body: AddDomainBody }>,
  reply: FastifyReply,
) {
  const app = request.ctx.app;

  const body = request.body || {};
  const rawList = normalizeDomains(body.domains);

  const domainNames = Array.from(
    new Set(
      rawList
        .flatMap((d) => String(d || "").split(","))
        .map((s) => cleanDomain(s))
        .filter((d): d is string => Boolean(d && d.length >= 3)),
    ),
  );

  if (domainNames.length === 0) {
    return reply.code(400).send({
      success: false,
      error: "At least one valid domain name is required",
    });
  }

  const createdDomains: any[] = [];
  const existingDomains: any[] = [];
  const conflictErrors: string[] = [];

  for (const domainName of domainNames) {
    const existing = app.domains.find((d) => d.hostname === domainName);
    if (existing) {
      existingDomains.push(existing);
      continue;
    }

    const conflict = await prisma.domain.findUnique({
      where: { hostname: domainName },
      include: { app: true },
    });

    if (conflict) {
      if (conflict.appId === app.id) {
        existingDomains.push(conflict);
      } else {
        conflictErrors.push(
          `Domain "${domainName}" is already assigned to application "${conflict.app.name}"`,
        );
      }
      continue;
    }

    try {
      const created = await prisma.domain.create({
        data: {
          appId: app.id,
          hostname: domainName,
        },
      });
      createdDomains.push(created);
    } catch (err: any) {
      conflictErrors.push(
        `Failed to attach domain "${domainName}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (createdDomains.length > 0) {
    await syncAppCaddy(app.id).catch((err) => {
      logger.warn(`[caddy] Warning: Failed to sync domain:`, err);
    });
  }

  const allDomains = [...createdDomains, ...existingDomains];

  const verifications = await Promise.all(
    allDomains.map(async (d) => ({
      domain: d.hostname,
      verification: await verifyDomainDns(d.hostname),
    })),
  );

  return reply.code(createdDomains.length > 0 ? 201 : 200).send({
    success: true,
    data: {
      domains: allDomains,
      created: createdDomains,
      existing: existingDomains,
      verifications,
      ...(conflictErrors.length > 0 ? { warnings: conflictErrors } : {}),
    },
  });
}
