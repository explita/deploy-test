import { mkdir } from "node:fs/promises";
import { Socket } from "node:net";
import { run, stream } from "./runner.js";
import { docker, mariadb } from "./constants.js";
import { MARIADB_CONTAINER_NAME, logger } from "@explita/protocol";

export async function ensureManagedMariaDb(): Promise<void> {
  if (!mariadb.rootPassword) {
    throw new Error(
      "Missing MYSQL_ROOT_PASSWORD (or MARIADB_ROOT_PASSWORD) in .env. A secure root password is required to run managed MariaDB.",
    );
  }

  // Ensure volume directory exists on the host
  await mkdir(mariadb.dataDir, { recursive: true });

  // Check if container already exists
  const inspect = await run("docker", [
    "inspect",
    "--format",
    "{{.State.Running}}",
    MARIADB_CONTAINER_NAME,
  ]);

  if (inspect.code !== 0) {
    logger.always(
      `Initializing MariaDB container (${MARIADB_CONTAINER_NAME}) on ${mariadb.dataDir}...`,
    );

    const runArgs = [
      "run",
      "-d",
      "--name",
      MARIADB_CONTAINER_NAME,
      "--restart",
      "unless-stopped",
      "--network",
      docker.network,
      "--network-alias",
      "explita-mysql",
      "-v",
      `${mariadb.dataDir}:/var/lib/mysql`,
      "-e",
      `MARIADB_ROOT_PASSWORD=${mariadb.rootPassword}`,
    ];

    if (mariadb.hostPort) {
      runArgs.push("-p", `127.0.0.1:${mariadb.hostPort}:${mariadb.port}`);
    }

    runArgs.push("mariadb:11-alpine");

    const start = await stream("docker", runArgs, {
      onLine: (line) => logger.always(` mariadb | ${line}`),
    });

    if (start.code !== 0) {
      throw new Error(
        `Failed to start MariaDB container: ${start.stderr || start.stdout}`,
      );
    }
  } else if (inspect.stdout.trim() !== "true") {
    logger.always(
      `Starting stopped MariaDB container (${MARIADB_CONTAINER_NAME})...`,
    );
    const start = await stream("docker", ["start", MARIADB_CONTAINER_NAME], {
      onLine: (line) => logger.always(` mariadb | ${line}`),
    });
    if (start.code !== 0) {
      throw new Error(
        `Failed to start stopped MariaDB container: ${start.stderr || start.stdout}`,
      );
    }
  }

  // Wait for MariaDB to accept connections
  await waitForMariaDb(
    MARIADB_CONTAINER_NAME,
    mariadb.rootPassword || "",
    mariadb.port,
    mariadb.hostPort,
  );
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

async function waitForMariaDb(
  containerName: string,
  rootPass: string,
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
        "mariadb-admin",
        "ping",
        "-u",
        "root",
        `-p${rootPass}`,
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
    `Timed out waiting for MariaDB container and TCP port to become ready.${logDetails ? `\nRecent container logs:\n${logDetails}` : ""}`,
  );
}

export function isMysqlOrMariaDb(val: unknown) {
  if (typeof val !== "string") return false;
  return val.startsWith("mysql:") || val.startsWith("mariadb:");
}
