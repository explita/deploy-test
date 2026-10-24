import { FastifyReply, FastifyRequest } from "fastify";
import { RequestParams } from "../../../types/misc.js";
import { DatabaseBackupFile } from "@explita/infra-protocol";
import { FormattedApp } from "../../../lib/formatters/app.js";
import { prisma } from "../../../lib/prisma.js";

export async function listBackups(
  request: FastifyRequest<{
    Params: RequestParams;
    Querystring: { key?: string };
  }>,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const key = request.query.key;

  const backups = await listDatabaseBackups(app, key);
  return reply.code(200).send({
    success: true,
    data: backups,
  });
}

export async function listDatabaseBackups(
  app: FormattedApp,
  key?: string,
): Promise<DatabaseBackupFile[]> {
  const targetKey = key?.trim().toLowerCase();

  const records = await prisma.databaseBackup.findMany({
    where: {
      appId: app.id,
      ...(targetKey ? { key: targetKey } : {}),
    },
    orderBy: { createdAt: "desc" },
  });

  return records.map((r) => ({
    id: r.filename,
    filename: r.filename,
    sizeBytes: Number(r.sizeBytes),
    sizeFormatted: r.sizeFormatted,
    createdAt: r.createdAt.toISOString(),
    key: r.key,
    dbName: r.dbName,
    storage: r.storage as "local" | "s3" | "both",
    s3Url: r.s3Url || undefined,
    contentHash: r.contentHash,
  }));
}
