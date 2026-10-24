import type { FastifyReply, FastifyRequest } from "fastify";
import { syncAppCaddy } from "../../lib/caddy.js";
import { prisma } from "../../lib/prisma.js";
import type { RequestParams } from "../../types/misc.js";
import { logger } from "@explita/infra-protocol";

interface DomainParams extends RequestParams {
  domain: string;
}

export async function removeAppDomain(
  request: FastifyRequest<{ Params: DomainParams }>,
  reply: FastifyReply,
) {
  const targetDomain = request.params.domain?.trim().toLowerCase();

  const app = request.ctx.app;

  const domain = app.domains.find(
    (d) => d.id === targetDomain || d.hostname === targetDomain,
  );

  if (!domain) {
    return reply
      .code(404)
      .send({ success: false, error: "Domain not found for this application" });
  }

  await prisma.domain.delete({
    where: { id: domain.id },
  });

  await syncAppCaddy(app.id).catch((err) => {
    logger.warn(`[caddy] Warning: Failed to sync domain:`, err);
  });

  return reply.code(200).send({
    success: true,
    data: { ok: true, removed: domain.hostname },
  });
}
