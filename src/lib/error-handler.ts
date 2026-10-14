import { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

export function errorHandler(
  error: FastifyError,
  _request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error instanceof z.ZodError) {
    return reply.code(400).send({
      success: false,
      error: error.errors
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join(", "),
    });
  }
  const statusCode =
    typeof error.statusCode === "number" ? error.statusCode : 500;
  return reply.code(statusCode).send({
    success: false,
    error: error.message ?? "Internal Server Error",
  });
}
