#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_DATA_ROOT="${OPENCLAW_DATA_ROOT:-${OPENCLAW_HOST_DATA_ROOT:-/data/openclaw}}"
OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-${OPENCLAW_DATA_ROOT}}"
OPENCLAW_WORKSPACE_ROOT="${OPENCLAW_WORKSPACE_ROOT:-${OPENCLAW_DATA_ROOT}/workspace}"
OPENCLAW_LOG_DIR="${OPENCLAW_LOG_DIR:-${OPENCLAW_DATA_ROOT}/logs}"
OPENCLAW_ETSY_STATE_DIR="${OPENCLAW_ETSY_STATE_DIR:-${OPENCLAW_DATA_ROOT}/state}"
OPENCLAW_AGENT_WORKSPACES="${OPENCLAW_AGENT_WORKSPACES:-jannetje,beppie,cornelis}"
OPENCLAW_UID="${OPENCLAW_UID:-1000}"
OPENCLAW_GID="${OPENCLAW_GID:-1000}"

mkdir -p "$OPENCLAW_STATE_DIR" "$OPENCLAW_WORKSPACE_ROOT" "$OPENCLAW_LOG_DIR" "$OPENCLAW_ETSY_STATE_DIR"

IFS=',' read -r -a agent_workspaces <<<"$OPENCLAW_AGENT_WORKSPACES"
for agent_workspace in "${agent_workspaces[@]}"; do
  agent_workspace="${agent_workspace#"${agent_workspace%%[![:space:]]*}"}"
  agent_workspace="${agent_workspace%"${agent_workspace##*[![:space:]]}"}"
  if [[ -z "$agent_workspace" ]]; then
    continue
  fi
  mkdir -p "$OPENCLAW_WORKSPACE_ROOT/$agent_workspace/skills"
done

chown -R "${OPENCLAW_UID}:${OPENCLAW_GID}" "$OPENCLAW_DATA_ROOT"

cat <<EOF
Prepared OpenClaw data root:
  data root:   $OPENCLAW_DATA_ROOT
  state dir:   $OPENCLAW_STATE_DIR
  workspace:   $OPENCLAW_WORKSPACE_ROOT
  logs dir:    $OPENCLAW_LOG_DIR
  etsy state:  $OPENCLAW_ETSY_STATE_DIR
  agent dirs:  $OPENCLAW_AGENT_WORKSPACES
EOF
