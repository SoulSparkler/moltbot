---
summary: "Run OpenClaw and Mission Control on one DigitalOcean Droplet with Docker Compose and one shared data root"
read_when:
  - Moving OpenClaw off Railway or a laptop
  - Setting up one canonical Droplet home for runtime state and workspaces
  - Running OpenClaw and Mission Control together on Docker Compose
title: "DigitalOcean"
---

# OpenClaw on DigitalOcean

## Goal

Run OpenClaw Gateway and Mission Control on one Ubuntu 24.04 Droplet with:

- app code under `/opt/openclaw`
- persistent runtime data under `/data/openclaw`, mounted into the containers at `/home/node/.openclaw`
- one explicit config file
- one explicit workspace root
- one explicit place for agent state, credentials, and sessions

This layout avoids split-brain between a deployed runtime, a laptop workspace, and ad-hoc local files.

## Canonical layout

Use this exact split:

```text
/opt/openclaw
  docker-compose.yml
  .env
  deploy/digitalocean/openclaw.example.json5
  scripts/deploy/prepare-droplet.sh

/data/openclaw
  openclaw.json
  logs/
  state/
    etsy_rss.json
  credentials/
  skills/
  agents/
    <agentId>/
      agent/
      sessions/
  workspace/
    <agentId>/
      AGENTS.md
      IDENTITY.md
      SOUL.md
      TOOLS.md
      skills/
```

Inside the containers, `/data/openclaw` is mounted at `/home/node/.openclaw`.

What reads what:

- Gateway config: `/home/node/.openclaw/openclaw.json`
- Gateway mutable state: `/home/node/.openclaw`
- Agent workspaces: `/home/node/.openclaw/workspace/<agentId>`
- Etsy watcher state: `/home/node/.openclaw/state/etsy_rss.json`
- Mission Control config path: `/home/node/.openclaw/openclaw.json`
- Mission Control gateway target: `ws://openclaw-gateway:18789`

## 1) Create the Droplet

Create an Ubuntu 24.04 Droplet and SSH into it:

```bash
ssh root@YOUR_DROPLET_IP
```

## 2) Install Docker

```bash
apt-get update
apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
docker --version
docker compose version
```

## 3) Clone the repo under /opt

```bash
mkdir -p /opt
cd /opt
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

## 4) Create the persistent data root

Create the host directories before starting the containers:

```bash
mkdir -p /data/openclaw
bash scripts/deploy/prepare-droplet.sh
```

The helper creates:

- `/data/openclaw`
- `/data/openclaw/workspace`
- `/data/openclaw/logs`
- `/data/openclaw/state`
- per-agent workspace folders listed in `OPENCLAW_AGENT_WORKSPACES`

## 5) Configure the stack

Copy the environment template:

```bash
cp .env.example .env
```

Edit `.env` and set at least:

- `OPENCLAW_HOST_DATA_ROOT=/data/openclaw`
- `OPENCLAW_STATE_DIR=/home/node/.openclaw`
- `OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json`
- `OPENCLAW_WORKSPACE_DIR=/home/node/.openclaw/workspace`
- `RSS_STATE_PATH=/home/node/.openclaw/state/etsy_rss.json`
- `OPENCLAW_GATEWAY_TOKEN=<long-random-token>`
- `OPENCLAW_MISSION_CONTROL_GATEWAY_TOKEN=<same token>`

Reasonable defaults:

- `OPENCLAW_GATEWAY_PUBLISH_HOST=0.0.0.0`
- `MISSION_CONTROL_PUBLISH_HOST=127.0.0.1`

Keep Mission Control loopback-only unless you are intentionally fronting it with a reverse proxy or other access layer.

## 6) Install the config file

Copy the example config into the persistent state dir:

```bash
cp deploy/digitalocean/openclaw.example.json5 /data/openclaw/openclaw.json
```

Edit `/data/openclaw/openclaw.json` and adjust:

- agent IDs and names
- agent workspace paths using container paths such as `/home/node/.openclaw/workspace/<agentId>`
- channel credentials and allowlists
- model configuration
- any hooks or tool settings

If you copied `openclaw.example.json5` from an older checkout, replace any legacy `/data/openclaw/...`, `/data/.openclaw/...`, or `/data/workspace/...` container paths inside `/data/openclaw/openclaw.json` with `/home/node/.openclaw/...` before restarting the stack.

The example uses three agents:

- `jannetje`
- `beppie`
- `cornelis`

If your agent IDs differ, change the workspace paths to match.

## 7) Move your workspace files into the canonical home

For each agent, copy the workspace files into `/data/openclaw/workspace/<agentId>/`.

Typical files:

- `AGENTS.md`
- `IDENTITY.md`
- `SOUL.md`
- `TOOLS.md`
- `skills/`
- `MEMORY.md` or `memory.md`
- any agent-local assets referenced from the workspace

Example:

```bash
rsync -av /path/to/old-workspace/jannetje/ /data/openclaw/workspace/jannetje/
rsync -av /path/to/old-workspace/beppie/ /data/openclaw/workspace/beppie/
rsync -av /path/to/old-workspace/cornelis/ /data/openclaw/workspace/cornelis/
```

## 8) Start the stack

Build and start:

```bash
docker compose up -d --build openclaw-gateway mission-control
```

Follow logs:

```bash
docker compose logs -f openclaw-gateway
docker compose logs -f mission-control
```

## 9) Verify the canonical home

Sanity check the running layout:

```bash
docker compose exec openclaw-gateway printenv OPENCLAW_STATE_DIR OPENCLAW_CONFIG_PATH OPENCLAW_WORKSPACE_DIR RSS_STATE_PATH
docker compose exec mission-control printenv OPENCLAW_STATE_DIR OPENCLAW_CONFIG_PATH OPENCLAW_MISSION_CONTROL_CONFIG_PATH OPENCLAW_MISSION_CONTROL_GATEWAY_URL
docker compose exec openclaw-gateway sh -lc 'node /app/openclaw.mjs gateway health --url ws://127.0.0.1:18789 --token "$OPENCLAW_GATEWAY_TOKEN"'
```

The expected answers are:

- Gateway state dir is `/home/node/.openclaw`
- Gateway config path is `/home/node/.openclaw/openclaw.json`
- Gateway default workspace is inside `/home/node/.openclaw/workspace/...`
- Mission Control config path is `/home/node/.openclaw/openclaw.json`
- Mission Control gateway URL is `ws://openclaw-gateway:18789`

