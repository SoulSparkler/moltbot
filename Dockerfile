FROM node:22-bullseye-slim

# Install system dependencies:
# - curl, unzip: required for bun installation
# - gnupg: required for 1Password CLI GPG key verification
# - tmux: required for isolated credential operations
# - git, make, cmake, build-essential: required for building native node modules (node-llama-cpp, sharp, etc.)
# - python3: required for node-gyp
# - 1password-cli: secure credential management
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    gnupg \
    tmux \
    git \
    make \
    cmake \
    build-essential \
    python3 && \
    curl -fsSL https://bun.sh/install | bash && \
    corepack enable && \
    curl -sS https://downloads.1password.com/linux/keys/1password.asc | gpg --dearmor --output /usr/share/keyrings/1password-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/$(dpkg --print-architecture) stable main" | tee /etc/apt/sources.list.d/1password.list && \
    mkdir -p /etc/debsig/policies/AC2D62742012EA22/ && \
    curl -sS https://downloads.1password.com/linux/debian/debsig/1password.pol | tee /etc/debsig/policies/AC2D62742012EA22/1password.pol && \
    mkdir -p /usr/share/debsig/keyrings/AC2D62742012EA22 && \
    curl -sS https://downloads.1password.com/linux/keys/1password.asc | gpg --dearmor --output /usr/share/debsig/keyrings/AC2D62742012EA22/debsig.gpg && \
    apt-get update && apt-get install -y 1password-cli && \
    op --version && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies installeren
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile

# Source code kopiëren
COPY . .

# ✅ Skip alle build commando's die falen
RUN pnpm ui:install

# Build the TypeScript source code
RUN pnpm build

# Install Playwright and Chromium browser
ENV PLAYWRIGHT_BROWSERS_PATH=/data/playwright-browsers
RUN pnpm add playwright && npx playwright install chromium

# Data folder maken
RUN mkdir -p /data/.clawdbot

# Entrypoint instellen
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]

# Allow non-root user to write files during runtime
RUN chown -R node:node /app /data

# Security hardening: run as non-root
USER node

# Default: start the gateway
# --bind lan ensures 0.0.0.0 binding for Railway healthchecks
# --allow-unconfigured allows starting without initial config
CMD ["node", "openclaw.mjs", "gateway", "run", "--bind", "lan", "--allow-unconfigured"]

