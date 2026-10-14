import dns from "node:dns/promises";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { caddy } from "./constants.js";
import { cleanDomain, DomainCheckResult } from "@explita/protocol/deploy";
import { getServerPublicIp } from "@explita/protocol";

/**
 * Checks if Caddy has already provisioned an active SSL/TLS certificate for this domain.
 */
export async function checkCaddyCertificate(
  domain: string,
): Promise<{ hasCertificate: boolean; message: string }> {
  const certsBase = join(caddy.dataDir, "caddy", "certificates");
  if (!existsSync(certsBase)) {
    return {
      hasCertificate: false,
      message: "No certificate provisioned yet.",
    };
  }

  try {
    const issuers = await readdir(certsBase);
    for (const issuer of issuers) {
      const issuerPath = join(certsBase, issuer);
      const domainDir = join(issuerPath, domain);
      if (existsSync(domainDir)) {
        const files = await readdir(domainDir);
        const crt = files.find((f) => f.endsWith(".crt"));
        if (crt) {
          const readableIssuer = issuer.includes("letsencrypt")
            ? "Let's Encrypt"
            : issuer.includes("zerossl")
              ? "ZeroSSL"
              : issuer;
          return {
            hasCertificate: true,
            message: `Active certificate provisioned by ${readableIssuer}.`,
          };
        }
      }
    }
  } catch {}

  return {
    hasCertificate: false,
    message: "Pending Caddy automated issuance after DNS points to server.",
  };
}

/**
 * Performs DNS resolution comparing the domain target against the server's public IP
 * and checks Caddy certificate status.
 */
export async function verifyDomainDns(
  domainInput: string,
): Promise<DomainCheckResult> {
  const domain = cleanDomain(domainInput);
  const serverIp = await getServerPublicIp();

  let aRecords: string[] = [];
  let cnameRecords: string[] = [];
  const cnameResolvedIps: string[] = [];

  try {
    aRecords = await dns.resolve4(domain);
  } catch (err: any) {
    if (err?.code !== "ENODATA" && err?.code !== "ENOTFOUND") {
      // ignore transient dns errors
    }
  }

  try {
    cnameRecords = await dns.resolveCname(domain);
  } catch {}

  // If there are CNAME records, resolve their target IPs as well
  for (const cname of cnameRecords) {
    try {
      const resolved = await dns.resolve4(cname);
      cnameResolvedIps.push(...resolved);
    } catch {}
  }

  const allResolvedIps = Array.from(
    new Set([...aRecords, ...cnameResolvedIps]),
  );
  const certInfo = await checkCaddyCertificate(domain);

  if (allResolvedIps.length === 0) {
    return {
      domain,
      serverIp,
      dns: {
        status: "unresolved",
        aRecords,
        cnameRecords,
        matchesServerIp: false,
        message: `No A or CNAME records found for "${domain}".`,
      },
      ssl: {
        status: certInfo.hasCertificate ? "active" : "pending",
        hasCertificate: certInfo.hasCertificate,
        message: certInfo.message,
      },
    };
  }

  const matches =
    allResolvedIps.includes(serverIp) ||
    (serverIp === "127.0.0.1" &&
      (allResolvedIps.includes("127.0.0.1") || domain === "localhost"));

  if (matches) {
    return {
      domain,
      serverIp,
      dns: {
        status: "verified",
        aRecords,
        cnameRecords,
        matchesServerIp: true,
        message: `DNS verified (points to ${serverIp}).`,
      },
      ssl: {
        status: certInfo.hasCertificate ? "active" : "pending",
        hasCertificate: certInfo.hasCertificate,
        message: certInfo.hasCertificate
          ? certInfo.message
          : "Caddy ready to issue automated SSL certificate.",
      },
    };
  }

  return {
    domain,
    serverIp,
    dns: {
      status: "mismatch",
      aRecords,
      cnameRecords,
      matchesServerIp: false,
      message: `Domain points to ${allResolvedIps.join(", ")} (expected ${serverIp}). Please update your DNS records.`,
    },
    ssl: {
      status: certInfo.hasCertificate ? "active" : "pending",
      hasCertificate: certInfo.hasCertificate,
      message: certInfo.message,
    },
  };
}
