import { FastifyReply, FastifyRequest } from "fastify";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import * as tar from "tar";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { deployer } from "../../lib/deployer.js";
import { server } from "../../lib/constants.js";
import { prisma } from "../../lib/prisma.js";
import { removeAppTunnel } from "../../lib/tunnel.js";
import { AppDbEntry } from "@explita/protocol/deploy";
import { formatDeployment } from "../../lib/formatters/deployment.js";

export async function deployApp(request: FastifyRequest, reply: FastifyReply) {
  const app = request.ctx.app;

  const query = request.query as Record<string, string> | undefined;

  if (query?.tunnel !== undefined) {
    const isTunnelWanted = query.tunnel !== "false";
    const existingMeta = app.metadata;
    await prisma.app.update({
      where: { id: app.id },
      data: {
        metadata: {
          ...existingMeta,
          tunnelEnabled: isTunnelWanted,
        } as any,
      },
    });
    if (!isTunnelWanted) {
      await removeAppTunnel(app);
    }
  }

  if (
    !request.body ||
    (!Buffer.isBuffer(request.body) &&
      typeof (request.body as any).pipe !== "function")
  ) {
    return reply
      .code(400)
      .send({ success: false, error: "Missing or invalid archive body" });
  }

  const isPreview = Boolean(query?.preview);
  const cloneDbParam = query?.cloneDb;

  let cloneDbTargets: AppDbEntry[] = [];

  if (cloneDbParam !== undefined && cloneDbParam !== "false") {
    if (!isPreview) {
      return reply.code(400).send({
        success: false,
        error:
          "Cannot use --clone-db on a production deployment. Database cloning is only supported for preview deployments (use --preview --clone-db).",
      });
    }

    const databases = app.databases;

    if (databases.length === 0) {
      return reply.code(400).send({
        success: false,
        error: `Cannot clone database: Application "${app.name}" does not have any database configured. Create a database first with "eda db create -a ${app.id}".`,
      });
    }

    const rawParam =
      cloneDbParam === "true" || cloneDbParam === ""
        ? undefined
        : cloneDbParam.trim();

    if (!rawParam) {
      // Fallback to "default" database key (or first configured database)
      const defaultDb = databases.find((d) => d.key === "default")!;
      cloneDbTargets = [defaultDb];
    } else if (rawParam.toLowerCase() === "all") {
      // Clone all databases configured for this application
      cloneDbTargets = [...databases];
    } else {
      // Comma-separated keys/names, or single key/name
      const requestedKeys = rawParam
        .split(",")
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean);

      for (const req of requestedKeys) {
        const found = databases.find(
          (d) => d.key.toLowerCase() === req || d.name.toLowerCase() === req,
        );
        if (!found) {
          const available = databases
            .map((d) => `${d.key} (${d.name})`)
            .join(", ");

          return reply.code(404).send({
            success: false,
            error: `Database "${req}" was not found on application "${app.name}". Available databases: ${available}`,
          });
        }

        if (!cloneDbTargets.some((t) => t.key === found.key)) {
          cloneDbTargets.push(found);
        }
      }
    }
  }

  const rawSubdomain = query?.subdomain
    ? String(query.subdomain).trim()
    : undefined;

  let previewDomains: string[] = [];
  if (query?.domain) {
    const rawDomain = query.domain;
    const items = Array.isArray(rawDomain) ? rawDomain : [rawDomain];
    for (const item of items) {
      if (typeof item === "string") {
        for (const part of item.split(",")) {
          const trimmed = part.trim();
          if (trimmed) previewDomains.push(trimmed);
        }
      }
    }
  }

  const rawSourceHash = query?.sourceHash
    ? String(query.sourceHash).trim()
    : undefined;

  const rawPreviewAuth = query?.previewAuth
    ? String(query.previewAuth).trim()
    : undefined;

  if (rawPreviewAuth && !isPreview) {
    return reply.code(400).send({
      success: false,
      error:
        "Cannot use auth without preview deployment (use --preview --auth <user:pass>).",
    });
  }

  const deployment = await deployer.prepareDeployment(app, {
    preview: isPreview,
    cloneDbs: cloneDbTargets,
    previewSubdomain: rawSubdomain,
    previewDomains: previewDomains.length > 0 ? previewDomains : undefined,
    previewAuth: rawPreviewAuth,
    sourceHash: rawSourceHash,
    tunnelPreference:
      query?.tunnel !== undefined
        ? query.tunnel !== "false" && query.tunnel !== "0"
        : undefined,
  });
  const destDir = join(server.deployBaseDir, app.id, deployment.id);
  await mkdir(destDir, { recursive: true });

  try {
    const inputStream = Buffer.isBuffer(request.body)
      ? Readable.from(request.body)
      : (request.body as any);

    await pipeline(inputStream, tar.x({ C: destDir }));
  } catch (err) {
    const errorMsg = `Failed to extract archive: ${err instanceof Error ? err.message : String(err)}`;
    await prisma.deployment
      .update({
        where: { id: deployment.id },
        data: {
          status: "FAILED",
          error: errorMsg,
          finishedAt: new Date(),
        },
      })
      .catch(() => {});
    await rm(destDir, { recursive: true, force: true }).catch(() => {});

    return reply.code(400).send({
      success: false,
      error: errorMsg,
    });
  }

  // Start background deployment execution
  deployer.startDeployment(app, deployment.id, destDir);

  return reply
    .code(202)
    .send({ success: true, data: formatDeployment(deployment) });
}
