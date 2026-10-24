# Changelog

All notable changes to `@explita/deploy-server` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-24

### Added

- **Core Server & Architecture**:
  - Fastify-based deployment control plane with WebSocket streaming support (`@fastify/websocket`) and configurable body limits.
  - Streaming content parsers for tarball source archives (`application/gzip`, `application/x-tar`) and raw SQL database dumps without RAM buffering.
  - Idempotent server host setup script (`scripts/setup.sh`) automating Docker Engine, Node.js 24 LTS, PM2, Caddy, PostgreSQL, persistent directory hierarchy (`/var/lib/explita`), and cryptographic key generation.
  - Security middleware: Bearer token authentication hook (`authHook`), request ID validation hook (`validateRequestId`), ID prefix normalizer (`normalizeIdPrefixesHook`), and custom `x-explita-version` header injection.
  - System health check endpoint (`GET /health`).

- **Application Lifecycle & Deployment Engine**:
  - Remote Docker container image building from local source archives with build layer caching.
  - Zero-downtime rolling traffic cutovers backed by automated HTTP health checks (`healthCheckPath`, `healthCheckTimeout`) before updating routing.
  - Ephemeral preview branch deployments with isolated containers and temporary preview URLs.
  - Promotion pipeline (`POST /api/deployments/:id/promote`) allowing instant promotion of verified preview containers to production without rebuilding.
  - One-command release rollbacks (`POST /api/deployments/:id/rollback`) targeting any previous image tag.
  - Active deployment cancellation (`POST /api/deployments/:id/cancel`).
  - Container lifecycle management: start (`POST /:id/start`), stop with graceful tunnel sidecar pausing (`POST /:id/stop`), restart (`POST /:id/restart`), and non-interactive command execution (`POST /:id/exec`).
  - Application deletion with automated cleanup of containers, volumes, deployments, and Caddy proxy routes (`DELETE /api/apps/:id`).

- **Automated Caddy Ingress & TLS**:
  - Containerized Caddy reverse proxy (`explita-caddy`) running on `explita-net` binding host ports 80 and 443.
  - Dynamic route reconfiguration via Caddy Admin API during deployments, preview creations, rollbacks, and deletions with zero dropped connections.
  - Automated Let's Encrypt / ZeroSSL TLS certificate issuance and renewal for custom apex domains and subdomains (`POST /api/apps/:id/domains`).
  - DNS resolution and domain health verification API (`GET /api/apps/:id/domain-check` and `GET /api/system/domain-check`).

- **Database Provisioning, Auto-Cloning & S3 Backups**:
  - Automated provisioning and lifecycle management for dedicated PostgreSQL and MariaDB database instances on `explita-net`.
  - Preview database auto-cloning (`database-clone.ts`): safely clones production PostgreSQL/MySQL schemas and seed datasets into isolated preview containers upon `eda --preview --clone-db`.
  - Point-in-time database dumps and streaming restores without buffering entire SQL dumps in RAM (`GET /api/apps/:id/db/dump`, `POST /api/apps/:id/db/restore`).
  - Scheduled automated database backups with cron configuration (`GET / POST /api/apps/:id/db/backup/schedule`).
  - Manual backup creation, restoration, and deletion (`/api/apps/:id/db/backups`).
  - Multi-provider S3 database backup replication (AWS S3, Cloudflare R2, MinIO, Wasabi) with credential verification and automated retention pruning (`helpers/prune.ts`).
  - Managed Redis instances with isolated authentication and lifecycle binding (`/api/apps/:id/redis`).

- **Application Dumps & Full-System Backups**:
  - Application-level and system-wide dump manifests (`GET /api/apps/:id/dump`, `GET /api/apps/dump`) bundling app configurations, database dumps, environment variables, cron schedules, and volume metadata into a unified archive.
  - Scheduled application dump engine with automated S3 snapshot synchronization (`/api/apps/:id/dump/schedule`).

- **Environment Variables & Secrets**:
  - AES-256-GCM encrypted environment variable storage in database.
  - Environment variable inspection, setting, deletion, and runtime injection (`GET / POST / DELETE /api/apps/:id/env`).
  - Zero-downtime environment application reload (`POST /api/apps/:id/env/apply`).

- **In-Container Cron Scheduler**:
  - Built-in cron scheduler executing recurring background jobs directly inside running application containers.
  - Cron management API: list registered cron jobs, manual immediate execution (`POST /:id/crons/run`), pause (`POST /:id/crons/pause`), resume (`POST /:id/crons/resume`), and execution history with exit codes, durations, and output logs (`GET /:id/crons/history`).

- **Observability, Telemetry & Interactive Shell**:
  - Live deployment build log streaming over WebSockets and HTTP snapshot retrieval (`GET /api/deployments/:id/logs`, `GET /api/deployments/:id/stream`).
  - Real-time container runtime logs over WebSockets and HTTP (`GET /api/apps/:id/runtime-logs`).
  - Interactive remote terminal shell over WebSockets (`GET /api/apps/:id/sh` and `GET /api/apps/:id/shell`), enabling full TTY interactive sessions (`eda sh` / `eda exec -it`).
  - Real-time container CPU, memory, and network I/O telemetry via Docker stats (`GET /api/apps/:id/stats`).
  - Comprehensive server doctor diagnostics (`GET /api/system/doctor`) inspecting Docker daemon state, Caddy health, disk utilization, database backup status, and system memory.
  - Host maintenance and Docker resource pruning (`POST /api/system/prune`) for unused containers, dangling images, and build caches.

- **Persistent Volume Management**:
  - Volume management API: list host volumes (`GET /api/volumes`), inspect container bindings and sizes (`GET /api/volumes/:name`), and delete unattached volumes (`DELETE /api/volumes/:name`).

- **Incident & Health Notifications**:
  - Multi-channel notification service supporting Discord, Slack, and Telegram webhooks (`GET / POST / DELETE /api/apps/:id/notify`).
  - Automated rich embed alert formatting for container health check failures, deployment completions, backup successes/failures, and cron execution errors.
  - Webhook delivery testing endpoint (`POST /api/apps/:id/notify/test`).

- **Instant Maintenance Mode**:
  - On-demand 503 maintenance mode toggle with customizable branded splash screen (`GET / POST /api/apps/:id/maintenance`).
