# Explita Deploy Server

The self-hosted deployment engine and control plane daemon for [Explita Infra](https://infra.explita.ng).

It runs directly on your Linux VPS to:

- Build and run your Docker applications from source archives.
- Execute zero-downtime rolling traffic cutovers via atomic Caddy proxy reloads.
- Spin up isolated preview branch containers with auto-cloned databases.
- Stream build logs and container metrics directly to the CLI (`eda`).

---

## Server Setup

For automated or manual host setup instructions, systemd/PM2 configurations, and reverse proxy guides, see our official documentation:

👉 **[infra.explita.ng/docs/deploy/setup](https://infra.explita.ng/docs/deploy/setup)**

### Automated One-Liner (Fresh Ubuntu/Debian VPS)

```bash
curl -fsSL https://raw.githubusercontent.com/explita/deploy-server/main/scripts/setup.sh | sudo bash
```

---

## Local Development

If you are contributing to or testing the deploy server locally:

Clone the repo:

```bash
git clone https://github.com/explita/deploy-server.git
cd deploy-server
```

Then install dependencies & generate Prisma client:

```bash
# 1. Install dependencies & generate Prisma client
pnpm install
pnpm db:gen

# 2. Configure environment
cp .env.example .env

# 3. Start development server in watch mode
pnpm dev
```

---

## Documentation

Full architectural guides, environment variables, and CLI references live on our docs site:

- [Deploy Server Setup Guide](https://infra.explita.ng/docs/deploy/setup)
- [Getting Started with Explita Deploy](https://infra.explita.ng/docs/deploy/getting-started)
- [Caddy Reverse Proxy & Custom Domains](https://infra.explita.ng/docs/deploy/caddy-proxy)
- [Preview Branches & Database Cloning](https://infra.explita.ng/docs/deploy/previews-and-cloning)
- [CLI Reference](https://infra.explita.ng/docs/cli-reference)

---

## 📄 License

MIT © [Explita](https://explita.ng)
