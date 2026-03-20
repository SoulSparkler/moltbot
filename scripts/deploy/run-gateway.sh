#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${OPENCLAW_STATE_DIR}/openclaw.json}"
OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-${OPENCLAW_STATE_DIR}/workspace}"
OPENCLAW_LOG_DIR="${OPENCLAW_LOG_DIR:-${OPENCLAW_STATE_DIR}/logs}"
CLAWDBOT_STATE_DIR="${CLAWDBOT_STATE_DIR:-${OPENCLAW_STATE_DIR}}"
MOLTBOT_STATE_DIR="${MOLTBOT_STATE_DIR:-${OPENCLAW_STATE_DIR}}"
RSS_STATE_PATH="${RSS_STATE_PATH:-${OPENCLAW_STATE_DIR}/state/etsy_rss.json}"
OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
OPENCLAW_GATEWAY_BIND="${OPENCLAW_GATEWAY_BIND:-lan}"

export OPENCLAW_STATE_DIR
export OPENCLAW_CONFIG_PATH
export OPENCLAW_WORKSPACE_DIR
export OPENCLAW_LOG_DIR
export CLAWDBOT_STATE_DIR
export MOLTBOT_STATE_DIR
export RSS_STATE_PATH
export OPENCLAW_GATEWAY_PORT
export OPENCLAW_GATEWAY_BIND

if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
  echo "[deploy] OPENCLAW_GATEWAY_TOKEN is required." >&2
  exit 1
fi

mkdir -p "$OPENCLAW_STATE_DIR" "$OPENCLAW_LOG_DIR" "$OPENCLAW_WORKSPACE_DIR" "$(dirname "$RSS_STATE_PATH")"

if [[ ! -f "$OPENCLAW_CONFIG_PATH" ]]; then
  echo "[deploy] Missing config: $OPENCLAW_CONFIG_PATH" >&2
  echo "[deploy] Copy deploy/digitalocean/openclaw.example.json5 to that path before starting the gateway." >&2
  exit 1
fi

echo "[deploy] Gateway config path: $OPENCLAW_CONFIG_PATH"
echo "[deploy] Gateway state dir: $OPENCLAW_STATE_DIR"
echo "[deploy] Gateway default workspace: $OPENCLAW_WORKSPACE_DIR"
echo "[deploy] Gateway bind=${OPENCLAW_GATEWAY_BIND} port=${OPENCLAW_GATEWAY_PORT}"

if [[ "$#" -eq 0 ]]; then
  set -- gateway run
fi

exec node /app/openclaw.mjs "$@" \
  --bind "$OPENCLAW_GATEWAY_BIND" \
  --port "$OPENCLAW_GATEWAY_PORT" \
  --token "$OPENCLAW_GATEWAY_TOKEN"
