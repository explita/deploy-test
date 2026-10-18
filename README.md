# Explita Deploy

> Self-hosted application deployment for Explita Infra.

Explita Deploy is a lightweight deployment control plane and CLI built with Node.js, TypeScript, Fastify, Docker, and Prisma.

---

## Architecture & Roles

```text
┌───────────────────────────────┐               ┌───────────────────────────────────────┐
│     DEVELOPER WORKSTATION     │               │               VPS HOST                │
│                               │               │                                       │
│  CLI (explita)                │               │  Fastify Server (@explita/deploy-server)
│  - Tarballs project source    │ ──HTTPS/WS──> │  - Authenticates via Bearer token     │
│  - Streams deployment logs    │               │  - Builds Docker images               │
│  - Manages apps & rollbacks   │               │  - Spawns & monitors containers       │
└───────────────────────────────┘               └───────────┬───────────────┬───────────┘
                                                            │               │
                                                            ▼               ▼
                                                       PostgreSQL         Docker
                                                     (Auto-container   (explita-net)
                                                     or external URL)       │
                                                                            ▼
                                                                     App Containers
```

> **Important**:
>
> - **The Server (`apps/server`)** runs natively on your **VPS host** where Docker is running.
> - **The CLI (`apps/cli`, `explita`)** runs only on **local developer machines** (laptops/workstations). You do **not** run the CLI on the VPS.

---

## 1. VPS Host Setup (Server)

Follow these steps on your Linux VPS (Ubuntu, Debian, Fedora, etc.).

### Option A: Automated Setup (Recommended)

Run the automated setup script. It is **completely idempotent**: running it repeatedly will update packages, pull git updates, and rebuild the server, but will **never** overwrite your existing database passwords, encryption keys, or `.env` configuration:

```bash
# Method 1: Direct one-liner on a fresh Linux VPS
curl -fsSL https://raw.githubusercontent.com/explita/deploy/main/scripts/setup.sh | sudo bash

# Method 2: Clone repository first
git clone https://github.com/explita/deploy.git /opt/explita-deploy
cd /opt/explita-deploy
sudo bash scripts/setup.sh
```

---

### Option B: Manual Step-by-Step Setup

### Prerequisites

- **Docker**: Engine running and accessible by your user.
- **Node.js**: v20+ or v22 LTS.
- **pnpm**: `npm install -g pnpm`
- **PM2**: `npm install -g pm2` (recommended process manager)

### Step 1: Prepare Storage Directories

Create persistent directories outside the application repository so updating or removing the repo will never delete database state or artifacts:

```bash
sudo mkdir -p /var/lib/explita/postgres /var/lib/explita/deployments /var/lib/explita/caddy
sudo chown -R $USER:$USER /var/lib/explita
```

### Step 2: Clone and Install

```bash
git clone https://github.com/explita/deploy.git /opt/explita-deploy
cd /opt/explita-deploy
pnpm install
```

### Step 3: Configure Environment

Copy `.env.example` to `.env` in the repository root:

```bash
cp .env.example .env
```

Edit `.env` to configure your settings:

```ini
# Server Listen Address
PORT=39756
HOST=0.0.0.0

# Secure Bearer token for CLI and API requests
DEPLOY_TOKEN=generate-a-strong-secret-token-here

# Persistent storage directories
DATA_DIR=/var/lib/explita

# PostgreSQL configuration (auto-managed container)
DB_DATA_DIR=/var/lib/explita/postgres
DB_PASSWORD=generate-a-strong-database-password-here
DB_USER=explita
DB_NAME=explita_deploy
DB_PORT=5432

# (Optional: external PostgreSQL instead of Docker container)
# DATABASE_URL=postgresql://user:pass@host:5432/dbname
```

### Step 4: Build Server

```bash
pnpm build
```

### Step 5: Start with PM2

