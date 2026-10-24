import { mkdir, readFile } from "node:fs/promises";
import { logger } from "@explita/infra-protocol";
import { FormattedApp } from "./formatters/app.js";
import { custom } from "./constants.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function resolveCustomMaintenanceFile(appId: string): string | null {
  const candidates = [`${appId}.503.html`, "503.html", "maintenance.html"];

  for (const candidate of candidates) {
    if (existsSync(join(custom.filesDir, candidate))) {
      return candidate;
    }
  }

  return null;
}

export function resolveCustomMaintenancePage(appId: string): string | null {
  const file = resolveCustomMaintenanceFile(appId);
  return file ? join(custom.filesDir, file) : null;
}

export async function getMaintenanceHtml(app: FormattedApp): Promise<string> {
  await mkdir(custom.filesDir, { recursive: true });

  const customPath = resolveCustomMaintenancePage(app.id);
  if (customPath) {
    try {
      let content = await readFile(customPath, "utf8");

      content = content
        .replace(/\{\{\s*app_?name\s*\}\}/gi, app.name)
        .replace(/\{\{\s*app_?id\s*\}\}/gi, app.id);

      logger.info(
        `Serving custom maintenance page from ${customPath} for ${app.name}`,
      );
      return content;
    } catch (err) {
      logger.warn(`Failed to read custom maintenance page ${customPath}:`, err);
    }
  }

  return renderMaintenanceHtml(app.name);
}

export function renderMaintenanceHtml(appName: string): string {
  const safeTitle = (appName || "Application")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="30">
  <title>${safeTitle} — Maintenance</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: rgba(18, 24, 38, 0.85);
      --border: rgba(255, 255, 255, 0.08);
      --accent: #f59e0b;
      --accent-glow: rgba(245, 158, 11, 0.15);
      --text-main: #f3f4f6;
      --text-muted: #9ca3af;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text-main);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
      position: relative;
      overflow-x: hidden;
    }
    body::before {
      content: "";
      position: absolute;
      width: 480px;
      height: 480px;
      background: radial-gradient(circle, var(--accent-glow) 0%, transparent 70%);
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 0;
      pointer-events: none;
    }
    .card {
      position: relative;
      z-index: 1;
      background: var(--card-bg);
      border: 1px solid var(--border);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-radius: 20px;
      padding: 2.75rem 2.25rem;
      max-width: 520px;
      width: 100%;
      text-align: center;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.03);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background: rgba(245, 158, 11, 0.12);
      border: 1px solid rgba(245, 158, 11, 0.3);
      color: #fbbf24;
      font-size: 0.8125rem;
      font-weight: 600;
      padding: 0.35rem 0.85rem;
      border-radius: 9999px;
      margin-bottom: 1.5rem;
      letter-spacing: 0.02em;
    }
    .pulse-dot {
      width: 8px;
      height: 8px;
      background-color: #f59e0b;
      border-radius: 50%;
      box-shadow: 0 0 8px #f59e0b;
      animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.8); }
    }
    h1 {
      font-size: 1.75rem;
      font-weight: 700;
      letter-spacing: -0.025em;
      margin-bottom: 0.75rem;
      color: #ffffff;
    }
    .message {
      font-size: 1rem;
      line-height: 1.6;
      color: var(--text-muted);
      margin-bottom: 2rem;
    }
    .status-panel {
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 12px;
      padding: 1rem;
      font-size: 0.875rem;
      color: var(--text-muted);
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.5rem;
    }
    .status-panel span:last-child {
      font-weight: 600;
      color: #34d399;
    }
    .retry-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      width: 100%;
      background: #ffffff;
      color: #090d16;
      font-weight: 600;
      font-size: 0.9375rem;
      padding: 0.75rem 1.25rem;
      border-radius: 10px;
      border: none;
      cursor: pointer;
      transition: all 0.15s ease;
      text-decoration: none;
    }
    .retry-btn:hover {
      background: #f3f4f6;
      transform: translateY(-1px);
    }
    .footer {
      position: relative;
      z-index: 1;
      margin-top: 2rem;
      font-size: 0.8125rem;
      color: #6b7280;
    }
    .footer a {
      color: inherit;
      text-decoration: underline;
      text-underline-offset: 3px;
      transition: color 0.15s ease;
    }
    .footer a:hover {
      color: var(--text-main);
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">
      <div class="pulse-dot"></div>
      Maintenance Mode
    </div>
    <h1>${safeTitle}</h1>
    <p class="message">We are currently performing scheduled maintenance and updates. Normal service will be restored shortly.</p>
    <div class="status-panel">
      <span>Auto-refreshing</span>
      <span id="countdown">30s</span>
    </div>
    <button class="retry-btn" onclick="location.reload()">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
        <path d="M3 3v5h5"/>
        <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
        <path d="M16 21h5v-5"/>
      </svg>
      Check Again
    </button>
  </div>
  <div class="footer">
    Powered by <a href="https://infra.explita.ng" target="_blank" rel="noopener noreferrer">Explita</a>
  </div>
  <script>
    let remaining = 30;
    const cd = document.getElementById('countdown');
    setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        location.reload();
      } else if (cd) {
        cd.textContent = remaining + 's';
      }
    }, 1000);
  </script>
</body>
</html>`;
}
