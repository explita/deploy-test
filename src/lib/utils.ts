import { server } from "./constants.js";
import { REDIS_CONTAINER_NAME } from "@explita/infra-protocol/deploy";

export function resolveRedisConfig() {
  const enabled = process.env.REDIS_ENABLED === "true";
  let defaultPort = 6379;

  if (!enabled) {
    return {
      enabled: false,
      port: undefined,
      defaultPort,
      password: undefined,
      user: "default",
      dataDir: server.redisDataDir,
      maxDatabases: 256,
      containerName: REDIS_CONTAINER_NAME,
    };
  }

  const rawPort = process.env.REDIS_PORT?.trim();
  let port: number | undefined;
  if (rawPort) {
    const parsed = Number(rawPort);
    if (Number.isNaN(parsed) || parsed <= 0) {
      throw new Error(`Invalid REDIS_PORT environment variable: "${rawPort}"`);
    }
    port = parsed;
  }

  const password = process.env.REDIS_PASSWORD?.trim() || undefined;
  const user = process.env.REDIS_USER?.trim() || "default";
  const maxDatabases = Number(process.env.REDIS_MAX_DATABASES) || 256;

  return {
    enabled: true,
    port,
    defaultPort,
    password,
    user,
    dataDir: server.redisDataDir,
    maxDatabases,
    containerName: REDIS_CONTAINER_NAME,
  };
}
