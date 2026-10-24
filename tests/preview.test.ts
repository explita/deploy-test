import "@explita/env-loader/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  getPreviewTunnelSubdomain,
  getPreviewTunnelContainerName,
  isPreviewStatus,
} from "@explita/infra-protocol/deploy";
import { syncPreviewTunnel, removePreviewTunnel } from "../src/lib/tunnel.js";

test("preview helper formatting and status identification", () => {
  assert.equal(isPreviewStatus("PREVIEW"), true);
  assert.equal(isPreviewStatus("LIVE"), false);
  assert.equal(isPreviewStatus("FAILED"), false);

  const sub = getPreviewTunnelSubdomain("d-12345678");
  assert.equal(sub, "preview-d12345678");

  const containerName = getPreviewTunnelContainerName("d-12345678");
  assert.equal(containerName, "explita-preview-tunnel-d12345678");
});

test("syncPreviewTunnel generates preview url and removes tunnel container", async () => {
  const dummyApp: any = {
    id: "app-abc123",
    name: "test-app",
    metadata: {},
  };

  const previewUrl = await syncPreviewTunnel(
    dummyApp,
    "d-deploy1",
    "explita-app-container",
    3000,
  );

  assert.ok(previewUrl);
  assert.ok(previewUrl.includes("preview-ddeploy1"));
  assert.ok(previewUrl.startsWith("https://"));

  await removePreviewTunnel("d-deploy1");
});

test("derivePreviewDatabaseUrl rewrites database name safely and fails closed", async () => {
  const { derivePreviewDatabaseUrl } =
    await import("../src/lib/app-helpers.js");

  // 1. Standard postgresql URL with query parameters
  const standard = derivePreviewDatabaseUrl(
    "postgresql://myuser:mypass@localhost:5432/myapp_prod?sslmode=disable",
    "myapp_prod",
    "myapp_prod_prev_d1234",
  );
  assert.equal(
    standard,
    "postgresql://myuser:mypass@localhost:5432/myapp_prod_prev_d1234?sslmode=disable",
  );

  // 2. Percent-encoded credentials and database name
  const encoded = derivePreviewDatabaseUrl(
    "postgres://user%40example.com:p%40ss%23123@db.internal:5432/app_data",
    "app_data",
    "app_data_prev_abc",
  );
  assert.equal(
    encoded,
    "postgres://user%40example.com:p%40ss%23123@db.internal:5432/app_data_prev_abc",
  );

  // 3. Fail-closed: Mismatched database name throws safety violation
  assert.throws(() => {
    derivePreviewDatabaseUrl(
      "postgresql://user:pass@localhost:5432/wrong_db",
      "expected_db",
      "expected_db_prev_1",
    );
  }, /Safety violation: database URL path "\/wrong_db" does not match configured database name "expected_db"/);

  // 4. MySQL / MariaDB protocols derive successfully
  const mysqlClone = derivePreviewDatabaseUrl(
    "mysql://user:pass@localhost:3306/mydb",
    "mydb",
    "mydb_prev",
  );
  assert.equal(mysqlClone, "mysql://user:pass@localhost:3306/mydb_prev");

  const mariaClone = derivePreviewDatabaseUrl(
    "mariadb://user:pass@explita-mariadb:3306/mydb",
    "mydb",
    "mydb_prev",
  );
  assert.equal(
    mariaClone,
    "mariadb://user:pass@explita-mariadb:3306/mydb_prev",
  );

  // 5. Fail-closed: Unsupported protocol throws
  assert.throws(() => {
    derivePreviewDatabaseUrl(
      "mongodb://user:pass@localhost:27017/mydb",
      "mydb",
      "mydb_prev",
    );
  }, /Safety violation: unsupported protocol "mongodb:"/);

  // 6. Empty source URL returns empty string
  assert.equal(derivePreviewDatabaseUrl("", "mydb", "mydb_prev"), "");
});

test("validateDbCloneParams validates identifiers, port, and returns config object", async () => {
  const { validateDbCloneParams } = await import("../src/lib/app-helpers.js");

  // Valid params
  const valid = validateDbCloneParams(
    { name: "my_db", user: "my_user", url: "postgres://..." },
    "deploy-uuid-1234",
    "explita",
    5432,
  );
  assert.equal(valid.sourceDbName, "my_db");
  assert.equal(valid.ownerUser, "my_user");
  assert.equal(valid.adminUser, "explita");
  assert.equal(valid.safePort, 5432);
  assert.ok(valid.cloneDbName.startsWith("my_db_prev_"));

  // Invalid source DB name
  assert.throws(() => {
    validateDbCloneParams(
      { name: "my-db;drop", user: "my_user", url: "" },
      "d1",
      "explita",
      5432,
    );
  }, /Invalid characters in source database name/);

  // Invalid source DB user
  assert.throws(() => {
    validateDbCloneParams(
      { name: "my_db", user: "user'--", url: "" },
      "d1",
      "explita",
      5432,
    );
  }, /Invalid characters in database user name/);

  // Invalid administrative username
  assert.throws(() => {
    validateDbCloneParams(
      { name: "my_db", user: "my_user", url: "" },
      "d1",
      "admin user",
      5432,
    );
  }, /Invalid characters in administrative database username/);

  // Invalid port
  assert.throws(() => {
    validateDbCloneParams(
      { name: "my_db", user: "my_user", url: "" },
      "d1",
      "explita",
      99999,
    );
  }, /Invalid database port/);
});

