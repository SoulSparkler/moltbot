import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

function hasBash(): boolean {
  const check = spawnSync("bash", ["-lc", "echo ok"], { encoding: "utf8" });
  return check.status === 0;
}

async function writeNodeStub(binDir: string, logPath: string) {
  const stub = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-" || "\${1:-}" == "-e" ]]; then
  exec "$REAL_NODE_PATH" "$@"
fi
echo "$*" >>"$NODE_STUB_LOG"
exit 0
`;

  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "node"), stub, { mode: 0o755 });
  await writeFile(logPath, "");
}

async function seedWorkspaceTemplates(rootDir: string) {
  const templatesDir = join(rootDir, "docs", "reference", "templates");
  await mkdir(templatesDir, { recursive: true });
  await writeFile(join(templatesDir, "AGENTS.md"), "# template agents\n");
  await writeFile(join(templatesDir, "IDENTITY.md"), "# template identity\n");
  await writeFile(join(templatesDir, "SOUL.md"), "# template soul\n");
  await writeFile(join(templatesDir, "TOOLS.md"), "# template tools\n");
}

describe("docker-entrypoint.sh", () => {
  it("persists agents.defaults.workspace and bootstraps onboarding files in active workspace", async () => {
    if (!hasBash()) {
      return;
    }

    const rootDir = await mkdtemp(join(tmpdir(), "openclaw-entrypoint-"));
    const scriptPath = join(rootDir, "docker-entrypoint.sh");
    const binDir = join(rootDir, "bin");
    const nodeLogPath = join(rootDir, "node-stub.log");
    const stateDir = join(rootDir, "state");
    const workspaceDir = join(rootDir, "workspace-active");
    const configPath = join(stateDir, "openclaw.json");

    const entrypoint = await readFile(join(repoRoot, "docker-entrypoint.sh"), "utf8");
    await writeFile(scriptPath, entrypoint, { mode: 0o755 });
    await seedWorkspaceTemplates(rootDir);
    await writeNodeStub(binDir, nodeLogPath);

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      REAL_NODE_PATH: process.execPath.replace(/\\/g, "/"),
      NODE_STUB_LOG: nodeLogPath,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_WORKSPACE_DIR: workspaceDir,
      OPENCLAW_GATEWAY_TOKEN: "test-gateway-token",
      PORT: "18080",
    };

    const result = spawnSync("bash", [scriptPath, "gateway"], {
      cwd: rootDir,
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);

    const parsedConfig = JSON.parse(await readFile(configPath, "utf8")) as {
      agents?: { defaults?: { workspace?: string } };
    };
    expect(parsedConfig.agents?.defaults?.workspace).toBe(workspaceDir);

    expect(await readFile(join(workspaceDir, "AGENTS.md"), "utf8")).toContain("template agents");
    expect(await readFile(join(workspaceDir, "IDENTITY.md"), "utf8")).toContain(
      "template identity",
    );
    expect(await readFile(join(workspaceDir, "SOUL.md"), "utf8")).toContain("template soul");
    expect(await readFile(join(workspaceDir, "TOOLS.md"), "utf8")).toContain("template tools");
    expect((await stat(join(workspaceDir, "skills"))).isDirectory()).toBe(true);
  });

  it("copies missing onboarding files from legacy workspace before templates", async () => {
    if (!hasBash()) {
      return;
    }

    const rootDir = await mkdtemp(join(tmpdir(), "openclaw-entrypoint-"));
    const scriptPath = join(rootDir, "docker-entrypoint.sh");
    const binDir = join(rootDir, "bin");
    const nodeLogPath = join(rootDir, "node-stub.log");
    const stateDir = join(rootDir, "state");
    const workspaceDir = join(rootDir, "workspace-active");
    const legacyDir = join(rootDir, "workspace-legacy");
    const configPath = join(stateDir, "openclaw.json");

    const entrypoint = await readFile(join(repoRoot, "docker-entrypoint.sh"), "utf8");
    await writeFile(scriptPath, entrypoint, { mode: 0o755 });
    await seedWorkspaceTemplates(rootDir);
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, "AGENTS.md"), "# legacy agents\n");
    await writeNodeStub(binDir, nodeLogPath);

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      REAL_NODE_PATH: process.execPath.replace(/\\/g, "/"),
      NODE_STUB_LOG: nodeLogPath,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_WORKSPACE_DIR: workspaceDir,
      OPENCLAW_WORKSPACE_LEGACY_DIRS: legacyDir,
      OPENCLAW_GATEWAY_TOKEN: "test-gateway-token",
      PORT: "18081",
    };

    const result = spawnSync("bash", [scriptPath, "gateway"], {
      cwd: rootDir,
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(await readFile(join(workspaceDir, "AGENTS.md"), "utf8")).toContain("legacy agents");
    expect(await readFile(join(workspaceDir, "IDENTITY.md"), "utf8")).toContain(
      "template identity",
    );
  });
});
