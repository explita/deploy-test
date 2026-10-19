import "@explita/env-loader/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readdirSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateBackupFilename,
  resolveSafeBackupPath,
} from "../src/services/database/lib/utils.js";
import { pruneOldDatabaseBackups } from "../src/services/database/backup/helpers/prune.js";

test("generateBackupFilename produces valid timestamped .sql.gz filename", () => {
  const defaultFile = generateBackupFilename();
  assert.ok(defaultFile.startsWith("backup-default-"));
  assert.ok(defaultFile.endsWith(".sql.gz"));

  const customKeyFile = generateBackupFilename("analytics");
  assert.ok(customKeyFile.startsWith("backup-analytics-"));
  assert.ok(customKeyFile.endsWith(".sql.gz"));
});

test("extractKeyFromBackupFilename extracts database key from backup filenames", async () => {
  const { extractKeyFromBackupFilename } = await import(
    "../src/services/database/lib/utils.js"
  );
  assert.equal(
    extractKeyFromBackupFilename("backup-default-2026-10-12T12-00-00-000Z.sql.gz"),
    "default",
  );
  assert.equal(
    extractKeyFromBackupFilename("backup-analytics-2026-10-12T12-00-00-000Z.sql.gz"),
    "analytics",
  );
  assert.equal(
    extractKeyFromBackupFilename("backup-2026-10-12T12-00-00-000Z.sql.gz"),
    "default",
  );
});

test("resolveSafeBackupPath allows valid filenames and rejects path traversal", () => {
  const valid = resolveSafeBackupPath("app-123", "backup-2026-10-10.sql.gz");
  assert.ok(valid.endsWith("backup-2026-10-10.sql.gz"));

  assert.throws(
    () => resolveSafeBackupPath("app-123", "../../../etc/passwd"),
    /Invalid backup filename/,
  );

  assert.throws(
    () => resolveSafeBackupPath("app-123", "malicious.sh"),
    /Invalid backup filename/,
  );
});

