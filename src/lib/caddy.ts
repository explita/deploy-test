import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { caddy, docker, backup, server } from "./constants.js";
import { run, stream } from "./runner.js";
import { logger } from "@explita/protocol";
import { cleanDomain } from "@explita/protocol/deploy";
import { findAppByIdOrName } from "./app-helpers.js";
import {
  renderMaintenanceHtml,
  resolveCustomMaintenanceFile,
} from "./maintenance-helpers.js";
import { FormattedApp } from "./formatters/app.js";

function toDockerPath(p: string): string {
  return p.replace(/\\/g, "/");
}

export async function syncServerCaddy(): Promise<void> {
  const filePath = join(caddy.appsDir, "_server.caddy");

  if (server.domain) {
    const domain = cleanDomain(server.domain);
    if (!domain) {
      if (existsSync(filePath)) {
        await unlink(filePath).catch(() => null);
        await reloadCaddy();
      }
      return;
    }

    const caddyConfig = `${domain} {
    reverse_proxy host.docker.internal:${server.port}
}
`;
    await writeFile(filePath, caddyConfig, "utf8");
    logger.info(
      `Server route active: https://${domain} -> host.docker.internal:${server.port}`,
    );
  } else {
    if (existsSync(filePath)) {
      await unlink(filePath).catch(() => null);
      logger.info("Removed server route");
      await reloadCaddy();
    }
  }
}

export async function ensureCaddy(): Promise<void> {
  await mkdir(caddy.appsDir, { recursive: true });
  await mkdir(caddy.dataDir, { recursive: true });
  await mkdir(backup.maintenanceDir, { recursive: true });

  if (!existsSync(caddy.filePath)) {
    const defaultCaddyfile = `{
    # Global options
}

import /etc/caddy/apps/*.caddy
`;
    await writeFile(caddy.filePath, defaultCaddyfile, "utf8");
  }

  // Check if explita-caddy is running
  const inspect = await run("docker", [
    "inspect",
    "--format",
    "{{.State.Running}}",
    caddy.containerName,
  ]).catch(() => ({ code: 1, stdout: "", stderr: "" }));

  if (inspect.code === 0 && inspect.stdout.trim() === "true") {
    const mountInspect = await run("docker", [
      "inspect",
      "--format",
      "{{range .Mounts}}{{.Destination}} {{end}}",
      caddy.containerName,
    ]).catch(() => ({ code: 1, stdout: "", stderr: "" }));

    if (mountInspect.stdout.includes("/var/www/custom")) {
      logger.always(`Container ${caddy.containerName} is running.`);
      await syncServerCaddy();
      return;
    }
    logger.always(
      `Recreating ${caddy.containerName} to mount /var/www/custom...`,
    );
  } else if (inspect.code === 0) {
    logger.always(`Starting stopped container ${caddy.containerName}...`);
    const startRes = await stream("docker", ["start", caddy.containerName], {
      onLine: (line) => logger.always(` caddy | ${line}`),
    });
    if (startRes.code === 0) {
      await syncServerCaddy();
      return;
    }
  }

  // Remove dead container if present
  await run("docker", ["rm", "-f", caddy.containerName]).catch(() => null);

  logger.always(`Spawning ${caddy.containerName} on ${docker.network}...`);
  const spawnRes = await stream(
    "docker",
    [
      "run",
      "-d",
      "--name",
      caddy.containerName,
      "--network",
      docker.network,
      "--restart",
      "unless-stopped",
      "--add-host",
      "host.docker.internal:host-gateway",
      "-p",
      "80:80",
      "-p",
      "443:443",
      "-v",
      `${toDockerPath(caddy.filePath)}:/etc/caddy/Caddyfile`,
      "-v",
      `${toDockerPath(caddy.appsDir)}:/etc/caddy/apps`,
      "-v",
      `${toDockerPath(caddy.dataDir)}:/data`,
      "-v",
      `${toDockerPath(backup.maintenanceDir)}:/var/www/custom`,
      "caddy:2-alpine",
    ],
    {
      onLine: (line) => logger.always(` caddy | ${line}`),
    },
  );

  if (spawnRes.code !== 0) {
    throw new Error(
      `Failed to start Caddy container (${caddy.containerName}): ${spawnRes.stderr || spawnRes.stdout}`,
    );
  }

  logger.always(`Container ${caddy.containerName} started successfully.`);
  await syncServerCaddy();
}

export async function reloadCaddy(): Promise<void> {
  const reloadRes = await run("docker", [
    "exec",
    caddy.containerName,
    "caddy",
    "reload",
    "--config",
    "/etc/caddy/Caddyfile",
  ]).catch(() => null);

  if (reloadRes && reloadRes.code !== 0) {
    logger.always(`Reload warning: ${reloadRes.stderr || reloadRes.stdout}`);
  }
}

export async function syncAppCaddy(appIdOrName: string): Promise<void> {
  await ensureCaddy();
  const app = await findAppByIdOrName(appIdOrName);

  if (!app) return;

  const safeName = app.name.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const appConfigFile = join(caddy.appsDir, `${safeName}.caddy`);
  const activeDeployment = app.currentDeployment;

  const meta = app.metadata;
  const maintenance = meta.maintenance;
  const isMaintenance = Boolean(maintenance?.enabled);

  if (isMaintenance) {
    await handleMaitenanceMode(app, appConfigFile);
  } else if (app.domains.length > 0 && activeDeployment?.containerName) {
    const port = app.port || 3000;
    const domainHosts = app.domains.map((d) => d.hostname.trim()).join(", ");
    const caddyConfig = `${domainHosts} {
    reverse_proxy ${activeDeployment.containerName}:${port}
}
`;
    await writeFile(appConfigFile, caddyConfig, "utf8");
    logger.info(
      `Updated route for ${app.name} (${domainHosts} -> ${activeDeployment.containerName}:${port})`,
    );
  } else {
    if (existsSync(appConfigFile)) {
      await unlink(appConfigFile).catch(() => null);
      logger.info(`Removed route for ${app.name}`);
    }
  }

  await reloadCaddy();
}

