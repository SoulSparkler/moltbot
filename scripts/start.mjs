#!/usr/bin/env node

import JSON5 from "json5";
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const LEGACY_CONFIG_FILES = ["openclaw.json", "clawdbot.json", "moltbot.json"];
const RAILWAY_PRIMARY_MODEL = "anthropic/claude-sonnet-4-5";

function pickExistingConfigPath(stateDir) {
  for (const file of LEGACY_CONFIG_FILES) {
    const candidate = path.join(stateDir, file);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function readConfigSummary(configPath) {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON5.parse(raw);
    const agentsList = Array.isArray(parsed?.agents?.list)
      ? parsed.agents.list.filter((entry) => entry && typeof entry === "object")
      : [];
    const defaultAgent = agentsList.find((entry) => entry.default === true);
    const fallbackAgent = agentsList[0];
    const resolvedDefaultId =
      (typeof defaultAgent?.id === "string" && defaultAgent.id.trim()) ||
      (typeof fallbackAgent?.id === "string" && fallbackAgent.id.trim()) ||
      "main";

    let hasNonMainAgent = false;
    let hasNamedIdentity = false;
    let hasJannetje = false;
    for (const agent of agentsList) {
      const id = typeof agent.id === "string" ? agent.id.trim().toLowerCase() : "";
      if (id && id !== "main") {
        hasNonMainAgent = true;
      }
      if (id === "jannetje") {
        hasJannetje = true;
      }
      const identityName =
        typeof agent?.identity?.name === "string" ? agent.identity.name.trim() : "";
      if (identityName && identityName.toLowerCase() !== "assistant") {
        hasNamedIdentity = true;
      }
    }

    const assistantName =
      typeof parsed?.ui?.assistant?.name === "string" ? parsed.ui.assistant.name.trim() : "";
    if (assistantName && assistantName.toLowerCase() !== "assistant") {
      hasNamedIdentity = true;
    }

    return {
      ok: true,
      agentsCount: agentsList.length,
      hasNonMainAgent,
      hasNamedIdentity,
      hasJannetje,
      defaultAgentId: resolvedDefaultId.toLowerCase(),
    };
  } catch {
    return { ok: false };
  }
}

function scoreStateCandidate(stateDir, configPath) {
  // Prefer the directory that likely contains real user setup over freshly-created empty state.
  let score = 0;
  if (configPath) {
    score += 100;
  }
  if (fs.existsSync(path.join(stateDir, "agents"))) {
    score += 20;
  }
  const summary = configPath ? readConfigSummary(configPath) : { ok: false };
  if (summary.ok) {
    score += 10;
    if (summary.agentsCount > 0) {
      score += 40 + Math.min(summary.agentsCount, 10);
    }
    if (summary.hasNonMainAgent) {
      score += 180;
    }
    if (summary.defaultAgentId && summary.defaultAgentId !== "main") {
      score += 80;
    }
    if (summary.hasNamedIdentity) {
      score += 220;
    }
    if (summary.hasJannetje) {
      score += 400;
    }
  }
  return score;
}

function resolveStartupPaths() {
  const explicit =
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.CLAWDBOT_STATE_DIR?.trim() ||
    process.env.MOLTBOT_STATE_DIR?.trim() ||
    "";
  const explicitConfigPath =
    process.env.OPENCLAW_CONFIG_PATH?.trim() ||
    process.env.CLAWDBOT_CONFIG_PATH?.trim() ||
    process.env.MOLTBOT_CONFIG_PATH?.trim() ||
    "";
  const explicitConfigDir =
    process.env.OPENCLAW_CONFIG_DIR?.trim() ||
    process.env.CLAWDBOT_CONFIG_DIR?.trim() ||
    process.env.MOLTBOT_CONFIG_DIR?.trim() ||
    "";

  if (explicitConfigPath) {
    return {
      stateDir: explicit || path.dirname(explicitConfigPath),
      configPath: explicitConfigPath,
    };
  }

  if (explicitConfigDir) {
    return {
      stateDir: explicit || explicitConfigDir,
      configPath:
        pickExistingConfigPath(explicitConfigDir) || path.join(explicitConfigDir, "openclaw.json"),
    };
  }

  if (explicit) {
    return {
      stateDir: explicit,
      configPath: pickExistingConfigPath(explicit) || path.join(explicit, "openclaw.json"),
    };
  }

  const candidates = ["/data/.openclaw", "/data/.clawdbot", "/data/.moltbot"];
  let best = null;
  for (const dir of candidates) {
    const configPath = pickExistingConfigPath(dir);
    const score = scoreStateCandidate(dir, configPath);
    if (!best || score > best.score) {
      best = { stateDir: dir, configPath, score };
    }
  }
  const selectedStateDir = best?.stateDir || "/data/.openclaw";
  const selectedConfigPath =
    best?.configPath ||
    pickExistingConfigPath(selectedStateDir) ||
    path.join(selectedStateDir, "openclaw.json");
  return { stateDir: selectedStateDir, configPath: selectedConfigPath };
}

function configurePersistentPaths() {
  const { stateDir, configPath } = resolveStartupPaths();
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.CLAWDBOT_STATE_DIR = stateDir;
  process.env.MOLTBOT_STATE_DIR = stateDir;

  process.env.OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH?.trim() || configPath;

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

function isRailwayRuntime() {
  return [
    process.env.RAILWAY_ENVIRONMENT,
    process.env.RAILWAY_PROJECT_ID,
    process.env.RAILWAY_SERVICE_ID,
    process.env.RAILWAY_SERVICE_NAME,
  ].some((value) => Boolean(value?.trim()));
}

function isLegacyClaude35ModelRef(value) {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return Boolean(normalized) && normalized.includes("claude-3-5-sonnet");
}

function isLegacyRailwayModelRef(value) {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized.startsWith("openrouter/") || isLegacyClaude35ModelRef(normalized);
}

function removeLegacyRailwayFallbacks(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .filter((value) => !isLegacyRailwayModelRef(value) && value !== RAILWAY_PRIMARY_MODEL);
}

function normalizeRailwayGatewayModels() {
  if (!isRailwayRuntime()) {
    return;
  }

  const configPath = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (!configPath) {
    return;
  }

  let cfg = {};
  try {
    cfg = JSON5.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    cfg = {};
  }

  if (!cfg || typeof cfg !== "object") {
    cfg = {};
  }

  cfg.agents = cfg.agents && typeof cfg.agents === "object" ? cfg.agents : {};
  cfg.agents.defaults =
    cfg.agents.defaults && typeof cfg.agents.defaults === "object" ? cfg.agents.defaults : {};
  cfg.agents.defaults.model = {
    primary: RAILWAY_PRIMARY_MODEL,
    fallbacks: [],
  };

  if (Array.isArray(cfg.agents.list)) {
    for (const agent of cfg.agents.list) {
      if (!agent || typeof agent !== "object") {
        continue;
      }
      if (typeof agent.model === "string") {
        if (isLegacyRailwayModelRef(agent.model)) {
          agent.model = RAILWAY_PRIMARY_MODEL;
        }
        continue;
      }
      if (!agent.model || typeof agent.model !== "object") {
        continue;
      }
      const nextPrimary = typeof agent.model.primary === "string" ? agent.model.primary.trim() : "";
      agent.model.primary =
        nextPrimary && !isLegacyRailwayModelRef(nextPrimary) ? nextPrimary : RAILWAY_PRIMARY_MODEL;
      agent.model.fallbacks = removeLegacyRailwayFallbacks(agent.model.fallbacks);
    }
  }

  cfg.agents.defaults.replyPipeline =
    cfg.agents.defaults.replyPipeline && typeof cfg.agents.defaults.replyPipeline === "object"
      ? cfg.agents.defaults.replyPipeline
      : {};
  const configuredBrainModel = (
    process.env.OPENCLAW_BRAIN_MODEL ||
    cfg.agents.defaults.replyPipeline.brainModel ||
    ""
  ).trim();
  cfg.agents.defaults.replyPipeline.brainModel =
    configuredBrainModel && !isLegacyRailwayModelRef(configuredBrainModel)
      ? configuredBrainModel
      : RAILWAY_PRIMARY_MODEL;
  cfg.agents.defaults.replyPipeline.muscleModels = [RAILWAY_PRIMARY_MODEL];

  cfg.agents.defaults.models = Object.fromEntries(
    Object.entries(cfg.agents.defaults.models || {}).filter(
      ([ref]) => !isLegacyClaude35ModelRef(ref),
    ),
  );
  for (const ref of [
    RAILWAY_PRIMARY_MODEL,
    ...(cfg.agents.defaults.model.fallbacks || []),
    cfg.agents.defaults.replyPipeline.brainModel,
    ...(cfg.agents.defaults.replyPipeline.muscleModels || []),
  ]) {
    if (typeof ref === "string" && ref.trim()) {
      cfg.agents.defaults.models[ref.trim()] = cfg.agents.defaults.models[ref.trim()] || {};
    }
  }

  // Enable meta_social tool so Jannetje can post to Facebook/Instagram.
  cfg.tools = cfg.tools && typeof cfg.tools === "object" ? cfg.tools : {};
  cfg.tools.metaSocial =
    cfg.tools.metaSocial && typeof cfg.tools.metaSocial === "object" ? cfg.tools.metaSocial : {};
  cfg.tools.metaSocial.enabled = true;

  // Ensure Jannetje agent entry is always present with the correct identity and emoji.
  if (!Array.isArray(cfg.agents.list)) {
    cfg.agents.list = [];
  }
  let jannetje = cfg.agents.list.find((a) => a && typeof a === "object" && a.id === "jannetje");
  if (!jannetje) {
    jannetje = { id: "jannetje" };
    cfg.agents.list.push(jannetje);
  }
  jannetje.default = true;
  jannetje.name = "Jannetje";
  jannetje.identity = { name: "Jannetje", emoji: "🧡" };
  if (!jannetje.workspace) {
    jannetje.workspace = process.env.OPENCLAW_WORKSPACE_DIR || "/data/workspace";
  }
  // Remove default flag from other agents.
  for (const agent of cfg.agents.list) {
    if (agent && typeof agent === "object" && agent.id !== "jannetje") {
      delete agent.default;
    }
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  console.log(
    `[openclaw start] Railway model defaults: primary=${RAILWAY_PRIMARY_MODEL} fallbacks=none`,
  );
  console.log("[openclaw start] Jannetje identity: name=Jannetje emoji=🧡");
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

  normalizeRailwayGatewayModels();

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
    let finished = false;
    let etsyChild = null;

    const exitAll = (code) => {
      if (finished) {
        return;
      }
      finished = true;
      try {
        etsyChild?.kill("SIGTERM");
      } catch {
        // ignore
      }
      process.exit(code);
    };

    // Keep Etsy sidecar alive independently. Gateway remains the primary process
    // so chat stays available even if Etsy crashes temporarily.
    const runEtsyLoop = async () => {
      let restartCount = 0;
      while (!finished) {
        const etsy = spawnPnpm(["--dir", "apps/etsy-auto-post", "start"], etsyEnv);
        etsyChild = etsy.child;
        const result = await etsy.done.catch((error) => {
          if (!finished) {
            console.error("[openclaw start] etsy-auto-post failed:", error);
          }
          return { ok: false, code: 1 };
        });
        if (finished) {
          return;
        }
        restartCount += 1;
        const backoffMs = Math.min(30_000, 2_000 * 2 ** Math.min(restartCount - 1, 4));
        console.error(
          `[openclaw start] etsy-auto-post exited (code=${result.code}); restarting in ${backoffMs}ms`,
        );
        await sleep(backoffMs);
      }
    };

    void runEtsyLoop();

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
