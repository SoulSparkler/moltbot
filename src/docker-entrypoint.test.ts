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
echo "CMD:$* PORT=\${PORT:-} RSS_DISABLE_HEALTH_SERVER=\${RSS_DISABLE_HEALTH_SERVER:-} ETSY_AUTO_POST_TOKEN=\${ETSY_AUTO_POST_TOKEN:-}" >>"$NODE_STUB_LOG"
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
  await writeFile(join(templatesDir, "USER.md"), "# template user\n");
  await writeFile(
    join(templatesDir, "IDENTITY.jannetje.md"),
    [
      "---",
      "summary: Jannetje identity",
      "---",
      "",
      "# IDENTITY.md",
      "",
      "- **Name:** Jannetje",
      "- **Creature:** warm assistant",
      "- **Emoji:** \\u{1F9E1}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(templatesDir, "SOUL.jannetje.md"),
    ["---", "summary: Jannetje soul", "---", "", "# SOUL.md", "", "I am Jannetje.", ""].join("\n"),
  );
  await writeFile(
    join(templatesDir, "USER.jannetje.md"),
    [
      "---",
      "summary: Loulou profile",
      "---",
      "",
      "# USER.md",
      "",
      "- **Name:** Loulou",
      "- **What to call them:** Loulou",
      "",
    ].join("\n"),
  );
}

async function installEntrypoint(rootDir: string) {
  const entrypointDir = join(rootDir, "bin-entrypoint");
  const scriptPath = join(entrypointDir, "docker-entrypoint.sh");
  const entrypoint = await readFile(join(repoRoot, "docker-entrypoint.sh"), "utf8");
  await mkdir(entrypointDir, { recursive: true });
  await writeFile(scriptPath, entrypoint, { mode: 0o755 });
  return scriptPath;
}

describe("docker-entrypoint.sh", () => {
  it("bootstraps Jannetje persona and Etsy bridge config in the active Railway workspace", async () => {
    if (!hasBash()) {
      return;
    }

    const rootDir = await mkdtemp(join(tmpdir(), "openclaw-entrypoint-"));
    const scriptPath = await installEntrypoint(rootDir);
    const binDir = join(rootDir, "bin");
    const nodeLogPath = join(rootDir, "node-stub.log");
    const stateDir = join(rootDir, "state");
    const workspaceDir = join(rootDir, "workspace-active");
    const configPath = join(stateDir, "openclaw.json");
    const etsyEntryPath = join(rootDir, "fake-etsy-entry.js");

    await seedWorkspaceTemplates(rootDir);
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(join(workspaceDir, "BOOTSTRAP.md"), "# stale bootstrap\n");
    await writeFile(etsyEntryPath, "console.log('fake etsy');\n");
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
      OPENCLAW_ETSY_ENTRY: etsyEntryPath,
      PORT: "18080",
    };

    const result = spawnSync("bash", [scriptPath, "gateway"], {
      cwd: rootDir,
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);

    const parsedConfig = JSON.parse(await readFile(configPath, "utf8")) as {
      agents?: {
        defaults?: { workspace?: string };
        list?: Array<{
          id?: string;
          default?: boolean;
          name?: string;
          workspace?: string;
          identity?: { name?: string; emoji?: string };
          model?: { primary?: string };
        }>;
      };
      messages?: { responsePrefix?: string };
      ui?: { assistant?: { name?: string; avatar?: string } };
      tools?: {
        metaSocial?: { enabled?: boolean };
        etsyAutoPost?: { enabled?: boolean; baseUrl?: string; token?: string };
      };
    };
    expect(parsedConfig.agents?.defaults?.workspace).toBe(workspaceDir);
    expect(parsedConfig.messages?.responsePrefix).toBe("auto");
    expect(parsedConfig.ui?.assistant?.name).toBe("Jannetje");
    expect(parsedConfig.ui?.assistant?.avatar).toBe("\u{1F9E1}");
    expect(parsedConfig.tools?.metaSocial?.enabled).toBe(true);
    expect(parsedConfig.tools?.etsyAutoPost?.enabled).toBe(true);
    expect(parsedConfig.tools?.etsyAutoPost?.baseUrl).toBe("http://127.0.0.1:8081");
    expect(parsedConfig.tools?.etsyAutoPost?.token).toBeTruthy();
    expect(parsedConfig.agents?.list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "jannetje",
          default: true,
          name: "Jannetje",
          workspace: workspaceDir,
          identity: expect.objectContaining({
            name: "Jannetje",
            emoji: "\u{1F9E1}",
          }),
          model: expect.objectContaining({
            primary: "anthropic/claude-sonnet-4-5",
          }),
        }),
      ]),
    );

    expect(await readFile(join(workspaceDir, "AGENTS.md"), "utf8")).toContain("template agents");
    expect(await readFile(join(workspaceDir, "IDENTITY.md"), "utf8")).toContain("Jannetje");
    expect(await readFile(join(workspaceDir, "SOUL.md"), "utf8")).toContain("I am Jannetje.");
    expect(await readFile(join(workspaceDir, "TOOLS.md"), "utf8")).toContain("template tools");
    expect(await readFile(join(workspaceDir, "USER.md"), "utf8")).toContain("Loulou");
    expect((await stat(join(workspaceDir, "skills"))).isDirectory()).toBe(true);
    await expect(stat(join(workspaceDir, "BOOTSTRAP.md"))).rejects.toThrow();

    const nodeLog = await readFile(nodeLogPath, "utf8");
    expect(nodeLog).toContain("fake-etsy-entry.js");
    expect(nodeLog).toContain("PORT=8081");
    expect(nodeLog).toContain("RSS_DISABLE_HEALTH_SERVER=0");
  });

  it("copies missing onboarding files from legacy workspace before templates", async () => {
    if (!hasBash()) {
      return;
    }

    const rootDir = await mkdtemp(join(tmpdir(), "openclaw-entrypoint-"));
    const scriptPath = await installEntrypoint(rootDir);
    const binDir = join(rootDir, "bin");
    const nodeLogPath = join(rootDir, "node-stub.log");
    const stateDir = join(rootDir, "state");
    const workspaceDir = join(rootDir, "workspace-active");
    const legacyDir = join(rootDir, "workspace-legacy");
    const configPath = join(stateDir, "openclaw.json");

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
    expect(await readFile(join(workspaceDir, "IDENTITY.md"), "utf8")).toContain("Jannetje");
  });
});
