import { mkdir } from "node:fs/promises";
import { Socket } from "node:net";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { run, stream } from "./runner.js";
import { database, docker, postgres } from "./constants.js";
import { POSTGRES_CONTAINER_NAME, logger } from "@explita/protocol";

function getPrismaCliPath(): string {
  const require = createRequire(import.meta.url);
  const pkgJsonPath = require.resolve("prisma/package.json");
  return join(dirname(pkgJsonPath), "build", "index.js");
}

export async function ensureManagedPostgres(): Promise<void> {
  if (!postgres.password) {
    throw new Error(
      "Missing POSTGRES_ROOT_PASSWORD in .env. A secure root password is required to run managed PostgreSQL.",
    );
  }

  // Ensure volume directory exists on the host
  await mkdir(postgres.dataDir, { recursive: true });

  // Check if container already exists
  const inspect = await run("docker", [
    "inspect",
    "--format",
    "{{.State.Running}}",
    POSTGRES_CONTAINER_NAME,
  ]);

  if (inspect.code !== 0) {
    logger.always(
      `Initializing PostgreSQL container (${POSTGRES_CONTAINER_NAME}) on ${postgres.dataDir}...`,
    );

    const runArgs = [
      "run",
      "-d",
      "--name",
      POSTGRES_CONTAINER_NAME,
      "--restart",
      "unless-stopped",
      "--network",
      docker.network,
      "-v",
      `${postgres.dataDir}:/var/lib/postgresql/data`,
      "-e",
      `PGPORT=${postgres.port}`,
      "-e",
      `POSTGRES_USER=${postgres.user}`,
      "-e",
      `POSTGRES_PASSWORD=${postgres.password}`,
      "-e",
      `POSTGRES_DB=${postgres.name}`,
    ];

    if (postgres.hostPort) {
      runArgs.push("-p", `127.0.0.1:${postgres.hostPort}:${postgres.port}`);
    }

    runArgs.push("postgres:17-alpine");

    const start = await stream("docker", runArgs, {
      onLine: (line) => logger.always(` pg | ${line}`),
    });

    if (start.code !== 0) {
      throw new Error(
        `Failed to start PostgreSQL container: ${start.stderr || start.stdout}`,
      );
    }
  } else if (inspect.stdout.trim() !== "true") {
    logger.always(
      `Starting stopped PostgreSQL container (${POSTGRES_CONTAINER_NAME})...`,
    );
    const start = await stream("docker", ["start", POSTGRES_CONTAINER_NAME], {
      onLine: (line) => logger.always(` pg | ${line}`),
    });
    if (start.code !== 0) {
      throw new Error(
        `Failed to start stopped PostgreSQL container: ${start.stderr || start.stdout}`,
      );
    }
  }

  // Wait for PostgreSQL to accept connections on socket (and TCP port if mapped)
  await waitForPostgres(
    POSTGRES_CONTAINER_NAME,
    postgres.user,
    postgres.port,
    postgres.hostPort,
  );
}

export async function ensureDatabase(): Promise<string> {
  let targetUrl: string;

  // If external database URL is configured, use it directly for control plane
  if (database.externalUrl) {
    if (!isPostgresDb(database.externalUrl)) {
      throw new Error(
        "External database URL is not a PostgreSQL database URL.",
      );
    }
    logger.always("Using external PostgreSQL database.");
    targetUrl = database.externalUrl;
  } else {
    await ensureManagedPostgres();

    const hostPort = postgres.hostPort;
    targetUrl = `postgresql://${encodeURIComponent(postgres.user)}:${encodeURIComponent(postgres.password)}@${postgres.host}:${hostPort}/${encodeURIComponent(postgres.name)}`;
    logger.always(
      `Database ready at ${postgres.host}:${hostPort}/${postgres.name}`,
    );
  }

  process.env.DATABASE_URL = targetUrl;

  // Programmatically ensure database schema and tables exist
  await syncPrismaSchema(targetUrl);

  return targetUrl;
}

function checkTcpPort(
  host: string,
  port: number,
  timeoutMs = 1000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

async function waitForPostgres(
  containerName: string,
  user: string,
  port: number,
  hostPort?: number,
  timeoutMs: number = 30000,
): Promise<void> {
  const start = Date.now();
  let socketReady = false;

  while (Date.now() - start < timeoutMs) {
    if (!socketReady) {
      const check = await run("docker", [
        "exec",
        containerName,
        "pg_isready",
        "-U",
        user,
        "-p",
        String(port),
      ]);
      if (check.code === 0) {
        socketReady = true;
      }
    }

    if (socketReady) {
      if (hostPort) {
        const tcpReady = await checkTcpPort("127.0.0.1", hostPort);
        if (tcpReady) {
          await new Promise((r) => setTimeout(r, 1000));
          return;
        }
      } else {
        await new Promise((r) => setTimeout(r, 1000));
        return;
      }
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  const logs = await run("docker", ["logs", "--tail", "15", containerName]);
  const logDetails = `${logs.stderr || ""}\n${logs.stdout || ""}`.trim();

  throw new Error(
    `Timed out waiting for PostgreSQL container and TCP port to become ready.${logDetails ? `\nRecent container logs:\n${logDetails}` : ""}`,
  );
}

async function syncPrismaSchema(
  databaseUrl: string,
  maxAttempts = 6,
): Promise<void> {
  logger.always("Synchronizing database schema with Prisma...");
  const prismaCli = getPrismaCliPath();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await run(process.execPath, [
        prismaCli,
        "db",
        "push",
        "--url",
        databaseUrl,
      ]);
      if (res.code === 0) {
        logger.always("Database schema is in sync.");
        return;
      }

      if (attempt < maxAttempts) {
        logger.always(
          `Database warming up, retrying schema sync (attempt ${attempt}/${maxAttempts})...`,
        );
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        throw new Error(
          `Prisma schema sync failed (exit code ${res.code}): ${res.stderr || res.stdout}`,
        );
      }
    } catch (err) {
      if (attempt < maxAttempts) {
        logger.always(
          `Retrying schema sync in 2s (attempt ${attempt}/${maxAttempts})...`,
        );
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        throw new Error(
          `Prisma schema sync error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

export function isPostgresDb(val: unknown) {
  if (typeof val !== "string") return false;
  return val.startsWith("postgresql:") || val.startsWith("postgres:");
}
