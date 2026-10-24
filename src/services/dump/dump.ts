import { FastifyReply, FastifyRequest } from "fastify";
import { mkdtemp, mkdir, rm, writeFile, cp } from "node:fs/promises";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import { prisma } from "../../lib/prisma.js";
import { stream } from "../../lib/runner.js";
import { formatApp, FormattedApp } from "../../lib/formatters/app.js";
import { stripAppPrefixes } from "../../lib/id.js";
import { getAppEnvironment } from "../../lib/app-helpers.js";
import { server, postgres, mariadb } from "../../lib/constants.js";
import {
  logger,
  formatSize,
  decryptValue,
  POSTGRES_CONTAINER_NAME,
  MARIADB_CONTAINER_NAME,
} from "@explita/infra-protocol";
import type { DumpQuery, DumpManifest } from "@explita/infra-protocol/deploy";
import type { RequestParams } from "../../types/misc.js";
import { uploadDumpToS3 } from "../database/backup/helpers/s3.js";

function parseDumpOptions(query: DumpQuery) {
  const hasExplicitSelection =
    query.db !== undefined ||
    query.files !== undefined ||
    query.env !== undefined;

  return {
    includeDb: hasExplicitSelection ? query.db === "true" : true,
    includeFiles: hasExplicitSelection ? query.files === "true" : true,
    includeEnv: hasExplicitSelection ? query.env === "true" : true,
    revealSecrets: query.revealSecrets === "true",
  };
}

export async function stageAppDump(
  app: FormattedApp,
  targetDir: string,
  options: {
    includeDb: boolean;
    includeFiles: boolean;
    includeEnv: boolean;
    revealSecrets: boolean;
  },
): Promise<{ hasDb: boolean; hasRedis: boolean; hasFiles: boolean }> {
  await mkdir(targetDir, { recursive: true });

  let hasDb = false;
  let hasRedis = false;
  let hasFiles = false;

  // 1. Write app.json (configuration, domains, crons, resource limits)

  await writeFile(
    join(targetDir, "app.json"),
    JSON.stringify(app, null, 2),
    "utf8",
  );

  // 2. Write .env (environment variables)
  if (options.includeEnv) {
    const { env } = getAppEnvironment(app, {
      revealSecrets: options.revealSecrets,
    });
    const envLines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    const header = options.revealSecrets
      ? "# Explita Environment Variables (Unredacted)\n"
      : "# Explita Environment Variables (Secrets Redacted)\n";

    await writeFile(
      join(targetDir, ".env"),
      header + envLines.join("\n") + "\n",
      "utf8",
    );
  }

  // 3. Export database SQL dump(s)
  const appDbs = app.databases || [];
  if (options.includeDb && Array.isArray(appDbs) && appDbs.length > 0) {
    for (const db of appDbs) {
      if (!db.name) continue;
      try {
        let isMysql = false;
        if (db.url) {
          try {
            const decrypted = decryptValue(db.url);
            isMysql =
              decrypted.startsWith("mysql:") ||
              decrypted.startsWith("mariadb:");
          } catch {
            // Default to postgres
          }
        }

        const sqlFilename =
          db.key === "default" ? "database.sql" : `database-${db.key}.sql`;
        const sqlPath = join(targetDir, sqlFilename);
        const sqlFile = createWriteStream(sqlPath);

        const dumpProcess = isMysql
          ? stream("docker", [
              "exec",
              MARIADB_CONTAINER_NAME,
              "mariadb-dump",
              "-u",
              "root",
              `-p${mariadb.rootPassword}`,
              "--single-transaction",
              "--quick",
              db.name,
            ])
          : stream("docker", [
              "exec",
              "-e",
              `PGPASSWORD=${postgres.password || ""}`,
              POSTGRES_CONTAINER_NAME,
              "pg_dump",
              "-U",
              postgres.user,
              "-p",
              String(postgres.port),
              "-d",
              db.name,
            ]);

        if (dumpProcess.child.stdout) {
          await pipeline(dumpProcess.child.stdout, sqlFile);
          hasDb = true;
        }
      } catch (err) {
        logger.warn(
          `[dump] Failed to dump database "${db.name}" for app ${app.name || app.id}:`,
          err,
        );
        await writeFile(
          join(targetDir, `database-${db.key}.error.txt`),
          `Database dump failed: ${err instanceof Error ? err.message : String(err)}\n`,
          "utf8",
        );
      }
    }
  }

  // 4. Copy deployment files
  if (options.includeFiles) {
    const depId = app.currentDeploymentId;
    const candidateDir = depId
      ? join(server.deployBaseDir, app.id, depId)
      : join(server.deployBaseDir, app.id);

    if (existsSync(candidateDir)) {
      try {
        const destFilesDir = join(targetDir, "files");
        await mkdir(destFilesDir, { recursive: true });
        await cp(candidateDir, destFilesDir, { recursive: true });
        hasFiles = true;
      } catch (err) {
        logger.warn(
          `[dump] Failed to copy files for app ${app.name || app.id}:`,
          err,
        );
      }
    }
  }

  // 5. Write redis.json if configured
  const appRedis = app.redis;
  if (appRedis) {
    const redisData = {
      dbIndex: appRedis.dbIndex,
      ...(options.revealSecrets && appRedis.url ? { url: appRedis.url } : {}),
    };
    await writeFile(
      join(targetDir, "redis.json"),
      JSON.stringify(redisData, null, 2),
      "utf8",
    );
    hasRedis = true;
  }

  return { hasDb, hasRedis, hasFiles };
}

