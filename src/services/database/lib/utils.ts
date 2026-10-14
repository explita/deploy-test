import { mkdirSync, existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { getAppDbBackupDir } from "../../../lib/constants.js";

export function ensureBackupDir(appId: string): string {
  const dir = getAppDbBackupDir(appId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function generateBackupFilename(key: string = "default"): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeKey = (key || "default").toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return `backup-${safeKey}-${timestamp}.sql.gz`;
}

export function extractKeyFromBackupFilename(filename: string): string {
  const clean = basename(filename.trim());
  const match = clean.match(/^backup-([a-zA-Z0-9_]+)-\d{4}-/);
  if (match) {
    return match[1];
  }
  return "default";
}

export function resolveSafeBackupPath(appId: string, backupId: string): string {
  const cleanName = basename(backupId.trim());
  if (!cleanName || cleanName.includes("..") || !cleanName.endsWith(".sql.gz")) {
    throw new Error(`Invalid backup filename: "${backupId}". Expected a .sql.gz file.`);
  }

  const baseDir = getAppDbBackupDir(appId);
  const fullPath = resolve(baseDir, cleanName);

  if (!fullPath.startsWith(baseDir)) {
    throw new Error("Path traversal detected in backup filename.");
  }

  return fullPath;
}
