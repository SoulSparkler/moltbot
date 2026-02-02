#!/usr/bin/env bash
set -euo pipefail

# Force OpenClaw to use /data as HOME
export HOME=/data

: "${OPENCLAW_CONFIG_PATH:=${HOME}/.clawdbot/openclaw.json}"

# Use PORT env var from Railway if set, otherwise default to 8080
: "${OPENCLAW_GATEWAY_PORT:=${PORT:-8080}}"

export OPENCLAW_GATEWAY_PORT

# Create directories
mkdir -p /data/.clawdbot /data/workspace 2>/dev/null || true

# Generate a gateway token if not already set (required for non-loopback binding)
# This token is used internally for the healthcheck and can be overridden via env
if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
    # Check if we have a persisted token in config
    if [ -f "$OPENCLAW_CONFIG_PATH" ]; then
        PERSISTED_TOKEN=$(node -e "try{const c=require('$OPENCLAW_CONFIG_PATH');console.log(c.gateway?.auth?.token||'')}catch{}" 2>/dev/null || true)
        if [ -n "$PERSISTED_TOKEN" ]; then
            export OPENCLAW_GATEWAY_TOKEN="$PERSISTED_TOKEN"
        fi
    fi
    # If still no token, generate one
    if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
        export OPENCLAW_GATEWAY_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)
        echo "Generated gateway token for Railway deployment"
    fi
fi

# Run the entrypoint command
exec "$@"