/**
 * Dump a single application by ID
 */
export async function dumpApp(
  request: FastifyRequest<{
    Params: RequestParams;
    Querystring: DumpQuery;
  }>,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const options = parseDumpOptions(request.query);

  const tempDir = await mkdtemp(join(tmpdir(), "explita-dump-app-"));

  try {
    const appDir = join(tempDir, app.name || app.id);
    const summary = await stageAppDump(app, appDir, options);

    const manifest: DumpManifest = {
      version: "1.0",
      timestamp: new Date().toISOString(),
      scope: "app",
      appsCount: 1,
      options,
      apps: [
        {
          id: app.id,
          name: app.name,
          ...summary,
        },
      ],
    };

    await writeFile(
      join(tempDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `explita-dump-${app.name || app.id}-${timestamp}.tar.gz`;

    if (request.query.s3 === "true" || request.query.s3 === "1") {
      const archivePath = join(tempDir, filename);
      await tar.c(
        {
          gzip: { level: 9 },
          file: archivePath,
          cwd: tempDir,
        },
        ["manifest.json", app.name || app.id],
      );

      const stats = statSync(archivePath);
      const s3Upload = await uploadDumpToS3(app, archivePath, filename);

      await rm(tempDir, { recursive: true, force: true }).catch(
        () => undefined,
      );

      return reply.code(200).send({
        success: true,
        message: `Application dump uploaded to S3 successfully.`,
        data: {
          filename,
          sizeBytes: stats.size,
          sizeFormatted: formatSize(stats.size),
          s3Url: s3Upload.s3Url,
          bucket: s3Upload.bucket,
          s3Key: s3Upload.s3Key,
        },
      });
    }

    const archiveStream = tar.c(
      {
        gzip: { level: 9 }, // Maximum compression for smallest archive size
        cwd: tempDir,
      },
      ["."],
    );

    const cleanup = () => {
      rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    };

    archiveStream.on("end", cleanup);
    archiveStream.on("close", cleanup);
    archiveStream.on("error", cleanup);

    reply.header("Content-Type", "application/gzip");
    reply.header("Content-Disposition", `attachment; filename="${filename}"`);

    return reply.send(archiveStream);
  } catch (err) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Dump all applications or system-wide backup
 */
export async function dumpAllApps(
  request: FastifyRequest<{ Querystring: DumpQuery }>,
  reply: FastifyReply,
) {
  const options = parseDumpOptions(request.query);

  const tempDir = await mkdtemp(join(tmpdir(), "explita-dump-all-"));

  try {
    const apps = await prisma.app.findMany({
      orderBy: { createdAt: "asc" },
      include: {
        domains: true,
        currentDeployment: true,
        databases: true,
        redis: true,
        crons: true,
        envs: true,
      },
    });

    const appsManifest: DumpManifest["apps"] = [];

    const appsBaseDir = join(tempDir, "apps");
    await mkdir(appsBaseDir, { recursive: true });

    const formattedApps = apps.map((app) =>
      stripAppPrefixes(formatApp(app, { showAll: options.revealSecrets })),
    );

    for (const app of formattedApps) {
      const appFolderName = `${app.name || app.id}`;
      const appDir = join(appsBaseDir, appFolderName);
      const summary = await stageAppDump(app, appDir, options);

      appsManifest.push({
        id: app.id,
        name: app.name,
        ...summary,
      });
    }

    const manifest: DumpManifest = {
      version: "1.0",
      timestamp: new Date().toISOString(),
      scope: "system",
      appsCount: apps.length,
      options,
      apps: appsManifest,
    };

    await writeFile(
      join(tempDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `explita-dump-all-${timestamp}.tar.gz`;

    if (request.query.s3 === "true" || request.query.s3 === "1") {
      const archivePath = join(tempDir, filename);
      await tar.c(
        {
          gzip: { level: 9 },
          file: archivePath,
          cwd: tempDir,
        },
        ["manifest.json", "apps"],
      );

      const stats = statSync(archivePath);
      const s3Upload = await uploadDumpToS3(null, archivePath, filename);

      await rm(tempDir, { recursive: true, force: true }).catch(
        () => undefined,
      );

      return reply.code(200).send({
        success: true,
        message: `Cluster backup dump uploaded to S3 successfully.`,
        data: {
          filename,
          sizeBytes: stats.size,
          sizeFormatted: formatSize(stats.size),
          s3Url: s3Upload.s3Url,
          bucket: s3Upload.bucket,
          s3Key: s3Upload.s3Key,
        },
      });
    }

    const archiveStream = tar.c(
      {
        gzip: { level: 9 }, // Maximum compression
        cwd: tempDir,
      },
      ["."],
    );

    const cleanup = () => {
      rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    };

    archiveStream.on("end", cleanup);
    archiveStream.on("close", cleanup);
    archiveStream.on("error", cleanup);

    reply.header("Content-Type", "application/gzip");
    reply.header("Content-Disposition", `attachment; filename="${filename}"`);

    return reply.send(archiveStream);
  } catch (err) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}
