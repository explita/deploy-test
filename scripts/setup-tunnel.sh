#!/usr/bin/env bash
# ==============================================================================
# Explita Deploy - Automated Preview Tunnel Provisioning Script
# ==============================================================================
# Configures Explita Tunnel authorization (TUNNEL_TOKEN) for automated branch &
# preview deployments. Requests OTP verification from Explita Tunnel and saves
# the verified token directly into the Explita Deploy .env configuration.
#
# Usage:
#   # 1. Interactive wizard (prompts for email & 6-digit OTP code)
#   sudo bash scripts/setup-tunnel.sh
#
#   # 2. Direct email request (prompts only for OTP)
#   sudo bash scripts/setup-tunnel.sh --email user@example.com
#
#   # 3. Direct token assignment (bypasses OTP)
#   sudo bash scripts/setup-tunnel.sh --token exp_live_...
#
#   # 4. Standalone remote execution on any Explita Deploy VPS
#   curl -fsSL https://raw.githubusercontent.com/explita/deploy-server/main/scripts/setup-tunnel.sh | sudo bash
# ==============================================================================

set -euo pipefail
umask 077

# Terminal colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m' # No Color

log_info() {
  echo -e "${BLUE}[INFO]${NC} $1" >&2
}

log_success() {
  echo -e "${GREEN}[SUCCESS]${NC} $1" >&2
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1" >&2
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1" >&2
}

print_help() {
  echo -e "${BOLD}Explita Deploy - Tunnel Provisioning Script${NC}"
  echo ""
  echo "Usage:"
  echo "  sudo bash scripts/setup-tunnel.sh [options]"
  echo ""
  echo "Options:"
  echo "  -a, --auto              Auto-request instant token via server IP (zero config)"
  echo "  -e, --email <email>     Email address to authorize with Explita Tunnel"
  echo "  -o, --otp <6-digit>     Verification code sent to email (alias: -v, --verify)"
  echo "  -t, --token <token>     Save a pre-existing tunnel token (bypasses OTP)"
  echo "  -s, --server <url>      Custom tunnel server URL (default: https://tunnel.explita.ng)"
  echo "  -h, --help              Show this help message"
  echo ""
  echo "Examples:"
  echo "  sudo bash scripts/setup-tunnel.sh"
  echo "  sudo bash scripts/setup-tunnel.sh --auto"
  echo "  sudo bash scripts/setup-tunnel.sh -e developer@example.com"
  echo "  sudo bash scripts/setup-tunnel.sh -e developer@example.com -o 123456"
  echo "  sudo bash scripts/setup-tunnel.sh --token exp_live_..."
  echo ""
}

# ------------------------------------------------------------------------------
# 1. Require Root / Sudo Privileges
# ------------------------------------------------------------------------------
if [ "$EUID" -ne 0 ]; then
  log_error "Please run this script with root privileges (e.g. sudo bash scripts/setup-tunnel.sh)"
  exit 1
fi

TARGET_USER="${SUDO_USER:-$USER}"
TARGET_GROUP="$(id -gn "$TARGET_USER" 2>/dev/null || echo "$TARGET_USER")"

# Helper to run commands as TARGET_USER (for PM2 interaction)
run_as_target() {
  if [ "$TARGET_USER" = "root" ]; then
    "$@"
  else
    sudo -u "$TARGET_USER" -H "$@"
  fi
}

# ------------------------------------------------------------------------------
# 2. Parse Command Line Arguments
# ------------------------------------------------------------------------------
PARAM_AUTO=false
PARAM_EMAIL=""
PARAM_OTP=""
PARAM_TOKEN=""
PARAM_SERVER="https://tunnel.explita.ng"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -a|--auto)
      PARAM_AUTO=true
      shift
      ;;
    -e|--email)
      PARAM_EMAIL="${2:-}"
      shift 2
      ;;
    -o|--otp|-v|--verify)
      PARAM_OTP="${2:-}"
      shift 2
      ;;
    -t|--token)
      PARAM_TOKEN="${2:-}"
      shift 2
      ;;
    -s|--server)
      PARAM_SERVER="${2:-}"
      shift 2
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      log_error "Unknown option: $1"
      echo "Run 'bash scripts/setup-tunnel.sh --help' for available options."
      exit 1
      ;;
  esac
done

