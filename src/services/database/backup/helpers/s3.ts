import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  statSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { FormattedApp } from "../../../../lib/formatters/app.js";
import { globalS3 } from "../../../../lib/constants.js";
import { decryptValue, logger } from "@explita/protocol";
import { DatabaseBackupS3Config } from "@explita/protocol/deploy";
import { extractKeyFromBackupFilename } from "../../lib/utils.js";

export interface ResolvedS3Config extends DatabaseBackupS3Config {
  isGlobal?: boolean;
}

/**
 * Resolves effective S3 backup configuration for an application.
 * Hierarchy: App metadata override -> Global server environment fallback.
 */
export function resolveAppS3Config(app: FormattedApp): ResolvedS3Config | null {
  const metaConfig = app.metadata?.s3;

  // App explicitly disabled off-site S3 backup
  if (metaConfig && metaConfig.enabled === false) {
    return null;
  }

  // App has dedicated S3 configuration
  if (
    metaConfig &&
    metaConfig.bucket &&
    metaConfig.accessKeyId &&
    metaConfig.secretAccessKey
  ) {
    return {
      enabled: true,
      endpoint: metaConfig.endpoint || undefined,
      region: metaConfig.region || "auto",
      bucket: metaConfig.bucket,
      accessKeyId: decryptValue(metaConfig.accessKeyId),
      secretAccessKey: decryptValue(metaConfig.secretAccessKey),
      prefix: (metaConfig.prefix || "backups").replace(/^\/+|\/+$/g, ""),
      forcePathStyle: Boolean(metaConfig.forcePathStyle),
      isGlobal: false,
    };
  }

  // Fallback to global VPS S3 configuration
  return resolveGlobalS3Config();
}

/**
 * Resolves global VPS S3 configuration from environment/constants.
 */
export function resolveGlobalS3Config(): ResolvedS3Config | null {
  if (
    globalS3.enabled &&
    globalS3.bucket &&
    globalS3.accessKeyId &&
    globalS3.secretAccessKey
  ) {
    return {
      enabled: true,
      endpoint: globalS3.endpoint || undefined,
      region: globalS3.region || "auto",
      bucket: globalS3.bucket,
      accessKeyId: globalS3.accessKeyId,
      secretAccessKey: globalS3.secretAccessKey,
      prefix: (globalS3.prefix || "backups").replace(/^\/+|\/+$/g, ""),
      forcePathStyle: globalS3.forcePathStyle,
      isGlobal: true,
    };
  }
  return null;
}

/**
 * Instantiates an AWS S3 client with compatible provider endpoints.
 */
export function getS3Client(config: ResolvedS3Config): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region || "auto",
    credentials: {
      accessKeyId: config.accessKeyId!,
      secretAccessKey: config.secretAccessKey!,
    },
    forcePathStyle: Boolean(config.forcePathStyle),
  });
}

/**
 * Constructs object storage key: ${prefix}/${appId}/${dbKey}/${filename}
 */
export function buildS3ObjectKey(
  prefix: string,
  appId: string,
  dbKey: string,
  filename: string,
): string {
  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, "");
  return `${cleanPrefix}/${appId}/${dbKey}/${filename}`;
}

/**
 * Uploads a local compressed database backup archive (.sql.gz) to S3.
 */
export async function replicateBackupToS3(
  app: FormattedApp,
  filePath: string,
  filename: string,
  dbKey: string,
): Promise<{ s3Key: string; s3Url: string; bucket: string } | null> {
  const s3Config = resolveAppS3Config(app);
  if (!s3Config) return null;

  if (!existsSync(filePath)) {
    throw new Error(
      `Cannot replicate to S3: local file "${filePath}" does not exist.`,
    );
  }

  const s3Key = buildS3ObjectKey(
    s3Config.prefix || "backups",
    app.id,
    dbKey,
    filename,
  );
  const client = getS3Client(s3Config);
  const stats = statSync(filePath);

  logger.info(
    `Replicating backup "${filename}" (${stats.size} bytes) to s3://${s3Config.bucket}/${s3Key}...`,
  );

  const fileStream = createReadStream(filePath);

  await client.send(
    new PutObjectCommand({
      Bucket: s3Config.bucket,
      Key: s3Key,
      Body: fileStream,
      ContentLength: stats.size,
      ContentType: "application/gzip",
    }),
  );

  const s3Url = `s3://${s3Config.bucket}/${s3Key}`;
  logger.info(`Successfully replicated backup to ${s3Url}`);

  return {
    s3Key,
    s3Url,
    bucket: s3Config.bucket!,
  };
}

/**
 * Downloads a database backup from S3 onto local disk if not found locally.
 */
