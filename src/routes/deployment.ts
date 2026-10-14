import { FastifyInstance } from "fastify";
import { getDeployment } from "../services/deployment/get.js";
import { getDeploymentLogs } from "../services/deployment/logs.js";
import { deploymentStatus } from "../services/deployment/deployment-status.js";
import { rollbackDeployment } from "../services/app/rollback.js";
import { promoteDeployment } from "../services/deployment/promote.js";
import { cancelDeployment } from "../services/deployment/cancel.js";

export function deploymentRoutes(app: FastifyInstance) {
  app.get("/:id", getDeployment);
  app.get("/:id/logs", getDeploymentLogs);
  app.get("/:id/stream", { websocket: true }, deploymentStatus);
  app.post("/:id/rollback", rollbackDeployment);
  app.post("/:id/promote", promoteDeployment);
  app.post("/:id/cancel", cancelDeployment);
}
