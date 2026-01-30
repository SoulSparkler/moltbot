#!/usr/bin/env bash
set -euo pipefail

: "${OPENCLAW_CONFIG_PATH:=/data/.openclaw/openclaw.json}"

# Unlock /data directory (run as root before switching to node user)
# These operations are non-fatal to handle cases where /data is read-only or already configured
mkdir -p /data/.openclaw /data/workspace 2>/dev/null || true
chown -R node:node /data 2>/dev/null || true
chmod -R ug+rwX /data 2>/dev/null || true

# Create minimal config if missing (Railway fresh volume)
if [ ! -f "$OPENCLAW_CONFIG_PATH" ]; then
  echo "No config found at $OPENCLAW_CONFIG_PATH, creating minimal config..."
  mkdir -p "$(dirname "$OPENCLAW_CONFIG_PATH")"
  cat > "$OPENCLAW_CONFIG_PATH" <<'JSON'
{
  "gateway": {
    "mode": "local"
  }
}
JSON
fi


# Railway sets PORT, but openclaw expects OPENCLAW_GATEWAY_PORT or CLAWDBOT_GATEWAY_PORT
# Map Railway's PORT to OPENCLAW_GATEWAY_PORT if not already set
if [ -n "${PORT:-}" ] && [ -z "${OPENCLAW_GATEWAY_PORT:-}" ] && [ -z "${CLAWDBOT_GATEWAY_PORT:-}" ]; then
  export OPENCLAW_GATEWAY_PORT="$PORT"
fi

# Default to 8080 if no port is set
: "${OPENCLAW_GATEWAY_PORT:=8080}"

# Run the gateway server with --allow-unconfigured for Railway deployments
# Switch to node user before executing the gateway
su node -c "node openclaw.mjs gateway --bind 0.0.0.0 --port ${PORT:-8080} --allow-unconfigured"
