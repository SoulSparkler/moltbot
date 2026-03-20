#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-/data/openclaw/state}"
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${OPENCLAW_STATE_DIR}/openclaw.json}"
OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-/data/openclaw/workspace/jannetje}"
OPENCLAW_LOG_DIR="${OPENCLAW_LOG_DIR:-/data/openclaw/logs}"
OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
OPENCLAW_GATEWAY_BIND="${OPENCLAW_GATEWAY_BIND:-lan}"

export OPENCLAW_STATE_DIR
export OPENCLAW_CONFIG_PATH
export OPENCLAW_WORKSPACE_DIR
export OPENCLAW_LOG_DIR
export OPENCLAW_GATEWAY_PORT
export OPENCLAW_GATEWAY_BIND

if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
  echo "[deploy] OPENCLAW_GATEWAY_TOKEN is required." >&2
  exit 1
fi

mkdir -p "$OPENCLAW_STATE_DIR" "$OPENCLAW_LOG_DIR"
mkdir -p "$OPENCLAW_WORKSPACE_DIR"

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
