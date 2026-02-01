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

# Trust all proxies for Railway's reverse proxy layer
# Railway sits behind a load balancer so we need to trust proxy headers
: "${OPENCLAW_TRUSTED_PROXIES:=0.0.0.0/0}"

export OPENCLAW_GATEWAY_BIND
export OPENCLAW_GATEWAY_PORT
export OPENCLAW_TRUSTED_PROXIES

# Create directories
mkdir -p /data/.clawdbot /data/workspace 2>/dev/null || true

# Create default config if it doesn't exist or if OPENCLAW_RESET_CONFIG=1
# This enables the gateway for Railway deployment with proper settings
if [ ! -f "$OPENCLAW_CONFIG_PATH" ] || [ "${OPENCLAW_RESET_CONFIG:-}" = "1" ]; then
  cat > "$OPENCLAW_CONFIG_PATH" << 'CONFIGEOF'
{
  "gateway": {
    "mode": "local",
    "controlUi": {
      "dangerouslyDisableDeviceAuth": true
    }
  }
}
CONFIGEOF
  echo "Created default config at $OPENCLAW_CONFIG_PATH"
fi

# Run the entrypoint command
exec "$@"
