import { resolve } from "node:path";
import {
  CADDY_CONTAINER_NAME,
  DEFAULT_DOCKER_NETWORK,
} from "@explita/protocol/deploy";
import {
  DEFAULT_TUNNEL_DOMAIN,
  DEFAULT_TUNNEL_IMAGE,
  parseSize,
  requireEnv,
  normalizeTunnelServerUrl,
} from "@explita/protocol";

const parsedPort = Number(requireEnv("PORT"));
if (Number.isNaN(parsedPort) || parsedPort <= 0) {
  throw new Error(`Invalid PORT environment variable: "${process.env.PORT}"`);
}

const rawDataDir = resolve(requireEnv("DATA_DIR"));
const extDbUrl = process.env.DATABASE_URL?.trim();
const rawTunnelSrvUrl = process.env.TUNNEL_SERVER_URL?.trim();
const tunnelSrvUrl = rawTunnelSrvUrl
  ? normalizeTunnelServerUrl(rawTunnelSrvUrl)
  : undefined;

// Grouped Domain Configurations
export const server = {
  port: parsedPort,
  host: requireEnv("HOST"),
  domain: process.env.DEPLOY_DOMAIN?.toLowerCase()?.trim() || undefined,
  token: requireEnv("DEPLOY_TOKEN"),
  passcode: process.env.DEPLOY_PASSCODE?.trim() || undefined,
  twoFactorSecret: process.env.DEPLOY_2FA_SECRET?.trim() || undefined,
  dataDir: rawDataDir,
  deployBaseDir: `${rawDataDir}/deployments`,
  redisDataDir: process.env.REDIS_DATA_DIR?.trim() || `${rawDataDir}/redis`,
  maxRequestBodySize: parseSize(
    process.env.MAX_REQUEST_BODY_SIZE,
    100 * 1024 * 1024,
  ),
};

export const docker = {
  network: DEFAULT_DOCKER_NETWORK,
  imageRetentionLimit: Number(requireEnv("IMAGE_RETENTION_LIMIT")),
};

export const cron = {
  historyLimit: Math.max(1, Number(process.env.CRON_HISTORY_LIMIT) || 50),
};

const pgPassword = process.env.POSTGRES_ROOT_PASSWORD?.trim();

const pgPortEnv = process.env.POSTGRES_PORT;
const pgHostPort = pgPortEnv ? Number(pgPortEnv) : extDbUrl ? undefined : 5432;

export const postgres = {
  dataDir: resolve(
    process.env.POSTGRES_DATA_DIR?.trim() || `${rawDataDir}/postgres`,
  ),
  password: pgPassword,
  user: process.env.POSTGRES_USER?.trim() || "explita",
  name: process.env.POSTGRES_DB?.trim() || "explita_deploy",
  port: 5432,
  hostPort: pgHostPort,
  host: "127.0.0.1",
};

export const appDbUrl =
  process.env.DATABASE_URL ||
  `postgresql://${encodeURIComponent(postgres.user)}:${encodeURIComponent(postgres.password)}@${postgres.host}:${pgHostPort}/${encodeURIComponent(postgres.name)}`;

const mysqlPortEnv = process.env.MYSQL_PORT;
export const mariadb = {
  dataDir: resolve(
    process.env.MYSQL_DATA_DIR?.trim() || `${rawDataDir}/mariadb`,
  ),
  rootPassword: process.env.MYSQL_ROOT_PASSWORD?.trim(),
  port: 3306,
  hostPort: mysqlPortEnv ? Number(mysqlPortEnv) : undefined,
};

export const database = {
  externalUrl: extDbUrl,
};

export const caddy = {
  dir: resolve(rawDataDir, "caddy"),
  appsDir: resolve(rawDataDir, "caddy", "apps"),
  dataDir: resolve(rawDataDir, "caddy", "data"),
  filePath: resolve(rawDataDir, "caddy", "Caddyfile"),
  containerName: CADDY_CONTAINER_NAME,
};

export const backup = {
  dir: resolve(rawDataDir, "backups"),
  databasesDir: resolve(rawDataDir, "backups", "databases"),
};

export const custom = {
  dir: resolve(rawDataDir, "custom"),
  filesDir: resolve(rawDataDir, "custom", "files"),
  caddyDir: resolve(rawDataDir, "custom", "caddy"),
};

export function getAppDbBackupDir(appId: string): string {
  return resolve(backup.databasesDir, appId);
}

export const tunnel = {
  serverUrl: tunnelSrvUrl,
  token: process.env.TUNNEL_TOKEN?.trim(),
  domain:
    process.env.TUNNEL_DOMAIN?.toLowerCase()?.trim() || DEFAULT_TUNNEL_DOMAIN,
  image: process.env.TUNNEL_IMAGE?.trim() || DEFAULT_TUNNEL_IMAGE,
  isExplita: Boolean(!tunnelSrvUrl || tunnelSrvUrl.includes("explita.ng")),
  enabled: process.env.TUNNEL_ENABLED === "true",
};

export const globalS3 = {
  endpoint: process.env.GLOBAL_S3_ENDPOINT?.trim(),
  region: process.env.GLOBAL_S3_REGION?.trim() || "auto",
  bucket: process.env.GLOBAL_S3_BUCKET?.trim(),
  accessKeyId: process.env.GLOBAL_S3_ACCESS_KEY_ID?.trim(),
  secretAccessKey: process.env.GLOBAL_S3_SECRET_ACCESS_KEY?.trim(),
  prefix: process.env.GLOBAL_S3_PREFIX?.trim() || "backups",
  forcePathStyle: process.env.GLOBAL_S3_FORCE_PATH_STYLE === "true",
  enabled:
    process.env.GLOBAL_S3_ENABLED === "true" ||
    Boolean(
      process.env.GLOBAL_S3_BUCKET?.trim() &&
      process.env.GLOBAL_S3_ACCESS_KEY_ID?.trim() &&
      process.env.GLOBAL_S3_SECRET_ACCESS_KEY?.trim(),
    ),
};
