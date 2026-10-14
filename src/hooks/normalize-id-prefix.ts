import { FastifyReply, FastifyRequest } from "fastify";
import { stripIdPrefix } from "../lib/id.js";

function stripObjectPrefixes(obj: any): void {
  if (!obj || typeof obj !== "object") return;
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      obj[key] = stripIdPrefix(value);
    }
  }
}

export async function normalizeIdPrefixesHook(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  stripObjectPrefixes(request.params);
  stripObjectPrefixes(request.query);
  stripObjectPrefixes(request.body);
}
