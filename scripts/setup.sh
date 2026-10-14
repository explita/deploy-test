#!/usr/bin/env bash
# ==============================================================================
# Explita Deploy - Host Server Setup & Provisioning Script
# ==============================================================================
# Automates the setup of Docker, Node.js, pnpm, PM2, storage directories,
# environment configuration, and builds the Explita Deploy control plane.
#
# IDEMPOTENT: Safe to run repeatedly. Existing databases, tokens, encryption
# keys, and configurations are strictly preserved on reruns.
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

# Standard deployment umask for package installations, repository files, and directories.
umask 022

# Terminal colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
DIM='\033[2m'
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
TARGET_GROUP="$(id -gn "$TARGET_USER" 2>/dev/null || echo "$TARGET_USER")"
TARGET_HOME="$(getent passwd "$TARGET_USER" 2>/dev/null | cut -d: -f6 || echo "")"
if [ -z "$TARGET_HOME" ] || [ ! -d "$TARGET_HOME" ]; then
  if [ "$TARGET_USER" = "root" ]; then
    TARGET_HOME="/root"
  else
    log_error "Could not determine valid home directory for service user '$TARGET_USER'."
    exit 1
  fi
fi

if [ "$TARGET_USER" != "root" ] && ! command -v sudo &>/dev/null; then
  log_error "'sudo' is required to execute commands as service user '$TARGET_USER'."
  exit 1
fi

# Helper to run commands as TARGET_USER (keeps PM2 & project files under the SSH user)
run_as_target() {
  if [ "$TARGET_USER" = "root" ]; then
    "$@"
  else
    sudo -u "$TARGET_USER" -H "$@"
  fi
}

# ------------------------------------------------------------------------------
# 3. Configuration & Directory Resolution
# ------------------------------------------------------------------------------
DEFAULT_INSTALL_DIR="/opt/explita-deploy"
REPO_URL="${REPO_URL:-https://github.com/explita/deploy-test.git}"
BRANCH="${BRANCH:-main}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-}")" 2>/dev/null && pwd || echo "")"

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
# 4. Base Utilities Detection & Batch Installation (Idempotent)
# ------------------------------------------------------------------------------
MISSING_PKGS=()
for tool in curl git openssl tar gzip; do
  if ! command -v "$tool" &>/dev/null; then
    MISSING_PKGS+=("$tool")
  fi
done

