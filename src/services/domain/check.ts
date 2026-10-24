import type { FastifyReply, FastifyRequest } from "fastify";
import type { RequestParams } from "../../types/misc.js";
import { verifyDomainDns } from "../../lib/domain-verifier.js";
import { DomainCheckResult } from "@explita/infra-protocol/deploy";

interface CheckAppDomainQuery {
  domain?: string;
}

export async function checkAppDomains(
  request: FastifyRequest<{
    Params: RequestParams;
    Querystring: CheckAppDomainQuery;
  }>,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const specificDomain = request.query?.domain?.trim();

  if (specificDomain) {
    const result = await verifyDomainDns(specificDomain);
    return reply.send({
      success: true,
      data: [result],
    });
  }

  // Check all domains attached to this app
  const results: DomainCheckResult[] = [];
  for (const d of app.domains) {
    const res = await verifyDomainDns(d.hostname);
    results.push(res);
  }

  return reply.send({
    success: true,
    data: results,
  });
}