test("pruneOldDatabaseBackups retains newest keepCount files and unlinks excess", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "explita-backup-test-"));

  try {
    const appDir = join(tmp, "test-app");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(appDir, { recursive: true });

    // Create 5 backup files with varying mtimes
    const now = Date.now();
    for (let i = 1; i <= 5; i++) {
      const file = join(appDir, `backup-${i}.sql.gz`);
      writeFileSync(file, `dummy backup data ${i}`, "utf8");
      // i=5 newest, i=1 oldest
      const time = new Date(now - (5 - i) * 60000);
      utimesSync(file, time, time);
    }

    const beforeFiles = readdirSync(appDir);
    assert.equal(beforeFiles.length, 5);

    // Prune keeping only 2 newest
    const deletedCount = await pruneOldDatabaseBackups("test-app", 2, appDir);
    assert.equal(deletedCount, 3);

    const remainingFiles = readdirSync(appDir);
    assert.equal(remainingFiles.length, 2);
    // Should keep backup-5 and backup-4
    assert.ok(remainingFiles.includes("backup-5.sql.gz"));
    assert.ok(remainingFiles.includes("backup-4.sql.gz"));
    assert.ok(!remainingFiles.includes("backup-1.sql.gz"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("pruneOldDatabaseBackups isolates pruning by database key", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "explita-backup-test-key-"));

  try {
    const appDir = join(tmp, "test-app");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(appDir, { recursive: true });

    const now = Date.now();
    // Create 3 default backups and 3 analytics backups
    for (let i = 1; i <= 3; i++) {
      const defFile = join(
        appDir,
        `backup-default-2026-10-1${i}T00-00-00-000Z.sql.gz`,
      );
      writeFileSync(defFile, `data default ${i}`);
      utimesSync(
        defFile,
        new Date(now - (4 - i) * 60000),
        new Date(now - (4 - i) * 60000),
      );

      const anaFile = join(
        appDir,
        `backup-analytics-2026-10-1${i}T00-00-00-000Z.sql.gz`,
      );
      writeFileSync(anaFile, `data analytics ${i}`);
      utimesSync(
        anaFile,
        new Date(now - (4 - i) * 60000),
        new Date(now - (4 - i) * 60000),
      );
    }

    // Prune only analytics keeping 1
    const deletedCount = await pruneOldDatabaseBackups(
      "test-app",
      1,
      appDir,
      "analytics",
    );
    assert.equal(deletedCount, 2);

    const remaining = readdirSync(appDir);
    // 3 default backups untouched + 1 newest analytics backup
    assert.equal(remaining.length, 4);
    assert.equal(remaining.filter((f) => f.includes("analytics")).length, 1);
    assert.equal(remaining.filter((f) => f.includes("default")).length, 3);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("buildS3ObjectKey formats object path correctly and trims slashes", async () => {
  const { buildS3ObjectKey } = await import(
    "../src/services/database/backup/helpers/s3.js"
  );

  const key1 = buildS3ObjectKey("backups", "app123", "default", "backup-default-2026.sql.gz");
  assert.equal(key1, "backups/app123/default/backup-default-2026.sql.gz");

  const key2 = buildS3ObjectKey("/custom/prefix/", "app456", "analytics", "backup-analytics-2026.sql.gz");
  assert.equal(key2, "custom/prefix/app456/analytics/backup-analytics-2026.sql.gz");
});

test("resolveAppS3Config resolves app override, honors disabled state, and decrypts secrets", async () => {
  const { resolveAppS3Config } = await import(
    "../src/services/database/backup/helpers/s3.js"
  );
  const { encryptValue } = await import("@explita/protocol");

  // Disabled
  const disabledApp: any = {
    id: "app-1",
    name: "test",
    metadata: {
      s3: { enabled: false, bucket: "test-b" },
    },
  };
  assert.equal(resolveAppS3Config(disabledApp), null);

  // App configured with encrypted secrets
  const appConfigured: any = {
    id: "app-2",
    name: "test-app",
    metadata: {
      s3: {
        enabled: true,
        bucket: "my-r2-bucket",
        endpoint: "https://r2.cloudflarestorage.com",
        accessKeyId: encryptValue("my-access-key"),
        secretAccessKey: encryptValue("my-secret-key"),
        region: "auto",
        prefix: "db-backups",
      },
    },
  };

  const resolved = resolveAppS3Config(appConfigured);
  assert.ok(resolved);
  assert.equal(resolved?.bucket, "my-r2-bucket");
  assert.equal(resolved?.accessKeyId, "my-access-key");
  assert.equal(resolved?.secretAccessKey, "my-secret-key");
  assert.equal(resolved?.prefix, "db-backups");
  assert.equal(resolved?.isGlobal, false);
});

test("SqlContentHasher computes identical hashes when only volatile comments/timestamps differ", async () => {
  const { SqlContentHasher } = await import(
    "../src/services/database/backup/helpers/exec.js"
  );
  const { Readable } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");
  const { Writable } = await import("node:stream");

  const dump1 = [
    "-- PostgreSQL database dump",
    "-- Dumped by pg_dump version 16.0",
    "-- Dumped from database version 16.0",
    "CREATE TABLE users (id SERIAL PRIMARY KEY, name VARCHAR(255));",
    "INSERT INTO users (id, name) VALUES (1, 'Alice');",
    "-- Dump completed on 2026-10-18 10:00:00",
  ].join("\n");

  const dump2 = [
    "-- PostgreSQL database dump",
    "-- Dumped by pg_dump version 16.1",
    "-- Dumped from database version 16.1",
    "CREATE TABLE users (id SERIAL PRIMARY KEY, name VARCHAR(255));",
    "INSERT INTO users (id, name) VALUES (1, 'Alice');",
    "-- Dump completed on 2026-10-18 16:30:00",
  ].join("\n");

  const dump3 = [
    "-- PostgreSQL database dump",
    "-- Dumped by pg_dump version 16.0",
    "CREATE TABLE users (id SERIAL PRIMARY KEY, name VARCHAR(255));",
    "INSERT INTO users (id, name) VALUES (1, 'Bob');",
    "-- Dump completed on 2026-10-18 10:00:00",
  ].join("\n");

  const hashStream = async (sql: string): Promise<{ digest: string; output: string }> => {
    const hasher = new SqlContentHasher();
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });

    await pipeline(Readable.from([Buffer.from(sql, "utf8")]), hasher, sink);
    return {
      digest: hasher.getDigest(),
      output: Buffer.concat(chunks).toString("utf8"),
    };
  };

  const res1 = await hashStream(dump1);
  const res2 = await hashStream(dump2);
  const res3 = await hashStream(dump3);

  // Raw streams must pass through transparently
  assert.equal(res1.output, dump1);
  assert.equal(res2.output, dump2);

  // Hash of dump1 and dump2 must match because only timestamps/banners differed
  assert.equal(res1.digest, res2.digest);

  // Hash of dump3 must differ because actual table data changed (Alice -> Bob)
  assert.notEqual(res1.digest, res3.digest);
});



