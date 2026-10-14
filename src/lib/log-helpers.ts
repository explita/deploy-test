import { prisma } from "./prisma.js";

/**
 * Persists deployment logs into a single 1-to-1 Log record with messages String[].
 */
export async function saveDeploymentLogs(
  deploymentId: string,
  messages: string[],
): Promise<void> {
  if (messages.length === 0) return;

  await prisma.log.upsert({
    where: { deploymentId },
    create: {
      deploymentId,
      messages,
    },
    update: {
      messages,
    },
  });
}

/**
 * Retrieves log messages for a given deployment ID.
 */
export async function getDeploymentLogsById(deploymentId: string) {
  const log = await prisma.log.findUnique({
    where: { deploymentId },
    select: { messages: true },
  });

  return log?.messages ?? null;
}
