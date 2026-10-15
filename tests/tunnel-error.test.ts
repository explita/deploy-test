import "@explita/env-loader/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { extractTunnelError } from "../src/lib/tunnel.js";

test("extractTunnelError identifies subdomain collision and suggests actionable fix", () => {
  const output = `
Failed to connect:
Subdomain "testing-app" is already in use by an active session.
Please choose a different subdomain or stop the active session first.
`;
  const err = extractTunnelError(output);
  assert.ok(err);
  assert.match(err, /Subdomain "testing-app" is already in use by an active session/);
  assert.match(err, /-s \/ --subdomain/);
});

test("extractTunnelError identifies invalid or unauthorized tokens", () => {
  const output = "Failed to connect: Invalid tunnel token supplied";
  const err = extractTunnelError(output);
  assert.ok(err);
  assert.match(err, /Invalid or unauthorized tunnel token/);
});

test("extractTunnelError identifies network or service unreachable errors", () => {
  const output = "Failed to connect: Unable to connect to the tunnel service.";
  const err = extractTunnelError(output);
  assert.ok(err);
  assert.match(err, /Unable to connect to the tunnel service/);
});

test("extractTunnelError returns null for successful output", () => {
  const output = "Public URL: https://testing-app.tunnel.explita.ng\nConnected to server";
  assert.equal(extractTunnelError(output), null);
});
