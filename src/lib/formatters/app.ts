import { decryptValue } from "@explita/infra-protocol";
import {
  App,
  Domain,
  Deployment,
  AppDatabase,
  AppRedis,
  AppCron,
  AppEnv,
} from "../../generated/prisma/client.js";
import { AppMetadata } from "@explita/infra-protocol/deploy";
import {
  formatAppId,
  formatDeploymentId,
  formatCronId,
  formatDatabaseId,
} from "../id.js";
import { formatDeployment } from "./deployment.js";

export function formatApp(
  item: App & {
    domains: Domain[];
    currentDeployment?: Deployment | null;
    databases?: AppDatabase[];
    redis?: AppRedis | null;
    crons?: AppCron[];
    envs?: AppEnv[];
  },
  options: { showAll?: boolean } = { showAll: false },
) {
  const meta = item.metadata as AppMetadata;

  const databases = (item.databases || []).map((db) => ({
    ...db,
    id: formatDatabaseId(db.id),
    url: options.showAll ? decryptValue(db.url) : "",
  }));

  const databasesMap = new Map(databases.map((db) => [db.key, db]));

  const redis = item.redis
    ? {
        ...item.redis,
        url: options.showAll ? decryptValue(item.redis.url) : "",
      }
    : null;

  const envs = (item.envs || []).map((e) => ({
    ...e,
    value: options.showAll ? decryptValue(e.value) : "••••••••",
  }));

  const envsMap = new Map(envs.map((e) => [e.key, e]));

  const crons = (item.crons || []).map((c) => ({
    ...c,
    id: formatCronId(c.id),
    appId: formatAppId(c.appId),
  }));
  const cronsMap = new Map(crons.map((c) => [c.id, c]));

  meta.preDeploy = meta.preDeploy || [];

  return {
    ...item,
    id: formatAppId(item.id),
    currentDeploymentId: item.currentDeploymentId
      ? formatDeploymentId(item.currentDeploymentId)
      : null,
    currentDeployment: item.currentDeployment
      ? formatDeployment(item.currentDeployment)
      : null,
    domains: item.domains,
    databases,
    databasesMap,
    redis,
    crons,
    cronsMap,
    envs,
    envsMap,
    metadata: meta,
  };
}

export type FormattedApp = ReturnType<typeof formatApp>;
