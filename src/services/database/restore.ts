import { FastifyReply, FastifyRequest } from "fastify";
import { postgres, mariadb } from "../../lib/constants.js";
import { stream } from "../../lib/runner.js";
import {
  logger,
  decryptValue,
  POSTGRES_CONTAINER_NAME,
  MARIADB_CONTAINER_NAME,
} from "@explita/protocol";
import { isMysqlOrMariaDb } from "../../lib/mariadb.js";

export async function restoreDatabase(
  request: FastifyRequest<{
    Querystring: { key?: string };
  }>,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const targetKey = request.query.key?.trim().toLowerCase() || "default";

  if (!request.query.key && app.databases.length > 1) {
    return reply.code(400).send({
      success: false,
      error:
        "You have multiple databases on this application. Please specify which database to restore by using the --key parameter.",
    });
  }

  const targetDb = app.databasesMap.get(targetKey);
  const dbName = targetDb?.name;

  if (!dbName || !targetDb) {
    return reply.code(404).send({
      success: false,
      error: `Application "${app.name}" does not have a managed database configured for key "${targetKey}".`,
    });
  }

  const body = (request.body || request.raw) as any;
  if (!body) {
    return reply.code(400).send({
      success: false,
      error: "SQL backup payload is required in request body.",
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
    `Restoring database "${dbName}" (key: "${targetKey}", type: "${isMysql ? "mysql" : "postgres"}") for app "${app.name}"`,
  );

  const result = isMysql
    ? await stream(
        "docker",
        [
          "exec",
          "-i",
          MARIADB_CONTAINER_NAME,
          "mariadb",
          "-u",
          "root",
          `-p${mariadb.rootPassword}`,
          dbName,
        ],
        { stdin: body },
      )
    : await stream(
        "docker",
        [
          "exec",
          "-i",
          "-e",
          `PGPASSWORD=${postgres.password || ""}`,
          POSTGRES_CONTAINER_NAME,
          "psql",
          "-U",
          postgres.user,
          "-p",
          String(postgres.port),
          "-d",
          dbName,
        ],
        { stdin: body },
      );

  if (result.code !== 0) {
    logger.error(
      `Database restore tool exited with code ${result.code}: ${result.stderr}`,
    );
    return reply.code(500).send({
      success: false,
      error:
        result.stderr ||
        `Database restore failed with exit code ${result.code}`,
    });
  }

  logger.info(`Successfully restored database "${dbName}"`);
  return reply.code(200).send({
    success: true,
    message: `Database "${dbName}" restored successfully.`,
    data: {
      appId: app.id,
      database: dbName,
      restored: true,
    },
  });
}