test("database-clone formatPgpassEntry formats multi-target entries and escapes special characters", async () => {
  const { formatPgpassEntry } = await import("../src/lib/database-clone.js");

  const entry = formatPgpassEntry("my:user\\name", "p:ass\\word", 5432);
  const lines = entry.split("\n");

  // Verify escaping colons and backslashes
  const expectedUser = "my\\:user\\\\name";
  const expectedPass = "p\\:ass\\\\word";

  assert.ok(lines.includes(`*:5432:*:${expectedUser}:${expectedPass}`));
  assert.ok(lines.includes(`*:*:*:${expectedUser}:${expectedPass}`));
  assert.ok(lines.includes(`localhost:5432:*:${expectedUser}:${expectedPass}`));
  assert.ok(lines.includes(`127.0.0.1:5432:*:${expectedUser}:${expectedPass}`));
  assert.ok(
    lines.includes(
      `/var/run/postgresql:5432:*:${expectedUser}:${expectedPass}`,
    ),
  );
  assert.ok(lines.includes(`/tmp:5432:*:${expectedUser}:${expectedPass}`));
});

test("database-clone validateAndParseSourceUrl verifies URL parameters and fails closed", async () => {
  const { validateAndParseSourceUrl } =
    await import("../src/lib/database-clone.js");
  const { encryptValue } = await import("@explita/infra-protocol");

  // Valid managed source URL
  const validUrl = "postgres://appuser:secret123@localhost:5432/myapp_db";
  const result = validateAndParseSourceUrl(
    { name: "myapp_db", user: "appuser", url: encryptValue(validUrl) },
    "myapp_db",
    "appuser",
    "myapp_db_prev_123",
    5432,
  );

  assert.equal(result.ownerPassword, "secret123");
  assert.equal(
    result.cloneUrl,
    "postgres://appuser:secret123@localhost:5432/myapp_db_prev_123",
  );

  // Fails if sourceDb has no url
  assert.throws(() => {
    validateAndParseSourceUrl(
      { name: "myapp_db", user: "appuser", url: "" },
      "myapp_db",
      "appuser",
      "myapp_db_prev_123",
      5432,
    );
  }, /does not have a connection URL configured/);

  // Fails if username doesn't match ownerUser
  assert.throws(() => {
    validateAndParseSourceUrl(
      {
        name: "myapp_db",
        user: "wronguser",
        url: encryptValue("postgres://wronguser:pass@localhost:5432/myapp_db"),
      },
      "myapp_db",
      "appuser",
      "myapp_db_prev_123",
      5432,
    );
  }, /Safety violation: database URL username "wronguser" does not match configured database owner "appuser"/);

  // Fails if port doesn't match safePort
  assert.throws(() => {
    validateAndParseSourceUrl(
      {
        name: "myapp_db",
        user: "appuser",
        url: encryptValue("postgres://appuser:pass@localhost:5433/myapp_db"),
      },
      "myapp_db",
      "appuser",
      "myapp_db_prev_123",
      5432,
    );
  }, /Safety violation: database URL port "5433" does not match managed database port "5432"/);

  // Fails if database name in path doesn't match sourceDbName
  assert.throws(() => {
    validateAndParseSourceUrl(
      {
        name: "myapp_db",
        user: "appuser",
        url: encryptValue("postgres://appuser:pass@localhost:5432/other_db"),
      },
      "myapp_db",
      "appuser",
      "myapp_db_prev_123",
      5432,
    );
  }, /Safety violation: database URL database name "other_db" does not match configured source database name "myapp_db"/);

  // Fails if hostname is an external unmanaged host
  assert.throws(() => {
    validateAndParseSourceUrl(
      {
        name: "myapp_db",
        user: "appuser",
        url: encryptValue(
          "postgres://appuser:pass@external-db.aws.com:5432/myapp_db",
        ),
      },
      "myapp_db",
      "appuser",
      "myapp_db_prev_123",
      5432,
    );
  }, /Safety violation: database URL host "external-db.aws.com" does not match managed database instance/);
});

test("database-clone dropPreviewDatabase handles empty or invalid identifiers safely", async () => {
  const { dropPreviewDatabase } = await import("../src/lib/database-clone.js");

  // Empty name does nothing and returns cleanly
  await dropPreviewDatabase("");

  // Invalid SQL injection identifier skips drop without throwing
  await dropPreviewDatabase("db; DROP TABLE users;");
});
