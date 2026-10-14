import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyDomainDns } from "../../lib/domain-verifier.js";

interface DomainCheckQuery {
  domain?: string;
}

export async function checkSystemDomain(
  request: FastifyRequest<{ Querystring: DomainCheckQuery }>,
  reply: FastifyReply,
) {
  const domain = request.query?.domain?.trim();
  if (!domain) {
    return reply.code(400).send({
      success: false,
      error: "Query parameter 'domain' is required (e.g. ?domain=api.example.com).",
    });
  }

  const result = await verifyDomainDns(domain);
  return reply.send({
    success: true,
    data: result,
  });
}