if [ ${#MISSING_PKGS[@]} -gt 0 ]; then
  log_info "Installing missing base utilities: ${MISSING_PKGS[*]}..."
  if command -v apt-get &>/dev/null; then
    apt-get update -qq && apt-get install -y -qq "${MISSING_PKGS[@]}"
  elif command -v dnf &>/dev/null; then
    dnf install -y -q "${MISSING_PKGS[@]}"
  elif command -v yum &>/dev/null; then
    yum install -y -q "${MISSING_PKGS[@]}"
  elif command -v pacman &>/dev/null; then
    pacman -Sy --noconfirm "${MISSING_PKGS[@]}"
  elif command -v zypper &>/dev/null; then
    zypper install -y "${MISSING_PKGS[@]}"
  else
    log_error "Unsupported package manager. Please install the following utilities manually and rerun: ${MISSING_PKGS[*]}"
    exit 1
  fi
fi

# Explicitly verify required tools now exist
for tool in curl git openssl tar gzip; do
  if ! command -v "$tool" &>/dev/null; then
    log_error "Required utility '$tool' is missing and could not be installed automatically."
    exit 1
  fi
done

# ------------------------------------------------------------------------------
# 5. Clone or Update Repository from Git (Idempotent)
# ------------------------------------------------------------------------------
if [ -d "$DEPLOY_DIR/.git" ]; then
  log_info "Existing Git repository found at: ${BOLD}${DEPLOY_DIR}${NC}"
  log_info "Fetching latest updates from branch '${BRANCH}'..."
  if (cd "$DEPLOY_DIR" && git fetch origin "$BRANCH" --quiet 2>/dev/null && git pull --ff-only origin "$BRANCH" --quiet 2>/dev/null); then
    log_success "Repository successfully updated to latest '${BRANCH}'."
  else
    if [ "${OFFLINE_MODE:-false}" = "true" ] || [ "${ALLOW_LOCAL_REPO:-false}" = "true" ]; then
      ACTIVE_COMMIT=$(cd "$DEPLOY_DIR" && git rev-parse --short HEAD 2>/dev/null || echo "unknown")
      log_warn "Git update from origin/${BRANCH} failed or was skipped."
      log_warn "Bypassing git update because OFFLINE_MODE=${OFFLINE_MODE:-false} / ALLOW_LOCAL_REPO=${ALLOW_LOCAL_REPO:-false} is set."
      log_warn "Proceeding with existing local checkout at commit: ${ACTIVE_COMMIT}"
    else
      log_error "Could not update repository from origin/${BRANCH}."
      log_error "Resolve git status/network, or set OFFLINE_MODE=true or ALLOW_LOCAL_REPO=true to bypass."
      exit 1
    fi
  fi
elif [ -f "$DEPLOY_DIR/package.json" ]; then
  log_info "Existing Explita Deploy files found at: ${BOLD}${DEPLOY_DIR}${NC}"
elif [ -d "$DEPLOY_DIR" ] && [ -n "$(find "$DEPLOY_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
  log_error "Install directory exists and is not empty, but is not a valid deployment checkout: ${DEPLOY_DIR}"
  log_error "Choose another INSTALL_DIR or inspect the directory before proceeding."
  exit 1
else
  log_info "Cloning Explita Deploy from ${BOLD}${REPO_URL}${NC} into ${BOLD}${DEPLOY_DIR}${NC}..."
  mkdir -p "$(dirname "$DEPLOY_DIR")"
  git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$DEPLOY_DIR"
  log_success "Repository cloned successfully."
fi

cd "$DEPLOY_DIR"

if [ ! -f "$DEPLOY_DIR/package.json" ]; then
  log_error "Validation failed: package.json not found in ${DEPLOY_DIR}."
  exit 1
fi

COMMIT_HASH="$(git rev-parse --short HEAD 2>/dev/null || echo "local")"
log_info "Active release commit: ${BOLD}${COMMIT_HASH}${NC}"

if [ "$TARGET_USER" != "root" ] && id "$TARGET_USER" &>/dev/null; then
  # Use -h to avoid following symlinks outside the repository directory
  if ! chown -R -h "$TARGET_USER:$TARGET_GROUP" "$DEPLOY_DIR"; then
    log_error "Failed to set ownership of ${DEPLOY_DIR} to ${TARGET_USER}:${TARGET_GROUP}."
    exit 1
  fi
fi

# ------------------------------------------------------------------------------
# 6. Docker Engine Setup (Idempotent)
# ------------------------------------------------------------------------------
if ! command -v docker &>/dev/null; then
  log_info "Docker not found. Installing Docker Engine..."
  curl -fsSL https://get.docker.com | sh
  if command -v systemctl &>/dev/null; then
    if ! systemctl enable --now docker >/dev/null 2>&1; then
      log_warn "Failed to enable and start Docker via systemctl. Attempting service start..."
      service docker start >/dev/null 2>&1 || true
    fi
  elif command -v service &>/dev/null; then
    service docker start >/dev/null 2>&1 || true
  fi
  log_success "Docker installed successfully."
else
  log_info "Docker is already installed ($(docker --version 2>/dev/null || echo 'active'))."
fi

# Ensure Docker daemon is active and responsive
if command -v systemctl &>/dev/null; then
  systemctl enable --now docker >/dev/null 2>&1 || true
elif command -v service &>/dev/null; then
  service docker start >/dev/null 2>&1 || true
fi

if ! docker info >/dev/null 2>&1; then
  log_error "Docker daemon is not running or unreachable. Please verify host Docker status ('systemctl status docker')."
  exit 1
fi

# Add target user to docker group if not root
if [ "$TARGET_USER" != "root" ] && id "$TARGET_USER" &>/dev/null; then
  if ! id -nG "$TARGET_USER" | grep -qw "docker"; then
    log_info "Adding '${TARGET_USER}' to docker group..."
    usermod -aG docker "$TARGET_USER"
    log_warn "Security Notice: Adding '${TARGET_USER}' to 'docker' grants root-equivalent container control on this host."
    log_warn "Note: An active SSH session for '${TARGET_USER}' must reconnect to activate new group membership."
    log_success "Added '${TARGET_USER}' to docker group."
  fi
fi

# Ensure default Explita bridge network exists
if ! docker network inspect explita-net >/dev/null 2>&1; then
  log_info "Creating Docker bridge network: explita-net..."
  docker network create explita-net >/dev/null
  log_success "Docker network 'explita-net' created."
fi

# ------------------------------------------------------------------------------
# 7. Node.js Setup (Minimum Node.js 20 required, Node.js 22 LTS default install)
# ------------------------------------------------------------------------------
MIN_NODE_MAJOR=20
INSTALL_NODE_MAJOR=22
NODE_NEEDS_INSTALL=true

if command -v node &>/dev/null; then
  INSTALLED_NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || node -v | cut -d'.' -f1 | sed 's/v//')
  if [ "$INSTALLED_NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ]; then
    NODE_NEEDS_INSTALL=false
    log_info "Node.js $(node -v) is already installed (satisfies minimum v${MIN_NODE_MAJOR}+ policy)."
  else
    log_warn "Installed Node.js ($(node -v)) is outdated (v${MIN_NODE_MAJOR}+ required). Upgrading to Node.js ${INSTALL_NODE_MAJOR} LTS..."
  fi
fi

if [ "$NODE_NEEDS_INSTALL" = true ]; then
  log_info "Installing system-wide Node.js ${INSTALL_NODE_MAJOR} LTS via official distribution packages..."
  if command -v apt-get &>/dev/null; then
    curl -fsSL "https://deb.nodesource.com/setup_${INSTALL_NODE_MAJOR}.x" | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs
  elif command -v dnf &>/dev/null; then
    curl -fsSL "https://rpm.nodesource.com/setup_${INSTALL_NODE_MAJOR}.x" | bash - >/dev/null 2>&1
    dnf install -y -q nodejs
  elif command -v yum &>/dev/null; then
    curl -fsSL "https://rpm.nodesource.com/setup_${INSTALL_NODE_MAJOR}.x" | bash - >/dev/null 2>&1
    yum install -y -q nodejs
  elif command -v pacman &>/dev/null; then
    pacman -Sy --noconfirm nodejs npm
  elif command -v zypper &>/dev/null; then
    zypper install -y nodejs npm
  else
    log_error "Unsupported package manager for automated Node.js installation. Please install Node.js ${MIN_NODE_MAJOR}+ manually."
    exit 1
  fi
fi

# Validate installed Node.js binary meets minimum version requirement
if ! command -v node &>/dev/null; then
  log_error "Node.js installation failed: 'node' executable not found on PATH."
  exit 1
fi
INSTALLED_NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || node -v | cut -d'.' -f1 | sed 's/v//')
if [ "$INSTALLED_NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  log_error "Installed Node.js version $(node -v) does not meet minimum requirement (v${MIN_NODE_MAJOR}+)."
  exit 1
fi
log_success "System Node.js $(node -v) verified."

# ------------------------------------------------------------------------------
# 8. pnpm & PM2 Installation (Idempotent)
# ------------------------------------------------------------------------------
if ! command -v npm &>/dev/null; then
  log_error "Node package manager ('npm') is not found on PATH. Ensure Node.js installed correctly."
  exit 1
fi

DESIRED_PNPM="${PNPM_VERSION:-10}"
if [[ ! "$DESIRED_PNPM" =~ ^[0-9]+$ ]]; then
  log_error "PNPM_VERSION must be a numeric major version (e.g. 10). Got: '${DESIRED_PNPM}'"
  exit 1
fi

INSTALL_PNPM=false
if command -v pnpm &>/dev/null; then
  INSTALLED_PNPM_VER="$(pnpm -v 2>/dev/null || echo "")"
  INSTALLED_PNPM_MAJOR="${INSTALLED_PNPM_VER%%.*}"
  if [[ "$INSTALLED_PNPM_MAJOR" =~ ^[0-9]+$ ]] && [ "$INSTALLED_PNPM_MAJOR" -eq "$DESIRED_PNPM" ]; then
    log_info "pnpm v${INSTALLED_PNPM_VER} matches desired major v${DESIRED_PNPM}."
  else
    log_warn "Installed pnpm (v${INSTALLED_PNPM_VER}) does not match desired major v${DESIRED_PNPM}. Installing pnpm@${DESIRED_PNPM}..."
    INSTALL_PNPM=true
  fi
else
  INSTALL_PNPM=true
fi

if [ "$INSTALL_PNPM" = true ]; then
  log_info "Installing pnpm@${DESIRED_PNPM} via npm..."
  if ! npm install -g "pnpm@${DESIRED_PNPM}" >/dev/null 2>&1; then
    log_warn "Standard npm install failed; attempting corepack enable pnpm..."
    corepack enable pnpm >/dev/null 2>&1 || true
  fi

  if ! command -v pnpm &>/dev/null; then
    log_error "Failed to install pnpm. Ensure npm is working properly."
    exit 1
  fi

  VERIFIED_PNPM_VER="$(pnpm -v 2>/dev/null || echo "")"
  VERIFIED_PNPM_MAJOR="${VERIFIED_PNPM_VER%%.*}"
  if [ "$VERIFIED_PNPM_MAJOR" != "$DESIRED_PNPM" ]; then
    log_error "pnpm installation verification failed: expected major v${DESIRED_PNPM}, but resolved v${VERIFIED_PNPM_VER}."
    exit 1
  fi
  log_success "pnpm installed and verified (v${VERIFIED_PNPM_VER})."
fi

if ! command -v pm2 &>/dev/null; then
  log_info "Installing PM2 process manager..."
  if ! npm install -g pm2 >/dev/null 2>&1; then
    log_error "Failed to install PM2 via npm."
    exit 1
  fi
  log_success "PM2 installed ($(pm2 -v))."
else
  log_info "PM2 is already installed ($(pm2 -v 2>/dev/null || echo 'active'))."
fi

# Verify runtime access and binary resolution under service user
TARGET_NODE_PATH=$(run_as_target command -v node 2>/dev/null || echo "")
TARGET_PM2_PATH=$(run_as_target command -v pm2 2>/dev/null || echo "")
TARGET_PNPM_PATH=$(run_as_target command -v pnpm 2>/dev/null || echo "")

if [ -z "$TARGET_NODE_PATH" ] || [ -z "$TARGET_PM2_PATH" ] || [ -z "$TARGET_PNPM_PATH" ]; then
  log_error "Service user verification failed: 'node', 'pm2', or 'pnpm' is not accessible under user '${TARGET_USER}'."
  exit 1
fi

TARGET_NODE_VERSION=$(run_as_target node -v 2>/dev/null || echo "")
TARGET_PM2_VERSION=$(run_as_target pm2 -v 2>/dev/null || echo "")
TARGET_PNPM_VERSION=$(run_as_target pnpm -v 2>/dev/null || echo "")

TARGET_NODE_MAJOR=$(run_as_target node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
TARGET_PNPM_MAJOR="${TARGET_PNPM_VERSION%%.*}"

if [ "$TARGET_NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  log_error "Service user '${TARGET_USER}' resolves node at ${TARGET_NODE_VERSION}, which does not meet minimum v${MIN_NODE_MAJOR}+."
  exit 1
fi

if [ "$TARGET_PNPM_MAJOR" != "$DESIRED_PNPM" ]; then
  log_error "Service user '${TARGET_USER}' resolves pnpm at v${TARGET_PNPM_VERSION}, which does not match required major v${DESIRED_PNPM}."
  exit 1
fi

SYSTEM_NODE_PATH=$(command -v node)
if [ "$TARGET_NODE_PATH" != "$SYSTEM_NODE_PATH" ]; then
  log_warn "Target user resolves 'node' at ${TARGET_NODE_PATH} while root uses ${SYSTEM_NODE_PATH}."
fi

log_info "Verified service user runtime: node ${TARGET_NODE_VERSION} (${TARGET_NODE_PATH}), pnpm ${TARGET_PNPM_VERSION} (${TARGET_PNPM_PATH}), pm2 ${TARGET_PM2_VERSION} (${TARGET_PM2_PATH})"

# ------------------------------------------------------------------------------
# 9. Host Persistent Storage Directories (Idempotent)
# ------------------------------------------------------------------------------
log_info "Ensuring host storage directories exist..."
mkdir -p /var/lib/explita/postgres \
         /var/lib/explita/redis \
         /var/lib/explita/caddy/apps \
         /var/lib/explita/caddy/data \
         /var/lib/explita/backups/databases \
         /var/lib/explita/deployments \
         /var/lib/explita/custom/files

# Assign directory ownership for paths written directly by the Explita Deploy service
if [ "$TARGET_USER" != "root" ] && id "$TARGET_USER" &>/dev/null; then
  chown -R "$TARGET_USER:$TARGET_GROUP" \
    /var/lib/explita/deployments \
    /var/lib/explita/caddy/apps \
    /var/lib/explita/backups \
    /var/lib/explita/custom
fi

# Set explicit directory permissions according to security and access boundaries:
chmod 755 /var/lib/explita
chmod 755 /var/lib/explita/deployments
chmod 755 /var/lib/explita/caddy
chmod 755 /var/lib/explita/caddy/apps
chmod 755 /var/lib/explita/caddy/data
chmod 700 /var/lib/explita/backups
chmod 700 /var/lib/explita/backups/databases
chmod 755 /var/lib/explita/custom
chmod 755 /var/lib/explita/custom/files

# Host-side mount directories for containers:
# - PostgreSQL: postgres:17-alpine entrypoint starts as root, chowns mount to postgres UID 70, and sets 700 inside
# - Redis: 755 allows redis container user to read and initialize appendonly data
chmod 755 /var/lib/explita/postgres
chmod 755 /var/lib/explita/redis

log_success "Storage directories verified with explicit ownership and permissions at /var/lib/explita."

# ------------------------------------------------------------------------------
# 10. Environment Configuration (.env) - Strictly Preserves Existing State
# ------------------------------------------------------------------------------
ENV_FILE="$DEPLOY_DIR/.env"

if [ -e "$ENV_FILE" ]; then
  if [ ! -f "$ENV_FILE" ] || [ -L "$ENV_FILE" ]; then
    log_error ".env must be a regular file, not a symlink or another file type."
    exit 1
  fi

  chmod 600 "$ENV_FILE"
fi

IS_FIRST_INSTALL=false

# Helper to read environment variables using strict simple KEY=value syntax
get_env_val() {
  local key="$1"
  local line
  line=$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -n 1 | tr -d '\r' || echo "")
  if [ -z "$line" ]; then
    echo ""
    return 0
  fi
  local val="${line#*=}"
  # Strip matching surrounding double or single quotes if present
  if [[ "$val" =~ ^\"(.*)\"$ ]] || [[ "$val" =~ ^\'(.*)\'$ ]]; then
    val="${BASH_REMATCH[1]}"
  fi
  echo "$val"
}

if [ ! -f "$ENV_FILE" ]; then
  IS_FIRST_INSTALL=true
  log_info "Generating new production configuration (.env)..."
  GEN_ENCRYPTION_KEY=$(openssl rand -hex 32)
  GEN_DEPLOY_TOKEN=$(openssl rand -hex 24)
  GEN_DB_PASS=$(openssl rand -hex 24)

  (
    umask 077
    cat <<EOF > "$ENV_FILE"
# ================================================== #
# EXPLITA DEPLOY - ENVIRONMENT CONFIGURATION (.env)  #
# ================================================== #
# Note: Values must be simple unquoted KEY=value entries.

# 1. IMMUTABLE VALUES - DO NOT CHANGE ONCE APPS ARE CREATED!
APP_ENCRYPTION_KEY=${GEN_ENCRYPTION_KEY}
DATA_DIR=/var/lib/explita
POSTGRES_ROOT_PASSWORD=${GEN_DB_PASS}

# 2. RUNTIME / ROTATABLE VALUES
PORT=39756
HOST=0.0.0.0
DEPLOY_TOKEN=${GEN_DEPLOY_TOKEN}
LOG_INFO=false
MAX_REQUEST_BODY_SIZE=100MB
IMAGE_RETENTION_LIMIT=3
CRON_HISTORY_LIMIT=50
REDIS_ENABLED=false
TUNNEL_ENABLED=true
EOF
  )
  log_success "Created fresh .env with secure random tokens."
else
  log_info "Existing .env detected. Preserving all existing values..."

  # Reject unsupported syntax variations for managed keys before processing
  MANAGED_KEYS_REGEX="APP_ENCRYPTION_KEY|DEPLOY_TOKEN|POSTGRES_ROOT_PASSWORD|PORT|DATA_DIR|HOST|LOG_INFO|MAX_REQUEST_BODY_SIZE|IMAGE_RETENTION_LIMIT|CRON_HISTORY_LIMIT|REDIS_ENABLED|TUNNEL_ENABLED"

  # 1. Reject leading whitespace before managed keys
  if grep -q -E "^[[:space:]]+(${MANAGED_KEYS_REGEX})" "$ENV_FILE" 2>/dev/null; then
    log_error "Leading whitespace detected before managed keys in ${ENV_FILE}."
    log_error "Configuration keys must start at the beginning of the line (e.g. KEY=value)."
    exit 1
  fi

  # 2. Reject unsupported 'export' syntax
  if grep -q -E "^[[:space:]]*export[[:space:]]+(${MANAGED_KEYS_REGEX})" "$ENV_FILE" 2>/dev/null; then
    log_error "Unsupported 'export' syntax detected for managed keys in ${ENV_FILE}."
    log_error "Configuration keys must use simple 'KEY=value' entries without the 'export' prefix."
    exit 1
  fi

  # 3. Reject whitespace around '=' (e.g. 'KEY =value' or 'KEY= value')
  if grep -q -E "^(${MANAGED_KEYS_REGEX})[[:space:]]+=" "$ENV_FILE" 2>/dev/null || \
     grep -q -E "^(${MANAGED_KEYS_REGEX})=[[:space:]]+" "$ENV_FILE" 2>/dev/null; then
    log_error "Whitespace detected around '=' for managed keys in ${ENV_FILE}."
    log_error "Configuration keys must use simple 'KEY=value' format without spaces around '='."
    exit 1
  fi

  # 4. Reject quotes on managed keys
  if grep -q -E "^(${MANAGED_KEYS_REGEX})=[\"']" "$ENV_FILE" 2>/dev/null; then
    log_error "Quoted value detected on a managed key in ${ENV_FILE}."
    log_error "Managed keys must use simple unquoted 'KEY=value' format."
    exit 1
  fi

  # 5. Reject inline comments on managed keys
  if grep -q -E "^(${MANAGED_KEYS_REGEX})=.*#" "$ENV_FILE" 2>/dev/null; then
    log_error "Inline comment ('#') detected on a managed key in ${ENV_FILE}."
    log_error "Managed keys must use simple 'KEY=value' format without inline comments."
    exit 1
  fi

  # Ensure existing .env ends with a trailing newline before appending new keys
  if [ -s "$ENV_FILE" ]; then
    LAST_CHAR=$(tail -c 1 "$ENV_FILE" 2>/dev/null || echo "")
    if [ -n "$LAST_CHAR" ]; then
      echo "" >> "$ENV_FILE"
    fi
  fi

  # Idempotently ensure missing required keys are appended without touching existing keys
  ensure_env_key() {
    local key="$1"
    local default_val="$2"
    if ! grep -q -E "^${key}=" "$ENV_FILE" 2>/dev/null; then
      log_warn "Adding missing configuration key: $key"
      echo "${key}=${default_val}" >> "$ENV_FILE"
    fi
  }

  if ! grep -q -E "^APP_ENCRYPTION_KEY=" "$ENV_FILE" 2>/dev/null; then
    ensure_env_key "APP_ENCRYPTION_KEY" "$(openssl rand -hex 32)"
  fi

  if ! grep -q -E "^DEPLOY_TOKEN=" "$ENV_FILE" 2>/dev/null; then
    ensure_env_key "DEPLOY_TOKEN" "$(openssl rand -hex 24)"
  fi

  if ! grep -q -E "^POSTGRES_ROOT_PASSWORD=" "$ENV_FILE" 2>/dev/null; then
    ensure_env_key "POSTGRES_ROOT_PASSWORD" "$(openssl rand -hex 24)"
  fi

  ensure_env_key "DATA_DIR" "/var/lib/explita"
  ensure_env_key "PORT" "39756"
  ensure_env_key "HOST" "0.0.0.0"
  ensure_env_key "LOG_INFO" "false"
  ensure_env_key "IMAGE_RETENTION_LIMIT" "3"
  ensure_env_key "CRON_HISTORY_LIMIT" "50"
  ensure_env_key "MAX_REQUEST_BODY_SIZE" "100MB"
  ensure_env_key "REDIS_ENABLED" "false"
  ensure_env_key "TUNNEL_ENABLED" "true"
fi

# Check and reject duplicate definitions for all managed keys
for key in APP_ENCRYPTION_KEY DEPLOY_TOKEN POSTGRES_ROOT_PASSWORD PORT DATA_DIR HOST LOG_INFO MAX_REQUEST_BODY_SIZE IMAGE_RETENTION_LIMIT CRON_HISTORY_LIMIT REDIS_ENABLED TUNNEL_ENABLED; do
  COUNT=$(grep -c -E "^${key}=" "$ENV_FILE" 2>/dev/null || echo 0)
  if [ "$COUNT" -gt 1 ]; then
    log_error "Duplicate configuration key detected: '${key}' appears ${COUNT} times in ${ENV_FILE}."
    log_error "Please remove duplicate entries in ${ENV_FILE} so runtime behavior is unambiguous."
    exit 1
  fi
done

# Validate critical secrets are non-empty and well-formed
for key in APP_ENCRYPTION_KEY DEPLOY_TOKEN POSTGRES_ROOT_PASSWORD; do
  VAL=$(get_env_val "$key")
  if [ -z "$VAL" ]; then
    log_error "Configuration validation failed: '${key}' in ${ENV_FILE} is missing or empty."
    exit 1
  fi
done

ENC_KEY_VAL=$(get_env_val "APP_ENCRYPTION_KEY")
if ! [[ "$ENC_KEY_VAL" =~ ^[0-9a-fA-F]{64}$ ]]; then
  log_error "Configuration validation failed: APP_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)."
  log_error "Generate a valid key using: openssl rand -hex 32"
  exit 1
fi

TOKEN_VAL=$(get_env_val "DEPLOY_TOKEN")
if [ ${#TOKEN_VAL} -lt 16 ]; then
  log_error "Configuration validation failed: DEPLOY_TOKEN in ${ENV_FILE} must be at least 16 characters."
  exit 1
fi

DB_PASS_VAL=$(get_env_val "POSTGRES_ROOT_PASSWORD")
if [[ "$DB_PASS_VAL" =~ [[:space:]] ]]; then
  log_error "Configuration validation failed: POSTGRES_ROOT_PASSWORD must not contain whitespace."
  exit 1
fi

# Validate server PORT early before building or starting process manager
ACTIVE_PORT=$(get_env_val "PORT")
if [[ ! "$ACTIVE_PORT" =~ ^[0-9]{1,5}$ ]]; then
  log_error "Invalid PORT in ${ENV_FILE}: '${ACTIVE_PORT}'. Must be a numeric value between 1 and 65535."
  exit 1
fi

ACTIVE_PORT=$((10#$ACTIVE_PORT))

if (( ACTIVE_PORT < 1 || ACTIVE_PORT > 65535 )); then
  log_error "PORT in ${ENV_FILE} must be between 1 and 65535 (got: ${ACTIVE_PORT})."
  exit 1
fi

# Validate remaining numeric configuration settings
for num_key in IMAGE_RETENTION_LIMIT CRON_HISTORY_LIMIT; do
  num_val=$(get_env_val "$num_key")
  if [ -n "$num_val" ]; then
    if [[ ! "$num_val" =~ ^[0-9]{1,5}$ ]]; then
      log_error "Configuration validation failed: ${num_key} in ${ENV_FILE} must be a non-negative integer (got: '${num_val}')."
      exit 1
    fi
  fi
done

ACTIVE_TOKEN="$TOKEN_VAL"

if [ "$TARGET_USER" != "root" ] && id "$TARGET_USER" &>/dev/null; then
  if ! chown "$TARGET_USER:$TARGET_GROUP" "$ENV_FILE"; then
    log_error "Failed to set file ownership of ${ENV_FILE} to ${TARGET_USER}:${TARGET_GROUP}."
    exit 1
  fi
fi
chmod 600 "$ENV_FILE"

# ------------------------------------------------------------------------------
# 11. Install Dependencies & Build Explita Deploy Server
# ------------------------------------------------------------------------------
log_info "Installing dependencies..."
if [ "${ALLOW_LOCKFILE_FALLBACK:-false}" = "true" ]; then
  if ! run_as_target pnpm install --frozen-lockfile --silent 2>/dev/null; then
    log_warn "ALLOW_LOCKFILE_FALLBACK=true: Frozen lockfile check skipped. Installing via standard pnpm install..."
    run_as_target pnpm install --silent
  fi
else
  run_as_target pnpm install --frozen-lockfile --silent
fi
log_info "Building Explita Deploy server..."
run_as_target pnpm build
log_success "Build completed successfully."

# ------------------------------------------------------------------------------
# 12. PM2 Process Management (User-Aware, Idempotent start / reload)
# ------------------------------------------------------------------------------
if [ ! -f "$DEPLOY_DIR/ecosystem.config.cjs" ]; then
  log_error "PM2 ecosystem.config.cjs missing in ${DEPLOY_DIR}."
  exit 1
fi

log_info "Managing server process via PM2 (service user: ${BOLD}${TARGET_USER}${NC})..."

# If an old process was started under root and TARGET_USER is different, handle migration safely
if [ "$TARGET_USER" != "root" ] && pm2 describe explita-deploy >/dev/null 2>&1; then
  log_warn "Detected legacy 'explita-deploy' registered in root's PM2 process list."
  if [ "${CLEANUP_ROOT_PM2:-false}" = "true" ]; then
    log_info "CLEANUP_ROOT_PM2=true: Migrating 'explita-deploy' from root PM2 to '${TARGET_USER}'..."
    if pm2 delete explita-deploy >/dev/null 2>&1 && pm2 save >/dev/null 2>&1; then
      log_success "Migrated 'explita-deploy': removed from root PM2 and updated root process list."
    else
      log_warn "Failed to remove 'explita-deploy' from root PM2. Check manually with 'sudo pm2 status'."
    fi
  else
    log_warn "Stopping root's instance temporarily to free port ${ACTIVE_PORT} for service user '${TARGET_USER}'."
    pm2 stop explita-deploy >/dev/null 2>&1 || true
    log_warn "Root's saved PM2 configuration was preserved to protect other root-managed applications."
    log_warn "To permanently remove from root PM2, run: sudo pm2 delete explita-deploy && sudo pm2 save"
    log_warn "Or rerun the setup script with: CLEANUP_ROOT_PM2=true"
  fi
fi

if run_as_target pm2 describe explita-deploy >/dev/null 2>&1; then
  log_info "Reloading existing explita-deploy PM2 process..."
  run_as_target pm2 reload ecosystem.config.cjs --update-env >/dev/null
  if ! run_as_target pm2 save >/dev/null; then
    log_error "Failed to save PM2 process state for '${TARGET_USER}'."
    exit 1
  fi
  log_success "PM2 process 'explita-deploy' reloaded with updated build."
else
  log_info "Starting explita-deploy in PM2..."
  run_as_target pm2 start ecosystem.config.cjs >/dev/null
  if ! run_as_target pm2 save >/dev/null; then
    log_error "Failed to save PM2 process state for '${TARGET_USER}'."
    exit 1
  fi
  log_success "PM2 process 'explita-deploy' started."
fi

# Configure PM2 startup service using PM2's supported systemd integration
SERVICE_UNIT="pm2-${TARGET_USER}"
if command -v systemctl &>/dev/null; then
  log_info "Configuring PM2 startup integration for '${TARGET_USER}'..."
  if ! env PATH="$PATH" pm2 startup systemd -u "$TARGET_USER" --hp "$TARGET_HOME" >/dev/null; then
    log_error "PM2 startup integration failed. Check PM2 installation and systemd."
    exit 1
  fi

  systemctl daemon-reload
  if ! systemctl cat "$SERVICE_UNIT" >/dev/null 2>&1; then
    log_error "Expected PM2 systemd unit '${SERVICE_UNIT}' was not found after running pm2 startup."
    exit 1
  fi

  if ! systemctl enable "$SERVICE_UNIT" >/dev/null 2>&1; then
    log_error "Failed to enable systemd unit '${SERVICE_UNIT}'."
    exit 1
  fi

  # Verify systemd service can start and manage the unit
  if ! systemctl start "$SERVICE_UNIT" >/dev/null 2>&1; then
    log_error "Failed to start PM2 systemd service '${SERVICE_UNIT}'. Check 'journalctl -u ${SERVICE_UNIT}'."
    exit 1
  fi

  if ! systemctl is-enabled "$SERVICE_UNIT" &>/dev/null; then
    log_error "Verification failed: PM2 service '${SERVICE_UNIT}' is not enabled in systemd."
    exit 1
  fi
  log_success "PM2 systemd service '${SERVICE_UNIT}' is enabled and running."
else
  log_warn "systemd not detected. Skipping systemd reboot service configuration."
fi

# ------------------------------------------------------------------------------
# 13. Verify Service Health Check
# ------------------------------------------------------------------------------
SERVER_IP=$(curl -4s --max-time 2 https://api.ipify.org 2>/dev/null || curl -4s --max-time 2 https://ifconfig.me 2>/dev/null || echo "YOUR_VPS_IP")

if ! run_as_target pm2 describe explita-deploy >/dev/null 2>&1; then
  log_error "Explita Deploy failed to register in PM2."
  exit 1
fi

log_info "Verifying service health on port ${ACTIVE_PORT}..."
HEALTHY=false
for i in {1..20}; do
  if curl -fsS --max-time 2 "http://127.0.0.1:${ACTIVE_PORT}/health" >/dev/null 2>&1; then
    HEALTHY=true
    break
  fi
  sleep 1
done

if [ "$HEALTHY" = true ]; then
  log_success "Explita Deploy is responsive and healthy on http://127.0.0.1:${ACTIVE_PORT}."
else
  log_error "Server process was started in PM2, but failed health check on http://127.0.0.1:${ACTIVE_PORT}/health within 20s."
  if [ "$TARGET_USER" = "root" ]; then
    log_error "Check live logs with: pm2 logs explita-deploy"
  else
    log_error "Check live logs with: pm2 logs explita-deploy (or: sudo -u ${TARGET_USER} -H pm2 logs)"
  fi
  exit 1
fi

# ------------------------------------------------------------------------------
# 14. Installation Summary & Connection Instructions
# ------------------------------------------------------------------------------
DEPLOY_DOMAIN=$(get_env_val "DEPLOY_DOMAIN")
if [ -n "$DEPLOY_DOMAIN" ]; then
  DISPLAY_URL="https://${DEPLOY_DOMAIN}"
  ENDPOINT_LABEL="Server URL     "
else
  DISPLAY_URL="http://${SERVER_IP}:${ACTIVE_PORT}"
  ENDPOINT_LABEL="Direct Endpoint"
fi

echo ""
echo -e "${GREEN}${BOLD}================================================================${NC}"
echo -e "${GREEN}${BOLD}      Explita Deploy Host Server Setup Complete!                ${NC}"
echo -e "${GREEN}${BOLD}================================================================${NC}"
echo ""
echo -e "Status         : ${GREEN}Active & Healthy (PM2: explita-deploy, user: ${TARGET_USER})${NC}"
echo -e "Server Port    : ${BOLD}${ACTIVE_PORT}${NC}"
echo -e "${ENDPOINT_LABEL}: ${BOLD}${DISPLAY_URL}${NC}"
echo -e "Storage Dir    : /var/lib/explita"
echo -e "Release        : ${BOLD}commit ${COMMIT_HASH}${NC}"

if [ "$IS_FIRST_INSTALL" = true ]; then
  echo -e "Auth Token     : ${YELLOW}${BOLD}${ACTIVE_TOKEN}${NC}  ${DIM}(Displayed once on initial setup — store securely!)${NC}"
else
  echo -e "Auth Token     : ${BOLD}••••••••••••••••••••••••${NC}  ${DIM}(Preserved in ${ENV_FILE})${NC}"
fi

echo ""
echo -e "${BOLD}Connect From Your Local Developer Machine:${NC}"
echo -e "  eda config set server ${DISPLAY_URL}"
if [ "$IS_FIRST_INSTALL" = true ]; then
  echo -e "  eda config set token ${ACTIVE_TOKEN}"
else
  echo -e "  eda config set token <your-token-from-.env>"
fi
echo ""
echo -e "${BOLD}Server Maintenance Commands (Run on VPS as '${TARGET_USER}'):${NC}"
echo -e "  pm2 logs explita-deploy     # View live server logs"
echo -e "  pm2 restart explita-deploy  # Restart server process"
echo -e "  pm2 status                  # Check process status"
echo ""
echo -e "${BLUE}[INFO]${NC} This script is idempotent: you can rerun it anytime to apply updates safely."
echo ""
