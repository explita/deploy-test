import { FormattedApp } from "./formatters/app.js";

const PREFIXES = ["app_", "dep_", "db_", "cron_", "dom_"] as const;

/**
 * Strips known entity prefix (app_, dep_, db_, cron_, dom_) and extracts the raw 10-char nanoid.
 * If the input does not have a recognized prefix, it returns the input unchanged (e.g. app names or legacy raw IDs).
 */
export function stripIdPrefix(val: string): string;
export function stripIdPrefix(val: undefined): undefined;
export function stripIdPrefix(val: string | undefined): string | undefined;
export function stripIdPrefix(val: string | undefined): string | undefined {
  if (typeof val !== "string") {
    return val;
  }

  const trimmed = val.trim();
  for (const prefix of PREFIXES) {
    if (trimmed.startsWith(prefix) && trimmed.length > 10) {
      return trimmed.slice(-10);
    }
  }

  return trimmed;
}

export function formatAppId(rawId: string): string {
  if (!rawId) return rawId;
  const clean = rawId.slice(-10);
  return `app_${clean}`;
}

export function formatDeploymentId(rawId: string): string {
  if (!rawId) return rawId;
  const clean = rawId.slice(-10);
  return `dep_${clean}`;
}

export function formatCronId(rawId: string): string {
  if (!rawId) return rawId;
  const clean = rawId.slice(-10);
  return `cron_${clean}`;
}

export function formatDatabaseId(rawId: string): string {
  if (!rawId) return rawId;
  const clean = rawId.slice(-10);
  return `db_${clean}`;
}

export function stripAppPrefixes(app: FormattedApp) {
  return {
    ...app,
    id: stripIdPrefix(app.id),
    currentDeploymentId: app.currentDeploymentId
      ? stripIdPrefix(app.currentDeploymentId)
      : null,
    currentDeployment: app.currentDeployment
      ? {
          ...app.currentDeployment,
          id: stripIdPrefix(app.currentDeployment.id),
        }
      : null,
  };
}
