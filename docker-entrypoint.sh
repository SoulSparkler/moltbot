#!/usr/bin/env bash
set -euo pipefail

# Force OpenClaw to use /data as HOME (Railway volume)
export HOME=/data

: "${OPENCLAW_CONFIG_PATH:=${HOME}/.openclaw/openclaw.json}"

# Unlock /data directory (run as root before switching to node user)
# These operations are non-fatal to handle cases where /data is read-only or already configured
mkdir -p /data/.openclaw /data/workspace 2>/dev/null || true
chown -R node:node /data 2>/dev/null || true
chmod -R ug+rwX /data 2>/dev/null || true

# Create minimal config if missing (Railway fresh volume)
# Run as root to handle volume permissions, then exec as node
if [ ! -f "$OPENCLAW_CONFIG_PATH" ]; then
  echo "No config found at $OPENCLAW_CONFIG_PATH, creating minimal config..."
  mkdir -p "$(dirname "$OPENCLAW_CONFIG_PATH")"
  cat > "$OPENCLAW_CONFIG_PATH" <<'JSON'
{
  "gateway": {
    "mode": "local",
    "bind": "lan"
  }
}
JSON
fi

# Ensure node user can write to data dir (Railway mounts volume with root ownership)
chown -R node:node /data

# Railway sets PORT, but openclaw expects OPENCLAW_GATEWAY_PORT or CLAWDBOT_GATEWAY_PORT
# Map Railway's PORT to OPENCLAW_GATEWAY_PORT if not already set
if [ -n "${PORT:-}" ] && [ -z "${OPENCLAW_GATEWAY_PORT:-}" ] && [ -z "${CLAWDBOT_GATEWAY_PORT:-}" ]; then
  export OPENCLAW_GATEWAY_PORT="$PORT"
fi

# Default to 8080 if no port is set
: "${OPENCLAW_GATEWAY_PORT:=8080}"

# Start a tiny healthcheck server (runs in background)
node -e 'require("http").createServer((_,res)=>res.end("ok")).listen(process.env.PORT)' &

# Ensure gateway process receives config path explicitly
export OPENCLAW_CONFIG_PATH

# Run the gateway server in lan mode for Railway deployments
# "lan" mode binds to 0.0.0.0 making the service reachable from Railway proxy
exec su node -c "HOME=$HOME node openclaw.mjs gateway run --bind lan --port $OPENCLAW_GATEWAY_PORT --allow-unconfigured"
