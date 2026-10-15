import { FastifyInstance } from "fastify";
import { listApps } from "../services/app/list.js";
import { createApp } from "../services/app/create.js";
import { updateApp } from "../services/app/update.js";
import { getAppById } from "../services/app/get-by-id.js";
import { deployApp } from "../services/app/deploy.js";
import { getAppDeployments } from "../services/app/get-deployments.js";
import { deleteApp } from "../services/app/delete.js";
import { execApp } from "../services/app/exec.js";
import { startApp, stopApp, restartApp } from "../services/app/lifecycle.js";
import { listAppDomains } from "../services/domain/list.js";
import { addAppDomain } from "../services/domain/add.js";
import { removeAppDomain } from "../services/domain/remove.js";
import { checkAppDomains } from "../services/domain/check.js";
import { createDatabase } from "../services/database/create.js";
import { getDatabase } from "../services/database/get.js";
import { deleteDatabase } from "../services/database/delete.js";
import { dumpDatabase } from "../services/database/dump.js";
import { restoreDatabase } from "../services/database/restore.js";
import { createBackup } from "../services/database/backup/create.js";
import { listBackups } from "../services/database/backup/list.js";
import { restoreBackup } from "../services/database/backup/restore.js";
import { deleteBackup } from "../services/database/backup/delete.js";
import {
  getBackupSchedule,
  setBackupSchedule,
} from "../services/database/backup/schedule.js";
import {
  getBackupS3,
  setBackupS3,
  deleteBackupS3,
  testBackupS3,
  getGlobalS3,
  testGlobalS3,
} from "../services/database/backup/s3.js";
import {
  getAppDumpSchedule,
  setAppDumpSchedule,
} from "../services/dump/schedule.js";
import { getEnv } from "../services/env/get.js";
import { setEnv } from "../services/env/set.js";
import { deleteEnv } from "../services/env/delete.js";
import { applyEnv } from "../services/env/apply.js";
import { createRedis } from "../services/redis/create.js";
import { getRedis } from "../services/redis/get.js";
import { deleteRedis } from "../services/redis/delete.js";
import { validateRequestId } from "../hooks/validate-request-id.js";
import { streamRuntimeLogsWs } from "../services/log/ws.js";
import { getRuntimeLogsHttp } from "../services/log/http.js";
import { streamAppShellWs } from "../services/app/sh.js";
import { getAppStatsHttp, streamAppStatsWs } from "../services/app/stats.js";
import { getCronHistory, getCrons } from "../services/cron/get.js";
import { runCron } from "../services/cron/run.js";
import { pauseCron } from "../services/cron/pause.js";
import { resumeCron } from "../services/cron/resume.js";
import { dumpApp, dumpAllApps } from "../services/dump/dump.js";
import {
  getMaintenance,
  setMaintenance,
} from "../services/app/maintenance.js";
import {
  getAppNotify,
  setAppNotify,
  removeAppNotify,
  testAppNotify,
} from "../services/app/notify.js";

export function appRoutes(app: FastifyInstance) {
  app.get("/", listApps);
  app.post("/", createApp);
  app.get("/dump", dumpAllApps);
  app.get("/s3", getGlobalS3);
  app.post("/s3/test", testGlobalS3);
}

export function appRoutesWithId(app: FastifyInstance) {
  app.addHook("onRequest", validateRequestId);

  app.get("/:id", getAppById);
  app.patch("/:id", updateApp);
  app.delete("/:id", deleteApp);
  app.post("/:id/deploy", deployApp);
  app.get("/:id/deployments", getAppDeployments);
  app.get("/:id/dump", dumpApp);
  app.get("/:id/dump/schedule", getAppDumpSchedule);
  app.post("/:id/dump/schedule", setAppDumpSchedule);

  // Lifecycle routes
  app.post("/:id/start", startApp);
  app.post("/:id/stop", stopApp);
  app.post("/:id/restart", restartApp);
  app.post("/:id/exec", execApp);

  // Domain routes
  app.get("/:id/domains", listAppDomains);
  app.post("/:id/domains", addAppDomain);
  app.delete("/:id/domains/:domain", removeAppDomain);
  app.get("/:id/domain-check", checkAppDomains);

  // S3 storage routes
  app.get("/:id/s3", getBackupS3);
  app.post("/:id/s3", setBackupS3);
  app.delete("/:id/s3", deleteBackupS3);
  app.post("/:id/s3/test", testBackupS3);

  // Database routes
  app.post("/:id/db", createDatabase);
  app.get("/:id/db", getDatabase);
  app.delete("/:id/db", deleteDatabase);
  app.get("/:id/db/dump", dumpDatabase);
  app.post("/:id/db/restore", restoreDatabase);
  app.get("/:id/db/backup/schedule", getBackupSchedule);
  app.post("/:id/db/backup/schedule", setBackupSchedule);
  app.get("/:id/db/backups", listBackups);
  app.post("/:id/db/backups", createBackup);
  app.post("/:id/db/backups/:backupId/restore", restoreBackup);
  app.delete("/:id/db/backups/:backupId", deleteBackup);
  app.get("/:id/db/backup/s3", getBackupS3);
  app.post("/:id/db/backup/s3", setBackupS3);
  app.delete("/:id/db/backup/s3", deleteBackupS3);
  app.post("/:id/db/backup/s3/test", testBackupS3);

  // Redis routes
  app.post("/:id/redis", createRedis);
  app.get("/:id/redis", getRedis);
  app.delete("/:id/redis", deleteRedis);

  // Environment variable routes
  app.get("/:id/env", getEnv);
  app.post("/:id/env", setEnv);
  app.delete("/:id/env", deleteEnv);
  app.post("/:id/env/apply", applyEnv);

  // Runtime logs route (supports both HTTP snapshot and WebSocket live streaming)
  app.route({
    method: "GET",
    url: "/:id/runtime-logs",
    handler: getRuntimeLogsHttp,
    wsHandler: streamRuntimeLogsWs,
  });

  // Interactive remote shell route over WebSocket (eda sh / eda exec -it)
  app.route({
    method: "GET",
    url: "/:id/sh",
    handler: async (_request, reply) => {
      reply.code(426).send({
        error:
          "Upgrade Required. Connect via WebSocket to attach interactive remote shell.",
      });
    },
    wsHandler: streamAppShellWs,
  });

  app.route({
    method: "GET",
    url: "/:id/shell",
    handler: async (_request, reply) => {
      reply.code(426).send({
        error:
          "Upgrade Required. Connect via WebSocket to attach interactive remote shell.",
      });
    },
    wsHandler: streamAppShellWs,
  });

  // Resource stats route (supports both HTTP snapshot and WebSocket live streaming)
  app.route({
    method: "GET",
    url: "/:id/stats",
    handler: getAppStatsHttp,
    wsHandler: streamAppStatsWs,
  });

  // Scheduled background jobs (cron) routes
  app.get("/:id/crons", getCrons);
  app.post("/:id/crons/run", runCron);
  app.post("/:id/crons/pause", pauseCron);
  app.post("/:id/crons/resume", resumeCron);
  app.get("/:id/crons/history", getCronHistory);

  // Notification & incident webhook routes
  app.get("/:id/notify", getAppNotify);
  app.post("/:id/notify", setAppNotify);
  app.delete("/:id/notify", removeAppNotify);
  app.post("/:id/notify/test", testAppNotify);

  // Maintenance mode routes
  app.get("/:id/maintenance", getMaintenance);
  app.post("/:id/maintenance", setMaintenance);
}
