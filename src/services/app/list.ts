import { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { formatApp } from "../../lib/formatters/app.js";

export async function listApps(
  request: FastifyRequest<{ Querystring: { search?: string; q?: string } }>,
  reply: FastifyReply,
) {
  const query = request.query.search?.trim() || request.query.q?.trim();

  const where = query
    ? {
        OR: [
          { name: { contains: query, mode: "insensitive" as const } },
          { id: { contains: query, mode: "insensitive" as const } },
        ],
      }
    : {};

  const apps = await prisma.app.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      domains: true,
      currentDeployment: true,
      databases: true,
      redis: true,
      crons: true,
      envs: true,
    },
  });

  const formattedApps = apps.map((app) => formatApp(app));

  return reply.code(200).send({ success: true, data: formattedApps });
}
