import { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { run } from "../../lib/runner.js";
import { logger } from "@explita/infra-protocol";
import { isCoreInfraContainer } from "@explita/infra-protocol/deploy";
import { cron } from "../../lib/constants.js";

interface PruneBody {
  all?: boolean;
}

export async function pruneSystem(
  request: FastifyRequest<{ Body?: PruneBody }>,
  reply: FastifyReply,
) {
  const pruneAll = Boolean(request.body?.all);
  logger.info(`Starting VPS disk prune (all=${pruneAll})`);

  // 1. Identify stopped / exited containers
  const psRes = await run("docker", [
    "ps",
    "-a",
    "--filter",
    "status=exited",
    "--filter",
    "status=created",
    "--format",
    "{{.ID}}\t{{.Names}}",
  ]);

  const removedContainers: string[] = [];

  if (psRes.code === 0 && psRes.stdout.trim()) {
    const lines = psRes.stdout.trim().split("\n");

    // If not pruneAll, protect intentionally stopped apps' active deployment containers
    let protectedContainers = new Set<string>();
    if (!pruneAll) {
      const apps = await prisma.app.findMany({
        include: { currentDeployment: true },
      });
      for (const app of apps) {
        if (app.currentDeployment?.containerName) {
          protectedContainers.add(app.currentDeployment.containerName);
        }
      }
    }

    for (const line of lines) {
      const [id, name] = line.trim().split("\t");
      if (!id || !name) continue;

      if (isCoreInfraContainer(name)) {
        continue;
      }

      if (!pruneAll && protectedContainers.has(name)) {
        // Preserved because it's the current container of an intentionally stopped app
        continue;
      }

      const rmRes = await run("docker", ["rm", "-f", id]);
      if (rmRes.code === 0) {
        removedContainers.push(name || id);
      }
    }
  }

  // 2. Prune Docker images
  const imageArgs = ["image", "prune", "-f"];
  if (pruneAll) {
    imageArgs.splice(2, 0, "-a");
  }
  const imageRes = await run("docker", imageArgs);
  const imageMatch = imageRes.stdout.match(
    /Total reclaimed space:\s*([^\r\n]+)/i,
  );
  const imagesReclaimed = imageMatch ? imageMatch[1].trim() : "0B";

  // 3. Prune BuildKit builder cache
  const builderArgs = ["builder", "prune", "-f"];
  if (pruneAll) {
    builderArgs.splice(2, 0, "-a");
  }
  const builderRes = await run("docker", builderArgs);
  const builderMatch = builderRes.stdout.match(/Total:\s*([^\r\n]+)/i);
  const builderReclaimed = builderMatch ? builderMatch[1].trim() : "0B";

  // 4. Prune old cron execution records beyond retention limit
  let cronRecordsPruned = 0;
  try {
    const apps = await prisma.app.findMany({ select: { id: true } });
    for (const app of apps) {
      const excess = await prisma.cronExecution.findMany({
        where: { appId: app.id },
        orderBy: { createdAt: "desc" },
        skip: cron.historyLimit,
        select: { id: true },
      });
      if (excess.length > 0) {
        const deleted = await prisma.cronExecution.deleteMany({
          where: { id: { in: excess.map((e) => e.id) } },
        });
        cronRecordsPruned += deleted.count;
      }
    }
  } catch (err) {
    logger.warn("Failed to prune old cron executions:", err);
  }

  logger.info(
    `Prune completed: ${removedContainers.length} containers removed, images reclaimed: ${imagesReclaimed}, build cache reclaimed: ${builderReclaimed}, cron records pruned: ${cronRecordsPruned}`,
  );

  return reply.send({
    success: true,
    data: {
      all: pruneAll,
      containersRemoved: removedContainers.length,
      containers: removedContainers,
      imagesReclaimed,
      builderReclaimed,
      cronRecordsPruned,
    },
  });
}
