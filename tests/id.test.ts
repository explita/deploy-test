import test from "node:test";
import assert from "node:assert/strict";
import {
  stripIdPrefix,
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
