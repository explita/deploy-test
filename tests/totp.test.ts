import test from "node:test";
import assert from "node:assert/strict";
import { generateTotp, verifyTotp, base32ToBuffer } from "../src/lib/totp.js";

test("base32ToBuffer decodes standard Base32 strings", () => {
  const buf = base32ToBuffer("JBSWY3DPEHPK3PXP");
  assert.equal(buf.slice(0, 6).toString("utf8"), "Hello!");
});

test("generateTotp produces 6-digit string", () => {
  const secret = "JBSWY3DPEHPK3PXP";
  const code = generateTotp(secret, 1000000000000);
  assert.equal(typeof code, "string");
  assert.equal(code.length, 6);
  assert.match(code, /^\d{6}$/);
});

test("verifyTotp validates current and nearby window codes", () => {
  const secret = "JBSWY3DPEHPK3PXP";
  const now = Date.now();
  const currentCode = generateTotp(secret, now);

  assert.equal(verifyTotp(secret, currentCode), true);

  // Past 25 seconds (same window or 1 step back)
  const pastCode = generateTotp(secret, now - 25000);
  assert.equal(verifyTotp(secret, pastCode), true);

  // Future 25 seconds (same window or 1 step forward)
  const futureCode = generateTotp(secret, now + 25000);
  assert.equal(verifyTotp(secret, futureCode), true);

  // Invalid code fails
  assert.equal(verifyTotp(secret, "000000"), false);
  assert.equal(verifyTotp(secret, "abcdef"), false);
  assert.equal(verifyTotp(secret, "12345"), false);
});
