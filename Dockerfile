FROM node:22-bullseye-slim

# Install system dependencies for Playwright/Chromium + bun + git
RUN apt-get update && apt-get install -y \
    git \
    curl \
    unzip \
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

# Source code kopiëren
COPY . .

# Install UI dependencies
RUN pnpm ui:install

# Install Playwright and Chromium browser
ENV PLAYWRIGHT_BROWSERS_PATH=/app/playwright-browsers
RUN pnpm add -w playwright && npx playwright install chromium

# Build the TypeScript source code
RUN pnpm build

# Build the Control UI assets
RUN pnpm ui:build

# Data folder maken
RUN mkdir -p /data/.openclaw /data/browser-profiles

# Entrypoint instellen
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]

# Default: start the gateway (entrypoint handles --bind lan --token automatically)
CMD ["gateway"]
