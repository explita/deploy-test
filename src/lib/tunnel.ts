import { prisma } from "./prisma.js";
import { run, stream } from "./runner.js";
import { caddy, docker, tunnel } from "./constants.js";
import { FormattedApp } from "./formatters/app.js";
import { logger } from "@explita/protocol";
import {
  DEFAULT_CONTAINER_PORT,
  getAppTunnelContainerName,
  getAppTunnelSubdomain,
  getPreviewTunnelContainerName,
  getPreviewTunnelSubdomain,
} from "@explita/protocol/deploy";
import { InputJsonValue } from "../generated/prisma/internal/prismaNamespace.js";

export async function ensureTunnelImage(): Promise<boolean> {
  if (!tunnel.enabled || !tunnel.image) {
    return false;
  }

  // 1. Check if the tunnel image already exists locally
  const inspectRes = await run("docker", [
    "image",
    "inspect",
    tunnel.image,
  ]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  if (inspectRes.code === 0) {
    return true;
  }

  logger.info(
    `Tunnel image "${tunnel.image}" not found locally. Pulling from registry...`,
  );

  // 2. Pull from container registry
  const pullRes = await stream("docker", ["pull", tunnel.image], {
    onLine: (line) => logger.always(` tunnel | ${line}`),
  }).catch(() => ({
    code: 1,
    stdout: "",
    stderr: "",
  }));
  if (pullRes.code === 0) {
    logger.info(`Successfully pulled tunnel image "${tunnel.image}"`);
    return true;
  }

  logger.warn(
    `Failed to pull tunnel image "${tunnel.image}": ${pullRes.stderr.trim() || pullRes.stdout.trim() || "Unknown error"}`,
  );
  return false;
}

/**
 * Extracts the verified public tunnel URL by polling the container logs.
 * Falls back to the constructed URL if logs cannot be parsed or on timeout.
 */
async function resolveTunnelUrlFromContainer(
  containerName: string,
  fallbackUrl: string,
  timeoutMs = 6000,
): Promise<string> {
  const start = Date.now();
  const urlRegex = /Public URL:\s*(https?:\/\/[^\s\u001b\r\n]+)/i;

  while (Date.now() - start < timeoutMs) {
    const res = await run("docker", [
      "logs",
      "--tail",
      "30",
      containerName,
    ]).catch(() => ({ code: 1, stdout: "", stderr: "" }));

    const output = `${res.stdout}\n${res.stderr}`;
    const cleanOutput = output.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "");
    const match = cleanOutput.match(urlRegex);
    if (match?.[1]) {
      return match[1].trim();
    }

    // Stop early if container crashed
    const inspectRes = await run("docker", [
      "inspect",
      "--format",
      "{{.State.Running}}",
      containerName,
    ]).catch(() => ({ code: 1, stdout: "", stderr: "" }));

    if (inspectRes.code === 0 && inspectRes.stdout.trim() === "false") {
      logger.warn(
        `Tunnel container ${containerName} exited: ${cleanOutput.trim()}`,
      );
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return fallbackUrl;
}

export async function syncAppTunnel(app: FormattedApp): Promise<string | null> {
  if (!tunnel.enabled) {
    await removeAppTunnel(app);
    return null;
  }

  const meta = app.metadata;

  const isTunnelRequested =
    meta.tunnel?.enabled === true || meta.tunnelEnabled === true;

  if (!isTunnelRequested) {
    await removeAppTunnel(app);
    return null;
  }

  const isMaintenance = Boolean(meta.maintenance?.enabled);

  const activeDeployment = app.currentDeploymentId
    ? await prisma.deployment.findUnique({
        where: { id: app.currentDeploymentId },
      })
    : await prisma.deployment.findFirst({
        where: { appId: app.id, status: { in: ["LIVE", "HEALTH_CHECK"] } },
        orderBy: { startedAt: "desc" },
      });

  if (!isMaintenance && !activeDeployment?.containerName) {
    await removeAppTunnel(app);
    return null;
  }

  // Ensure target container is currently running if not in maintenance
  if (!isMaintenance && activeDeployment?.containerName) {
    const inspect = await run("docker", [
      "inspect",
      "--format",
      "{{.State.Running}}",
      activeDeployment.containerName,
    ]).catch(() => ({ code: 1, stdout: "", stderr: "" }));

    if (inspect.code !== 0 || inspect.stdout.trim() !== "true") {
      await removeAppTunnel(app);
      return null;
    }
  }

  // If using explita tunnel without a token, skip gracefully with a log
  if (tunnel.isExplita && !tunnel.token) {
    logger.info(
      `Tunnel skipped for "${app.name}": TUNNEL_TOKEN is not configured in .env`,
    );
    await removeAppTunnel(app);
    return null;
  }

  // Ensure tunnel Docker image exists locally
  const hasImage = await ensureTunnelImage();
  if (!hasImage) {
    logger.warn(
      `Tunnel skipped for "${app.name}": Tunnel image ${tunnel.image} could not be acquired or built.`,
    );
    await removeAppTunnel(app);
    return null;
  }

  const tunnelContainerName = getAppTunnelContainerName(app.id);
  const subdomain = getAppTunnelSubdomain(app);
  const targetHost = isMaintenance
    ? caddy.containerName
    : activeDeployment!.containerName!;
  const targetPort = isMaintenance ? 80 : app.port || DEFAULT_CONTAINER_PORT;

  // Remove existing tunnel container to rebind to new live container target
  await run("docker", ["rm", "-f", tunnelContainerName]).catch(() => null);

  const dockerArgs = [
    "run",
    "-d",
    "--name",
    tunnelContainerName,
    "--restart",
    "unless-stopped",
    "--network",
    docker.network,
    "--label",
    `explita.app.id=${app.id}`,
    "--label",
    `explita.managed=true`,
    tunnel.image,
    "tunnel",
    String(targetPort),
    "--host",
    targetHost,
    "--subdomain",
    subdomain,
    "--no-inspect",
  ];

  if (tunnel.serverUrl) {
    dockerArgs.push("--server", tunnel.serverUrl);
  }
  if (tunnel.token) {
    dockerArgs.push("--token", tunnel.token);
  }

  const spawnMsg = `Spawning tunnel container ${tunnelContainerName} for ${app.name} (${subdomain}.${tunnel.domain} -> ${targetHost}:${targetPort}${isMaintenance ? " [MAINTENANCE]" : ""})...`;
  logger.info(`${spawnMsg}`);

  const spawnRes = await run("docker", dockerArgs);
  if (spawnRes.code !== 0) {
    const errMsg = `Failed to spawn tunnel container ${tunnelContainerName}: ${spawnRes.stderr || spawnRes.stdout}`;
    logger.warn(`${errMsg}`);
    await removeAppTunnel(app);
    return null;
  }

  const fallbackUrl = `https://${subdomain}.${tunnel.domain}`;
  const tunnelUrl = await resolveTunnelUrlFromContainer(
    tunnelContainerName,
    fallbackUrl,
  );

  meta.tunnel = { enabled: true, url: tunnelUrl, subdomain: subdomain };
  // Persist tunnel URL in App metadata for fast lookups
  await prisma.app.update({
    where: { id: app.id },
    data: {
      metadata: meta as InputJsonValue,
    },
  });

  logger.info(`Tunnel active for ${app.name}: ${tunnelUrl}`);

  return tunnelUrl;
}

export async function removeAppTunnel(app: FormattedApp): Promise<void> {
  const tunnelContainerName = getAppTunnelContainerName(app.id);
  const rm = await run("docker", ["rm", "-f", tunnelContainerName]).catch(
    () => null,
  );
  if (rm && rm.code === 0) {
    logger.info(`Removed tunnel container ${tunnelContainerName}`);
  }

  // Purge tunnelUrl and tunnelSubdomain from app metadata to prevent ghost state
  try {
    const meta = app.metadata;
    if ("tunnel" in meta) {
      delete meta.tunnel;
      await prisma.app.update({
        where: { id: app.id },
        data: { metadata: meta as InputJsonValue },
      });
    }
  } catch (err) {
    logger.warn(`Failed to clear tunnel metadata for ${app.id}:`, err);
  }
}

export async function syncPreviewTunnel(
  app: FormattedApp,
  deploymentId: string,
  containerName: string,
  port: number,
  subdomainPrefix?: string,
  auth?: string | null,
): Promise<string | null> {
  if (!tunnel.enabled) {
    logger.warn(
      `Preview tunnel unavailable for ${deploymentId}: tunnel is disabled on this server`,
    );
    return null;
  }

  const hasImage = await ensureTunnelImage();
  if (!hasImage) {
    logger.warn(
      `Preview tunnel unavailable for ${deploymentId}: tunnel image ${tunnel.image} could not be acquired`,
    );
    return null;
  }

  const previewSubdomain = getPreviewTunnelSubdomain(
    deploymentId,
    subdomainPrefix,
  );
  const previewTunnelContainerName =
    getPreviewTunnelContainerName(deploymentId);
  const previewUrl = `https://${previewSubdomain}.${tunnel.domain}`;

  // Remove existing preview tunnel container to ensure fresh connection
  await run("docker", ["rm", "-f", previewTunnelContainerName]).catch(
    () => null,
  );

  const dockerArgs = [
    "run",
    "-d",
    "--name",
    previewTunnelContainerName,
    "--restart",
    "unless-stopped",
    "--network",
    docker.network,
    "--label",
    `explita.app.id=${app.id}`,
    "--label",
    `explita.deployment.id=${deploymentId}`,
    "--label",
    "explita.preview=true",
    "--label",
    "explita.managed=true",
    tunnel.image,
    "tunnel",
    String(port),
    "--host",
    containerName,
    "--subdomain",
    previewSubdomain,
    "--no-inspect",
  ];

  if (auth && auth.includes(":")) {
    dockerArgs.push("--auth", auth.trim());
  }

  if (tunnel.serverUrl) {
    dockerArgs.push("--server", tunnel.serverUrl);
  }
  if (tunnel.token) {
    dockerArgs.push("--token", tunnel.token);
  }

  logger.info(
    `Spawning preview tunnel container ${previewTunnelContainerName} (${previewUrl} -> ${containerName}:${port})...`,
  );

  const spawnRes = await run("docker", dockerArgs);
  if (spawnRes.code !== 0) {
    logger.warn(
      `Failed to spawn preview tunnel container ${previewTunnelContainerName}: ${spawnRes.stderr || spawnRes.stdout}`,
    );
    return null;
  }

  const verifiedPreviewUrl = await resolveTunnelUrlFromContainer(
    previewTunnelContainerName,
    previewUrl,
  );

  return verifiedPreviewUrl;
}

export async function removePreviewTunnel(deploymentId: string): Promise<void> {
  const previewTunnelContainerName =
    getPreviewTunnelContainerName(deploymentId);
  const rm = await run("docker", [
    "rm",
    "-f",
    previewTunnelContainerName,
  ]).catch(() => null);

  if (rm && rm.code === 0) {
    logger.info(
      `Removed preview tunnel container ${previewTunnelContainerName}`,
    );
  }
}
