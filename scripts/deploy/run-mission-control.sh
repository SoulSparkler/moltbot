#!/usr/bin/env bash
set -euo pipefail

MISSION_CONTROL_HOST="${MISSION_CONTROL_HOST:-0.0.0.0}"
MISSION_CONTROL_PORT="${MISSION_CONTROL_PORT:-3021}"
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-/data/openclaw/state/openclaw.json}"

export MISSION_CONTROL_HOST
export MISSION_CONTROL_PORT
export OPENCLAW_CONFIG_PATH

if [[ -z "${OPENCLAW_MISSION_CONTROL_GATEWAY_URL:-}" ]]; then
  echo "[deploy] OPENCLAW_MISSION_CONTROL_GATEWAY_URL is required." >&2
  exit 1
fi

echo "[deploy] Mission Control config path: $OPENCLAW_CONFIG_PATH"
echo "[deploy] Mission Control gateway url: $OPENCLAW_MISSION_CONTROL_GATEWAY_URL"
echo "[deploy] Mission Control bind=${MISSION_CONTROL_HOST} port=${MISSION_CONTROL_PORT}"

exec pnpm --dir /app/apps/mission-control exec next start \
  --hostname "$MISSION_CONTROL_HOST" \
  --port "$MISSION_CONTROL_PORT"
