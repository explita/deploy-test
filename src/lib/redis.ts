import { mkdir } from "node:fs/promises";
import { run, stream } from "./runner.js";
import { docker } from "./constants.js";
import { resolveRedisConfig } from "./utils.js";
import { logger } from "@explita/infra-protocol";

export async function ensureRedis(): Promise<void> {
  const config = resolveRedisConfig();

  if (!config.enabled) {
    logger.always("Managed Redis is disabled (REDIS_ENABLED != true).");
    return;
  }

  await mkdir(config.dataDir, { recursive: true });

  const inspect = await run("docker", [
    "inspect",
    "--format",
    "{{.State.Running}}",
    config.containerName,
  ]);

  const targetPort = config.defaultPort;

  if (inspect.code !== 0) {
    logger.always(
      `Initializing Redis container (${config.containerName}) on ${config.dataDir}...`,
    );

    const runArgs = [
      "run",
      "-d",
      "--name",
      config.containerName,
      "--restart",
      "unless-stopped",
      "--network",
      docker.network,
      "-v",
      `${config.dataDir}:/data`,
    ];

    if (config.port) {
      runArgs.push("-p", `127.0.0.1:${config.port}:${config.port}`);
    }

    runArgs.push(
      "redis:7-alpine",
      "redis-server",
      "--appendonly",
      "yes",
      "--databases",
      String(config.maxDatabases),
      "--port",
      String(targetPort),
    );

    if (config.password) {
      runArgs.push("--requirepass", config.password);
    }

    const start = await stream("docker", runArgs, {
      onLine: (line) => logger.always(` redis | ${line}`),
    });
    if (start.code !== 0) {
      throw new Error(
        `Failed to start Redis container: ${start.stderr || start.stdout}`,
      );
    }
  } else if (inspect.stdout.trim() !== "true") {
    logger.always(
      `Starting stopped Redis container (${config.containerName})...`,
    );
    const start = await stream("docker", ["start", config.containerName], {
      onLine: (line) => logger.always(` redis | ${line}`),
    });
    if (start.code !== 0) {
      throw new Error(
        `Failed to start stopped Redis container: ${start.stderr || start.stdout}`,
      );
    }
  }

  await waitForRedis(config.containerName, targetPort, config.password);
  logger.always(
    config.port
      ? `Redis ready at 127.0.0.1:${config.port} (container port ${targetPort})`
      : `Redis ready on ${docker.network} (port ${targetPort})`,
  );
}

async function waitForRedis(
  containerName: string,
  port: number,
  password?: string,
  timeoutMs = 15000,
): Promise<void> {
  const start = Date.now();
  const pingArgs = ["exec", containerName, "redis-cli", "-p", String(port)];
  if (password) {
    pingArgs.push("-a", password, "--no-auth-warning");
  }
  pingArgs.push("ping");

  while (Date.now() - start < timeoutMs) {
    const check = await run("docker", pingArgs);
    if (check.code === 0 && check.stdout.includes("PONG")) {
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(`Timeout waiting for Redis container (${containerName})`);
}

export async function execRedisCli(
  cliArgs: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const config = resolveRedisConfig();
  const targetPort = config.defaultPort;

  const args = [
    "exec",
    config.containerName,
    "redis-cli",
    "-p",
    String(targetPort),
  ];
  if (config.password) {
    args.push("-a", config.password, "--no-auth-warning");
  }
  args.push(...cliArgs);

  return run("docker", args);
}

export function getAppRedisUrl(dbIndex: number): string {
  const config = resolveRedisConfig();
  const targetPort = config.defaultPort;
  const auth = config.password
    ? config.user && config.user !== "default"
      ? `${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@`
      : `:${encodeURIComponent(config.password)}@`
    : "";

  return `redis://${auth}${config.containerName}:${targetPort}/${dbIndex}`;
}
