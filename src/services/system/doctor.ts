import { FastifyReply, FastifyRequest } from "fastify";
import os from "node:os";
import { statfs } from "node:fs/promises";
import { run } from "../../lib/runner.js";
import { caddy } from "../../lib/constants.js";
import { SystemDiagnostics } from "@explita/protocol/deploy";
import { DEPLOY_VERSION } from "../../version.js";

export async function getSystemDoctor(
  _request: FastifyRequest,
  reply: FastifyReply,
) {
  // 1. Docker check
  let dockerAvailable = false;
  let dockerVersion: string | undefined;
  let containersRunning = 0;
  let dockerError: string | undefined;

  try {
    const versionRes = await run("docker", [
      "version",
      "--format",
      "{{.Server.Version}}",
    ]);
    if (versionRes.code === 0 && versionRes.stdout.trim()) {
      dockerAvailable = true;
      dockerVersion = versionRes.stdout.trim();

      const psRes = await run("docker", ["ps", "-q"]);
      if (psRes.code === 0) {
        containersRunning = psRes.stdout.trim()
          ? psRes.stdout.trim().split("\n").length
          : 0;
      }
    } else {
      dockerError = versionRes.stderr || "Docker daemon not responding";
    }
  } catch (err: any) {
    dockerError = err?.message || String(err);
  }

  // 2. Disk check
  let diskStats = {
    totalBytes: 0,
    freeBytes: 0,
    usedBytes: 0,
    usedPercent: 0,
  };

  try {
    const stat = await statfs(process.cwd());
    const bsize = Number(stat.bsize || 4096);
    const total = Number(stat.blocks) * bsize;
    const free = Number(stat.bavail) * bsize;
    const used = Math.max(0, total - free);
    const usedPercent =
      total > 0 ? Number(((used / total) * 100).toFixed(1)) : 0;

    diskStats = {
      totalBytes: total,
      freeBytes: free,
      usedBytes: used,
      usedPercent,
    };
  } catch {
    // fallback if statfs fails
  }

  // 3. Memory check
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);
  const memUsedPercent =
    totalMem > 0 ? Number(((usedMem / totalMem) * 100).toFixed(1)) : 0;

  // 4. Caddy check
  let caddyRunning = false;
  let caddyStatus = "not found";

  try {
    const caddyInspect = await run("docker", [
      "inspect",
      "--format",
      "{{.State.Running}}",
      caddy.containerName,
    ]);

    if (caddyInspect.code === 0 && caddyInspect.stdout.trim() === "true") {
      caddyRunning = true;
      caddyStatus = "running";
    } else if (caddyInspect.code === 0) {
      caddyStatus = "stopped";
    }
  } catch {
    caddyStatus = "unreachable";
  }

  const diagnostics: SystemDiagnostics = {
    server: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      uptimeSeconds: Math.floor(os.uptime()),
      nodeVersion: process.version,
      version: DEPLOY_VERSION,
    },
    docker: {
      available: dockerAvailable,
      version: dockerVersion,
      containersRunning,
      error: dockerError,
    },
    disk: diskStats,
    memory: {
      totalBytes: totalMem,
      freeBytes: freeMem,
      usedBytes: usedMem,
      usedPercent: memUsedPercent,
    },
    caddy: {
      container: caddy.containerName,
      running: caddyRunning,
      status: caddyStatus,
    },
  };

  return reply.code(200).send({
    success: true,
    data: diagnostics,
  });
}
