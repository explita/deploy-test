import { createHmac } from "node:crypto";

/**
 * Decodes a Base32 string into a Buffer.
 * Supports standard RFC 4648 Base32 alphabet (A-Z, 2-7).
 */
export function base32ToBuffer(base32: string): Buffer {
  const clean = base32.toUpperCase().replace(/[\s=-]/g, "");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (let i = 0; i < clean.length; i++) {
    const val = alphabet.indexOf(clean[i]);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/**
 * Computes a 6-digit TOTP code (RFC 6238) for a given Base32 secret and timestamp.
 */
export function generateTotp(
  secret: string,
  timeMs: number = Date.now(),
  stepSeconds: number = 30,
): string {
  const key = base32ToBuffer(secret);
  const counter = Math.floor(timeMs / 1000 / stepSeconds);

  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigInt64BE(BigInt(counter));

  const hmac = createHmac("sha1", key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = (binary % 1000000).toString().padStart(6, "0");
  return otp;
}

/**
 * Verifies whether a user-provided OTP matches the secret within the allowed window.
 * Default window = 1 allows -30s to +30s clock drift (3 intervals total).
 */
export function verifyTotp(
  secret: string,
  token: string,
  window: number = 1,
): boolean {
  const cleanToken = token.trim();
  if (cleanToken.length !== 6 || !/^\d{6}$/.test(cleanToken)) {
    return false;
  }

  const now = Date.now();
  for (let offset = -window; offset <= window; offset++) {
    const time = now + offset * 30 * 1000;
    const expected = generateTotp(secret, time);
    if (cleanToken === expected) {
      return true;
    }
  }

  return false;
}