## Migration plan from a laptop or Railway

Use this order:

1. Freeze changes on the old host so the laptop and Railway stop diverging.
2. Export or copy the current useful config, credentials, sessions, and workspace files from the old environment.
3. Create `/data/openclaw` on the Droplet.
4. Copy `deploy/digitalocean/openclaw.example.json5` to `/data/openclaw/openclaw.json` and merge in the real settings.
5. Copy each agent workspace into `/data/openclaw/workspace/<agentId>/`.
6. If you need historical runtime state, copy the useful parts into `/data/openclaw`, especially:
   - `credentials/`
   - `agents/<agentId>/agent/`
   - `agents/<agentId>/sessions/`
   - `skills/`
   - `state/etsy_rss.json` if you want to preserve the Etsy watcher state
7. Start the Droplet stack.
8. Verify Mission Control and the gateway both point at the Droplet paths above.
9. Only after verification, disable Railway as the primary runtime.

## Checklist

You are done when all of these are true:

- `docker compose ps` shows `openclaw-gateway` and `mission-control` running on the Droplet.
- `docker compose exec openclaw-gateway printenv OPENCLAW_STATE_DIR` returns `/home/node/.openclaw`.
- `docker compose exec mission-control printenv OPENCLAW_CONFIG_PATH` returns `/home/node/.openclaw/openclaw.json`.
- `docker compose exec mission-control printenv OPENCLAW_MISSION_CONTROL_GATEWAY_URL` returns `ws://openclaw-gateway:18789`.
- `/data/openclaw/openclaw.json` is the only config file you edit for the deployment.
- `/data/openclaw/workspace/<agentId>/` contains the live workspace files for each agent.
- New session transcripts appear under `/data/openclaw/agents/<agentId>/sessions/`.
- Managed skills and credentials appear under `/data/openclaw/...`, not on a laptop-only path.
- Railway is no longer receiving the traffic or acting as the main runtime.

## Notes

- The Compose stack in this repo uses dedicated Droplet startup scripts, not the Railway-oriented runtime entrypoint.
- Gateway and Mission Control share the same host data root at `/data/openclaw`, which is mounted into the containers at `/home/node/.openclaw`.
- Mission Control stays explicit about its gateway target so it does not accidentally drift to its own container-local `127.0.0.1`.
- If you need the dashboard publicly reachable, change `MISSION_CONTROL_PUBLISH_HOST` to `0.0.0.0` and put it behind your normal network and auth controls.
