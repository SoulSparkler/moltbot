#!/usr/bin/env bash
set -euo pipefail

# Force OpenClaw to use /data as HOME
export HOME=/data

# Config path follows OpenClaw convention: ~/.openclaw/openclaw.json
: "${OPENCLAW_CONFIG_PATH:=${HOME}/.openclaw/openclaw.json}"
export OPENCLAW_CONFIG_PATH

# Use PORT env var from Railway if set, otherwise default to 8080
: "${OPENCLAW_GATEWAY_PORT:=${PORT:-8080}}"
export OPENCLAW_GATEWAY_PORT

# Create directories
mkdir -p /data/.openclaw /data/workspace 2>/dev/null || true

# Generate a gateway token if not already set (required for non-loopback binding)
if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
    # Check if we have a persisted token in config
    if [ -f "$OPENCLAW_CONFIG_PATH" ]; then
        PERSISTED_TOKEN=$(node -e "try{const c=JSON.parse(require('fs').readFileSync('$OPENCLAW_CONFIG_PATH','utf8'));console.log(c.gateway?.auth?.token||'')}catch(e){}" 2>/dev/null || true)
        if [ -n "$PERSISTED_TOKEN" ]; then
            export OPENCLAW_GATEWAY_TOKEN="$PERSISTED_TOKEN"
            echo "[entrypoint] Using persisted gateway token from config"
        fi
    fi
    # If still no token, generate one
    if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
        export OPENCLAW_GATEWAY_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)
        echo "[entrypoint] Generated gateway token for Railway deployment"
    fi
fi

echo "[entrypoint] Token: ${OPENCLAW_GATEWAY_TOKEN:0:8}..."
echo "[entrypoint] Port: $OPENCLAW_GATEWAY_PORT"

# If first arg is "gateway", run it directly with our configured options
if [ "${1:-}" = "gateway" ] || [ "${1:-}" = "node" ]; then
    echo "[entrypoint] Running gateway with explicit bind=lan and token"

    # Force bind mode in config
    echo "[entrypoint] Writing gateway.bind=lan to config..."
    node -e "
const fs = require('fs');
const configPath = '$OPENCLAW_CONFIG_PATH';
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
cfg.gateway = cfg.gateway || {};
cfg.gateway.bind = 'lan';
cfg.gateway.mode = 'local';
cfg.gateway.auth = cfg.gateway.auth || {};
cfg.gateway.auth.token = '$OPENCLAW_GATEWAY_TOKEN';
// Remove invalid key from previous deployment
delete cfg.gateway.customBindHost;
fs.mkdirSync(require('path').dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
console.log('[entrypoint] Config written:', JSON.stringify(cfg.gateway, null, 2));
"

    exec node /app/openclaw.mjs gateway run \
        --bind lan \
        --token "$OPENCLAW_GATEWAY_TOKEN" \
        --port "$OPENCLAW_GATEWAY_PORT" \
        --allow-unconfigured \
        --verbose
fi

# Otherwise run whatever was passed
echo "[entrypoint] Running: $@"
exec "$@"
