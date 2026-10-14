import { FastifyReply, FastifyRequest } from "fastify";

export async function getDatabase(
  request: FastifyRequest<{
    Querystring: { key?: string };
  }>,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const requestedKey = request.query.key?.trim().toLowerCase();

  const dbs = app.databases;

  if (dbs.length === 0) {
    return reply.code(404).send({
      success: false,
      error: `No database configured for application "${app.name}". Use "eda db create -a ${app.id}" to provision one.`,
    });
  }

  if (requestedKey) {
    const targetDb = app.databasesMap.get(requestedKey);
    if (!targetDb) {
      return reply.code(404).send({
        success: false,
        error: `Database with key "${requestedKey}" not found for application "${app.name}".`,
      });
    }

    return reply.code(200).send({
      success: true,
      data: {
        id: targetDb.id,
        appId: app.id,
        key: targetDb.key,
        name: targetDb.name,
        user: targetDb.user,
        url: targetDb.url,
        createdAt: targetDb.createdAt.toISOString(),
      },
    });
  }

  const defaultDb = dbs.find((d) => d.key === "default") || dbs[0];
  return reply.code(200).send({
    success: true,
    data: {
      id: defaultDb.id,
      appId: app.id,
      key: defaultDb.key,
      name: defaultDb.name,
      user: defaultDb.user,
      url: defaultDb.url,
      createdAt: defaultDb.createdAt.toISOString(),
      databases: dbs.map((d) => ({
        id: d.id,
        key: d.key,
        name: d.name,
        user: d.user,
        url: d.url,
        createdAt: d.createdAt.toISOString(),
      })),
    },
  });
}
