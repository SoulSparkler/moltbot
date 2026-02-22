#!/usr/bin/env bash

set -u

log() {
  echo "[ombaa bootstrap] $*"
}

if [[ -z "${GIT_SSH_KEY:-}" ]]; then
  log "GIT_SSH_KEY not provided; skipping Ombaa bootstrap."
  exit 0
fi

repo="${OMBAA_REPO_SSH:-}"
if [[ -z "$repo" ]]; then
  log "OMBAA_REPO_SSH not provided; skipping clone/update."
  exit 0
fi

branch="${OMBAA_BRANCH:-main}"
dest="${OMBAA_DIR:-/data/workspace/ombaa}"

ssh_tmp_dir="$(mktemp -d 2>/dev/null || mktemp -d -t ombaa-ssh)"
key_file="$ssh_tmp_dir/id_ombaa"
known_hosts="$ssh_tmp_dir/known_hosts"
ssh_config="$ssh_tmp_dir/config"

cleanup() {
  rm -rf "$ssh_tmp_dir" 2>/dev/null || true
}
trap cleanup EXIT

if ! printf '%s\n' "$GIT_SSH_KEY" >"$key_file"; then
  log "Failed to write SSH key; skipping."
  exit 0
fi
chmod 600 "$key_file" 2>/dev/null || true

cat >"$ssh_config" <<EOF
Host *
  IdentityFile $key_file
  StrictHostKeyChecking accept-new
  UserKnownHostsFile $known_hosts
EOF

export GIT_SSH_COMMAND="ssh -F $ssh_config"

if ! mkdir -p "$(dirname "$dest")"; then
  log "Unable to create parent directory for $dest; skipping."
  exit 0
fi

if [ -d "$dest/.git" ]; then
  log "Updating existing Ombaa repo at $dest (branch $branch)."

  if ! git -C "$dest" remote get-url origin >/dev/null 2>&1; then
    log "Existing repository missing origin remote; skipping update."
    exit 0
  fi

  if ! git -C "$dest" fetch origin "$branch" >/dev/null 2>&1; then
    log "Fetch failed; skipping update."
    exit 0
  fi

  if ! git -C "$dest" rev-parse --verify "origin/$branch" >/dev/null 2>&1; then
    log "Remote branch $branch not found; skipping update."
    exit 0
  fi

  if ! git -C "$dest" checkout "$branch" >/dev/null 2>&1; then
    log "Checkout failed; skipping update."
    exit 0
  fi

  if ! git -C "$dest" reset --hard "origin/$branch" >/dev/null 2>&1; then
    log "Reset failed; skipping update."
    exit 0
  fi

  log "Ombaa repository updated."
else
  if [ -e "$dest" ]; then
    log "Target path $dest exists and is not a git repo; skipping clone."
    exit 0
  fi

  log "Cloning Ombaa repo into $dest (branch $branch)."
  if ! git clone --branch "$branch" "$repo" "$dest" >/dev/null 2>&1; then
    log "Clone failed; skipping Ombaa bootstrap."
    exit 0
  fi

  log "Ombaa repository cloned."
fi

exit 0
