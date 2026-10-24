import { AppDbEntry } from "@explita/infra-protocol/deploy";
import { formatApp, FormattedApp } from "./formatters/app.js";
import { prisma } from "./prisma.js";
import { stripAppPrefixes, stripIdPrefix } from "./id.js";
import {
  AppEnvironmentOptions,
  ValidatedDbCloneParams,
} from "../types/misc.js";

export async function findAppByIdOrName(
  identifier: string,
  stripPrefixes?: boolean,
) {
  const cleanId = stripIdPrefix(identifier);
  const app = await prisma.app.findFirst({
    where: {
      OR: [
        { id: identifier },
        { name: identifier },
        ...(cleanId !== identifier ? [{ id: cleanId }] : []),
      ],
    },
    include: {
      domains: true,
      currentDeployment: true,
      databases: true,
      redis: true,
      crons: true,
      envs: true,
    },
  });

  if (!app) {
    return null;
  }

  const formatted = formatApp(app, { showAll: true });

  if (stripPrefixes) {
    return stripAppPrefixes(formatted);
  }

  return formatted;
}

export async function findDeployment(id: string) {
  const cleanId = stripIdPrefix(id);
  const deployment = await prisma.deployment.findFirst({
    where: {
      OR: [{ id: cleanId }, { tag: id }],
    },
    orderBy: { startedAt: "desc" },
    include: {
      app: {
        include: {
          domains: true,
          currentDeployment: true,
          databases: true,
          redis: true,
          crons: true,
          envs: true,
        },
      },
    },
  });

  if (!deployment) return null;

  return {
    ...deployment,
    app: stripAppPrefixes(formatApp(deployment.app, { showAll: true })),
  };
}

/**
 * Safely derives a preview database connection URL from a source database URL.
 * Fails closed (throws an error) if the protocol is invalid, if the URL cannot be parsed,
 * or if the path does not match the expected source database name.
 */
export function derivePreviewDatabaseUrl(
  sourceUrl: string,
  sourceDbName: string,
  cloneDbName: string,
): string {
  if (!sourceUrl) return "";

  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch (err) {
    throw new Error(
      `Safety violation: unable to parse source database URL: ${err instanceof Error ? err.message : String(err)}. Refusing to expose credentials to preview container.`,
    );
  }

  const allowedProtocols = new Set([
    "postgres:",
    "postgresql:",
    "mysql:",
    "mariadb:",
  ]);
  if (!allowedProtocols.has(parsed.protocol)) {
    throw new Error(
      `Safety violation: unsupported protocol "${parsed.protocol}" in database URL. Expected "postgres:", "postgresql:", "mysql:", or "mariadb:".`,
    );
  }

  const urlDbName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (urlDbName !== sourceDbName) {
    throw new Error(
      `Safety violation: database URL path "/${urlDbName}" does not match configured database name "${sourceDbName}". Refusing to clone connection string to prevent pointing preview to production.`,
    );
  }

  parsed.pathname = `/${encodeURIComponent(cloneDbName)}`;
  const cloneUrl = parsed.toString();

  if (!cloneUrl || cloneUrl === sourceUrl) {
    throw new Error(
      `Safety violation: generated preview database URL is identical to production database URL. Refusing to boot preview container with production credentials.`,
    );
  }

  return cloneUrl;
}

/**
 * Validates database cloning parameters and generates safe, sanitised database identifiers.
 * Throws a clear descriptive Error if any identifier contains illegal characters or if the port is invalid.
 */
