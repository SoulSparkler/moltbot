#!/usr/bin/env bash
set -euo pipefail

# Force OpenClaw to use /data as HOME
export HOME=/data

: "${OPENCLAW_CONFIG_PATH:=${HOME}/.clawdbot/openclaw.json}"

# Railway requires binding to all interfaces (0.0.0.0)
# Default to 'lan' bind mode unless explicitly set
: "${OPENCLAW_GATEWAY_BIND:=lan}"

# Use PORT env var from Railway if set, otherwise default to 8080
: "${OPENCLAW_GATEWAY_PORT:=${PORT:-8080}}"

# Generate a random auth token if binding to LAN and no token is configured
if [ "${OPENCLAW_GATEWAY_BIND}" != "loopback" ] && [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)
  echo "=========================================="
  echo "⚠️  GATEWAY AUTH TOKEN (for Control UI)"
  echo "=========================================="
  echo "Token: ${OPENCLAW_GATEWAY_TOKEN}"
  echo "Paste this token in Control UI settings or use: jannetje.up.railway.app?token=${OPENCLAW_GATEWAY_TOKEN}"
  echo "=========================================="
fi

export OPENCLAW_GATEWAY_BIND
export OPENCLAW_GATEWAY_PORT
if [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  export OPENCLAW_GATEWAY_TOKEN
fi

# Create directories
mkdir -p /data/.clawdbot /data/workspace 2>/dev/null || true

# Run the entrypoint command
exec "$@"