Use the included root [`ecosystem.config.cjs`](file:///c:/Projects/explita-infra/deploy/ecosystem.config.cjs):

```bash
# Start server under PM2
pm2 start ecosystem.config.cjs

# Save process list and enable launch on system boot
pm2 save
pm2 startup
```

To view server logs or restart:

```bash
pm2 logs explita-deploy
pm2 restart explita-deploy
```

_(Optional)_ If you prefer **systemd** over PM2, you can create `/etc/systemd/system/explita-deploy.service`:

```ini
[Unit]
Description=Explita Deploy Server
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=your-user
WorkingDirectory=/opt/explita-deploy
ExecStart=/usr/bin/node /opt/explita-deploy/apps/server/dist/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Then enable with:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now explita-deploy
```

---

## 2. Developer Machine Setup (CLI)

Run these steps on your **local computer / development machine**.

### Installation

Install the CLI globally or link it from the workspace:

```bash
# Once published or globally linked:
npm install -g @explita/deploy-cli
```

_(During development in this monorepo, you can run `pnpm --filter @explita/deploy-cli build` and `npm link apps/cli`)._

### Configure Connection

Configure the remote server address and token once per machine (stored in `~/.explita/config.json`):

```bash
# Point to your VPS server domain or IP (using 'eda config' or 'explita deploy config')
eda config set server https://deploy.yourdomain.com
# Or direct IP:
eda config set server http://<VPS_IP>:39756

# Set the auth token matching EXPLITA_DEPLOY_TOKEN on the VPS
eda config set token <your-token>

# Verify your configuration
eda config
```

---

## 3. Usage & Workflows

### Deploying an Application

Navigate to any project directory containing a `Dockerfile`:

```bash
cd my-node-app

# Deploy with explicit application name (using 'eda' shorthand or 'explita deploy'):
eda -n my-api
# or
explita deploy -n my-api

# Deploy with custom domain and port:
eda -n my-api -p 8080 -d api.example.com
```

The CLI packages your local directory (ignoring `.git` and `node_modules`), uploads the archive, triggers a remote Docker build, launches the container on `explita-net`, and live-streams build and startup logs via WebSocket.

### Custom Domains (Automated Caddy Reverse Proxy)

Explita Deploy manages an `explita-caddy` container on `explita-net` that binds host ports 80 and 443, automatically handling SSL/TLS generation via Let's Encrypt / ZeroSSL.

```bash
# Attach a domain to an application:
explita deploy domain add <appId> api.example.com
explita deploy domain add <appId> www.example.com

# List all domains configured for an application:
explita deploy domain ls <appId>

# Remove a domain from an application:
explita deploy domain rm <appId> www.example.com
```

Whenever an app receives a new deployment or rollback, Caddy's upstream routes are automatically updated with zero downtime.

### Explita Tunnel (Automated Public URLs & Previews)

In addition to custom domains, Explita Deploy integrates natively with **Explita Tunnel** (`@explita/cli`). For each active application, an isolated tunnel container (`explita-tunnel-<appId>`) runs on `explita-net` using `--restart unless-stopped`.

- **No open ports needed**: App containers don't need public IP addresses or open inbound firewall ports.
- **Stable public URL**: `https://<appName>.tunnel.explita.ng` (auto-routed over encrypted WebSockets).
- **Zero-Downtime Retargeting**: On redeployment or rollback, the tunnel sidecar seamlessly updates its upstream target to the new container.
- **Auto-Cleanup**: Deleting an app automatically removes its tunnel sidecar.

#### Getting a Tunnel Token

You do not need to install the separate tunnel CLI. Use the built-in `explita` command:

```bash
# 1. Request verification code and verify interactively:
explita tunnel token dev@example.com

# 2. Add the resulting token to your VPS server's .env:
# TUNNEL_TOKEN=exp_sec_...

# 3. Toggle tunnel for any application:
explita deploy tunnel <appId> enable
explita deploy tunnel <appId> disable
```

### Managing Applications

You can use `explita deploy` or the short binary `eda`:

```bash
# List all apps (optional search filter by name or ID)
eda app ls
# or: explita deploy app ls
eda app ls -s "backend"

# Inspect a specific app
explita deploy app info <appId>

# View deployment history
explita deploy history <appId>

# View deployment logs
explita deploy logs <appId>

# Rollback directly to any previous deployment ID
explita deploy rollback <deploymentId>

# Start, stop, or reboot an application container:
explita deploy stop <appId>
explita deploy start <appId>
explita deploy restart <appId>
# Note: Stopping an app pauses the container and stops its tunnel sidecar to conserve
# resources, while keeping Caddy reverse-proxy routes and SSL/TLS certificates intact
# (returning 502 Bad Gateway until restarted).

# Delete an app and its containers, arifacts and deployments and everything related to it.
explita deploy app rm <appId>
```

---

## Local Development (Contributing to Explita Deploy)

To run both the server and CLI locally during development:

```bash
# Install dependencies
pnpm install

# Configure server env
cp apps/server/.env.example apps/server/.env

# Start server in watch mode (auto-starts local Postgres container and Prisma sync)
pnpm dev

# In another terminal, run CLI commands
pnpm --filter @explita/deploy-cli dev config
pnpm --filter @explita/deploy-cli dev deploy
```
