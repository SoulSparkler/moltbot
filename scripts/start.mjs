#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", (error) => reject(error));
    child.on("exit", (code, signal) => {
      if (signal) {
        resolve({ ok: false, code: 1 });
        return;
      }
      resolve({ ok: (code ?? 1) === 0, code: code ?? 1 });
    });
  });
}

function runPnpm(args) {
  if (process.platform === "win32") {
    return run("cmd.exe", ["/d", "/s", "/c", "pnpm", ...args]);
  }
  return run("pnpm", args);
}

async function main() {
  const explicitMode = process.env.OPENCLAW_START_MODE?.trim().toLowerCase();
  const railwayServiceName = process.env.RAILWAY_SERVICE_NAME?.trim().toLowerCase() ?? "";
  const etsyRssUrl = process.env.ETSY_SHOP_RSS_URL?.trim() ?? "";
  const inferredEtsyMode =
    etsyRssUrl.length > 0 ||
    (process.env.RAILWAY_ENVIRONMENT &&
      (railwayServiceName.includes("etsy") ||
        railwayServiceName.includes("rss") ||
        railwayServiceName.includes("autopost")));
  const runEtsyMode = explicitMode
    ? explicitMode === "etsy" || explicitMode === "etsy-auto-post"
    : inferredEtsyMode;

  if (runEtsyMode) {
    console.log("[openclaw start] mode=etsy-auto-post");
    if (!fs.existsSync("apps/etsy-auto-post/dist/index.js")) {
      console.log("[openclaw start] etsy dist missing; running build");
      const etsyBuild = await runPnpm(["--dir", "apps/etsy-auto-post", "build"]);
      if (!etsyBuild.ok) {
        process.exit(etsyBuild.code);
        return;
      }
    }
    const etsyStart = await runPnpm(["--dir", "apps/etsy-auto-post", "start"]);
    process.exit(etsyStart.code);
    return;
  }

  console.log("[openclaw start] mode=gateway");
  const bootstrap = await run("bash", ["scripts/bootstrap-ombaa.sh"]);
  if (!bootstrap.ok) {
    process.exit(bootstrap.code);
    return;
  }

  const gatewayStart = await run(process.execPath, ["scripts/run-node.mjs"]);
  process.exit(gatewayStart.code);
}

main().catch((error) => {
  console.error("[openclaw start] Failed to start service:", error);
  process.exit(1);
});