export async function removeAppCaddy(appName: string): Promise<void> {
  const safeName = appName.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const appConfigFile = join(caddy.appsDir, `${safeName}.caddy`);
  if (existsSync(appConfigFile)) {
    await unlink(appConfigFile).catch(() => null);
    logger.info(`Removed route for ${appName}`);
  }
  await reloadCaddy();
}

export function getPreviewCaddyConfigPath(deploymentId: string): string {
  const safeId = deploymentId.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return join(caddy.appsDir, `preview-${safeId}.caddy`);
}

export async function hashCaddyPassword(password: string): Promise<string> {
  await ensureCaddy();
  const res = await run(
    "docker",
    ["exec", "-i", caddy.containerName, "caddy", "hash-password"],
    { stdin: `${password.trim()}\n` },
  );

  if (res.code === 0 && res.stdout.trim()) {
    return res.stdout.trim();
  }

  // Fallback to explicit --plaintext if stdin is unbuffered
  const fallback = await run("docker", [
    "exec",
    caddy.containerName,
    "caddy",
    "hash-password",
    "--plaintext",
    password.trim(),
  ]);

  if (fallback.code === 0 && fallback.stdout.trim()) {
    return fallback.stdout.trim();
  }

  throw new Error(
    `Failed to hash password via Caddy: ${fallback.stderr || res.stderr || "Unknown error"}`,
  );
}

export async function syncPreviewCaddy(
  deploymentId: string,
  domains: string[],
  containerName: string,
  port: number,
  auth?: string | null,
): Promise<string[]> {
  await ensureCaddy();
  const filePath = getPreviewCaddyConfigPath(deploymentId);
  const validDomains = domains.map((d) => cleanDomain(d)).filter(Boolean);

  if (validDomains.length === 0) {
    if (existsSync(filePath)) {
      await unlink(filePath).catch(() => null);
      await reloadCaddy();
    }
    return [];
  }

  let basicAuthDirective = "";
  if (auth && auth.includes(":")) {
    const colonIdx = auth.indexOf(":");
    const username = auth.slice(0, colonIdx).trim();
    const password = auth.slice(colonIdx + 1);

    if (username && password) {
      try {
        const hashedPassword = await hashCaddyPassword(password);
        basicAuthDirective = `    basic_auth {
        ${username} ${hashedPassword}
    }
`;
      } catch (err) {
        logger.warn(
          `Failed to configure basic_auth for preview ${deploymentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  const domainHosts = validDomains.join(", ");
  const caddyConfig = `${domainHosts} {
${basicAuthDirective}    reverse_proxy ${containerName}:${port}
}
`;
  await writeFile(filePath, caddyConfig, "utf8");
  logger.info(
    `Updated preview route for ${deploymentId} (${domainHosts} -> ${containerName}:${port}${basicAuthDirective ? " [basic_auth enabled]" : ""})`,
  );

  await reloadCaddy();

  return validDomains.map((d) => `https://${d}`);
}

export async function removePreviewCaddy(deploymentId: string): Promise<void> {
  const filePath = getPreviewCaddyConfigPath(deploymentId);

  if (existsSync(filePath)) {
    await unlink(filePath).catch(() => null);
    logger.info(`Removed preview route for ${deploymentId}`);

    await reloadCaddy();
  }
}

async function handleMaitenanceMode(app: FormattedApp, appConfigFile: string) {
  const meta = app.metadata;

  const domainHosts = app.domains.map((d) => d.hostname.trim()).filter(Boolean);
  const tunnelHost =
    meta.tunnel?.enabled !== false && meta.tunnel?.url ? meta.tunnel.url : null;

  const allHosts = [...domainHosts, ...(tunnelHost ? [tunnelHost] : [])];

  if (allHosts.length > 0) {
    const customFile = resolveCustomMaintenanceFile(app.id);
    let maintenanceDirective: string;

    if (customFile) {
      logger.info(
        `Serving custom maintenance file (${customFile}) from disk for ${app.name}`,
      );
      maintenanceDirective = `    root * /var/www/custom
    rewrite * /${customFile}
    file_server {
        status 503
    }`;
    } else {
      const fallbackHtml = renderMaintenanceHtml(app.name);
      maintenanceDirective = `    respond <<HTML
${fallbackHtml}
HTML 503`;
    }

    const caddyConfig = `${allHosts.join(", ")} {
    header Content-Type "text/html; charset=utf-8"
    header Retry-After 300
    header Cache-Control "no-store, no-cache, must-revalidate"
${maintenanceDirective}
}
`;
    await writeFile(appConfigFile, caddyConfig, "utf8");
    logger.info(
      `Maintenance mode route active for ${app.name} (${allHosts.join(", ")})`,
    );
  } else {
    if (existsSync(appConfigFile)) {
      await unlink(appConfigFile).catch(() => null);
    }
  }
}
