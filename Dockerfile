FROM node:22-bullseye-slim

# ✅ curl en unzip installeren zodat bun werkt
# ✅ Playwright dependencies for headless Chromium on Railway
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    # Playwright/Chromium system dependencies
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    libxshmfence1 \
    # Fonts for rendering
    fonts-liberation \
    fonts-noto-color-emoji \
    && curl -fsSL https://bun.sh/install | bash \
    && corepack enable \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies installeren
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile

# Install Playwright browsers (chromium only for Railway)
# Set up Playwright environment for Railway
ENV PLAYWRIGHT_BROWSERS_PATH=/data/playwright-browsers
ENV PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
RUN mkdir -p /data/playwright-browsers && \
    npx playwright install chromium --with-deps

# Source code kopiëren
COPY . .

# ✅ Skip alle build commando's die falen
RUN pnpm ui:install

# Build the TypeScript source code
RUN pnpm build

# Data folder maken voor persistence + Playwright sessions
RUN mkdir -p /data/.clawdbot \
             /data/playwright-sessions \
             /data/playwright-downloads \
             /data/playwright-output \
             /data/workspace

# Entrypoint instellen
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]

# Default: start the gateway
# Uses OPENCLAW_GATEWAY_PORT env var, --bind lan ensures 0.0.0.0 binding for Railway
# --allow-unconfigured allows starting without initial config
CMD ["node", "openclaw.mjs", "gateway", "run", "--bind", "lan", "--allow-unconfigured"]
