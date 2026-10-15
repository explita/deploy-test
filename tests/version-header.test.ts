import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { DEPLOY_VERSION } from "../src/version.js";

test("Fastify onSend hook sets x-explita-version header", async () => {
  const app = Fastify();

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("x-explita-version", DEPLOY_VERSION);
    return payload;
  });

  app.get("/health", async () => ({
    ok: true,
    service: "explita-deploy",
    version: DEPLOY_VERSION,
  }));

  const res = await app.inject({ method: "GET", url: "/health" });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-explita-version"], DEPLOY_VERSION);

  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.service, "explita-deploy");
  assert.equal(body.version, DEPLOY_VERSION);
});
