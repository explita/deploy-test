import { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { run } from "../../lib/runner.js";
import type {
  VolumeInspectResult,
  VolumeAppBinding,
} from "@explita/protocol/deploy";

type InspectVolumeParams = {
  name: string;
};

export async function inspectVolume(
  request: FastifyRequest<{ Params: InspectVolumeParams }>,
  reply: FastifyReply,
) {
  const { name } = request.params;
  if (!name?.trim()) {
    return reply.code(400).send({
      success: false,
      error: "Volume name is required",
    });
  }

  const inspectRes = await run("docker", ["volume", "inspect", name]).catch(
    () => null,
  );

  if (!inspectRes || inspectRes.code !== 0 || !inspectRes.stdout.trim()) {
    return reply.code(404).send({
      success: false,
      error: `Volume "${name}" not found`,
    });
  }

  let raw: any;
  try {
    const parsed = JSON.parse(inspectRes.stdout.trim());
    raw = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (_err) {
    return reply.code(500).send({
      success: false,
      error: "Failed to parse Docker volume inspect output",
    });
  }

  if (!raw || !raw.Name) {
    return reply.code(404).send({
      success: false,
      error: `Volume "${name}" not found`,
    });
  }

  // Size from docker system df -v
  let size: string | undefined;
  const dfRes = await run("docker", [
    "system",
    "df",
    "-v",
    "--format",
    "{{json .Volumes}}",
  ]).catch(() => null);

  if (dfRes && dfRes.code === 0 && dfRes.stdout.trim()) {
    try {
      const jsonParsed = JSON.parse(dfRes.stdout.trim());
      if (Array.isArray(jsonParsed)) {
        const found = jsonParsed.find((v: any) => v.Name === raw.Name);
        if (found && found.Size && found.Size !== "N/A") {
          size = found.Size;
        }
      }
    } catch {
      // ignore
    }
  }

  // Containers using this volume
  const psRes = await run("docker", [
    "ps",
    "-a",
    "--filter",
    `volume=${raw.Name}`,
    "--format",
    "{{.Names}}",
  ]).catch(() => null);

  const containers = psRes?.stdout
    ? psRes.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  // Correlate with Prisma apps
  const apps = await prisma.app.findMany({
    select: {
      id: true,
      name: true,
      metadata: true,
    },
  });

  const matchingApps: VolumeAppBinding[] = [];
  for (const app of apps) {
    const meta = app.metadata as Record<string, any> | null;
    if (meta?.volumes && typeof meta.volumes === "object") {
      for (const [source, dest] of Object.entries(meta.volumes)) {
        if (source === raw.Name && typeof dest === "string") {
          matchingApps.push({
            appId: app.id,
            appName: app.name,
            containerPath: dest,
          });
        }
      }
    }
  }

  const data: VolumeInspectResult = {
    name: raw.Name,
    driver: raw.Driver || "local",
    scope: raw.Scope || "local",
    mountpoint: raw.Mountpoint,
    createdAt: raw.CreatedAt,
    labels: raw.Labels || {},
    options: raw.Options || null,
    size,
    apps: matchingApps,
    containers,
    inUse: containers.length > 0,
    raw,
  };

  return { success: true, data };
}
