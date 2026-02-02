#!/usr/bin/env bash
set -euo pipefail

# Force OpenClaw to use /data as HOME
export HOME=/data

# Set state directory explicitly for Railway
export OPENCLAW_STATE_DIR=/data/.openclaw

: "${OPENCLAW_CONFIG_PATH:=${HOME}/.clawdbot/openclaw.json}"

# Railway requires binding to all interfaces (0.0.0.0)
# Default to 'lan' bind mode unless explicitly set
: "${OPENCLAW_GATEWAY_BIND:=lan}"

# Use PORT env var from Railway if set, otherwise default to 8080
: "${OPENCLAW_GATEWAY_PORT:=${PORT:-8080}}"

export OPENCLAW_GATEWAY_BIND
export OPENCLAW_GATEWAY_PORT

# Gateway requires auth when binding to 0.0.0.0 (non-loopback)
# Generate a random token if not provided (for Railway)
if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  export OPENCLAW_GATEWAY_TOKEN="railway-$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  echo "Generated gateway token for Railway deployment" >&2
fi

# Playwright configuration for headless Railway operation
export PLAYWRIGHT_BROWSERS_PATH=/data/playwright-browsers
export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
# Persistent sessions directory
: "${PLAYWRIGHT_CLI_SESSION_DIR:=/data/playwright-sessions}"
export PLAYWRIGHT_CLI_SESSION_DIR
# Downloads directory
export PLAYWRIGHT_DOWNLOADS_PATH=/data/playwright-downloads

# Create directories
mkdir -p /data/.openclaw /data/.clawdbot /data/workspace 2>/dev/null || true

# Run the entrypoint command
exec "$@"