export async function downloadBackupFromS3(
  app: FormattedApp,
  filename: string,
  targetPath: string,
  dbKey?: string,
): Promise<boolean> {
  const s3Config = resolveAppS3Config(app);
  if (!s3Config) return false;

  const targetDbKey =
    dbKey?.trim().toLowerCase() || extractKeyFromBackupFilename(filename);
  const s3Key = buildS3ObjectKey(
    s3Config.prefix || "backups",
    app.id,
    targetDbKey,
    filename,
  );
  const client = getS3Client(s3Config);

  try {
    logger.info(
      `Downloading off-site backup from s3://${s3Config.bucket}/${s3Key} to ${targetPath}...`,
    );

    const response = await client.send(
      new GetObjectCommand({
        Bucket: s3Config.bucket,
        Key: s3Key,
      }),
    );

    if (!response.Body) {
      throw new Error("Empty body received from S3.");
    }

    const outStream = createWriteStream(targetPath);
    await pipeline(response.Body as Readable, outStream);

    logger.info(`Successfully downloaded backup from S3: "${filename}"`);
    return true;
  } catch (err: any) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
      return false;
    }
    logger.warn(`Failed to download backup "${filename}" from S3:`, err);
    return false;
  }
}

/**
 * Lists backup archives stored in S3 for an application.
 */
export async function listS3DatabaseBackups(
  app: FormattedApp,
  targetKey?: string,
): Promise<
  Array<{
    filename: string;
    sizeBytes: number;
    createdAt: string;
    key: string;
    s3Url: string;
    s3Key: string;
  }>
> {
  const s3Config = resolveAppS3Config(app);
  if (!s3Config) return [];

  const client = getS3Client(s3Config);
  const cleanPrefix = (s3Config.prefix || "backups").replace(/^\/+|\/+$/g, "");
  const basePrefix = targetKey
    ? `${cleanPrefix}/${app.id}/${targetKey.trim().toLowerCase()}/`
    : `${cleanPrefix}/${app.id}/`;

  try {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: s3Config.bucket,
        Prefix: basePrefix,
      }),
    );

    const results: Array<{
      filename: string;
      sizeBytes: number;
      createdAt: string;
      key: string;
      s3Url: string;
      s3Key: string;
    }> = [];

    for (const item of response.Contents || []) {
      if (!item.Key || !item.Key.endsWith(".sql.gz")) continue;

      const parts = item.Key.split("/");
      const filename = parts[parts.length - 1];
      const key =
        parts[parts.length - 2] || extractKeyFromBackupFilename(filename);

      if (targetKey && targetKey.trim().toLowerCase() !== key.toLowerCase()) {
        continue;
      }

      results.push({
        filename,
        sizeBytes: item.Size || 0,
        createdAt: (item.LastModified || new Date()).toISOString(),
        key,
        s3Url: `s3://${s3Config.bucket}/${item.Key}`,
        s3Key: item.Key,
      });
    }

    return results;
  } catch (err) {
    logger.warn(`Failed to list S3 objects for ${app.name}:`, err);
    return [];
  }
}

/**
 * Prunes rolling S3 backup objects beyond the retention keep limit.
 */
export async function pruneS3DatabaseBackups(
  app: FormattedApp,
  keepCount: number,
  targetKey: string,
): Promise<number> {
  const s3Config = resolveAppS3Config(app);
  if (!s3Config) return 0;

  const effectiveKeep = Math.max(1, keepCount || 7);
  const objects = await listS3DatabaseBackups(app, targetKey);

  if (objects.length <= effectiveKeep) {
    return 0;
  }

  // Sort descending by date (newest first)
  objects.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  const excess = objects.slice(effectiveKeep);
  const client = getS3Client(s3Config);
  let deletedCount = 0;

  for (const item of excess) {
    try {
      await client.send(
        new DeleteObjectCommand({
          Bucket: s3Config.bucket,
          Key: item.s3Key,
        }),
      );
      deletedCount++;
      logger.info(
        `Pruned old remote backup "${item.filename}" from s3://${s3Config.bucket}/${item.s3Key} (keep: ${effectiveKeep})`,
      );
    } catch (err) {
      logger.warn(`Failed to prune remote S3 backup "${item.s3Key}":`, err);
    }
  }

  return deletedCount;
}

/**
 * Deletes a specific backup archive from S3.
 */
