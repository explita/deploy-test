#!/usr/bin/env bash
# ==============================================================================
# Explita Deploy - Host Server Setup & Provisioning Script
# ==============================================================================
# Automates the setup of Docker, Node.js, pnpm, PM2, storage directories,
# environment configuration, and builds the Explita Deploy control plane.
#
# IDEMPOTENT: Safe to run repeatedly. Existing databases, tokens, encryption
# keys, and configurations will NEVER be overwritten or corrupted on reruns.
#
# Usage:
#   # Option 1: Direct one-liner on a fresh VPS
#   curl -fsSL https://raw.githubusercontent.com/explita/deploy-test/main/scripts/setup.sh | sudo bash
#
#   # Option 2: Run from cloned repository
#   cd /opt/explita-deploy
#   sudo bash scripts/setup.sh
# ==============================================================================

set -euo pipefail

# Terminal colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m' # No Color

log_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
  echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1" >&2
}

# ------------------------------------------------------------------------------
# 1. OS Compatibility Check (Linux VPS Only)
# ------------------------------------------------------------------------------
OS_TYPE="$(uname -s 2>/dev/null || echo "Unknown")"
if [ "$OS_TYPE" != "Linux" ]; then
  log_error "This setup script is strictly intended for Linux host servers (Ubuntu, Debian, Fedora, etc.)."
  log_error "Detected OS: ${OS_TYPE}"
  echo ""
  echo "• On a local development machine (macOS/Windows), use the client CLI instead:"
  echo "    pnpm install -g @explita/cli"
  echo "    eda --help"
  echo ""
  echo "• To run the deploy server locally during development:"
  echo "    cd deploy && pnpm install && pnpm dev"
  echo ""
  exit 1
fi

# ------------------------------------------------------------------------------
# 2. Require root privileges
# ------------------------------------------------------------------------------
if [ "$EUID" -ne 0 ]; then
  log_error "Please run this script with root privileges (e.g. sudo bash scripts/setup.sh)"
  exit 1
fi

TARGET_USER="${SUDO_USER:-$USER}"

# ------------------------------------------------------------------------------
# 3. Configuration & Directory Resolution
# ------------------------------------------------------------------------------
DEFAULT_INSTALL_DIR="/opt/explita-deploy"
REPO_URL="${REPO_URL:-https://github.com/explita/deploy-test.git}"
BRANCH="${BRANCH:-main}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo "")"

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/../package.json" ]; then
  DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
elif [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ]; then
  DEPLOY_DIR="$SCRIPT_DIR"
elif [ -f "${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}/package.json" ]; then
  DEPLOY_DIR="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
else
  DEPLOY_DIR="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
fi

log_info "Configuring Explita Deploy at: ${BOLD}${DEPLOY_DIR}${NC}"

# ------------------------------------------------------------------------------
# 4. Base Utilities Detection & Installation (Idempotent)
# ------------------------------------------------------------------------------
install_pkg() {
  local pkg="$1"
  if command -v apt-get &>/dev/null; then
    apt-get update -qq && apt-get install -y -qq "$pkg"
  elif command -v dnf &>/dev/null; then
    dnf install -y -q "$pkg"
  elif command -v yum &>/dev/null; then
    yum install -y -q "$pkg"
  elif command -v pacman &>/dev/null; then
    pacman -Sy --noconfirm "$pkg"
  elif command -v zypper &>/dev/null; then
    zypper install -y "$pkg"
  else
    log_warn "No recognized package manager. Ensure '$pkg' is installed manually."
  fi
}

for tool in curl git openssl tar gzip; do
  if ! command -v "$tool" &>/dev/null; then
    log_info "Installing missing base utility: $tool..."
    install_pkg "$tool"
  fi
done

