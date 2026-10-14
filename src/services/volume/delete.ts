import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { run } from "../../lib/runner.js";
import { logger } from "@explita/protocol";

type DeleteVolumeParams = {
  name: string;
};

type DeleteVolumeQuery = {
  force?: string;
};

export async function deleteVolume(
  request: FastifyRequest<{
    Params: DeleteVolumeParams;
    Querystring: DeleteVolumeQuery;
  }>,
  reply: FastifyReply,
) {
  const name = request.params.name?.trim();
  const force = request.query.force === "true" || request.query.force === "1";

  if (!name) {
    return reply.code(400).send({
      success: false,
      error: "Volume name is required",
    });
  }

  // 1. Verify volume exists in Docker
  const inspectRes = await run("docker", ["volume", "inspect", name]).catch(
    () => null,
  );
  if (!inspectRes || inspectRes.code !== 0 || !inspectRes.stdout.trim()) {
    return reply.code(404).send({
      success: false,
      error: `Volume "${name}" not found`,
    });
  }

  // 2. Check active/stopped container usage
  const psRes = await run("docker", [
    "ps",
    "-a",
    "--filter",
    `volume=${name}`,
    "--format",
    "{{.Names}}",
  ]).catch(() => null);

  const containers = psRes?.stdout
    ? psRes.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  if (containers.length > 0) {
    return reply.code(409).send({
      success: false,
      error: `Cannot remove volume "${name}": currently mounted by container(s): ${containers.join(", ")}. Stop or remove the container(s) first.`,
    });
  }

  // 3. Check if any app currently configures this volume in metadata.volumes
  if (!force) {
    const apps = await prisma.app.findMany({
      select: { id: true, name: true, metadata: true },
    });

    for (const app of apps) {
      const meta = app.metadata as Record<string, any> | null;
      if (meta?.volumes && typeof meta.volumes === "object") {
        for (const [source, dest] of Object.entries(meta.volumes)) {
          if (source === name) {
            return reply.code(409).send({
              success: false,
              error: `Cannot remove volume "${name}": configured in application "${app.name}" (${app.id}) at mount path "${dest}". Remove it from the app configuration first, or pass force=true.`,
            });
          }
        }
      }
    }
  }

  // 4. Remove volume in Docker
  const rmArgs = ["volume", "rm"];
  if (force) rmArgs.push("-f");
  rmArgs.push(name);

  const rmRes = await run("docker", rmArgs);
  if (rmRes.code !== 0) {
    logger.warn(`Failed to remove volume ${name}: ${rmRes.stderr}`);
    return reply.code(500).send({
      success: false,
      error: rmRes.stderr.trim() || `Failed to remove volume "${name}"`,
    });
  }

  logger.info(`Volume "${name}" successfully removed.`);
  return reply.code(200).send({
    success: true,
    data: { ok: true, removed: name },
  });
}
