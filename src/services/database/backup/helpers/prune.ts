import { readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getAppDbBackupDir } from "../../../../lib/constants.js";
import { logger } from "@explita/protocol";
import { extractKeyFromBackupFilename } from "../../lib/utils.js";

export async function pruneOldDatabaseBackups(
  appId: string,
  keepCount: number,
  customDir?: string,
  targetKey?: string,
): Promise<number> {
  const dir = customDir || getAppDbBackupDir(appId);
  if (!existsSync(dir)) return 0;

  const effectiveKeep = Math.max(1, keepCount || 7);

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const backupFiles = entries
      .filter((e) => {
        if (!e.isFile() || !e.name.endsWith(".sql.gz")) return false;
        if (targetKey) {
          const fileKey = extractKeyFromBackupFilename(e.name);
          return fileKey.toLowerCase() === targetKey.toLowerCase();
        }
        return true;
      })
      .map((e) => {
        const fullPath = resolve(dir, e.name);
        const stats = statSync(fullPath);
        return {
          name: e.name,
          path: fullPath,
          mtime: stats.mtimeMs,
        };
      })
      .sort((a, b) => b.mtime - a.mtime); // newest first

    if (backupFiles.length <= effectiveKeep) {
      return 0;
    }

    const excessFiles = backupFiles.slice(effectiveKeep);
    let deletedCount = 0;

    for (const file of excessFiles) {
      try {
        unlinkSync(file.path);
        deletedCount++;
        logger.info(
          `[db-backup] Pruned old backup "${file.name}" for app "${appId}" (retention limit: ${effectiveKeep})`,
        );
      } catch (err) {
        logger.warn(
          `[db-backup] Failed to delete pruned backup "${file.path}":`,
          err,
        );
      }
    }

    return deletedCount;
  } catch (err) {
    logger.warn(`[db-backup] Failed to prune backups for app "${appId}":`, err);
    return 0;
  }
}
