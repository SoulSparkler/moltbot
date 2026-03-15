import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

function hasBash(): boolean {
  const check = spawnSync("bash", ["-lc", "echo ok"], { encoding: "utf8" });
  return check.status === 0;
}

async function createStartScriptFixture(rootDir: string) {
  const scriptsDir = join(rootDir, "scripts");
  const logPath = join(rootDir, "run-node.log");
  await mkdir(scriptsDir, { recursive: true });
  await writeFile(join(rootDir, "package.json"), '{ "type": "module" }\n');
  await writeFile(
    join(scriptsDir, "start.mjs"),
    await readFile(join(repoRoot, "scripts", "start.mjs"), "utf8"),
  );
  await writeFile(
    join(scriptsDir, "bootstrap-ombaa.sh"),
    "#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n",
    { mode: 0o755 },
  );
  await writeFile(
    join(scriptsDir, "run-node.mjs"),
    [
      'import { appendFileSync } from "node:fs";',
      "appendFileSync(process.env.RUN_NODE_LOG_PATH, `${JSON.stringify(process.argv.slice(2))}\\n`);",
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  await writeFile(logPath, "");

  return { logPath };
}

describe("scripts/start.mjs", () => {
  it("forces Claude Sonnet 4.5 on Railway before launching the gateway", async () => {
    if (!hasBash()) {
      return;
    }

    const rootDir = await mkdtemp(join(repoRoot, ".tmp-openclaw-start-"));
    try {
      const { logPath } = await createStartScriptFixture(rootDir);
      const stateDir = join(rootDir, "state");
      const configPath = join(stateDir, "openclaw.json");
      const workspaceDir = join(rootDir, "workspace");

      await mkdir(stateDir, { recursive: true });
      await writeFile(
        configPath,
        `${JSON.stringify(
          {
            agents: {
              defaults: {
                model: {
                  primary: "anthropic/claude-3-5-sonnet",
                  fallbacks: ["claude-3-5-sonnet-20241022", "anthropic/claude-sonnet-4-5"],
                },
                replyPipeline: {
                  enabled: true,
                  brainModel: "claude-3-5-sonnet-20241022",
                  muscleModels: ["anthropic/claude-3-5-sonnet", "anthropic/claude-sonnet-4-5"],
                },
                models: {
                  "anthropic/claude-3-5-sonnet": { alias: "legacy" },
                },
              },
              list: [
                { id: "main", default: true, model: "claude-3-5-sonnet-20241022" },
                {
                  id: "writer",
                  model: {
                    primary: "anthropic/claude-3-5-sonnet",
                    fallbacks: ["anthropic/claude-3-5-sonnet", "openai/gpt-4o"],
                  },
                },
              ],
            },
          },
          null,
          2,
        )}\n`,
      );

      const result = spawnSync(process.execPath, ["scripts/start.mjs"], {
        cwd: rootDir,
        env: {
          ...process.env,
          RAILWAY_ENVIRONMENT: "production",
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_WORKSPACE_DIR: workspaceDir,
          OPENCLAW_GATEWAY_TOKEN: "railway-token",
          PORT: "19090",
          RUN_NODE_LOG_PATH: logPath,
        },
        encoding: "utf8",
      });

      expect(result.status).toBe(0);

      const parsedConfig = JSON.parse(await readFile(configPath, "utf8")) as {
        agents?: {
          defaults?: {
            model?: { primary?: string; fallbacks?: string[] };
            models?: Record<string, unknown>;
            replyPipeline?: { brainModel?: string; muscleModels?: string[] };
          };
          list?: Array<{ model?: string | { primary?: string; fallbacks?: string[] } }>;
        };
      };

      expect(parsedConfig.agents?.defaults?.model).toEqual({
        primary: "anthropic/claude-sonnet-4-5",
        fallbacks: [],
      });
      expect(parsedConfig.agents?.defaults?.replyPipeline?.brainModel).toBe(
        "anthropic/claude-sonnet-4-5",
      );
      expect(parsedConfig.agents?.defaults?.replyPipeline?.muscleModels).toEqual([
        "anthropic/claude-sonnet-4-5",
      ]);
      expect(parsedConfig.agents?.defaults?.models).not.toHaveProperty(
        "anthropic/claude-3-5-sonnet",
      );
      expect(parsedConfig.agents?.defaults?.models).toHaveProperty("anthropic/claude-sonnet-4-5");
      expect(parsedConfig.agents?.list?.[0]?.model).toBe("anthropic/claude-sonnet-4-5");
      expect(parsedConfig.agents?.list?.[1]?.model).toEqual({
        primary: "anthropic/claude-sonnet-4-5",
        fallbacks: ["openai/gpt-4o"],
      });
      expect(await readFile(logPath, "utf8")).toContain('"gateway"');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("does not rewrite local configs outside Railway", async () => {
    if (!hasBash()) {
      return;
    }

    const rootDir = await mkdtemp(join(repoRoot, ".tmp-openclaw-start-"));
    try {
      const { logPath } = await createStartScriptFixture(rootDir);
      const stateDir = join(rootDir, "state");
      const configPath = join(stateDir, "openclaw.json");
      const workspaceDir = join(rootDir, "workspace");
      const originalConfig = {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-3-5-sonnet",
              fallbacks: ["claude-3-5-sonnet-20241022"],
            },
          },
        },
      };

      await mkdir(stateDir, { recursive: true });
      await writeFile(configPath, `${JSON.stringify(originalConfig, null, 2)}\n`);

      const result = spawnSync(process.execPath, ["scripts/start.mjs"], {
        cwd: rootDir,
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_WORKSPACE_DIR: workspaceDir,
          OPENCLAW_GATEWAY_TOKEN: "local-token",
          PORT: "19091",
          RUN_NODE_LOG_PATH: logPath,
        },
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(originalConfig);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