export function validateDbCloneParams(
  sourceDb: AppDbEntry,
  deploymentId: string,
  adminUser: string,
  adminPort: number | string,
): ValidatedDbCloneParams {
  if (!/^[a-zA-Z0-9_]+$/.test(sourceDb.name)) {
    throw new Error(
      `Invalid characters in source database name: "${sourceDb.name}". Database names must be alphanumeric/underscores.`,
    );
  }
  if (!/^[a-zA-Z0-9_]+$/.test(sourceDb.user)) {
    throw new Error(
      `Invalid characters in database user name: "${sourceDb.user}". Usernames must be alphanumeric/underscores.`,
    );
  }
  if (!/^[a-zA-Z0-9_]+$/.test(adminUser)) {
    throw new Error(
      `Invalid characters in administrative database username: "${adminUser}".`,
    );
  }
  const safePort = Number(adminPort);
  if (Number.isNaN(safePort) || safePort <= 0 || safePort > 65535) {
    throw new Error(`Invalid database port: "${adminPort}".`);
  }

  const safeDeployId = deploymentId.toLowerCase().replace(/[^a-z0-9]/g, "");
  const safeSource = sourceDb.name.toLowerCase().replace(/[^a-z0-9_]/g, "");
  const prefix = safeSource.slice(0, 40);
  const cloneDbName = `${prefix}_prev_${safeDeployId}`.slice(0, 63);

  return {
    sourceDbName: sourceDb.name,
    ownerUser: sourceDb.user,
    cloneDbName,
    adminUser,
    safePort,
  };
}

/**
 * Extracts and consolidates all environment variables for an application, including:
 * - Primary/Default Database (DATABASE_URL)
 * - Secondary Databases (<KEY>_DATABASE_URL)
 * - Redis Cache (REDIS_URL)
 * - Decrypted Custom Application Environment Variables (app.envs)
 *
 * Supports preview database overrides and secret masking.
 */
export function getAppEnvironment(
  app: FormattedApp,
  options?: AppEnvironmentOptions,
) {
  const env: Record<string, string> = {};

  // 1. Primary/Default Database
  const defaultDb =
    app.databasesMap?.get("default") ||
    app.databasesMap?.get("primary") ||
    app.databases?.[0];

  const defaultClonedUrl =
    typeof options?.overrideDbUrls === "string"
      ? options.overrideDbUrls
      : (defaultDb && options?.overrideDbUrls?.get(defaultDb.key)) ||
        options?.overrideDbUrls?.get("default") ||
        options?.overrideDbUrls?.get("primary");

  const defaultDbUrl = defaultClonedUrl || defaultDb?.url;
  if (defaultDbUrl) {
    env["DATABASE_URL"] = defaultDbUrl;
  }

  // 2. Secondary Databases
  if (Array.isArray(app.databases)) {
    for (const db of app.databases) {
      if (db.key !== "default" && db.key !== "primary" && db.url) {
        const envKey = `${db.key.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}_DATABASE_URL`;
        const activeUrl =
          typeof options?.overrideDbUrls !== "string" &&
          options?.overrideDbUrls?.has(db.key)
            ? options.overrideDbUrls.get(db.key)!
            : db.url;
        env[envKey] = activeUrl;
      }
    }
  }

  // 3. Redis
  if (app.redis?.url) {
    env["REDIS_URL"] = app.redis.url;
  }

  // 4. Custom App Environment Variables (stored in app.envs)
  if (Array.isArray(app.envs)) {
    for (const e of app.envs) {
      if (e.key) {
        env[e.key] =
          options?.revealSecrets === false ? "••••••••" : (e.value ?? "");
      }
    }
  }

  // 5. Generate Docker CLI arguments
  const dockerArgs: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    dockerArgs.push("-e", `${key}=${value}`);
  }

  const meta = app.metadata;
  const resources = meta?.resources;
  if (resources?.memory) {
    dockerArgs.push(`--memory=${resources.memory}`);
  }
  if (resources?.cpus) {
    dockerArgs.push(`--cpus=${resources.cpus}`);
  }

  if (meta?.volumes && typeof meta.volumes === "object") {
    const volumeEntries = Object.entries(meta.volumes);
    for (const [hostOrVol, containerPath] of volumeEntries) {
      dockerArgs.push("-v", `${hostOrVol}:${containerPath}`);
    }
  }

  return { env, dockerArgs };
}

export const extractAppEnvironment = getAppEnvironment;
export const resolveAppEnvironment = getAppEnvironment;
