#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function spawnWithResult(command, args, env = process.env) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env,
  });
  const done = new Promise((resolve, reject) => {
    child.on("error", (error) => reject(error));
    child.on("exit", (code, signal) => {
      if (signal) {
        resolve({ ok: false, code: 1 });
        return;
      }
      resolve({ ok: (code ?? 1) === 0, code: code ?? 1 });
    });
  });
  return { child, done };
}

function run(command, args, env = process.env) {
  return spawnWithResult(command, args, env).done;
}

function runPnpm(args, env = process.env) {
  if (process.platform === "win32") {
    return run("cmd.exe", ["/d", "/s", "/c", "pnpm", ...args], env);
  }
  return run("pnpm", args, env);
}

function spawnPnpm(args, env = process.env) {
  if (process.platform === "win32") {
    return spawnWithResult("cmd.exe", ["/d", "/s", "/c", "pnpm", ...args], env);
  }
  return spawnWithResult("pnpm", args, env);
}

const LEGACY_CONFIG_FILES = ["openclaw.json", "clawdbot.json", "moltbot.json"];

function pickExistingConfigPath(stateDir) {
  for (const file of LEGACY_CONFIG_FILES) {
    const candidate = path.join(stateDir, file);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveStateDirForStartup() {
  const explicit =
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.CLAWDBOT_STATE_DIR?.trim() ||
    process.env.MOLTBOT_STATE_DIR?.trim() ||
    "";
  if (explicit) {
    return explicit;
  }

  const candidates = ["/data/.openclaw", "/data/.clawdbot", "/data/.moltbot"];
  for (const dir of candidates) {
    if (pickExistingConfigPath(dir)) {
      return dir;
    }
  }
  return "/data/.openclaw";
}

function configurePersistentPaths() {
  const stateDir = resolveStateDirForStartup();
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.CLAWDBOT_STATE_DIR = stateDir;
  process.env.MOLTBOT_STATE_DIR = stateDir;

  if (!process.env.OPENCLAW_CONFIG_PATH?.trim()) {
    process.env.OPENCLAW_CONFIG_PATH =
      pickExistingConfigPath(stateDir) || path.join(stateDir, "openclaw.json");
  }

  if (!process.env.OPENCLAW_WORKSPACE_DIR?.trim()) {
    process.env.OPENCLAW_WORKSPACE_DIR = "/data/workspace";
  }

  try {
    fs.mkdirSync(stateDir, { recursive: true });
  } catch {
    // ignore
  }
  try {
    fs.mkdirSync(process.env.OPENCLAW_WORKSPACE_DIR, { recursive: true });
  } catch {
    // ignore
  }

  console.log(
    `[openclaw start] state=${process.env.OPENCLAW_STATE_DIR} config=${process.env.OPENCLAW_CONFIG_PATH} workspace=${process.env.OPENCLAW_WORKSPACE_DIR}`,
  );
}

async function ensureEtsyBuild() {
  if (fs.existsSync("apps/etsy-auto-post/dist/index.js")) {
    return { ok: true, code: 0 };
  }
  console.log("[openclaw start] etsy dist missing; running build");
  return runPnpm(["--dir", "apps/etsy-auto-post", "build"]);
}

function resolveGatewayPort() {
  const raw = process.env.OPENCLAW_GATEWAY_PORT?.trim() || process.env.PORT?.trim() || "8080";
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return 8080;
}

function resolveGatewayBind() {
  const raw =
    process.env.OPENCLAW_GATEWAY_BIND?.trim() || process.env.CLAWDBOT_GATEWAY_BIND?.trim() || "";
  const normalized = raw.toLowerCase();
  if (
    normalized === "loopback" ||
    normalized === "lan" ||
    normalized === "tailnet" ||
    normalized === "auto" ||
    normalized === "custom"
  ) {
    return normalized;
  }
  return "lan";
}

function ensureGatewayToken() {
  const existing =
    process.env.OPENCLAW_GATEWAY_TOKEN?.trim() ||
    process.env.CLAWDBOT_GATEWAY_TOKEN?.trim() ||
    process.env.MOLTBOT_GATEWAY_TOKEN?.trim() ||
    "";
  if (existing) {
    process.env.OPENCLAW_GATEWAY_TOKEN = existing;
    return existing;
  }
  const generated = randomBytes(24).toString("base64url");
  process.env.OPENCLAW_GATEWAY_TOKEN = generated;
  console.warn(
    "[openclaw start] OPENCLAW_GATEWAY_TOKEN missing; generated an ephemeral token for this deployment.",
  );
  return generated;
}

async function runGateway() {
  const bootstrap = await run("bash", ["scripts/bootstrap-ombaa.sh"]);
  if (!bootstrap.ok) {
    return bootstrap;
  }

  const gatewayToken = ensureGatewayToken();
  const gatewayPort = resolveGatewayPort();
  const gatewayBind = resolveGatewayBind();
  console.log(
    `[openclaw start] gateway launch bind=${gatewayBind} port=${gatewayPort} token=${gatewayToken.slice(0, 6)}...`,
  );

  return run(process.execPath, [
    "scripts/run-node.mjs",
    "gateway",
    "--allow-unconfigured",
    "--bind",
    gatewayBind,
    "--port",
    String(gatewayPort),
    "--auth",
    "token",
    "--token",
    gatewayToken,
  ]);
}

async function runEtsyForeground() {
  const etsyBuild = await ensureEtsyBuild();
  if (!etsyBuild.ok) {
    return etsyBuild;
  }
  return runPnpm(["--dir", "apps/etsy-auto-post", "start"]);
}

async function main() {
  configurePersistentPaths();

  const explicitMode = process.env.OPENCLAW_START_MODE?.trim().toLowerCase();
  const railwayServiceName = process.env.RAILWAY_SERVICE_NAME?.trim().toLowerCase() ?? "";
  const gatewayTokenHints = [
    process.env.OPENCLAW_GATEWAY_TOKEN,
    process.env.CLAWDBOT_GATEWAY_TOKEN,
    process.env.MOLTBOT_GATEWAY_TOKEN,
  ]
    .map((value) => value?.trim() ?? "")
    .filter(Boolean);
  const hasGatewayHints =
    gatewayTokenHints.length > 0 || Boolean(process.env.SETUP_PASSWORD?.trim());
  const etsyRssUrl = process.env.ETSY_SHOP_RSS_URL?.trim() ?? "";
  const inferredEtsyMode =
    etsyRssUrl.length > 0 ||
    (process.env.RAILWAY_ENVIRONMENT &&
      (railwayServiceName.includes("etsy") ||
        railwayServiceName.includes("rss") ||
        railwayServiceName.includes("autopost")));
  const selectedMode =
    explicitMode || (inferredEtsyMode ? (hasGatewayHints ? "all" : "etsy") : "gateway");
  const runEtsyMode = selectedMode === "etsy" || selectedMode === "etsy-auto-post";
  const runAllMode = selectedMode === "all";

  if (runEtsyMode) {
    console.log("[openclaw start] mode=etsy-auto-post");
    const etsyStart = await runEtsyForeground();
    process.exit(etsyStart.code);
    return;
  }

  if (runAllMode) {
    console.log("[openclaw start] mode=all (gateway + etsy-auto-post)");
    const etsyBuild = await ensureEtsyBuild();
    if (!etsyBuild.ok) {
      process.exit(etsyBuild.code);
      return;
    }

    const etsyEnv = { ...process.env };
    if (!etsyEnv.RSS_DISABLE_HEALTH_SERVER) {
      etsyEnv.RSS_DISABLE_HEALTH_SERVER = "1";
    }
    if (!etsyEnv.RSS_TELEGRAM_POLLING) {
      etsyEnv.RSS_TELEGRAM_POLLING = "false";
    }

    const etsy = spawnPnpm(["--dir", "apps/etsy-auto-post", "start"], etsyEnv);
    let finished = false;

    const exitAll = (code) => {
      if (finished) {
        return;
      }
      finished = true;
      try {
        etsy.child.kill("SIGTERM");
      } catch {
        // ignore
      }
      process.exit(code);
    };

    etsy.done
      .then((result) => {
        if (finished) {
          return;
        }
        console.error(
          `[openclaw start] etsy-auto-post exited (code=${result.code}); stopping container for restart`,
        );
        exitAll(result.code);
      })
      .catch((error) => {
        if (finished) {
          return;
        }
        console.error("[openclaw start] etsy-auto-post failed:", error);
        exitAll(1);
      });

    const gateway = await runGateway();
    exitAll(gateway.code);
    return;
  }

  console.log("[openclaw start] mode=gateway");
  const gateway = await runGateway();
  process.exit(gateway.code);
}

main().catch((error) => {
  console.error("[openclaw start] Failed to start service:", error);
  process.exit(1);
});
