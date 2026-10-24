import { FastifyReply, FastifyRequest } from "fastify";
import { postgres, mariadb } from "../../lib/constants.js";
import { stream } from "../../lib/runner.js";
import {
  logger,
  decryptValue,
  POSTGRES_CONTAINER_NAME,
  MARIADB_CONTAINER_NAME,
} from "@explita/infra-protocol";
import { isMysqlOrMariaDb } from "../../lib/mariadb.js";

export async function dumpDatabase(
  request: FastifyRequest<{
    Querystring: { key?: string };
  }>,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const targetKey = request.query.key?.trim().toLowerCase() || "default";

  let dbName: string | undefined;

  const targetDb = app.databasesMap.get(targetKey);

  if (targetDb) {
    dbName = targetDb.name;
  }

  if (!dbName || !targetDb) {
    return reply.code(404).send({
      success: false,
      error: `Application "${app.name}" does not have a managed database configured for key "${targetKey}".`,
    });
  }

  let isMysql = false;
  if (targetDb.url) {
    try {
      const decrypted = decryptValue(targetDb.url);
      isMysql = isMysqlOrMariaDb(decrypted);
    } catch {
      // Default to postgres
    }
  }

  logger.info(
    `[db-dump] Dumping database "${dbName}" (key: "${targetKey}", type: "${isMysql ? "mysql" : "postgres"}") for app "${app.name}"`,
  );

  const streaming = isMysql
    ? stream("docker", [
        "exec",
        MARIADB_CONTAINER_NAME,
        "mariadb-dump",
        "-u",
        "root",
        `-p${mariadb.rootPassword}`,
        "--single-transaction",
        "--quick",
        dbName,
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
        dbName,
      ]);

  reply.header("Content-Type", "application/sql");
  reply.header("Content-Disposition", `attachment; filename="${dbName}.sql"`);

  return reply.send(streaming.child.stdout);
}
