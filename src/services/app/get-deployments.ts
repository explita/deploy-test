import { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { formatDeployment } from "../../lib/formatters/deployment.js";

interface GetDeploymentsQuery {
  take?: string;
  limit?: string;
  status?: string | string[];
  statuses?: string | string[];
  includeLogs?: string;
}

export async function getAppDeployments(
  request: FastifyRequest<{ Querystring: GetDeploymentsQuery }>,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const query = request.query || {};

  const takeVal = query.take || query.limit;
  const take = takeVal ? Math.max(1, Math.min(100, parseInt(takeVal, 10) || 50)) : undefined;

  const rawStatus = query.status || query.statuses;
  let statusFilter: any = undefined;
  if (rawStatus) {
    const list = (Array.isArray(rawStatus) ? rawStatus : rawStatus.split(","))
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (list.length === 1) {
      statusFilter = list[0];
    } else if (list.length > 1) {
      statusFilter = { in: list };
    }
  }

  const shouldIncludeLogs = query.includeLogs !== "false";

  const where: any = { appId: app.id };
  if (statusFilter) {
    where.status = statusFilter;
  }

  const deployments = await prisma.deployment.findMany({
    where,
    include: {
      log: shouldIncludeLogs,
    },
    orderBy: { startedAt: "desc" },
    ...(take ? { take } : {}),
  });

  const formatted = deployments.map(formatDeployment);

  return reply.code(200).send({ success: true, data: formatted });
}
