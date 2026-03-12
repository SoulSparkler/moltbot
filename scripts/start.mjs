#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
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

async function ensureEtsyBuild() {
  if (fs.existsSync("apps/etsy-auto-post/dist/index.js")) {
    return { ok: true, code: 0 };
  }
  console.log("[openclaw start] etsy dist missing; running build");
  return runPnpm(["--dir", "apps/etsy-auto-post", "build"]);
}

async function runGateway() {
  const bootstrap = await run("bash", ["scripts/bootstrap-ombaa.sh"]);
  if (!bootstrap.ok) {
    return bootstrap;
  }
  return run(process.execPath, ["scripts/run-node.mjs"]);
}

async function runEtsyForeground() {
  const etsyBuild = await ensureEtsyBuild();
  if (!etsyBuild.ok) {
    return etsyBuild;
  }
  return runPnpm(["--dir", "apps/etsy-auto-post", "start"]);
}

async function main() {
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