export async function deleteS3Backup(
  app: FormattedApp,
  filename: string,
  targetKey?: string,
): Promise<boolean> {
  const s3Config = resolveAppS3Config(app);
  if (!s3Config) return false;

  const dbKey =
    targetKey?.trim().toLowerCase() || extractKeyFromBackupFilename(filename);
  const s3Key = buildS3ObjectKey(
    s3Config.prefix || "backups",
    app.id,
    dbKey,
    filename,
  );
  const client = getS3Client(s3Config);

  try {
    await client.send(
      new DeleteObjectCommand({
        Bucket: s3Config.bucket,
        Key: s3Key,
      }),
    );
    logger.info(`Deleted remote S3 backup "${s3Key}"`);
    return true;
  } catch (err) {
    logger.warn(`Failed to delete remote S3 backup "${s3Key}":`, err);
    return false;
  }
}

/**
 * Performs a lightweight read/write/delete round-trip test against target S3 configuration.
 */
export async function testS3Connection(
  config: ResolvedS3Config,
): Promise<{ success: boolean; message: string }> {
  const client = getS3Client(config);
  const testKey = `${(config.prefix || "backups").replace(/^\/+|\/+$/g, "")}/.explita-s3-test-${Date.now()}.txt`;

  try {
    // 1. Test Write
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: testKey,
        Body: "Explita S3 Backup Connectivity Test",
        ContentType: "text/plain",
      }),
    );

    // 2. Test Read
    await client.send(
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: testKey,
      }),
    );

    // 3. Test Delete
    await client.send(
      new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: testKey,
      }),
    );

    return {
      success: true,
      message: `Successfully verified S3 connection to bucket "${config.bucket}" with read/write/delete permissions.`,
    };
  } catch (err: any) {
    return {
      success: false,
      message: `S3 connection test failed: ${err.message || String(err)}`,
    };
  }
}

/**
 * Uploads a full application or cluster backup archive (.tar.gz) to S3.
 */
export async function uploadDumpToS3(
  app: FormattedApp | null,
  filePath: string,
  filename: string,
): Promise<{ s3Key: string; s3Url: string; bucket: string }> {
  const s3Config = app ? resolveAppS3Config(app) : resolveGlobalS3Config();
  if (!s3Config) {
    throw new Error(
      `No S3 configuration found. Configure S3 for this app using "eda s3 set -a <appId>" or set server GLOBAL_S3_* environment variables.`,
    );
  }

  if (!existsSync(filePath)) {
    throw new Error(
      `Cannot upload dump to S3: local file "${filePath}" does not exist.`,
    );
  }

  const cleanPrefix = (s3Config.prefix || "backups").replace(/^\/+|\/+$/g, "");
  const s3Key = app
    ? `${cleanPrefix}/dumps/${app.id}/${filename}`
    : `${cleanPrefix}/dumps/cluster/${filename}`;

  const client = getS3Client(s3Config);
  const stats = statSync(filePath);

  logger.info(
    `Uploading dump "${filename}" (${stats.size} bytes) to s3://${s3Config.bucket}/${s3Key}...`,
  );

  const fileStream = createReadStream(filePath);

  await client.send(
    new PutObjectCommand({
      Bucket: s3Config.bucket,
      Key: s3Key,
      Body: fileStream,
      ContentLength: stats.size,
      ContentType: "application/gzip",
    }),
  );

  const s3Url = `s3://${s3Config.bucket}/${s3Key}`;
  logger.info(`Successfully uploaded dump to ${s3Url}`);

  return {
    s3Key,
    s3Url,
    bucket: s3Config.bucket!,
  };
}

/**
 * Prunes older dumps stored in S3 beyond retention limit.
 */
export async function pruneS3Dumps(
  app: FormattedApp | null,
  keep: number,
): Promise<number> {
  if (keep <= 0) return 0;
  const s3Config = app ? resolveAppS3Config(app) : resolveGlobalS3Config();
  if (!s3Config) return 0;

  const cleanPrefix = (s3Config.prefix || "backups").replace(/^\/+|\/+$/g, "");
  const prefix = app
    ? `${cleanPrefix}/dumps/${app.id}/`
    : `${cleanPrefix}/dumps/cluster/`;

  const client = getS3Client(s3Config);
  try {
    const list = await client.send(
      new ListObjectsV2Command({
        Bucket: s3Config.bucket,
        Prefix: prefix,
      }),
    );

    if (!list.Contents || list.Contents.length <= keep) return 0;

    // Sort newest first
    const sorted = list.Contents.filter(
      (obj) => obj.Key && obj.Key !== prefix,
    ).sort(
      (a, b) =>
        (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0),
    );

    const toDelete = sorted.slice(keep);
    for (const item of toDelete) {
      if (item.Key) {
        await client.send(
          new DeleteObjectCommand({
            Bucket: s3Config.bucket,
            Key: item.Key,
          }),
        );
      }
    }
    return toDelete.length;
  } catch (err) {
    logger.warn(`Failed to prune remote S3 dumps:`, err);
    return 0;
  }
}
