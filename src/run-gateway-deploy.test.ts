import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

function hasBash(): boolean {
  const check = spawnSync("bash", ["-lc", "echo ok"], { encoding: "utf8" });
  return check.status === 0;
}

async function writeNodeWrapper(binDir: string, logPath: string) {
  const wrapper = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--input-type=module" ]]; then
  exec "$REAL_NODE_PATH" "$@"
fi
if [[ "\${1:-}" == "/app/openclaw.mjs" ]]; then
  echo "$*" >>"$NODE_STUB_LOG"
  exit 0
fi
exec "$REAL_NODE_PATH" "$@"
`;

  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "node"), wrapper, { mode: 0o755 });
  await writeFile(logPath, "");
}

describe("scripts/deploy/run-gateway.sh", () => {
  it("rewrites legacy /data container paths inside the copied DigitalOcean config", async () => {
    if (!hasBash()) {
      return;
    }

    const rootDir = await mkdtemp(join(tmpdir(), "openclaw-run-gateway-"));
    const scriptPath = join(rootDir, "run-gateway.sh");
    const binDir = join(rootDir, "bin");
    const nodeLogPath = join(rootDir, "node-stub.log");
    const stateDir = join(rootDir, "runtime", ".openclaw");
    const configPath = join(stateDir, "openclaw.json");
    const workspaceDir = join(stateDir, "workspace");
    const logDir = join(stateDir, "logs");
    const rssStatePath = join(stateDir, "state", "etsy_rss.json");

    const script = await readFile(join(repoRoot, "scripts", "deploy", "run-gateway.sh"), "utf8");
    await writeFile(scriptPath, script, { mode: 0o755 });
    await writeNodeWrapper(binDir, nodeLogPath);
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      configPath,
      [
        "{",
        '  logging: { file: "/data/openclaw/logs/openclaw.log" },',
        "  agents: {",
        '    defaults: { workspace: "/data/openclaw/workspace/jannetje" },',
        "    list: [",
        '      { id: "jannetje", workspace: "/data/openclaw/workspace/jannetje" },',
        '      { id: "beppie", workspace: "/data/workspace/beppie" },',
        "    ],",
        "  },",
        "}",
        "",
      ].join("\n"),
    );

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      REAL_NODE_PATH: process.execPath.replace(/\\/g, "/"),
      NODE_STUB_LOG: nodeLogPath,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_WORKSPACE_DIR: workspaceDir,
      OPENCLAW_LOG_DIR: logDir,
      RSS_STATE_PATH: rssStatePath,
      OPENCLAW_GATEWAY_TOKEN: "test-gateway-token",
      OPENCLAW_GATEWAY_BIND: "lan",
      OPENCLAW_GATEWAY_PORT: "18789",
    };

    const result = spawnSync("bash", [scriptPath, "gateway", "run"], {
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `[deploy] Rewrote legacy /data container paths in ${configPath}`,
    );

    const rewrittenConfig = await readFile(configPath, "utf8");
    expect(rewrittenConfig).toContain(`file: "${logDir.replace(/\\/g, "/")}/openclaw.log"`);
    expect(rewrittenConfig).toContain(`workspace: "${workspaceDir.replace(/\\/g, "/")}/jannetje"`);
    expect(rewrittenConfig).toContain(`workspace: "${workspaceDir.replace(/\\/g, "/")}/beppie"`);
    expect(rewrittenConfig).not.toContain("/data/openclaw");
    expect(rewrittenConfig).not.toContain("/data/workspace");

    const nodeLog = await readFile(nodeLogPath, "utf8");
    expect(nodeLog).toContain(
      "/app/openclaw.mjs gateway run --bind lan --port 18789 --token test-gateway-token",
    );
  });
});