# Normalize server URL to HTTP/HTTPS base
PARAM_SERVER="${PARAM_SERVER%/}"
if [[ "$PARAM_SERVER" == wss://* ]]; then
  PARAM_SERVER="https://${PARAM_SERVER#wss://}"
elif [[ "$PARAM_SERVER" == ws://* ]]; then
  PARAM_SERVER="http://${PARAM_SERVER#ws://}"
fi
PARAM_SERVER="${PARAM_SERVER%/_connect}"

# Enforce HTTPS by default (HTTP strictly permitted for local development only)
if [[ "$PARAM_SERVER" == http://* ]]; then
  if ! [[ "$PARAM_SERVER" =~ ^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?(/.*)?$ ]]; then
    log_error "Plain HTTP is only permitted for local development (localhost / 127.0.0.1)."
    log_error "External tunnel servers must use HTTPS for transport encryption: ${PARAM_SERVER}"
    exit 1
  fi
elif [[ "$PARAM_SERVER" == https://* ]]; then
  if ! [[ "$PARAM_SERVER" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]{1,5})?(/.*)?$ ]]; then
    log_error "Invalid HTTPS tunnel server URL: '${PARAM_SERVER}'"
    exit 1
  fi
else
  log_error "Invalid tunnel server URL: '${PARAM_SERVER}'. Protocol must be https:// (or http:// for localhost)."
  exit 1
fi

# ------------------------------------------------------------------------------
# 3. Locate and Protect Target .env File
# ------------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-}")" 2>/dev/null && pwd || echo "")"
DEFAULT_INSTALL_DIR="/opt/explita/deploy"

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/../package.json" ]; then
  DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
elif [ -f "./package.json" ]; then
  DEPLOY_DIR="$(pwd)"
elif [ -d "$DEFAULT_INSTALL_DIR" ]; then
  DEPLOY_DIR="$DEFAULT_INSTALL_DIR"
else
  DEPLOY_DIR="$(pwd)"
fi

ENV_FILE="$DEPLOY_DIR/.env"

if [ ! -f "$ENV_FILE" ] || [ -L "$ENV_FILE" ]; then
  log_error ".env configuration must be a regular file, not a symlink (checked at: ${ENV_FILE})."
  log_error "Please run this script inside your Explita Deploy installation directory."
  exit 1
fi

# Ensure existing .env has secure permissions while preserving service user ownership
if [ "$TARGET_USER" != "root" ] && id "$TARGET_USER" &>/dev/null; then
  chown "$TARGET_USER:$TARGET_GROUP" "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"

# ------------------------------------------------------------------------------
# 4. Secure Temporary Files Cleanup Trap
# ------------------------------------------------------------------------------
REQ_FILE=""
VERIFY_FILE=""
TMP_ENV_FILE=""

cleanup() {
  rm -f "${REQ_FILE:-}" "${VERIFY_FILE:-}" "${TMP_ENV_FILE:-}"
}
trap cleanup EXIT

# ------------------------------------------------------------------------------
# 5. Helper Functions
# ------------------------------------------------------------------------------
has_tty() {
  [ -t 0 ] || { [ -c /dev/tty ] && (: < /dev/tty) 2>/dev/null; }
}

read_input() {
  local prompt_text="$1"
  local var_name="$2"
  if [ -c /dev/tty ] && (: < /dev/tty) 2>/dev/null; then
    read -r -p "$prompt_text" "${var_name?}" < /dev/tty
  else
    read -r -p "$prompt_text" "${var_name?}"
  fi
}

read_secret() {
  local prompt_text="$1"
  local var_name="$2"
  if [ -c /dev/tty ] && (: < /dev/tty) 2>/dev/null; then
    read -r -s -p "$prompt_text" "${var_name?}" < /dev/tty
  else
    read -r -s -p "$prompt_text" "${var_name?}"
  fi
  echo ""
}

get_env_val() {
  local key="$1"
  local line
  line=$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -n 1 | tr -d '\r' || echo "")
  if [ -z "$line" ]; then
    echo ""
    return 0
  fi
  local val="${line#*=}"
  if [[ "$val" =~ ^\"(.*)\"$ ]] || [[ "$val" =~ ^\'(.*)\'$ ]]; then
    val="${BASH_REMATCH[1]}"
  fi
  echo "$val"
}

# Safely encode key-value pairs into valid JSON using native JSON serializer
encode_json_payload() {
  if command -v node &>/dev/null; then
    node -e '
      const args = process.argv.slice(1);
      const obj = {};
      for (let i = 0; i < args.length; i += 2) {
        obj[args[i]] = args[i + 1];
      }
      process.stdout.write(JSON.stringify(obj));
    ' "$@"
  elif command -v python3 &>/dev/null; then
    python3 -c '
import sys, json
args = sys.argv[1:]
obj = {args[i]: args[i+1] for i in range(0, len(args), 2)}
sys.stdout.write(json.dumps(obj))
' "$@"
  else
    log_error "JSON serialization requires either 'node' or 'python3' on system PATH."
    exit 1
  fi
}

# Safe & Atomic .env update: updates both TUNNEL_TOKEN and TUNNEL_ENABLED in a single atomic mv
safe_save_tunnel_config() {
  local token="$1"

  # Reject duplicate definitions for managed keys before updating
  for key in TUNNEL_TOKEN TUNNEL_ENABLED; do
    local count
    count=$(grep -c -E "^${key}=" "$ENV_FILE" 2>/dev/null || true)
    if [ "$count" -gt 1 ]; then
      log_error "Duplicate configuration key detected: '${key}' appears ${count} times in ${ENV_FILE}."
      log_error "Please remove duplicate entries in ${ENV_FILE} before updating."
      exit 1
    fi
  done

  TMP_ENV_FILE=$(mktemp "${DEPLOY_DIR}/.env.tmp.XXXXXX") || {
    log_error "Failed to create temporary file in ${DEPLOY_DIR}."
    exit 1
  }

  TOKEN_VAL="$token" awk '
    BEGIN {
      token_set = 0;
      enabled_set = 0;
      new_token = ENVIRON["TOKEN_VAL"];
    }
    $0 ~ /^TUNNEL_TOKEN=/ {
      print "TUNNEL_TOKEN=" new_token;
      token_set = 1;
      next;
    }
    $0 ~ /^TUNNEL_ENABLED=/ {
      print "TUNNEL_ENABLED=true";
      enabled_set = 1;
      next;
    }
    { print }
    END {
      if (!token_set) {
        print "TUNNEL_TOKEN=" new_token;
      }
      if (!enabled_set) {
        print "TUNNEL_ENABLED=true";
      }
    }
  ' "$ENV_FILE" > "$TMP_ENV_FILE"

  if [ "$TARGET_USER" != "root" ] && id "$TARGET_USER" &>/dev/null; then
    chown "$TARGET_USER:$TARGET_GROUP" "$TMP_ENV_FILE"
  fi
  chmod 600 "$TMP_ENV_FILE"

  # Atomic replacement: replaces original .env in a single filesystem operation
  mv -f "$TMP_ENV_FILE" "$ENV_FILE"
  TMP_ENV_FILE=""
}

# Cross-platform JSON field extractor (Node -> Python3 -> regex)
extract_json_field() {
  local json="$1"
  local field="$2"

  if command -v node &>/dev/null; then
    echo "$json" | node -e "
      const fs = require('fs');
      try {
        const obj = JSON.parse(fs.readFileSync(0, 'utf8'));
        const val = obj['$field'];
        if (val !== undefined && val !== null) {
          process.stdout.write(typeof val === 'object' ? JSON.stringify(val) : String(val));
        }
      } catch (e) {}
    " 2>/dev/null || echo ""
  elif command -v python3 &>/dev/null; then
    echo "$json" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    v = d.get('$field')
    if v is not None:
        sys.stdout.write(json.dumps(v) if isinstance(v, (dict, list)) else str(v))
except Exception:
    pass
" 2>/dev/null || echo ""
  else
    echo "$json" | grep -o "\"$field\":[^,}]*" | head -n 1 | cut -d: -f2- | tr -d ' "' || echo ""
  fi
}

mask_secret() {
  local str="$1"
  local len=${#str}
  if [ "$len" -le 8 ]; then
    echo "••••••••"
  else
    local prefix="${str:0:4}"
    local suffix="${str: -4}"
    echo "${prefix}••••••••••••${suffix}"
  fi
}

validate_tunnel_token() {
  local t="$1"
  # Valid Explita Tunnel tokens: exp_live_<uuid> or exp_<identifier> (allowing alphanumeric, hyphens, and underscores)
  if [[ "$t" =~ ^exp_[a-zA-Z0-9_-]{16,64}$ ]]; then
    return 0
  fi
  return 1
}

# ------------------------------------------------------------------------------
# 6. Check Existing Configuration
# ------------------------------------------------------------------------------
EXISTING_TOKEN=$(get_env_val "TUNNEL_TOKEN")
if [ -n "$EXISTING_TOKEN" ] && [ -z "$PARAM_TOKEN" ] && [ -z "$PARAM_EMAIL" ]; then
  MASKED=$(mask_secret "$EXISTING_TOKEN")
  echo ""
  echo -e "${YELLOW}[!] A tunnel token is already configured in ${ENV_FILE}:${NC}"
  echo -e "    Current Token: ${BOLD}${MASKED}${NC}"
  echo ""
  if ! has_tty; then
    log_info "Non-interactive environment detected with active token. Keeping existing configuration."
    exit 0
  fi
  read_input "Do you want to re-authenticate and replace this token? [y/N]: " REPLACE_CHOICE || REPLACE_CHOICE="n"
  case "$REPLACE_CHOICE" in
    [yY][eE][sS]|[yY])
      log_info "Proceeding to replace existing tunnel token..."
      ;;
    *)
      log_info "Keeping existing configuration. No changes made."
      exit 0
      ;;
  esac
fi

# ------------------------------------------------------------------------------
# 7. Direct Token Mode (Bypasses OTP)
# ------------------------------------------------------------------------------
if [ -n "$PARAM_TOKEN" ]; then
  FINAL_TOKEN=$(echo "$PARAM_TOKEN" | tr -d '[:space:]')
  if ! validate_tunnel_token "$FINAL_TOKEN"; then
    log_error "Invalid tunnel token format. Explita Tunnel tokens start with 'exp_live_' or 'exp_'."
    exit 1
  fi

  safe_save_tunnel_config "$FINAL_TOKEN"
  log_success "TUNNEL_TOKEN and TUNNEL_ENABLED successfully saved to ${ENV_FILE}."

  # Restart PM2 process if active with honest error reporting
  if run_as_target pm2 describe explita-deploy >/dev/null 2>&1; then
    log_info "Reloading Explita Deploy in PM2 to apply new token..."
    if run_as_target pm2 restart explita-deploy --update-env >/dev/null 2>&1; then
      log_success "Explita Deploy process refreshed."
    else
      log_error "Failed to restart Explita Deploy via PM2."
      log_warn "Inspect server logs with: pm2 logs explita-deploy"
      exit 1
    fi
  fi

  echo ""
  echo -e "${GREEN}${BOLD}✨ Explita Tunnel setup complete! Automated preview deployments are active.${NC}"
  echo ""
  exit 0
fi

request_instant_token() {
  local server="$1"
  log_info "Auto-requesting instant tunnel token from ${server} via server IP..."

  local public_ip
  public_ip=$(curl -4s --max-time 3 https://api.ipify.org 2>/dev/null || curl -4s --max-time 3 https://ifconfig.me 2>/dev/null || echo "")

  local machine_id=""
  if [ -f /etc/machine-id ]; then
    machine_id=$(tr -d '[:space:]' < /etc/machine-id 2>/dev/null || echo "")
  fi

  local req_file
  req_file=$(mktemp) || return 1

  local payload
  payload=$(printf '{"ip":"%s","machineId":"%s"}' "$public_ip" "$machine_id")

  local http_code
  http_code=$(curl -fsS --max-time 10 -o "$req_file" -w "%{http_code}" \
    -X POST "${server}/_api/token/issue" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>/dev/null || echo "000")

  local body
  body=$(cat "$req_file" 2>/dev/null || echo "{}")
  rm -f "$req_file"

  if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
    local token
    token=$(extract_json_field "$body" "token")
    if [ -n "$token" ] && validate_tunnel_token "$token"; then
      echo "$token"
      return 0
    fi
  fi
  return 1
}

# ------------------------------------------------------------------------------
# 8. Token Provisioning (Instant IP-based or Email OTP)
# ------------------------------------------------------------------------------
USE_INSTANT=false

if [ "$PARAM_AUTO" = true ]; then
  USE_INSTANT=true
elif [ -z "$PARAM_EMAIL" ] && [ -z "$PARAM_OTP" ]; then
  if ! has_tty; then
    USE_INSTANT=true
  else
    echo ""
    echo -e "${BOLD}Explita Preview Tunnels Setup${NC}"
    echo -e "${DIM}Automated preview URLs allow sharing live branch previews (e.g. app-pr-12-preview.tunnel.explita.ng).${NC}"
    echo ""
    echo "Choose token provisioning method:"
    echo "  1) Instant token via Server IP (Recommended, zero configuration)"
    echo "  2) Email verification (OTP code)"
    echo ""
    read_input "Select option [1/2, default: 1]: " PROV_CHOICE || PROV_CHOICE="1"
    if [ "$PROV_CHOICE" = "2" ]; then
      USE_INSTANT=false
    else
      USE_INSTANT=true
    fi
  fi
fi

VERIFIED_TOKEN=""
TOKEN_SOURCE="Server IP / Machine ID"

if [ "$USE_INSTANT" = true ]; then
  INSTANT_TOKEN=$(request_instant_token "$PARAM_SERVER" || echo "")
  if [ -n "$INSTANT_TOKEN" ]; then
    VERIFIED_TOKEN="$INSTANT_TOKEN"
    log_success "Instant tunnel token successfully retrieved from ${PARAM_SERVER}."
  else
    if [ "$PARAM_AUTO" = true ] || ! has_tty; then
      log_error "Failed to auto-provision instant tunnel token from ${PARAM_SERVER}."
      exit 1
    fi
    log_warn "Instant token provisioning could not reach ${PARAM_SERVER}. Falling back to email OTP..."
    USE_INSTANT=false
  fi
fi

if [ "$USE_INSTANT" = false ]; then
  EMAIL="$PARAM_EMAIL"
  if [ -z "$EMAIL" ]; then
    if ! has_tty; then
      log_error "Interactive TTY required to prompt for email. Pass --email or --token."
      exit 1
    fi
    read_input "Enter your email for tunnel authorization: " EMAIL
    EMAIL=$(echo "$EMAIL" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
  fi

if ! [[ "$EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
  log_error "Invalid email address: '${EMAIL}'"
  exit 1
fi

OTP="$PARAM_OTP"

# Step A: Request OTP if not directly provided
if [ -z "$OTP" ]; then
  log_info "Requesting 6-digit verification code from ${PARAM_SERVER} for ${BOLD}${EMAIL}${NC}..."

  REQUEST_ENDPOINT="${PARAM_SERVER}/_api/token/request-otp"

  # Create secure temporary file in current shell
  REQ_FILE=$(mktemp) || {
    log_error "Failed to create temporary request file."
    exit 1
  }

  REQ_PAYLOAD=$(encode_json_payload "email" "${EMAIL}")

  REQ_HTTP_CODE=$(curl -sS --connect-timeout 10 --max-time 30 -o "$REQ_FILE" -w "%{http_code}" \
    -X POST "$REQUEST_ENDPOINT" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    -d "$REQ_PAYLOAD" 2>/dev/null || echo "000")

  REQ_BODY=$(cat "$REQ_FILE" 2>/dev/null || echo "{}")
  rm -f "$REQ_FILE"
  REQ_FILE=""

  REQ_SUCCESS=$(extract_json_field "$REQ_BODY" "success")
  REQ_ERROR=$(extract_json_field "$REQ_BODY" "error")
  REQ_MESSAGE=$(extract_json_field "$REQ_BODY" "message")

  if [ "$REQ_HTTP_CODE" != "200" ] && [ "$REQ_HTTP_CODE" != "201" ] || [ "$REQ_SUCCESS" != "true" ]; then
    ERR_DETAIL="${REQ_ERROR:-${REQ_MESSAGE:-HTTP ${REQ_HTTP_CODE}}}"
    log_error "Failed to request verification code from tunnel server: ${ERR_DETAIL}"
    exit 1
  fi

  echo ""
  echo -e "${CYAN}📩${NC} ${BOLD}A 6-digit verification code was sent to ${EMAIL}.${NC}"
  echo -e "${DIM}Check your inbox (and spam folder) for your Explita verification code.${NC}"
  echo ""

  if ! has_tty; then
    log_error "Verification code sent, but running in non-interactive environment."
    echo "To complete verification, rerun:"
    echo "  sudo bash scripts/setup-tunnel.sh --email ${EMAIL} --otp <code>"
    exit 1
  fi

  read_input "Enter the 6-digit verification code: " OTP
  OTP=$(echo "$OTP" | tr -d '[:space:]')
fi

# Enforce strict 6-digit numeric OTP format
if [[ ! "$OTP" =~ ^[0-9]{6}$ ]]; then
  log_error "Verification code must be exactly 6 digits (got: '${OTP}')."
  exit 1
fi

# Step B: Verify OTP & Retrieve Token
log_info "Verifying code with tunnel server..."

VERIFY_ENDPOINT="${PARAM_SERVER}/_api/token/verify-otp"

VERIFY_FILE=$(mktemp) || {
  log_error "Failed to create temporary verification file."
  exit 1
}

VERIFY_PAYLOAD=$(encode_json_payload "email" "${EMAIL}" "otp" "${OTP}")

VERIFY_HTTP_CODE=$(curl -sS --connect-timeout 10 --max-time 30 -o "$VERIFY_FILE" -w "%{http_code}" \
  -X POST "$VERIFY_ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d "$VERIFY_PAYLOAD" 2>/dev/null || echo "000")

VERIFY_BODY=$(cat "$VERIFY_FILE" 2>/dev/null || echo "{}")
rm -f "$VERIFY_FILE"
VERIFY_FILE=""

VERIFY_SUCCESS=$(extract_json_field "$VERIFY_BODY" "success")
VERIFIED_TOKEN=$(extract_json_field "$VERIFY_BODY" "token")
VERIFY_ERROR=$(extract_json_field "$VERIFY_BODY" "error")
VERIFY_MESSAGE=$(extract_json_field "$VERIFY_BODY" "message")

if [ "$VERIFY_HTTP_CODE" != "200" ] && [ "$VERIFY_HTTP_CODE" != "201" ] || [ "$VERIFY_SUCCESS" != "true" ] || [ -z "$VERIFIED_TOKEN" ]; then
  ERR_DETAIL="${VERIFY_ERROR:-${VERIFY_MESSAGE:-HTTP ${VERIFY_HTTP_CODE}}}"
  log_error "Verification failed: ${ERR_DETAIL}"
  exit 1
fi

  if ! validate_tunnel_token "$VERIFIED_TOKEN"; then
    log_error "Verification succeeded, but server returned an invalid token format."
    exit 1
  fi
fi

# ------------------------------------------------------------------------------
# 9. Save Configuration safely & atomically into .env
# ------------------------------------------------------------------------------
safe_save_tunnel_config "$VERIFIED_TOKEN"

log_success "Tunnel token verified and saved into ${ENV_FILE}."

# ------------------------------------------------------------------------------
# 10. Refresh PM2 Process If Running (Honest Error Reporting)
# ------------------------------------------------------------------------------
if run_as_target pm2 describe explita-deploy >/dev/null 2>&1; then
  log_info "Reloading Explita Deploy in PM2 to activate tunnel token..."
  if run_as_target pm2 restart explita-deploy --update-env >/dev/null 2>&1; then
    log_success "Explita Deploy reloaded successfully."
  else
    log_error "Failed to reload Explita Deploy in PM2."
    log_warn "Inspect live server logs with: pm2 logs explita-deploy"
    exit 1
  fi
fi

# ------------------------------------------------------------------------------
# 11. Summary Banner
# ------------------------------------------------------------------------------
MASKED_TOKEN=$(mask_secret "$VERIFIED_TOKEN")

echo ""
echo -e "${GREEN}${BOLD}================================================================${NC}"
echo -e "${GREEN}${BOLD}         Explita Preview Tunnels Successfully Activated!         ${NC}"
echo -e "${GREEN}${BOLD}================================================================${NC}"
echo ""
echo -e "Identifier       : ${BOLD}${TOKEN_SOURCE}${NC}"
echo -e "Tunnel Server    : ${BOLD}${PARAM_SERVER}${NC}"
echo -e "Tunnel Token     : ${CYAN}${MASKED_TOKEN}${NC}"
echo -e "Config Location  : ${DIM}${ENV_FILE}${NC}"
echo ""
echo -e "Your remote VPS is now fully authorized to provision public preview URLs"
echo -e "for branches and pull requests automatically upon deployment."
echo ""
