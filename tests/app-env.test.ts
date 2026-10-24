import "@explita/env-loader/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { getAppEnvironment, extractAppEnvironment, resolveAppEnvironment } from "../src/lib/app-helpers.js";

test("getAppEnvironment extracts primary database, secondary databases, redis, and custom envs", () => {
  const dummyApp: any = {
    id: "app_1234567890",
    name: "payment-service",
    databases: [
      { key: "default", url: "postgresql://postgres:secret@127.0.0.1:5432/main_db" },
      { key: "analytics", url: "postgresql://postgres:secret@127.0.0.1:5432/analytics_db" },
      { key: "read-replica", url: "postgresql://postgres:secret@127.0.0.1:5432/replica_db" },
    ],
    databasesMap: new Map([
      ["default", { key: "default", url: "postgresql://postgres:secret@127.0.0.1:5432/main_db" }],
      ["analytics", { key: "analytics", url: "postgresql://postgres:secret@127.0.0.1:5432/analytics_db" }],
      ["read-replica", { key: "read-replica", url: "postgresql://postgres:secret@127.0.0.1:5432/replica_db" }],
    ]),
    redis: {
      url: "redis://default:redispass@127.0.0.1:6379",
    },
    envs: [
      { key: "NODE_ENV", value: "production" },
      { key: "STRIPE_KEY", value: "sk_live_secret123" },
    ],
  };

  const { env, dockerArgs } = getAppEnvironment(dummyApp);

  assert.equal(env["DATABASE_URL"], "postgresql://postgres:secret@127.0.0.1:5432/main_db");
  assert.equal(env["ANALYTICS_DATABASE_URL"], "postgresql://postgres:secret@127.0.0.1:5432/analytics_db");
  assert.equal(env["READ_REPLICA_DATABASE_URL"], "postgresql://postgres:secret@127.0.0.1:5432/replica_db");
  assert.equal(env["REDIS_URL"], "redis://default:redispass@127.0.0.1:6379");
  assert.equal(env["NODE_ENV"], "production");
  assert.equal(env["STRIPE_KEY"], "sk_live_secret123");

  assert.ok(dockerArgs.includes("-e"));
  assert.ok(dockerArgs.includes("DATABASE_URL=postgresql://postgres:secret@127.0.0.1:5432/main_db"));
  assert.ok(dockerArgs.includes("ANALYTICS_DATABASE_URL=postgresql://postgres:secret@127.0.0.1:5432/analytics_db"));
  assert.ok(dockerArgs.includes("READ_REPLICA_DATABASE_URL=postgresql://postgres:secret@127.0.0.1:5432/replica_db"));
  assert.ok(dockerArgs.includes("REDIS_URL=redis://default:redispass@127.0.0.1:6379"));
  assert.ok(dockerArgs.includes("NODE_ENV=production"));
  assert.ok(dockerArgs.includes("STRIPE_KEY=sk_live_secret123"));

  // Check aliases
  assert.equal(extractAppEnvironment, getAppEnvironment);
  assert.equal(resolveAppEnvironment, getAppEnvironment);
});

test("getAppEnvironment falls back to databases[0] when key 'default' is not explicitly used", () => {
  const dummyApp: any = {
    id: "app_1234567890",
    name: "single-db-app",
    databases: [
      { key: "mydb", url: "postgresql://postgres:secret@127.0.0.1:5432/my_custom_db" },
    ],
    envs: [],
  };

  const { env, dockerArgs } = getAppEnvironment(dummyApp);

  assert.equal(env["DATABASE_URL"], "postgresql://postgres:secret@127.0.0.1:5432/my_custom_db");
  assert.ok(dockerArgs.includes("DATABASE_URL=postgresql://postgres:secret@127.0.0.1:5432/my_custom_db"));
});

test("getAppEnvironment honors preview overrideDbUrls as Map and string", () => {
  const dummyApp: any = {
    id: "app_1234567890",
    name: "preview-app",
    databases: [
      { key: "default", url: "postgresql://postgres:prod@127.0.0.1:5432/prod_db" },
      { key: "analytics", url: "postgresql://postgres:prod@127.0.0.1:5432/prod_analytics" },
    ],
    databasesMap: new Map([
      ["default", { key: "default", url: "postgresql://postgres:prod@127.0.0.1:5432/prod_db" }],
      ["analytics", { key: "analytics", url: "postgresql://postgres:prod@127.0.0.1:5432/prod_analytics" }],
    ]),
    envs: [{ key: "APP_ENV", value: "preview" }],
  };

  // 1. As Map (multi-db cloning)
  const previewMap = new Map([
    ["default", "postgresql://postgres:prod@127.0.0.1:5432/prod_db_prev_123"],
    ["analytics", "postgresql://postgres:prod@127.0.0.1:5432/prod_analytics_prev_123"],
  ]);

  const { env: mapEnv } = getAppEnvironment(dummyApp, { overrideDbUrls: previewMap });
  assert.equal(mapEnv["DATABASE_URL"], "postgresql://postgres:prod@127.0.0.1:5432/prod_db_prev_123");
  assert.equal(mapEnv["ANALYTICS_DATABASE_URL"], "postgresql://postgres:prod@127.0.0.1:5432/prod_analytics_prev_123");

  // 2. As single string
  const { env: stringEnv } = getAppEnvironment(dummyApp, {
    overrideDbUrls: "postgresql://postgres:prod@127.0.0.1:5432/single_cloned_db",
  });
  assert.equal(stringEnv["DATABASE_URL"], "postgresql://postgres:prod@127.0.0.1:5432/single_cloned_db");
  // Secondary DB still uses original URL if not mapped in string mode
  assert.equal(stringEnv["ANALYTICS_DATABASE_URL"], "postgresql://postgres:prod@127.0.0.1:5432/prod_analytics");
});

test("getAppEnvironment masks custom secrets when revealSecrets is false", () => {
  const dummyApp: any = {
    id: "app_1234567890",
    name: "secure-app",
    databases: [],
    envs: [
      { key: "PUBLIC_URL", value: "https://myapp.com" },
      { key: "SECRET_TOKEN", value: "super_secret_token" },
    ],
  };

  const { env, dockerArgs } = getAppEnvironment(dummyApp, { revealSecrets: false });
  assert.equal(env["PUBLIC_URL"], "••••••••");
  assert.equal(env["SECRET_TOKEN"], "••••••••");
  assert.ok(dockerArgs.includes("SECRET_TOKEN=••••••••"));
});
