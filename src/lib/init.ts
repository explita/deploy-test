import { mkdir } from "node:fs/promises";
import { ensureCaddy } from "./caddy.js";
import { server } from "./constants.js";
import { ensureDatabase } from "./postgres.js";
import { ensureRedis } from "./redis.js";
import { ensureDockerNetwork } from "./docker-network.js";
import { ensureTunnelImage } from "./tunnel.js";
import { cronScheduler } from "./cron-scheduler.js";
import { dbBackupScheduler } from "./database-backup-scheduler.js";
import { dumpScheduler } from "./dump-scheduler.js";
import { containerHealthMonitor } from "./container-health-monitor.js";
import { assertEncryptionKey, logger } from "@explita/protocol";

export async function init() {
  process.env.LOG_PREFIX = "[deploy-server]";
  let success = false;
  try {
    assertEncryptionKey();
    await mkdir(server.deployBaseDir, { recursive: true });
    await ensureDockerNetwork();
    // await Promise.all([
    //   ensureDatabase(),
    //   ensureRedis(),
    //   ensureCaddy(),
    //   ensureTunnelImage(),
    // ]);
    await ensureDatabase();
    await ensureRedis();
    await ensureCaddy();
    await ensureTunnelImage();
    await cronScheduler.start();
    await dbBackupScheduler.start();
    await dumpScheduler.start();
    containerHealthMonitor.start();
    success = true;
  } catch (err) {
    logger.error(
      `\nFatal initialization error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  if (!success) process.exit(1);
}
