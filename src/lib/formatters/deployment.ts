import { Deployment, Log } from "../../generated/prisma/client.js";
import { formatAppId, formatDeploymentId } from "../id.js";

export function formatDeployment(item: Deployment & { log?: Log | null }) {
  if (!item) return item;

  const { log, ...d } = item;

  return {
    ...d,
    id: formatDeploymentId(d.id),
    appId: formatAppId(d.appId),
    startedAt:
      d.startedAt instanceof Date ? d.startedAt.toISOString() : d.startedAt,
    finishedAt:
      d.finishedAt instanceof Date
        ? d.finishedAt.toISOString()
        : (d.finishedAt ?? undefined),
    logs: log?.messages ?? [],
  };
}