# ------------------------------------------------------------------------------
# 5. Clone or Update Repository from Git (Idempotent)
# ------------------------------------------------------------------------------
if [ -d "$DEPLOY_DIR/.git" ]; then
  log_info "Existing Git repository found at: ${BOLD}${DEPLOY_DIR}${NC}"
  log_info "Fetching latest updates from branch '${BRANCH}'..."
  (cd "$DEPLOY_DIR" && git fetch origin "$BRANCH" --quiet 2>/dev/null && git pull --ff-only origin "$BRANCH" 2>/dev/null || true)
elif [ ! -f "$DEPLOY_DIR/package.json" ]; then
  log_info "Cloning Explita Deploy from ${BOLD}${REPO_URL}${NC} into ${BOLD}${DEPLOY_DIR}${NC}..."
  mkdir -p "$(dirname "$DEPLOY_DIR")"
  git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$DEPLOY_DIR"
  log_success "Repository cloned successfully."
else
  log_info "Existing Explita Deploy files found at: ${BOLD}${DEPLOY_DIR}${NC}"
fi

cd "$DEPLOY_DIR"

if [ "$TARGET_USER" != "root" ] && id "$TARGET_USER" &>/dev/null; then
  chown -R "$TARGET_USER:$TARGET_USER" "$DEPLOY_DIR" 2>/dev/null || true
fi

# ------------------------------------------------------------------------------
# 6. Docker Engine Setup (Idempotent)
# ------------------------------------------------------------------------------
if ! command -v docker &>/dev/null; then
  log_info "Docker not found. Installing Docker Engine..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker >/dev/null 2>&1 || service docker start >/dev/null 2>&1 || true
  log_success "Docker installed successfully."
else
  log_info "Docker is already installed ($(docker --version 2>/dev/null || echo 'active'))."
fi

# Ensure Docker daemon is active
if command -v systemctl &>/dev/null; then
  systemctl enable --now docker >/dev/null 2>&1 || true
elif command -v service &>/dev/null; then
  service docker start >/dev/null 2>&1 || true
fi

# Ensure user is in docker group if non-root sudo was used
if [ "$TARGET_USER" != "root" ] && id "$TARGET_USER" &>/dev/null; then
  if ! id -nG "$TARGET_USER" 2>/dev/null | grep -qw "docker"; then
    log_info "Adding '$TARGET_USER' to docker group..."
    usermod -aG docker "$TARGET_USER" 2>/dev/null || true
  fi
fi

# Ensure shared Docker bridge network exists
if ! docker network inspect explita-net >/dev/null 2>&1; then
  log_info "Creating Docker bridge network: explita-net..."
  docker network create explita-net >/dev/null
  log_success "Docker network 'explita-net' created."
else
  log_info "Docker network 'explita-net' already exists."
fi

# ------------------------------------------------------------------------------
# 7. Node.js Setup (v20+ Required, Idempotent)
# ------------------------------------------------------------------------------
NODE_NEEDS_INSTALL=true
if command -v node &>/dev/null; then
  NODE_MAJOR=$(node -v | tr -d 'v' | cut -d'.' -f1)
  if [ "$NODE_MAJOR" -ge 20 ]; then
    NODE_NEEDS_INSTALL=false
    log_info "Node.js is already installed ($(node -v))."
  else
    log_warn "Node.js $(node -v) is older than v20. Upgrading to Node.js 22 LTS..."
  fi
fi

if [ "$NODE_NEEDS_INSTALL" = true ]; then
  log_info "Installing Node.js 22 LTS..."
  if command -v apt-get &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y -qq nodejs
  elif command -v dnf &>/dev/null || command -v yum &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    dnf install -y -q nodejs 2>/dev/null || yum install -y -q nodejs
  else
    log_error "Unsupported package manager. Please install Node.js >= 20 manually."
    exit 1
  fi
  log_success "Node.js $(node -v) installed."
fi

# ------------------------------------------------------------------------------
# 8. pnpm & PM2 Installation (Idempotent)
# ------------------------------------------------------------------------------
if ! command -v pnpm &>/dev/null; then
  log_info "Installing pnpm..."
  npm install -g pnpm@latest --silent
  log_success "pnpm installed ($(pnpm --version))."
