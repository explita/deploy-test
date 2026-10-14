import "@explita/env-loader/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { createAppSchema, updateAppSchema } from "../src/zod/app-schema.js";

test("zod createAppSchema normalizes preDeploy always to array", () => {
  const parsedSingle = createAppSchema.parse({
    name: "test-app",
    preDeploy: "npx prisma migrate deploy",
  });
  assert.deepEqual(parsedSingle.preDeploy, ["npx prisma migrate deploy"]);

  const parsedArray = createAppSchema.parse({
    name: "test-app",
    preDeploy: ["npx prisma migrate deploy", "npm run seed"],
  });
  assert.deepEqual(parsedArray.preDeploy, [
    "npx prisma migrate deploy",
    "npm run seed",
  ]);

  const parsedJsonArray = createAppSchema.parse({
    name: "test-app",
    preDeploy: JSON.stringify(["npx prisma migrate deploy", "npm run seed"]),
  });
  assert.deepEqual(parsedJsonArray.preDeploy, [
    "npx prisma migrate deploy",
    "npm run seed",
  ]);

  const parsedDefault = createAppSchema.parse({
    name: "test-app",
  });
  assert.deepEqual(parsedDefault.preDeploy, []);

  const parsedEmpty = createAppSchema.parse({
    name: "test-app",
    preDeploy: "",
  });
  assert.deepEqual(parsedEmpty.preDeploy, []);

  const parsedWhitespace = createAppSchema.parse({
    name: "test-app",
    preDeploy: "   ",
  });
  assert.deepEqual(parsedWhitespace.preDeploy, []);
});

test("zod updateAppSchema normalizes preDeploy always to array or preserves undefined", () => {
  const updateParsed = updateAppSchema.parse({
    preDeploy: ["npm run migrate", "npm run warmup"],
  });
  assert.deepEqual(updateParsed.preDeploy, [
    "npm run migrate",
    "npm run warmup",
  ]);

  const clearParsedNull = updateAppSchema.parse({
    preDeploy: null,
  });
  assert.deepEqual(clearParsedNull.preDeploy, []);

  const clearParsedEmpty = updateAppSchema.parse({
    preDeploy: [],
  });
  assert.deepEqual(clearParsedEmpty.preDeploy, []);

  const omittedUndefined = updateAppSchema.parse({});
  assert.equal(omittedUndefined.preDeploy, undefined);
});

test("zod schemas normalize healthCheck path cleanly", () => {
  const defaultApp = createAppSchema.parse({ name: "my-app" });
  assert.equal(defaultApp.healthCheck, "/");

  const customPath = createAppSchema.parse({
    name: "my-app",
    healthCheck: "health",
  });
  assert.equal(customPath.healthCheck, "/health");

  const slashPath = createAppSchema.parse({
    name: "my-app",
    healthCheck: "/api/health",
  });
  assert.equal(slashPath.healthCheck, "/api/health");

  const disabledApp = createAppSchema.parse({
    name: "my-app",
    healthCheck: false,
  });
  assert.equal(disabledApp.healthCheck, null);

  const disabledNull = createAppSchema.parse({
    name: "my-app",
    healthCheck: null,
  });
  assert.equal(disabledNull.healthCheck, null);

  const updateCustom = updateAppSchema.parse({
    healthCheck: "ready",
  });
  assert.equal(updateCustom.healthCheck, "/ready");

  const updateDisabled = updateAppSchema.parse({
    healthCheck: null,
  });
  assert.equal(updateDisabled.healthCheck, null);

  const updateOmitted = updateAppSchema.parse({});
  assert.equal(updateOmitted.healthCheck, undefined);
});
