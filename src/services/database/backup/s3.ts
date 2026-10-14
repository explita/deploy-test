import { FastifyReply, FastifyRequest } from "fastify";
import { RequestParams } from "../../../types/misc.js";
import { prisma } from "../../../lib/prisma.js";
import { encryptValue, logger } from "@explita/protocol";
import {
  DatabaseBackupS3Config,
  DatabaseBackupS3Status,
} from "@explita/protocol/deploy";
import {
  resolveAppS3Config,
  resolveGlobalS3Config,
  testS3Connection,
  ResolvedS3Config,
} from "./helpers/s3.js";
import { setBackupS3Schema } from "../../../zod/db.js";

export async function getBackupS3(
  request: FastifyRequest<{ Params: RequestParams }>,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const metaConfig = app.metadata?.s3;
  const resolved = resolveAppS3Config(app);

  const status: DatabaseBackupS3Status = {
    enabled: Boolean(resolved?.enabled),
    source: metaConfig ? "app" : resolved?.isGlobal ? "server" : "none",
    endpoint: resolved?.endpoint,
    region: resolved?.region,
    bucket: resolved?.bucket,
    prefix: resolved?.prefix,
    forcePathStyle: resolved?.forcePathStyle,
    hasAccessKey: Boolean(resolved?.accessKeyId),
    hasSecretKey: Boolean(resolved?.secretAccessKey),
  };

  return reply.code(200).send({
    success: true,
    data: status,
  });
}

export async function setBackupS3(
  request: FastifyRequest<{
    Params: RequestParams;
    Body: DatabaseBackupS3Config;
  }>,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const input = setBackupS3Schema.parse(request.body);

  const encryptedConfig: DatabaseBackupS3Config = {
    enabled: input.enabled,
    bucket: input.bucket.trim(),
    accessKeyId: encryptValue(input.accessKeyId.trim()),
    secretAccessKey: encryptValue(input.secretAccessKey.trim()),
    endpoint: input.endpoint?.trim() || undefined,
    region: input.region?.trim() || "auto",
    prefix: (input.prefix || "backups").replace(/^\/+|\/+$/g, ""),
    forcePathStyle: Boolean(input.forcePathStyle),
  };

  const meta = app.metadata;

  await prisma.app.update({
    where: { id: app.id },
    data: {
      metadata: {
        ...meta,
        s3: encryptedConfig,
      } as any,
    },
  });

  logger.info(
    `Configured S3 backup replication for app "${app.name}": bucket="${input.bucket}", prefix="${encryptedConfig.prefix}"`,
  );

  return reply.code(200).send({
    success: true,
    message: `Off-site S3 backup replication configured successfully for bucket "${input.bucket}".`,
    data: {
      enabled: input.enabled,
      bucket: input.bucket,
      endpoint: input.endpoint,
      region: input.region,
      prefix: encryptedConfig.prefix,
      forcePathStyle: encryptedConfig.forcePathStyle,
    },
  });
}

export async function deleteBackupS3(
  request: FastifyRequest<{ Params: RequestParams }>,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  const meta = app.metadata;

  if (meta.s3) {
    delete meta.s3;

    await prisma.app.update({
      where: { id: app.id },
      data: {
        metadata: { ...meta },
      },
    });
  }

  logger.info(`Removed app-level S3 backup configuration for "${app.name}"`);

  return reply.code(200).send({
    success: true,
    message: `App-level S3 backup configuration removed for "${app.name}".`,
  });
}

export async function getGlobalS3(
  _request: FastifyRequest,
  reply: FastifyReply,
) {
  const resolved = resolveGlobalS3Config();
  const status: DatabaseBackupS3Status = {
    enabled: Boolean(resolved?.enabled),
    source: resolved ? "server" : "none",
    endpoint: resolved?.endpoint,
    region: resolved?.region,
    bucket: resolved?.bucket,
    prefix: resolved?.prefix,
    forcePathStyle: resolved?.forcePathStyle,
    hasAccessKey: Boolean(resolved?.accessKeyId),
    hasSecretKey: Boolean(resolved?.secretAccessKey),
  };

  return reply.code(200).send({
    success: true,
    data: status,
  });
}

export async function testGlobalS3(
  request: FastifyRequest<{ Body?: DatabaseBackupS3Config }>,
  reply: FastifyReply,
) {
  let testConfig: ResolvedS3Config | null = null;
  if (
    request.body &&
    request.body.bucket &&
    request.body.accessKeyId &&
    request.body.secretAccessKey
  ) {
    const input = request.body;
    testConfig = {
      bucket: input.bucket?.trim(),
      accessKeyId: input.accessKeyId?.trim(),
      secretAccessKey: input.secretAccessKey?.trim(),
      endpoint: input.endpoint?.trim() || undefined,
      region: input.region?.trim() || "auto",
      forcePathStyle: Boolean(input.forcePathStyle),
    };
  } else {
    testConfig = resolveGlobalS3Config();
  }

  if (!testConfig) {
    return reply.code(400).send({
      success: false,
      error:
        "No global S3 configuration found on server and no test credentials provided.",
    });
  }

  const result = await testS3Connection(testConfig);
  if (!result.success) {
    return reply.code(400).send({
      success: false,
      error: result.message,
    });
  }

  return reply.code(200).send({
    success: true,
    message: result.message,
  });
}

export async function testBackupS3(
  request: FastifyRequest<{
    Params: RequestParams;
    Body?: DatabaseBackupS3Config;
  }>,
  reply: FastifyReply,
) {
  const app = request.ctx.app;
  let testConfig: ResolvedS3Config | null = null;

  if (
    request.body &&
    request.body.bucket &&
    request.body.accessKeyId &&
    request.body.secretAccessKey
  ) {
    const input = request.body;
    testConfig = {
      bucket: input.bucket?.trim(),
      accessKeyId: input.accessKeyId?.trim(),
      secretAccessKey: input.secretAccessKey?.trim(),
      endpoint: input.endpoint?.trim() || undefined,
      region: input.region?.trim() || "auto",
      prefix: (input.prefix || "backups").replace(/^\/+|\/+$/g, ""),
      forcePathStyle: Boolean(input.forcePathStyle),
      enabled: true,
    };
  } else {
    testConfig = resolveAppS3Config(app);
  }

  if (!testConfig) {
    return reply.code(400).send({
      success: false,
      error:
        "No S3 backup configuration found to test. Provide configuration in request body or configure S3 backup first.",
    });
  }

  const result = await testS3Connection(testConfig);

  if (!result.success) {
    return reply.code(400).send({
      success: false,
      error: result.message,
    });
  }

  return reply.code(200).send({
    success: true,
    message: result.message,
  });
}
