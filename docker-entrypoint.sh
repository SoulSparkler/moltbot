#!/usr/bin/env bash
set -euo pipefail

echo "[entrypoint] Starting OpenClaw gateway entrypoint..."

# Force OpenClaw to use /data as HOME
export HOME=/data

# Config path follows OpenClaw convention: ~/.openclaw/openclaw.json
: "${OPENCLAW_CONFIG_PATH:=${HOME}/.openclaw/openclaw.json}"
export OPENCLAW_CONFIG_PATH

# Use PORT env var from Railway if set, otherwise default to 8080
: "${OPENCLAW_GATEWAY_PORT:=${PORT:-8080}}"
export OPENCLAW_GATEWAY_PORT

# Create directories
mkdir -p /data/.openclaw /data/workspace 2>/dev/null || true

# Find Playwright Chromium executable
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/app/playwright-browsers}"
CHROMIUM_EXE=$(find "$PLAYWRIGHT_BROWSERS_PATH" -name "chrome" -type f -path "*/chrome-linux/*" 2>/dev/null | head -1)
if [ -n "$CHROMIUM_EXE" ]; then
    echo "[entrypoint] Found Playwright Chromium at: $CHROMIUM_EXE"
    export CHROMIUM_EXE
else
    echo "[entrypoint] WARNING: Playwright Chromium not found at $PLAYWRIGHT_BROWSERS_PATH"
fi

# Generate a gateway token if not already set (required for non-loopback binding)
if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
    # Check if we have a persisted token in config
    if [ -f "$OPENCLAW_CONFIG_PATH" ]; then
        PERSISTED_TOKEN=$(node -e "try{const c=JSON.parse(require('fs').readFileSync('$OPENCLAW_CONFIG_PATH','utf8'));console.log(c.gateway?.auth?.token||'')}catch(e){}" 2>/dev/null || true)
        if [ -n "$PERSISTED_TOKEN" ]; then
            export OPENCLAW_GATEWAY_TOKEN="$PERSISTED_TOKEN"
            echo "[entrypoint] Using persisted gateway token from config"
        fi
    fi
    # If still no token, generate one
    if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
        export OPENCLAW_GATEWAY_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)
        echo "[entrypoint] Generated gateway token for Railway deployment"
    fi
fi

echo "[entrypoint] Token: ${OPENCLAW_GATEWAY_TOKEN:0:8}..."
echo "[entrypoint] Port: $OPENCLAW_GATEWAY_PORT"

# If first arg is "gateway", run it directly with our configured options
if [ "${1:-}" = "gateway" ] || [ "${1:-}" = "node" ]; then
    echo "[entrypoint] Running gateway with explicit bind=lan and token"

    # Force bind mode in config and set up browser profiles
    echo "[entrypoint] Writing config with gateway.bind=lan and browser profiles..."
    node -e "
const fs = require('fs');
const configPath = '$OPENCLAW_CONFIG_PATH';
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}

// Gateway config
cfg.gateway = cfg.gateway || {};
cfg.gateway.bind = 'lan';
cfg.gateway.mode = 'local';
cfg.gateway.auth = cfg.gateway.auth || {};
cfg.gateway.auth.token = '$OPENCLAW_GATEWAY_TOKEN';
// Remove invalid key from previous deployment
delete cfg.gateway.customBindHost;

// Browser config - headless mode for Railway containers
cfg.browser = cfg.browser || {};
cfg.browser.enabled = true;
cfg.browser.headless = true;
cfg.browser.noSandbox = true;  // Required for Docker/Railway

// Set Playwright Chromium executable path
const chromiumExe = process.env.CHROMIUM_EXE;
if (chromiumExe) {
  cfg.browser.executablePath = chromiumExe;
  console.log('[entrypoint] Browser executable:', chromiumExe);
}

// Browser profiles - cdpPort is required, colors assigned
cfg.browser.profiles = cfg.browser.profiles || {};
cfg.browser.profiles.main = { cdpPort: 18800, color: '#FF4500' };
cfg.browser.profiles.google = { cdpPort: 18801, color: '#4285F4' };
cfg.browser.profiles.facebook = { cdpPort: 18802, color: '#1877F2' };
cfg.browser.profiles.instagram = { cdpPort: 18803, color: '#E4405F' };
cfg.browser.profiles.linkedin = { cdpPort: 18804, color: '#0A66C2' };
cfg.browser.profiles.tiktok = { cdpPort: 18805, color: '#000000' };
cfg.browser.profiles.github = { cdpPort: 18806, color: '#181717' };

// Agent model config - OpenRouter auto routing with Haiku fallback
cfg.agents = cfg.agents || {};
cfg.agents.defaults = cfg.agents.defaults || {};
cfg.agents.defaults.model = {
  primary: 'openrouter/openrouter/auto',
  fallbacks: ['openrouter/anthropic/claude-haiku-4.5']
};
cfg.agents.defaults.models = {
  'openrouter/openrouter/auto': {},
  'openrouter/anthropic/claude-haiku-4.5': {}
};

fs.mkdirSync(require('path').dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
console.log('[entrypoint] Config written');
console.log('[entrypoint] Browser profiles:', Object.keys(cfg.browser.profiles).join(', '));
"

    # Create browser profile directories
    mkdir -p /data/browser-profiles/main \
             /data/browser-profiles/google \
             /data/browser-profiles/facebook \
             /data/browser-profiles/instagram \
             /data/browser-profiles/linkedin \
             /data/browser-profiles/tiktok \
             /data/browser-profiles/github

    exec node /app/openclaw.mjs gateway run \
        --bind lan \
        --token "$OPENCLAW_GATEWAY_TOKEN" \
        --port "$OPENCLAW_GATEWAY_PORT" \
        --allow-unconfigured \
        --verbose
fi

# Otherwise run whatever was passed
echo "[entrypoint] Running: $@"
exec "$@"
# Railway deployment trigger - 20260203170111
