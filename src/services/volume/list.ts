import { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { run } from "../../lib/runner.js";
import type {
  VolumeItem,
  VolumeAppBinding,
  VolumeListResult,
} from "@explita/infra-protocol/deploy";

type ListVolumesQuery = {
  app?: string;
};

export async function listVolumes(
  request: FastifyRequest<{ Querystring: ListVolumesQuery }>,
  _reply: FastifyReply,
) {
  const queryApp = request.query.app?.trim();

  // 1. Fetch Docker volumes using docker system df -v (gives size & links)
  // or fallback to docker volume ls
  const rawVolumes: Array<{
    name: string;
    driver: string;
    scope: string;
    mountpoint?: string;
    size?: string;
    links?: number;
  }> = [];

  const dfRes = await run("docker", [
    "system",
    "df",
    "-v",
    "--format",
    "{{json .Volumes}}",
  ]).catch(() => null);

  let parsedDf = false;
  if (dfRes && dfRes.code === 0 && dfRes.stdout.trim()) {
    try {
      const jsonParsed = JSON.parse(dfRes.stdout.trim());
      if (Array.isArray(jsonParsed)) {
        parsedDf = true;
        for (const item of jsonParsed) {
          if (!item.Name) continue;
          rawVolumes.push({
            name: item.Name,
            driver: item.Driver || "local",
            scope: item.Scope || "local",
            mountpoint: item.Mountpoint || undefined,
            size: item.Size && item.Size !== "N/A" ? item.Size : undefined,
            links: item.Links ? parseInt(item.Links, 10) : undefined,
          });
        }
      }
    } catch {
      // Fallback below
    }
  }

  if (!parsedDf) {
    const lsRes = await run("docker", [
      "volume",
      "ls",
      "--format",
      "{{json .}}",
    ]).catch(() => null);

    if (lsRes && lsRes.code === 0 && lsRes.stdout.trim()) {
      const lines = lsRes.stdout.trim().split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line.trim());
          if (!item.Name) continue;
          rawVolumes.push({
            name: item.Name,
            driver: item.Driver || "local",
            scope: item.Scope || "local",
            mountpoint: item.Mountpoint || undefined,
            size: item.Size && item.Size !== "N/A" ? item.Size : undefined,
          });
        } catch {
          // ignore malformed line
        }
      }
    }
  }

  // 2. Discover all running/stopped containers and their mounted volumes
  const volumeContainersMap = new Map<string, string[]>();
  const ps = await run("docker", ["ps", "-a", "-q"]).catch(() => null);
  const containerIds = ps?.stdout
    ? ps.stdout.trim().split(/\s+/).filter(Boolean)
    : [];

  if (containerIds.length > 0) {
    const inspectRes = await run("docker", [
      "inspect",
      "--format",
      "{{.Name}}\t{{range .Mounts}}{{.Type}}:{{.Name}} {{end}}",
      ...containerIds,
    ]).catch(() => null);

    if (inspectRes?.stdout) {
      for (const line of inspectRes.stdout.split(/\r?\n/)) {
        const [rawName, mountsStr] = line.split("\t");
        if (!rawName || !mountsStr) continue;
        const containerName = rawName.replace(/^\//, "");
        const tokens = mountsStr.trim().split(/\s+/).filter(Boolean);
        for (const token of tokens) {
          const [type, volName] = token.split(":");
          if (type === "volume" && volName) {
            const list = volumeContainersMap.get(volName) || [];
            if (!list.includes(containerName)) {
              list.push(containerName);
            }
            volumeContainersMap.set(volName, list);
          }
        }
      }
    }
  }

  // 3. Map to Prisma applications
  const apps = await prisma.app.findMany({
    select: {
      id: true,
      name: true,
      metadata: true,
    },
  });

  const volumeAppsMap = new Map<string, VolumeAppBinding[]>();
  for (const app of apps) {
    const meta = app.metadata as Record<string, any> | null;
    if (meta?.volumes && typeof meta.volumes === "object") {
      for (const [source, dest] of Object.entries(meta.volumes)) {
        if (typeof source === "string" && typeof dest === "string") {
          const list = volumeAppsMap.get(source) || [];
          if (!list.some((b) => b.appId === app.id)) {
            list.push({
              appId: app.id,
              appName: app.name,
              containerPath: dest,
            });
          }
          volumeAppsMap.set(source, list);
        }
      }
    }
  }

  // 4. Combine into VolumeItem[]
  let volumes: VolumeItem[] = rawVolumes.map((raw) => {
    const attachedContainers = volumeContainersMap.get(raw.name) || [];
    const attachedApps = volumeAppsMap.get(raw.name) || [];
    const inUse =
      attachedContainers.length > 0 ||
      (typeof raw.links === "number" && raw.links > 0);

    return {
      name: raw.name,
      driver: raw.driver,
      scope: raw.scope,
      mountpoint: raw.mountpoint,
      size: raw.size,
      apps: attachedApps,
      containers: attachedContainers,
      inUse,
      links: raw.links,
    };
  });

  // 5. Optional filter by app
  if (queryApp) {
    const lowerApp = queryApp.toLowerCase();
    volumes = volumes.filter((v) =>
      v.apps.some(
        (a) =>
          a.appId.toLowerCase() === lowerApp ||
          a.appName.toLowerCase() === lowerApp,
      ),
    );
  }

  return { success: true, data: volumes };
}
