import "@explita/env-loader/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { syncServerCaddy } from "../src/lib/caddy.js";
import { caddy, server } from "../src/lib/constants.js";

test("syncServerCaddy writes and unlinks _server.caddy based on server.domain", async () => {
  const filePath = join(caddy.appsDir, "_server.caddy");

  // Clean initial state
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }

  // 1. When server.domain is defined
  (server as any).domain = "deploy.example.com";
  await syncServerCaddy();

  assert.equal(existsSync(filePath), true);
  const content = readFileSync(filePath, "utf8");
  assert.ok(content.includes("deploy.example.com {"));
  assert.ok(content.includes(`reverse_proxy host.docker.internal:${server.port}`));

  // 2. When server.domain is undefined
  (server as any).domain = undefined;
  await syncServerCaddy();

  assert.equal(existsSync(filePath), false);
});
