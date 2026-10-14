import { FastifyRequest, FastifyReply } from "fastify";
import { server } from "../lib/constants.js";
import { verifyTotp } from "../lib/totp.js";

const excludedRoutes = ["/health"];

export async function authHook(request: FastifyRequest, reply: FastifyReply) {
  if (excludedRoutes.some((route) => request.url.startsWith(route))) return;

  const authHeader = request.headers.authorization;
  const query = request.query;
  const bearerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : undefined;
  const providedToken = bearerToken || query?.token;

  if (!providedToken || providedToken !== server.token) {
    return reply.code(401).send({ error: "Unauthorized, check your token." });
  }

  // 1. Verify Passcode via header (if DEPLOY_PASSCODE is configured)
  if (server.passcode) {
    const providedPass = (
      request.headers["x-explita-pass"] as string | undefined
    )?.trim();

    if (providedPass !== server.passcode) {
      return reply.code(401).send({
        error:
          "Passcode authentication failed or required. Provide --pass <pin>.",
        requiresPasscode: true,
      });
    }
  }

  // 2. Verify TOTP 2FA via header (if DEPLOY_2FA_SECRET is configured)
  if (server.twoFactorSecret) {
    const providedOtp = (
      (request.headers["x-explita-2fa"] as string | undefined) ||
      (request.headers["x-explita-otp"] as string | undefined)
    )?.trim();

    if (!providedOtp || !verifyTotp(server.twoFactorSecret, providedOtp)) {
      return reply.code(401).send({
        error:
          "2FA authentication failed or required. Provide valid 6-digit code via --otp <code>.",
        requires2FA: true,
      });
    }
  }
}
