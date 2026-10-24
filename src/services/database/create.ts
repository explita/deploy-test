import { FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { execPostgres, execMariaDb } from "./lib/exec.js";
import { postgres, mariadb } from "../../lib/constants.js";
import { ensureManagedPostgres } from "../../lib/postgres.js";
import { ensureManagedMariaDb } from "../../lib/mariadb.js";
import { prisma } from "../../lib/prisma.js";
import {
  encryptValue,
  POSTGRES_CONTAINER_NAME,
  MARIADB_CONTAINER_NAME,
} from "@explita/infra-protocol";

interface CreateDbBody {
  key?: string;
  name?: string;
  user?: string;
  password?: string;
  type?: string;
}

export async function createDatabase(
  request: FastifyRequest<{ Body?: CreateDbBody }>,
  reply: FastifyReply,
) {
  const app = request.ctx.app;

  const rawKey = request.body?.key?.trim().toLowerCase();
  const key = rawKey || "default";

  if (!/^[a-z0-9_-]{1,63}$/.test(key)) {
    return reply.code(400).send({
      success: false,
      error:
        "Invalid database key. Must contain only alphanumeric characters, underscores, and hyphens (max 63 chars).",
    });
  }

  const existingDb = app.databasesMap.get(key);

  if (existingDb) {
    return reply.code(409).send({
      success: false,
      error: `Application already has a database configured for key "${key}" ("${existingDb.name}"). Use "eda db url -a ${app.id} -k ${key}" to view its connection string or "eda db rm -a ${app.id} -k ${key}" to remove it.`,
    });
  }

  const rawType = request.body?.type?.trim().toLowerCase() || "postgres";
  const isMysql = rawType === "mysql" || rawType === "mariadb";
  const isPostgres = rawType === "postgres" || rawType === "postgresql";

  if (!isMysql && !isPostgres) {
    return reply.code(400).send({
      success: false,
      error: `Unsupported database type "${rawType}". Supported types are "postgres" (or "postgresql") and "mysql" (or "mariadb").`,
    });
  }

  const rawName = request.body?.name?.trim();
  const rawUser = request.body?.user?.trim();
  const rawPass = request.body?.password?.trim();

  const safeAppId = app.id.toLowerCase().replace(/[^a-z0-9]/g, "");
  const safeKeySuffix =
    key === "default" ? "" : `_${key.replace(/[^a-z0-9]/g, "_")}`;

  const dbNameCandidate = (rawName || `app_${safeAppId}${safeKeySuffix}`)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, 63);
  const dbUserCandidate = (rawUser || `user_${safeAppId}${safeKeySuffix}`)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, 63);
  const password = rawPass || randomBytes(16).toString("hex");

  if (!/^[a-z0-9_]{1,63}$/.test(dbNameCandidate)) {
    return reply.code(400).send({
      success: false,
      error:
        "Invalid database name. Must contain only lowercase alphanumeric characters and underscores (max 63 chars).",
    });
  }

  if (!/^[a-z0-9_]{1,63}$/.test(dbUserCandidate)) {
    return reply.code(400).send({
      success: false,
      error:
        "Invalid database user. Must contain only lowercase alphanumeric characters and underscores (max 63 chars).",
    });
  }

  const nameInUse = await prisma.appDatabase.findUnique({
    where: { name: dbNameCandidate },
  });
  if (nameInUse && nameInUse.appId !== app.id) {
    return reply.code(409).send({
      success: false,
      error: `Database name "${dbNameCandidate}" is already in use by another application. Please specify a different name with -n/--name.`,
    });
  }

  const escapedPass = password.replace(/'/g, "''");
  let databaseUrl: string;

  if (isMysql) {
    // 1. Ensure MariaDB container is running on demand
    try {
      await ensureManagedMariaDb();
    } catch (err) {
      return reply.code(500).send({
        success: false,
        error: `Failed to initialize managed MariaDB container: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // 2. Provision user, database, and privileges in MariaDB
    const createMariaDbSql = `
CREATE USER IF NOT EXISTS '${dbUserCandidate}'@'%' IDENTIFIED BY '${escapedPass}';
ALTER USER '${dbUserCandidate}'@'%' IDENTIFIED BY '${escapedPass}';
CREATE DATABASE IF NOT EXISTS \`${dbNameCandidate}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON \`${dbNameCandidate}\`.* TO '${dbUserCandidate}'@'%';
FLUSH PRIVILEGES;
`.trim();

    const mariaRes = await execMariaDb(createMariaDbSql);
    if (mariaRes.code !== 0) {
      return reply.code(500).send({
        success: false,
        error: `Failed to create MariaDB database/user: ${mariaRes.stderr || mariaRes.stdout}`,
      });
    }

    databaseUrl = `mysql://${dbUserCandidate}:${encodeURIComponent(password)}@${MARIADB_CONTAINER_NAME}:${mariadb.port}/${dbNameCandidate}`;
  } else {
    // 1. Ensure PostgreSQL container is running on demand
    try {
      await ensureManagedPostgres();
    } catch (err) {
      return reply.code(500).send({
        success: false,
        error: `Failed to initialize managed PostgreSQL container: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // 2. Create or update user role in PostgreSQL
    const createRoleSql = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${dbUserCandidate}') THEN
    CREATE ROLE "${dbUserCandidate}" WITH LOGIN ENCRYPTED PASSWORD '${escapedPass}';
  ELSE
    ALTER ROLE "${dbUserCandidate}" WITH ENCRYPTED PASSWORD '${escapedPass}';
  END IF;
END
$$;
`.trim();

    const roleRes = await execPostgres(createRoleSql);
    if (roleRes.code !== 0) {
      return reply.code(500).send({
        success: false,
        error: `Failed to create database role: ${roleRes.stderr || roleRes.stdout}`,
      });
    }

    // 3. Check if database exists, create if not
    const checkDbSql = `SELECT 1 FROM pg_database WHERE datname = '${dbNameCandidate}';`;
    const checkRes = await execPostgres(checkDbSql);
    const dbExists = checkRes.stdout.trim() === "1";

    if (!dbExists) {
      const createDbRes = await execPostgres(
        `CREATE DATABASE "${dbNameCandidate}" OWNER "${dbUserCandidate}";`,
      );
      if (createDbRes.code !== 0) {
        await execPostgres(`DROP ROLE IF EXISTS "${dbUserCandidate}";`).catch(
          () => {},
        );
        return reply.code(500).send({
          success: false,
          error: `Failed to create database: ${createDbRes.stderr || createDbRes.stdout}`,
        });
      }
    }

    // 4. Grant privileges
    const grantRes = await execPostgres(
      `GRANT ALL PRIVILEGES ON DATABASE "${dbNameCandidate}" TO "${dbUserCandidate}";`,
    );
    if (grantRes.code !== 0) {
      await execPostgres(
        `DROP DATABASE IF EXISTS "${dbNameCandidate}" WITH (FORCE);`,
      ).catch(() => {});
      await execPostgres(`DROP ROLE IF EXISTS "${dbUserCandidate}";`).catch(
        () => {},
      );
      return reply.code(500).send({
        success: false,
        error: `Failed to grant database privileges: ${grantRes.stderr || grantRes.stdout}`,
      });
    }

    databaseUrl = `postgresql://${dbUserCandidate}:${encodeURIComponent(password)}@${POSTGRES_CONTAINER_NAME}:${postgres.port}/${dbNameCandidate}`;
  }

  // 5. Store in Prisma appDatabase
  try {
    const createdDb = await prisma.appDatabase.create({
      data: {
        appId: app.id,
        key,
        name: dbNameCandidate,
        user: dbUserCandidate,
        url: encryptValue(databaseUrl),
      },
    });

    return reply.code(201).send({
      success: true,
      message: `Database "${dbNameCandidate}" (key: "${key}", type: "${isMysql ? "mysql" : "postgres"}") created for app "${app.name}"`,
      data: {
        id: createdDb.id,
        appId: app.id,
        key,
        name: dbNameCandidate,
        user: dbUserCandidate,
        type: isMysql ? "mysql" : "postgres",
        url: databaseUrl,
        createdAt: createdDb.createdAt.toISOString(),
      },
    });
  } catch (err) {
    if (isMysql) {
      await execMariaDb(
        `DROP DATABASE IF EXISTS \`${dbNameCandidate}\`; DROP USER IF EXISTS '${dbUserCandidate}'@'%';`,
      ).catch(() => {});
    } else {
      await execPostgres(
        `DROP DATABASE IF EXISTS "${dbNameCandidate}" WITH (FORCE);`,
      ).catch(() => {});
      await execPostgres(`DROP ROLE IF EXISTS "${dbUserCandidate}";`).catch(
        () => {},
      );
    }
    return reply.code(500).send({
      success: false,
      error: `Failed to save database record: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