else
  log_info "pnpm is already installed ($(pnpm --version))."
fi

if ! command -v pm2 &>/dev/null; then
  log_info "Installing PM2 process manager..."
  npm install -g pm2@latest --silent
  log_success "PM2 installed."
else
  log_info "PM2 is already installed ($(pm2 --version))."
fi

# ------------------------------------------------------------------------------
# 9. Host Persistent Storage Directories (Idempotent)
# ------------------------------------------------------------------------------
log_info "Ensuring host storage directories exist..."
mkdir -p /var/lib/explita/postgres
mkdir -p /var/lib/explita/deployments
mkdir -p /var/lib/explita/caddy/apps
mkdir -p /var/lib/explita/caddy/data
mkdir -p /var/lib/explita/backups/databases
mkdir -p /var/lib/explita/custom/files
mkdir -p /var/lib/explita/redis

chmod 755 /var/lib/explita
chmod 700 /var/lib/explita/postgres
log_success "Storage directories verified at /var/lib/explita."

# ------------------------------------------------------------------------------
# 10. Environment Configuration (.env) - Strictly Preserves Existing State
# ------------------------------------------------------------------------------
ENV_FILE="$DEPLOY_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  log_info "Generating new production configuration (.env)..."
  GEN_ENCRYPTION_KEY=$(openssl rand -hex 32)
  GEN_DEPLOY_TOKEN=$(openssl rand -hex 24)
  GEN_DB_PASS=$(openssl rand -hex 24)

  cat <<EOF > "$ENV_FILE"
# ================================================== #
# EXPLITA DEPLOY - ENVIRONMENT CONFIGURATION (.env)  #
# ================================================== #

# 1. IMMUTABLE VALUES - DO NOT CHANGE ONCE APPS ARE CREATED!
APP_ENCRYPTION_KEY=${GEN_ENCRYPTION_KEY}
DATA_DIR=/var/lib/explita
POSTGRES_ROOT_PASSWORD=${GEN_DB_PASS}
# POSTGRES_PORT=5432
# POSTGRES_DATA_DIR=/var/lib/explita/postgres

# 2. RUNTIME / ROTATABLE VALUES
PORT=39756
HOST=0.0.0.0
DEPLOY_TOKEN=${GEN_DEPLOY_TOKEN}
# DEPLOY_PASSCODE=3434
# DEPLOY_2FA_SECRET=JBSWY3DPEHPK3PXF
LOG_INFO=false
MAX_REQUEST_BODY_SIZE=100MB
IMAGE_RETENTION_LIMIT=3
CRON_HISTORY_LIMIT=50
REDIS_ENABLED=false
TUNNEL_ENABLED=true
EOF
  chmod 600 "$ENV_FILE"
  log_success "Created fresh .env with secure random tokens."
else
  log_info "Existing .env detected. Preserving all existing values..."

  # Idempotently ensure missing required keys are appended without touching existing keys
  ensure_env_key() {
    local key="$1"
    local default_val="$2"
    if ! grep -q -E "^${key}=" "$ENV_FILE" 2>/dev/null; then
      log_warn "Adding missing required configuration key: $key"
      echo "${key}=${default_val}" >> "$ENV_FILE"
    fi
  }

  # Ensure APP_ENCRYPTION_KEY exists (required for AES-256-GCM secret encryption)
  if ! grep -q -E "^APP_ENCRYPTION_KEY=" "$ENV_FILE" 2>/dev/null; then
    NEW_KEY=$(openssl rand -hex 32)
    ensure_env_key "APP_ENCRYPTION_KEY" "$NEW_KEY"
  fi

  # Ensure DEPLOY_TOKEN exists
  if ! grep -q -E "^DEPLOY_TOKEN=" "$ENV_FILE" 2>/dev/null; then
    ensure_env_key "DEPLOY_TOKEN" "$(openssl rand -hex 24)"
  fi

  ensure_env_key "PORT" "39756"
  ensure_env_key "HOST" "0.0.0.0"
  ensure_env_key "DATA_DIR" "/var/lib/explita"
  ensure_env_key "DB_DATA_DIR" "/var/lib/explita/postgres"
  ensure_env_key "DB_USER" "explita"
  ensure_env_key "DB_NAME" "explita_deploy"
  ensure_env_key "DB_PORT" "5432"
  ensure_env_key "IMAGE_RETENTION_LIMIT" "3"
  ensure_env_key "CRON_HISTORY_LIMIT" "50"
  ensure_env_key "MAX_REQUEST_BODY_SIZE" "100MB"
