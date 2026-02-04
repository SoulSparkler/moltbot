FROM node:22-bullseye-slim

# Install system dependencies:
# - curl, unzip: required for bun installation
# - gnupg, ca-certificates, lsb-release: required for repository management
# - tmux: required for isolated credential operations
# - git, make, build-essential: required for building native node modules
# - python3: required for node-gyp
# - cmake (via Kitware): node-llama-cpp requires cmake 3.19+, but Debian Bullseye has 3.18
# - 1password-cli: secure credential management
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    gnupg \
    ca-certificates \
    lsb-release \
    tmux \
    git \
    make \
    build-essential \
    python3 && \
    # Install newer cmake from Kitware (node-llama-cpp requires 3.19+)
    curl -fsSL https://apt.kitware.com/keys/kitware-archive-latest.asc | gpg --dearmor -o /usr/share/keyrings/kitware-archive-keyring.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/kitware-archive-keyring.gpg] https://apt.kitware.com/ubuntu/ focal main" | tee /etc/apt/sources.list.d/kitware.list && \
    apt-get update && apt-get install -y cmake && \
    # Install bun
    curl -fsSL https://bun.sh/install | bash && \
    corepack enable && \
    # Install 1Password CLI
    curl -sS https://downloads.1password.com/linux/keys/1password.asc | gpg --dearmor --output /usr/share/keyrings/1password-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/$(dpkg --print-architecture) stable main" | tee /etc/apt/sources.list.d/1password.list && \
    mkdir -p /etc/debsig/policies/AC2D62742012EA22/ && \
    curl -sS https://downloads.1password.com/linux/debian/debsig/1password.pol | tee /etc/debsig/policies/AC2D62742012EA22/1password.pol && \
    mkdir -p /usr/share/debsig/keyrings/AC2D62742012EA22 && \
    curl -sS https://downloads.1password.com/linux/keys/1password.asc | gpg --dearmor --output /usr/share/debsig/keyrings/AC2D62742012EA22/debsig.gpg && \
    apt-get update && apt-get install -y 1password-cli && \
    # Verify installations
    cmake --version && \
    op --version && \
    # Cleanup
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

# Install Chromium browser for Playwright
# Note: playwright-core doesn't include the install CLI, so we temporarily add playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/data/playwright-browsers
RUN pnpm add -D -w playwright && \
    npx playwright install --with-deps chromium && \
    pnpm remove -w playwright

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

