import { prisma } from "./prisma.js";
import { run, stream } from "./runner.js";
import { caddy, docker, tunnel } from "./constants.js";
import { FormattedApp } from "./formatters/app.js";
import { logger } from "@explita/infra-protocol";
import {
  DEFAULT_CONTAINER_PORT,
  getAppTunnelContainerName,
  getAppTunnelSubdomain,
  getPreviewTunnelContainerName,
  getPreviewTunnelSubdomain,
} from "@explita/infra-protocol/deploy";
import { InputJsonValue } from "../generated/prisma/internal/prismaNamespace.js";
import { stripIdPrefix } from "./id.js";

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

export function extractTunnelError(cleanOutput: string): string | null {
  if (/already in use by an active session/i.test(cleanOutput)) {
    const match = cleanOutput.match(/Subdomain "([^"]+)" is already in use/i);
    const sub = match ? `Subdomain "${match[1]}"` : "Subdomain";
    return `${sub} is already in use by an active session. Choose a different subdomain with -s / --subdomain, or stop the conflicting tunnel session.`;
  }
  if (
    /Invalid tunnel token|Token.*invalid|Unauthorized|Forbidden/i.test(
      cleanOutput,
    )
  ) {
    return "Invalid or unauthorized tunnel token. Check TUNNEL_TOKEN in your .env configuration.";
  }
  if (/Unable to connect to the tunnel service/i.test(cleanOutput)) {
    return "Unable to connect to the tunnel service. Please verify network connectivity or TUNNEL_SERVER_URL.";
  }
  if (/Failed to connect:/i.test(cleanOutput)) {
    const lines = cleanOutput
      .split("\n")
      .map((l) => l.trim().replace(/^[-*•]\s*/, ""))
      .filter((l) => l.length > 0 && !l.startsWith("Failed to connect:"));
    if (lines.length > 0) {
      return lines.slice(0, 2).join(". ");
    }
    return "Tunnel connection to server failed";
  }
  return null;
}

/**
 * Extracts the verified public tunnel URL by polling the container logs.
 * Throws a descriptive error if the container crashes or connection fails.
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
      "50",
      containerName,
    ]).catch(() => ({ code: 1, stdout: "", stderr: "" }));

    const output = `${res.stdout}\n${res.stderr}`;
    const cleanOutput = output.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "");
    const match = cleanOutput.match(urlRegex);
    if (match?.[1]) {
      return match[1].trim();
    }

    // Check for explicit tunnel connection failure messages
    const explicitErr = extractTunnelError(cleanOutput);
    if (explicitErr) {
      await run("docker", ["rm", "-f", containerName]).catch(() => null);
      throw new Error(explicitErr);
    }

    // Stop early if container crashed/exited
    const inspectRes = await run("docker", [
      "inspect",
      "--format",
      "{{.State.Running}} {{.State.ExitCode}}",
      containerName,
    ]).catch(() => ({ code: 1, stdout: "", stderr: "" }));

    if (inspectRes.code === 0) {
      const [running, exitCodeStr] = inspectRes.stdout.trim().split(" ");
      if (running === "false") {
        await run("docker", ["rm", "-f", containerName]).catch(() => null);
        const exitCode = Number(exitCodeStr || "1");
        const errDetail =
          extractTunnelError(cleanOutput) ||
          cleanOutput.trim().split("\n").filter(Boolean).slice(-2).join(" ") ||
          `container exited with code ${exitCode}`;
        throw new Error(`Tunnel failed: ${errDetail}`);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  // If timeout expired without receiving a public URL or clean connection
  const timeoutLogs = await run("docker", [
    "logs",
    "--tail",
    "20",
    containerName,
  ]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  const finalClean = `${timeoutLogs.stdout}\n${timeoutLogs.stderr}`.replace(
    /\u001b\[[0-9;]*[a-zA-Z]/g,
    "",
  );
  const finalErr = extractTunnelError(finalClean);
  await run("docker", ["rm", "-f", containerName]).catch(() => null);
  if (finalErr) {
    throw new Error(finalErr);
  }

  throw new Error(
    `Tunnel timed out: tunnel container did not establish connection within ${timeoutMs / 1000}s`,
  );
}

export async function syncAppTunnel(
  app: FormattedApp,
  targetContainerName?: string,
): Promise<string | null> {
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
  const rawAppId = stripIdPrefix(app.id);
  const rawDepId = stripIdPrefix(app.currentDeploymentId || "");

  const activeDeployment = targetContainerName
    ? null
    : app.currentDeployment
      ? app.currentDeployment
      : rawDepId
        ? await prisma.deployment.findUnique({
            where: { id: rawDepId },
          })
        : await prisma.deployment.findFirst({
            where: {
              appId: rawAppId,
              status: { in: ["LIVE", "HEALTH_CHECK"] },
            },
            orderBy: { startedAt: "desc" },
          });

  const targetHost = isMaintenance
    ? caddy.containerName
    : targetContainerName || activeDeployment?.containerName;

  if (!targetHost) {
    await removeAppTunnel(app);
    return null;
  }

  // Ensure target container is currently running if not in maintenance
  if (!isMaintenance && targetHost) {
    const inspect = await run("docker", [
      "inspect",
      "--format",
      "{{.State.Running}}",
      targetHost,
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

  const tunnelContainerName = getAppTunnelContainerName(rawAppId);
  const subdomain = getAppTunnelSubdomain(app);
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
    `explita.app.id=${rawAppId}`,
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
    throw new Error(errMsg);
  }

  const fallbackUrl = `https://${subdomain}.${tunnel.domain}`;
  try {
    const tunnelUrl = await resolveTunnelUrlFromContainer(
      tunnelContainerName,
      fallbackUrl,
    );

    meta.tunnel = { enabled: true, url: tunnelUrl, subdomain: subdomain };
    // Persist tunnel URL in App metadata for fast lookups
    await prisma.app.update({
      where: { id: rawAppId },
      data: {
        metadata: meta as InputJsonValue,
      },
    });

    logger.info(`Tunnel active for ${app.name}: ${tunnelUrl}`);
    return tunnelUrl;
  } catch (err) {
    await removeAppTunnel(app);
    throw err;
  }
}

export async function removeAppTunnel(app: FormattedApp): Promise<void> {
  const rawAppId = stripIdPrefix(app.id);
  const tunnelContainerName = getAppTunnelContainerName(rawAppId);
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
        where: { id: rawAppId },
        data: { metadata: meta as InputJsonValue },
      });
    }
  } catch (err) {
    logger.warn(`Failed to clear tunnel metadata for ${rawAppId}:`, err);
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

  try {
    const verifiedPreviewUrl = await resolveTunnelUrlFromContainer(
      previewTunnelContainerName,
      previewUrl,
    );
    return verifiedPreviewUrl;
  } catch (err) {
    await removePreviewTunnel(deploymentId);
    throw err;
  }
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