fi

# ------------------------------------------------------------------------------
# 11. Install Dependencies & Build Explita Deploy Server
# ------------------------------------------------------------------------------
log_info "Installing dependencies and building Explita Deploy server..."
pnpm install --frozen-lockfile=false --silent
pnpm build
log_success "Build completed successfully."

# ------------------------------------------------------------------------------
# 12. PM2 Process Management (Idempotent start / reload)
# ------------------------------------------------------------------------------
if [ -f "$DEPLOY_DIR/ecosystem.config.cjs" ]; then
  log_info "Managing server process via PM2..."
  if pm2 describe explita-deploy >/dev/null 2>&1; then
    log_info "Reloading existing explita-deploy PM2 process..."
    pm2 reload ecosystem.config.cjs --update-env >/dev/null
    log_success "PM2 process 'explita-deploy' reloaded with updated build."
  else
    log_info "Starting explita-deploy in PM2..."
    pm2 start ecosystem.config.cjs >/dev/null
    pm2 save >/dev/null 2>&1 || true
    log_success "PM2 process 'explita-deploy' started."
  fi
fi

# ------------------------------------------------------------------------------
# 13. Read Active Configuration for Summary
# ------------------------------------------------------------------------------
ACTIVE_PORT=$(grep -E "^PORT=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | tr -d '\r' || echo "39756")
ACTIVE_TOKEN=$(grep -E "^DEPLOY_TOKEN=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | tr -d '\r' || echo "")
SERVER_IP=$(curl -4s --max-time 2 https://api.ipify.org 2>/dev/null || curl -4s --max-time 2 https://ifconfig.me 2>/dev/null || echo "YOUR_VPS_IP")

echo ""
echo -e "${GREEN}${BOLD}================================================================${NC}"
echo -e "${GREEN}${BOLD}      Explita Deploy Host Server Setup Complete!                ${NC}"
echo -e "${GREEN}${BOLD}================================================================${NC}"
echo ""
echo -e "Status         : ${GREEN}Active & Running (PM2: explita-deploy)${NC}"
echo -e "Server Port    : ${BOLD}${ACTIVE_PORT}${NC}"
echo -e "Server URL     : ${BOLD}http://${SERVER_IP}:${ACTIVE_PORT}${NC}"
echo -e "Storage Dir    : /var/lib/explita"
echo -e "Auth Token     : ${BOLD}${ACTIVE_TOKEN}${NC}"
echo ""
echo -e "${BOLD}Connect From Your Local Developer Machine:${NC}"
echo -e "  eda config set server http://${SERVER_IP}:${ACTIVE_PORT}"
echo -e "  eda config set token ${ACTIVE_TOKEN}"
echo ""
echo -e "${BOLD}Server Maintenance Commands (Run on VPS):${NC}"
echo -e "  pm2 logs explita-deploy     # View live server logs"
echo -e "  pm2 restart explita-deploy  # Restart server process"
echo -e "  pm2 status                  # Check process status"
echo ""
echo -e "${BLUE}[INFO]${NC} This script is idempotent: you can rerun it anytime to apply updates safely."
echo ""
