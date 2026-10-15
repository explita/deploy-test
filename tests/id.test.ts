import test from "node:test";
import assert from "node:assert/strict";
import {
  stripIdPrefix,
  stripAppPrefixes,
  formatAppId,
  formatDeploymentId,
  formatCronId,
  formatDatabaseId,
} from "../src/lib/id.js";

test("formatDeploymentId prepends dep_ and slices last 10 characters", () => {
  assert.equal(formatDeploymentId("-bqX25k6ty"), "dep_-bqX25k6ty");
  assert.equal(formatDeploymentId("1234567890"), "dep_1234567890");
});

test("formatAppId prepends app_ and slices last 10 characters", () => {
  assert.equal(formatAppId("s_uu3JUzdG"), "app_s_uu3JUzdG");
});

test("formatCronId and formatDatabaseId prepend respective prefixes", () => {
  assert.equal(formatCronId("c123456789"), "cron_c123456789");
  assert.equal(formatDatabaseId("d123456789"), "db_d123456789");
});

test("stripIdPrefix slices last 10 characters for known prefixes with length > 10", () => {
  assert.equal(stripIdPrefix("dep_-bqX25k6ty"), "-bqX25k6ty");
  assert.equal(stripIdPrefix("app_s_uu3JUzdG"), "s_uu3JUzdG");
  assert.equal(stripIdPrefix("cron_c123456789"), "c123456789");
  assert.equal(stripIdPrefix("db_d123456789"), "d123456789");
});

test("stripIdPrefix preserves app names and un-prefixed IDs", () => {
  assert.equal(stripIdPrefix("my-sample-app"), "my-sample-app");
  assert.equal(stripIdPrefix("-bqX25k6ty"), "-bqX25k6ty");
  assert.equal(stripIdPrefix("s_uu3JUzdG"), "s_uu3JUzdG");
  assert.equal(stripIdPrefix(""), "");
  assert.equal(stripIdPrefix(undefined), undefined);
});

test("stripIdPrefix does not accidentally strip 10-char raw nanoids starting with dep_ or app_", () => {
  // A raw 10-char nanoid coincidentally starting with app_
  const rawCoincidental = "app_123456"; // length 10
  assert.equal(stripIdPrefix(rawCoincidental), "app_123456");

  // But its formatted version (14 chars) correctly strips to the 10-char raw ID
  const formatted = formatAppId(rawCoincidental);
  assert.equal(formatted, "app_app_123456");
  assert.equal(stripIdPrefix(formatted), "app_123456");
});

test("stripAppPrefixes removes prefixes from app id, deployment id, databases, and crons", () => {
  const mockFormattedApp: any = {
    id: "app_s_uu3JUzdG",
    currentDeploymentId: "dep_-bqX25k6ty",
    currentDeployment: {
      id: "dep_-bqX25k6ty",
      containerName: "explita-app-test",
    },
    databases: [
      { id: "db_d123456789", key: "default", name: "app_db" },
    ],
    databasesMap: new Map([
      ["default", { id: "db_d123456789", key: "default", name: "app_db" }],
    ]),
    crons: [
      { id: "cron_c123456789", appId: "app_s_uu3JUzdG", name: "cleanup", schedule: "* * * * *" },
    ],
    cronsMap: new Map([
      ["cron_c123456789", { id: "cron_c123456789", appId: "app_s_uu3JUzdG", name: "cleanup", schedule: "* * * * *" }],
    ]),
  };

  const stripped = stripAppPrefixes(mockFormattedApp);
  assert.equal(stripped.id, "s_uu3JUzdG");
  assert.equal(stripped.currentDeploymentId, "-bqX25k6ty");
  assert.equal(stripped.currentDeployment?.id, "-bqX25k6ty");
  assert.equal(stripped.databases[0].id, "d123456789");
  assert.equal(stripped.crons[0].id, "c123456789");
  assert.equal(stripped.crons[0].appId, "s_uu3JUzdG");
  assert.equal(stripped.cronsMap.has("c123456789"), true);
});
