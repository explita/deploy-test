import { rm } from "node:fs/promises";
import { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { execPostgres, execMariaDb } from "./lib/exec.js";
import { getAppDbBackupDir } from "../../lib/constants.js";
import { decryptValue } from "@explita/protocol";

export async function deleteDatabase(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const targetKey = request.query?.key?.trim().toLowerCase() || "default";

  const targetDb = app.databasesMap.get(targetKey);

  if (!targetDb) {
    return reply.code(404).send({
      success: false,
      error: `Database with key "${targetKey}" not found for application "${app.name}".`,
    });
  }

  let isMysql = false;
  if (targetDb.url) {
    try {
      const decrypted = decryptValue(targetDb.url);
      isMysql = decrypted.startsWith("mysql:") || decrypted.startsWith("mariadb:");
    } catch {
      // Ignore decrypt failure and default to postgres
    }
  }

  if (isMysql) {
    if (targetDb.name) {
      await execMariaDb(`DROP DATABASE IF EXISTS \`${targetDb.name}\`;`).catch(() => {});
    }
    if (targetDb.user) {
      await execMariaDb(`DROP USER IF EXISTS '${targetDb.user}'@'%'; FLUSH PRIVILEGES;`).catch(() => {});
    }
  } else {
    if (targetDb.name) {
      await execPostgres(
        `DROP DATABASE IF EXISTS "${targetDb.name}" WITH (FORCE);`,
      ).catch(() => {});
    }
    if (targetDb.user) {
      await execPostgres(`DROP ROLE IF EXISTS "${targetDb.user}";`).catch(() => {});
    }
  }

  await prisma.appDatabase.delete({
    where: { id: targetDb.id },
  });

  const remainingCount = await prisma.appDatabase.count({
    where: { appId: app.id },
  });
  if (remainingCount === 0) {
    await rm(getAppDbBackupDir(app.id), { recursive: true, force: true }).catch(
      () => undefined,
    );
  }

  return reply.code(200).send({
    success: true,
    message: `Database "${targetDb.name}" (key: "${targetDb.key}") dropped successfully for app "${app.name}"`,
    data: {
      deleted: true,
      key: targetDb.key,
      name: targetDb.name,
      user: targetDb.user,
    },
  });
}
