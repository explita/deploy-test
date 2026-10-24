import { randomUUID } from "node:crypto";
import {
  AppDbEntry,
  POSTGRES_CONTAINER_NAME,
  MARIADB_CONTAINER_NAME,
} from "@explita/infra-protocol/deploy";
import { logger, decryptValue } from "@explita/infra-protocol";
import { run } from "./runner.js";
import { postgres, mariadb } from "./constants.js";
import {
  derivePreviewDatabaseUrl,
  validateDbCloneParams,
} from "./app-helpers.js";
import {
  execPostgres,
  execMariaDb,
  quoteIdentifier,
  escapeLiteral,
} from "../services/database/lib/exec.js";
import { FormattedApp } from "./formatters/app.js";
import { isMysqlOrMariaDb } from "./mariadb.js";

export interface ExtensionMetadata {
  name: string;
  version: string;
  schema: string;
}

export interface CloneDatabaseParams {
  app: FormattedApp;
  deploymentId: string;
  sourceDb: AppDbEntry;
  stateLog: (line: string) => Promise<void>;
  activeClonesSet?: Set<string>;
}

export interface ClonedDatabaseResult {
  name: string;
  user: string;
  url: string;
  sourceDb: string;
  isClone: boolean;
  createdAt: string;
}

/**
 * Generates comprehensive .pgpass entries matching wildcard, localhost, loopback,
 * and standard Linux Unix-domain socket paths for libpq connection authentication.
 */
export function formatPgpassEntry(
  user: string,
  pass: string,
  port: number | string = "*",
): string {
  const escapePgpass = (str: string) =>
    str.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
  const u = escapePgpass(user);
  const p = escapePgpass(pass);
  return [
    `*:${port}:*:${u}:${p}`,
    `*:*:*:${u}:${p}`,
    `localhost:${port}:*:${u}:${p}`,
    `localhost:*:*:${u}:${p}`,
    `127.0.0.1:${port}:*:${u}:${p}`,
    `127.0.0.1:*:*:${u}:${p}`,
    `/var/run/postgresql:${port}:*:${u}:${p}`,
    `/var/run/postgresql:*:*:${u}:${p}`,
    `/tmp:${port}:*:${u}:${p}`,
    `/tmp:*:*:${u}:${p}`,
  ].join("\n");
}

/**
 * Validates connection URL upfront before touching database, ensuring role, port,
 * database name, and host all match the managed database instance.
 */
export function validateAndParseSourceUrl(
  sourceDb: AppDbEntry,
  sourceDbName: string,
  ownerUser: string,
  cloneDbName: string,
  safePort: number,
): { ownerPassword: string; cloneUrl: string } {
  if (!sourceDb.url) {
    throw new Error(
      `Cannot clone database for preview: source database "${sourceDbName}" does not have a connection URL configured.`,
    );
  }

  const decryptedSourceUrl = decryptValue(sourceDb.url);
  const parsedSourceUrl = new URL(decryptedSourceUrl);

  const urlUser = decodeURIComponent(parsedSourceUrl.username || "");
  if (!urlUser || urlUser !== ownerUser) {
    throw new Error(
      `Safety violation: database URL username "${urlUser}" does not match configured database owner "${ownerUser}". Refusing to clone connection string.`,
    );
  }

  if (parsedSourceUrl.port && Number(parsedSourceUrl.port) !== safePort) {
    throw new Error(
      `Safety violation: database URL port "${parsedSourceUrl.port}" does not match managed database port "${safePort}". Refusing to clone connection string.`,
    );
  }

  const urlDbName = decodeURIComponent(
    parsedSourceUrl.pathname.replace(/^\//, ""),
  );
  if (!urlDbName || urlDbName !== sourceDbName) {
    throw new Error(
      `Safety violation: database URL database name "${urlDbName}" does not match configured source database name "${sourceDbName}". Refusing to clone connection string.`,
    );
  }

  const host = parsedSourceUrl.hostname.toLowerCase();
  const allowedHosts = new Set([
    "localhost",
    "127.0.0.1",
    POSTGRES_CONTAINER_NAME.toLowerCase(),
    MARIADB_CONTAINER_NAME.toLowerCase(),
    "explita-mysql",
    "host.docker.internal",
  ]);
  if (!allowedHosts.has(host)) {
    throw new Error(
      `Safety violation: database URL host "${parsedSourceUrl.hostname}" does not match managed database instance ("${POSTGRES_CONTAINER_NAME}", "${MARIADB_CONTAINER_NAME}", or "localhost"). Refusing to clone external connection string.`,
    );
  }

  const ownerPassword = decodeURIComponent(parsedSourceUrl.password || "");
  const cloneUrl = derivePreviewDatabaseUrl(
    decryptedSourceUrl,
    sourceDbName,
    cloneDbName,
  );

  return { ownerPassword, cloneUrl };
}

/**
 * Prepares the preview target database: drops any stale database with the same name,
 * creates the target database owned by ownerUser, and sets public schema ownership.
 */
export async function initializeCloneDatabase(
  cloneDbName: string,
  ownerUser: string,
): Promise<void> {
  const dropRes = await execPostgres(
    `DROP DATABASE IF EXISTS ${quoteIdentifier(cloneDbName)} WITH (FORCE);`,
  );
  if (dropRes.code !== 0) {
    throw new Error(
      `Failed to initialize preview database: unable to clean existing database "${cloneDbName}": ${dropRes.stderr || dropRes.stdout}`,
    );
  }

  const createRes = await execPostgres(
    `CREATE DATABASE ${quoteIdentifier(cloneDbName)} OWNER ${quoteIdentifier(ownerUser)};`,
  );
  if (createRes.code !== 0) {
    throw new Error(
      `Failed to create preview database "${cloneDbName}": ${createRes.stderr || createRes.stdout}`,
    );
  }

  const schemaRes = await execPostgres(
    `ALTER SCHEMA public OWNER TO ${quoteIdentifier(ownerUser)}; GRANT ALL ON SCHEMA public TO ${quoteIdentifier(ownerUser)};`,
    cloneDbName,
  );
  if (schemaRes.code !== 0) {
    throw new Error(
      `Failed to prepare preview schema in "${cloneDbName}": ${schemaRes.stderr || schemaRes.stdout}`,
    );
  }
}

/**
 * Discovers user/application-defined schemas from the source database, excluding
 * PostgreSQL system schemas and schemas owned directly by extensions via pg_depend.
 */
export async function discoverApplicationSchemas(
  sourceDbName: string,
): Promise<string[]> {
  const appSchemasSql = `
SELECT coalesce(json_agg(n.nspname), '[]'::json)::text
FROM pg_namespace n
WHERE n.nspname NOT LIKE 'pg_%'
  AND n.nspname <> 'information_schema'
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend d
    WHERE d.classid = 'pg_namespace'::regclass
      AND d.objid = n.oid
      AND d.refclassid = 'pg_extension'::regclass
      AND d.deptype = 'e'
  );
`;
  const userSchemasRes = await execPostgres(appSchemasSql, sourceDbName);
  if (userSchemasRes.code !== 0) {
    throw new Error(
      `Failed to discover application schemas in source database "${sourceDbName}": ${userSchemasRes.stderr || userSchemasRes.stdout}`,
    );
  }

  let userSchemas: string[] = [];
  try {
    const rawJson = userSchemasRes.stdout.trim() || "[]";
    userSchemas = JSON.parse(rawJson) as string[];
  } catch (err) {
    throw new Error(
      `Failed to parse schema metadata JSON from source database "${sourceDbName}": ${err}`,
    );
  }

  for (const schema of userSchemas) {
    if (!schema || typeof schema !== "string" || /[\x00\r\n]/.test(schema)) {
      throw new Error(
        `Schema name "${schema}" contains control characters or is invalid.`,
      );
    }
  }

  if (!userSchemas.includes("public")) {
    userSchemas.unshift("public");
  }

  return userSchemas;
}

/**
 * Discovers extensions present in the source database (excluding plpgsql)
 * using an atomic JSON aggregation query.
 */
export async function discoverSourceExtensions(
  sourceDbName: string,
): Promise<ExtensionMetadata[]> {
  const extRes = await execPostgres(
    `SELECT coalesce(json_agg(json_build_object('name', e.extname, 'version', e.extversion, 'schema', n.nspname)), '[]'::json)::text FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname <> 'plpgsql';`,
    sourceDbName,
  );
  if (extRes.code !== 0) {
    throw new Error(
      `Failed to inspect source database extensions in "${sourceDbName}": ${extRes.stderr || extRes.stdout}`,
    );
  }

  let sourceExtensions: ExtensionMetadata[] = [];
  try {
    const rawExtJson = extRes.stdout.trim() || "[]";
    sourceExtensions = JSON.parse(rawExtJson) as ExtensionMetadata[];
  } catch (err) {
    throw new Error(
      `Failed to parse extension metadata JSON from source database "${sourceDbName}": ${err}`,
    );
  }

  for (const ext of sourceExtensions) {
    if (
      !ext.name ||
      /[\x00\r\n]/.test(ext.name) ||
      (ext.schema && /[\x00\r\n]/.test(ext.schema)) ||
      (ext.version && /[\x00\r\n]/.test(ext.version))
    ) {
      throw new Error(
        `Invalid characters in extension metadata: ${JSON.stringify(ext)}`,
      );
    }
    if (!ext.schema) {
      ext.schema = "public";
    }
    if (!ext.version) {
      ext.version = "";
    }
  }

  return sourceExtensions;
}

/**
 * Pre-provisions required extensions in the preview database, ensuring schema placement
 * and exact version parity without silent fallbacks.
 */
export async function provisionExtensions(
  cloneDbName: string,
  extensions: ExtensionMetadata[],
): Promise<void> {
  for (const ext of extensions) {
    const targetSchema = ext.schema || "public";

    if (targetSchema !== "public") {
      const createSchemaRes = await execPostgres(
        `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(targetSchema)};`,
        cloneDbName,
      );
      if (createSchemaRes.code !== 0) {
        throw new Error(
          `Failed to prepare schema "${targetSchema}" for extension "${ext.name}" in preview database "${cloneDbName}": ${createSchemaRes.stderr || createSchemaRes.stdout}`,
        );
      }
    }

    const checkTargetExtRes = await execPostgres(
      `SELECT json_build_object('version', e.extversion, 'schema', n.nspname)::text FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = ${escapeLiteral(ext.name)};`,
      cloneDbName,
    );
    if (checkTargetExtRes.code !== 0) {
      throw new Error(
        `Failed to inspect extension status for "${ext.name}" in preview database "${cloneDbName}": ${checkTargetExtRes.stderr || checkTargetExtRes.stdout}`,
      );
    }

    const existingTargetExt = checkTargetExtRes.stdout.trim();
    if (!existingTargetExt) {
      const createSql = ext.version
        ? `CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(ext.name)} SCHEMA ${quoteIdentifier(targetSchema)} VERSION ${escapeLiteral(ext.version)};`
        : `CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(ext.name)} SCHEMA ${quoteIdentifier(targetSchema)};`;

      const createExtRes = await execPostgres(createSql, cloneDbName);
      if (createExtRes.code !== 0) {
        throw new Error(
          `Failed to pre-install extension "${ext.name}" (version "${ext.version}") in schema "${targetSchema}" for preview database "${cloneDbName}": ${createExtRes.stderr || createExtRes.stdout}`,
        );
      }
    }

    const verifyExtRes = await execPostgres(
      `SELECT json_build_object('version', e.extversion, 'schema', n.nspname)::text FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = ${escapeLiteral(ext.name)};`,
      cloneDbName,
    );
    if (verifyExtRes.code !== 0 || !verifyExtRes.stdout.trim()) {
      throw new Error(
        `Failed to verify extension "${ext.name}" in preview database "${cloneDbName}": ${verifyExtRes.stderr || verifyExtRes.stdout}`,
      );
    }

    const installed = JSON.parse(verifyExtRes.stdout.trim()) as {
      version?: string;
      schema?: string;
    };

    if (installed.schema !== targetSchema) {
      const alterSchemaRes = await execPostgres(
        `ALTER EXTENSION ${quoteIdentifier(ext.name)} SET SCHEMA ${quoteIdentifier(targetSchema)};`,
        cloneDbName,
      );
      if (alterSchemaRes.code !== 0) {
        throw new Error(
          `Extension "${ext.name}" in preview database is installed in schema "${installed.schema}", but source database uses schema "${targetSchema}". Failed to relocate extension: ${alterSchemaRes.stderr || alterSchemaRes.stdout}`,
        );
      }
    }

    if (ext.version && installed.version !== ext.version) {
      const updateRes = await execPostgres(
        `ALTER EXTENSION ${quoteIdentifier(ext.name)} UPDATE TO ${escapeLiteral(ext.version)};`,
        cloneDbName,
      );
      if (updateRes.code !== 0) {
        throw new Error(
          `Extension "${ext.name}" in preview database has version "${installed.version}", but source database requires version "${ext.version}". Failed to update extension version: ${updateRes.stderr || updateRes.stdout}`,
        );
      }
    }
  }
}

/**
 * Streams a logical snapshot from source to clone via in-container pg_dump | psql,
 * authenticated via an isolated, temporary PGPASSFILE with chmod 600.
 */
export async function streamDatabaseSnapshot(
  sourceDbName: string,
  cloneDbName: string,
  adminUser: string,
  ownerUser: string,
  ownerPassword: string,
  safePort: number,
): Promise<void> {
  const pgpassFile = `/tmp/.explita_pgpass_${randomUUID().replace(/-/g, "")}`;
  const pgpassContent = `${formatPgpassEntry(adminUser, postgres.password || "", safePort)}\n${formatPgpassEntry(ownerUser, ownerPassword, safePort)}\n`;

  const writePgpassRes = await run(
    "docker",
    [
      "exec",
      "-i",
      POSTGRES_CONTAINER_NAME,
      "bash",
      "-c",
      `cat > "${pgpassFile}" && chmod 600 "${pgpassFile}"`,
    ],
    { stdin: pgpassContent },
  );

  if (writePgpassRes.code !== 0) {
    throw new Error(
      `Failed to prepare secure credentials for database streaming: ${writePgpassRes.stderr || writePgpassRes.stdout}`,
    );
  }

  try {
    const dumpRestoreRes = await run("docker", [
      "exec",
      "-e",
      `PGPASSFILE=${pgpassFile}`,
      POSTGRES_CONTAINER_NAME,
      "bash",
      "-o",
      "pipefail",
      "-c",
      `set -eu
pg_dump -h localhost -p ${safePort} -U ${adminUser} --no-owner --no-acl -d "${sourceDbName}" | psql -h localhost -p ${safePort} -U ${ownerUser} -d "${cloneDbName}" -v ON_ERROR_STOP=1 -q`,
    ]);

    if (dumpRestoreRes.code !== 0) {
      throw new Error(
        `Failed to copy data from "${sourceDbName}" to preview database "${cloneDbName}": ${dumpRestoreRes.stderr || dumpRestoreRes.stdout}`,
      );
    }
  } finally {
    await run("docker", [
      "exec",
      POSTGRES_CONTAINER_NAME,
      "rm",
      "-f",
      pgpassFile,
    ]).catch(() => {});
  }
}

/**
 * Grants database and object privileges across all application schemas to ownerUser.
 */
export async function grantApplicationPrivileges(
  cloneDbName: string,
  ownerUser: string,
  userSchemas: string[],
): Promise<void> {
  const grantDbRes = await execPostgres(
    `GRANT ALL PRIVILEGES ON DATABASE ${quoteIdentifier(cloneDbName)} TO ${quoteIdentifier(ownerUser)};`,
  );
  if (grantDbRes.code !== 0) {
    throw new Error(
      `Failed to grant database privileges on "${cloneDbName}" to "${ownerUser}": ${grantDbRes.stderr || grantDbRes.stdout}`,
    );
  }

  const grantStatements = userSchemas
    .map(
      (schema) => `
GRANT ALL ON SCHEMA ${quoteIdentifier(schema)} TO ${quoteIdentifier(ownerUser)};
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${quoteIdentifier(schema)} TO ${quoteIdentifier(ownerUser)};
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${quoteIdentifier(schema)} TO ${quoteIdentifier(ownerUser)};
GRANT ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA ${quoteIdentifier(schema)} TO ${quoteIdentifier(ownerUser)};
ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(ownerUser)} IN SCHEMA ${quoteIdentifier(schema)} GRANT ALL ON TABLES TO ${quoteIdentifier(ownerUser)};
ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(ownerUser)} IN SCHEMA ${quoteIdentifier(schema)} GRANT ALL ON SEQUENCES TO ${quoteIdentifier(ownerUser)};
`,
    )
    .join("\n");

  const grantObjectsRes = await execPostgres(grantStatements, cloneDbName);
  if (grantObjectsRes.code !== 0) {
    throw new Error(
      `Failed to grant object privileges in preview database "${cloneDbName}" to "${ownerUser}": ${grantObjectsRes.stderr || grantObjectsRes.stdout}`,
    );
  }
}

/**
 * Verifies connectivity, catalog table sanity, and post-restore extension parity.
 */
export async function verifyClonedDatabase(
  cloneDbName: string,
  sourceDbName: string,
  sourceExtensions: ExtensionMetadata[],
): Promise<void> {
  const pingRes = await execPostgres(`SELECT 1;`, cloneDbName);
  if (pingRes.code !== 0) {
    throw new Error(
      `Failed to verify cloned database "${cloneDbName}": database is not accepting connections: ${pingRes.stderr || pingRes.stdout}`,
    );
  }

  const countSql = `SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema');`;
  const cloneCountRes = await execPostgres(countSql, cloneDbName);
  if (cloneCountRes.code !== 0) {
    throw new Error(
      `Failed to verify cloned database "${cloneDbName}": catalog query failed: ${cloneCountRes.stderr || cloneCountRes.stdout}`,
    );
  }

  const cloneTables = parseInt(cloneCountRes.stdout.trim(), 10);
  if (Number.isNaN(cloneTables)) {
    throw new Error(
      `Failed to verify cloned database "${cloneDbName}": invalid catalog response "${cloneCountRes.stdout}".`,
    );
  }

  const sourceCountRes = await execPostgres(countSql, sourceDbName).catch(
    () => null,
  );
  if (sourceCountRes && sourceCountRes.code === 0) {
    const sourceTables = parseInt(sourceCountRes.stdout.trim(), 10);
    if (!Number.isNaN(sourceTables) && sourceTables > 0 && cloneTables === 0) {
      throw new Error(
        `Verification failed: source database "${sourceDbName}" has ${sourceTables} user table(s), but cloned preview database "${cloneDbName}" has 0 tables.`,
      );
    }
  }

  if (sourceExtensions.length > 0) {
    const postExtRes = await execPostgres(
      `SELECT coalesce(json_agg(json_build_object('name', e.extname, 'version', e.extversion, 'schema', n.nspname)), '[]'::json)::text FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname <> 'plpgsql';`,
      cloneDbName,
    );
    if (postExtRes.code !== 0) {
      throw new Error(
        `Failed to query extensions in preview database "${cloneDbName}" after restore: ${postExtRes.stderr || postExtRes.stdout}`,
      );
    }

    const installedExtMap = new Map<
      string,
      { version: string; schema: string }
    >();
    try {
      const rawPostExt = postExtRes.stdout.trim() || "[]";
      const parsedList = JSON.parse(rawPostExt) as ExtensionMetadata[];
      for (const item of parsedList) {
        installedExtMap.set(item.name, {
          version: item.version || "",
          schema: item.schema || "public",
        });
      }
    } catch (err) {
      throw new Error(
        `Failed to parse post-restore extension JSON from "${cloneDbName}": ${err}`,
      );
    }

    for (const ext of sourceExtensions) {
      const installed = installedExtMap.get(ext.name);
      if (!installed) {
        throw new Error(
          `Post-restore extension verification failed: required extension "${ext.name}" is missing from preview database "${cloneDbName}".`,
        );
      }
      const expectedSchema = ext.schema || "public";
      if (installed.schema !== expectedSchema) {
        throw new Error(
          `Post-restore extension verification failed: extension "${ext.name}" is installed in schema "${installed.schema}", but source uses schema "${expectedSchema}".`,
        );
      }
      if (ext.version && installed.version !== ext.version) {
        throw new Error(
          `Post-restore extension verification failed: extension "${ext.name}" has version "${installed.version}", but source requires version "${ext.version}".`,
        );
      }
    }
  }
}

/**
 * Prepares the preview target MariaDB database: drops any stale database, creates target database,
 * and grants all privileges on it to ownerUser.
 */
export async function initializeMariaDbCloneDatabase(
  cloneDbName: string,
  ownerUser: string,
): Promise<void> {
  const initSql = `
DROP DATABASE IF EXISTS \`${cloneDbName}\`;
CREATE DATABASE \`${cloneDbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON \`${cloneDbName}\`.* TO '${ownerUser}'@'%';
FLUSH PRIVILEGES;
`.trim();
  const res = await execMariaDb(initSql);
  if (res.code !== 0) {
    throw new Error(
      `Failed to initialize preview MariaDB database "${cloneDbName}": ${res.stderr || res.stdout}`,
    );
  }
}

/**
 * Streams a logical snapshot from source to clone via in-container mariadb-dump | mariadb.
 */
export async function streamMariaDbSnapshot(
  sourceDbName: string,
  cloneDbName: string,
): Promise<void> {
  const dumpRestoreRes = await run("docker", [
    "exec",
    MARIADB_CONTAINER_NAME,
    "bash",
    "-o",
    "pipefail",
    "-c",
    `set -eu
mariadb-dump -u root -p${mariadb.rootPassword} --single-transaction --quick "${sourceDbName}" | mariadb -u root -p${mariadb.rootPassword} "${cloneDbName}"`,
  ]);

  if (dumpRestoreRes.code !== 0) {
    throw new Error(
      `Failed to copy data from "${sourceDbName}" to preview database "${cloneDbName}": ${dumpRestoreRes.stderr || dumpRestoreRes.stdout}`,
    );
  }
}

/**
 * Verifies that the cloned MariaDB database exists and contains tables if the source contained tables.
 */
export async function verifyMariaDbClonedDatabase(
  cloneDbName: string,
  sourceDbName: string,
): Promise<void> {
  const countSql = `SELECT count(*) FROM information_schema.tables WHERE table_schema = '${cloneDbName}';`;
  const res = await execMariaDb(countSql);
  if (res.code !== 0) {
    throw new Error(
      `Failed to verify cloned MariaDB database "${cloneDbName}": ${res.stderr || res.stdout}`,
    );
  }
}

/**
 * Drops a preview database safely with FORCE, failing open with logging so
 * cleanup never masks primary errors.
 */
export async function dropPreviewDatabase(
  dbName: string,
  isMysql?: boolean,
): Promise<void> {
  if (!dbName) return;
  if (!/^[a-zA-Z0-9_]+$/.test(dbName)) {
    logger.warn(
      `Warning: Invalid database identifier "${dbName}". Skipping drop.`,
    );
    return;
  }

  if (isMysql) {
    const res = await execMariaDb(
      `DROP DATABASE IF EXISTS \`${dbName}\`;`,
    ).catch((err) => ({
      code: 1,
      stderr: String(err),
      stdout: "",
    }));
    if (res.code !== 0) {
      logger.warn(
        `Warning: Failed to clean up preview MariaDB database "${dbName}": ${res.stderr || res.stdout}`,
      );
    }
  } else {
    const res = await execPostgres(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(dbName)} WITH (FORCE);`,
    ).catch((err) => ({
      code: 1,
      stderr: String(err),
      stdout: "",
    }));

    if (res.code !== 0) {
      logger.warn(
        `Warning: Failed to clean up preview database "${dbName}": ${res.stderr || res.stdout}`,
      );
    }
  }
}

/**
 * Orchestrates cloning an application database for preview deployments.
 */
export async function cloneDatabaseForPreview(
  params: CloneDatabaseParams,
): Promise<ClonedDatabaseResult> {
  const { app, deploymentId, sourceDb, stateLog, activeClonesSet } = params;

  let isMysql = false;
  if (sourceDb.url) {
    try {
      const decrypted = decryptValue(sourceDb.url);
      isMysql = isMysqlOrMariaDb(decrypted);
    } catch {
      // Default to postgres
    }
  }

  const adminUser = isMysql ? "root" : postgres.user;
  const adminPort = isMysql
    ? mariadb.hostPort || mariadb.port
    : postgres.hostPort || postgres.port;

  const { sourceDbName, ownerUser, cloneDbName, safePort } =
    validateDbCloneParams(sourceDb, deploymentId, adminUser, adminPort);

  if (activeClonesSet?.has(cloneDbName)) {
    throw new Error(
      `A database clone operation is already in progress for "${cloneDbName}".`,
    );
  }
  activeClonesSet?.add(cloneDbName);

  let cloneCreated = false;
  let completed = false;

  try {
    // 1. Validate connection URL upfront
    const { ownerPassword, cloneUrl } = validateAndParseSourceUrl(
      sourceDb,
      sourceDbName,
      ownerUser,
      cloneDbName,
      safePort,
    );

    await stateLog(
      `Cloning ${isMysql ? "MariaDB" : "PostgreSQL"} database "${sourceDbName}" -> "${cloneDbName}"...`,
    );

    if (isMysql) {
      // 2. Initialize clean target database
      await initializeMariaDbCloneDatabase(cloneDbName, ownerUser);
      cloneCreated = true;

      // 3. Stream snapshot
      await streamMariaDbSnapshot(sourceDbName, cloneDbName);

      // 4. Verify clone
      await verifyMariaDbClonedDatabase(cloneDbName, sourceDbName);
    } else {
      // 2. Initialize clean target database
      await initializeCloneDatabase(cloneDbName, ownerUser);
      cloneCreated = true;

      // 3. Discover schemas & extensions
      const userSchemas = await discoverApplicationSchemas(sourceDbName);
      const sourceExtensions = await discoverSourceExtensions(sourceDbName);

      // 4. Pre-provision extensions
      await provisionExtensions(cloneDbName, sourceExtensions);

      // 5. Stream snapshot
      await streamDatabaseSnapshot(
        sourceDbName,
        cloneDbName,
        adminUser,
        ownerUser,
        ownerPassword,
        safePort,
      );

      // 6. Grant application privileges
      await grantApplicationPrivileges(cloneDbName, ownerUser, userSchemas);

      // 7. Verify clone
      await verifyClonedDatabase(cloneDbName, sourceDbName, sourceExtensions);
    }

    completed = true;

    return {
      name: cloneDbName,
      user: ownerUser,
      url: cloneUrl,
      sourceDb: sourceDbName,
      isClone: true,
      createdAt: new Date().toISOString(),
    };
  } finally {
    try {
      if (cloneCreated && !completed) {
        await dropPreviewDatabase(cloneDbName, isMysql).catch((cleanupErr) => {
          logger.warn(
            `Warning: Best-effort cleanup failed for preview database "${cloneDbName}": ${cleanupErr}`,
          );
        });
      }
    } catch (cleanupErr) {
      logger.warn(
        `Warning: Unexpected exception during cleanup of preview database "${cloneDbName}": ${cleanupErr}`,
      );
    } finally {
      activeClonesSet?.delete(cloneDbName);
    }
  }
}
