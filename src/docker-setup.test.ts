import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

async function writeDockerStub(binDir: string, logPath: string) {
  const stub = `#!/usr/bin/env bash
set -euo pipefail
log="$DOCKER_STUB_LOG"
if [[ "\${1:-}" == "compose" && "\${2:-}" == "version" ]]; then
  exit 0
fi
if [[ "\${1:-}" == "build" ]]; then
  echo "build $*" >>"$log"
  exit 0
fi
if [[ "\${1:-}" == "compose" ]]; then
  echo "compose $*" >>"$log"
  exit 0
fi
echo "unknown $*" >>"$log"
exit 0
`;

  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "docker"), stub, { mode: 0o755 });
  await writeFile(logPath, "");
}

describe("docker-setup.sh", () => {
  it("handles unset optional env vars under strict mode", async () => {
    const assocCheck = spawnSync("bash", ["-c", "declare -A _t=()"], {
      encoding: "utf8",
    });
    if (assocCheck.status !== 0) {
      return;
    }

    const rootDir = await mkdtemp(join(tmpdir(), "openclaw-docker-setup-"));
    const scriptPath = join(rootDir, "docker-setup.sh");
    const dockerfilePath = join(rootDir, "Dockerfile");
    const composePath = join(rootDir, "docker-compose.yml");
    const binDir = join(rootDir, "bin");
    const logPath = join(rootDir, "docker-stub.log");

    const script = await readFile(join(repoRoot, "docker-setup.sh"), "utf8");
    await writeFile(scriptPath, script, { mode: 0o755 });
    await writeFile(dockerfilePath, "FROM scratch\n");
    await writeFile(
      composePath,
      "services:\n  openclaw-gateway:\n    image: noop\n  openclaw-cli:\n    image: noop\n",
    );
    await writeDockerStub(binDir, logPath);

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      DOCKER_STUB_LOG: logPath,
      OPENCLAW_GATEWAY_TOKEN: "test-token",
      OPENCLAW_CONFIG_DIR: join(rootDir, "config"),
      OPENCLAW_WORKSPACE_DIR: join(rootDir, "openclaw"),
    };
    delete env.OPENCLAW_DOCKER_APT_PACKAGES;
    delete env.OPENCLAW_EXTRA_MOUNTS;
    delete env.OPENCLAW_HOME_VOLUME;

    const result = spawnSync("bash", [scriptPath], {
      cwd: rootDir,
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);

    const envFile = await readFile(join(rootDir, ".env"), "utf8");
    expect(envFile).toContain("OPENCLAW_DOCKER_APT_PACKAGES=");
    expect(envFile).toContain("OPENCLAW_EXTRA_MOUNTS=");
    expect(envFile).toContain("OPENCLAW_HOME_VOLUME=");
  });

  it("plumbs OPENCLAW_DOCKER_APT_PACKAGES into .env and docker build args", async () => {
    const assocCheck = spawnSync("bash", ["-c", "declare -A _t=()"], {
      encoding: "utf8",
    });
    if (assocCheck.status !== 0) {
      return;
    }

    const rootDir = await mkdtemp(join(tmpdir(), "openclaw-docker-setup-"));
    const scriptPath = join(rootDir, "docker-setup.sh");
    const dockerfilePath = join(rootDir, "Dockerfile");
    const composePath = join(rootDir, "docker-compose.yml");
    const binDir = join(rootDir, "bin");
    const logPath = join(rootDir, "docker-stub.log");

    const script = await readFile(join(repoRoot, "docker-setup.sh"), "utf8");
    await writeFile(scriptPath, script, { mode: 0o755 });
    await writeFile(dockerfilePath, "FROM scratch\n");
    await writeFile(
      composePath,
      "services:\n  openclaw-gateway:\n    image: noop\n  openclaw-cli:\n    image: noop\n",
    );
    await writeDockerStub(binDir, logPath);

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      DOCKER_STUB_LOG: logPath,
      OPENCLAW_DOCKER_APT_PACKAGES: "ffmpeg build-essential",
      OPENCLAW_GATEWAY_TOKEN: "test-token",
      OPENCLAW_CONFIG_DIR: join(rootDir, "config"),
      OPENCLAW_WORKSPACE_DIR: join(rootDir, "openclaw"),
      OPENCLAW_EXTRA_MOUNTS: "",
      OPENCLAW_HOME_VOLUME: "",
    };

    const result = spawnSync("bash", [scriptPath], {
      cwd: rootDir,
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);

    const envFile = await readFile(join(rootDir, ".env"), "utf8");
    expect(envFile).toContain("OPENCLAW_DOCKER_APT_PACKAGES=ffmpeg build-essential");

    const log = await readFile(logPath, "utf8");
    expect(log).toContain("--build-arg OPENCLAW_DOCKER_APT_PACKAGES=ffmpeg build-essential");
  });

  it("keeps docker-compose gateway command in sync", async () => {
    const compose = await readFile(join(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose).not.toContain("gateway-daemon");
    expect(compose).toContain('"gateway"');
  });

  it("keeps DigitalOcean compose services aligned to /home/node/.openclaw", async () => {
    const compose = await readFile(join(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose).toContain("mission-control:");
    expect(compose).toContain("OPENCLAW_STATE_DIR: /home/node/.openclaw");
    expect(compose).toContain("OPENCLAW_CONFIG_PATH: /home/node/.openclaw/openclaw.json");
    expect(compose).toContain("OPENCLAW_WORKSPACE_DIR: /home/node/.openclaw/workspace");
    expect(compose).toContain("RSS_STATE_PATH: /home/node/.openclaw/state/etsy_rss.json");
    expect(compose).toContain("CLAWDBOT_STATE_DIR: /home/node/.openclaw");
    expect(compose).toContain("MOLTBOT_STATE_DIR: /home/node/.openclaw");
    expect(compose).toContain("${OPENCLAW_HOST_DATA_ROOT:-/data/openclaw}:/home/node/.openclaw");
    expect(compose).not.toContain("${OPENCLAW_STATE_DIR:-/home/node/.openclaw}");
  });

  it("keeps droplet deploy script defaults aligned to /home/node/.openclaw", async () => {
    const gatewayScript = await readFile(
      join(repoRoot, "scripts", "deploy", "run-gateway.sh"),
      "utf8",
    );
    const missionControlScript = await readFile(
      join(repoRoot, "scripts", "deploy", "run-mission-control.sh"),
      "utf8",
    );
    const prepareDropletScript = await readFile(
      join(repoRoot, "scripts", "deploy", "prepare-droplet.sh"),
      "utf8",
    );

    expect(gatewayScript).toContain(
      'OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"',
    );
    expect(gatewayScript).toContain(
      'OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-${OPENCLAW_STATE_DIR}/workspace}"',
    );
    expect(gatewayScript).toContain(
      'RSS_STATE_PATH="${RSS_STATE_PATH:-${OPENCLAW_STATE_DIR}/state/etsy_rss.json}"',
    );

    expect(missionControlScript).toContain(
      'OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"',
    );
    expect(missionControlScript).toContain(
      'OPENCLAW_MISSION_CONTROL_CONFIG_PATH="${OPENCLAW_MISSION_CONTROL_CONFIG_PATH:-${OPENCLAW_CONFIG_PATH}}"',
    );

    expect(prepareDropletScript).toContain(
      'OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-${OPENCLAW_DATA_ROOT}}"',
    );
    expect(prepareDropletScript).toContain(
      'OPENCLAW_ETSY_STATE_DIR="${OPENCLAW_ETSY_STATE_DIR:-${OPENCLAW_DATA_ROOT}/state}"',
    );
  });

  it("keeps DigitalOcean examples aligned to container paths under /home/node/.openclaw", async () => {
    const envExample = await readFile(join(repoRoot, ".env.example"), "utf8");
    const digitalOceanExample = await readFile(
      join(repoRoot, "deploy", "digitalocean", "openclaw.example.json5"),
      "utf8",
    );

    expect(envExample).toContain("OPENCLAW_STATE_DIR=/home/node/.openclaw");
    expect(envExample).toContain("OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json");
    expect(envExample).toContain("OPENCLAW_WORKSPACE_DIR=/home/node/.openclaw/workspace");
    expect(envExample).toContain("RSS_STATE_PATH=/home/node/.openclaw/state/etsy_rss.json");

    expect(digitalOceanExample).toContain('file: "/home/node/.openclaw/logs/openclaw.log"');
    expect(digitalOceanExample).toContain('workspace: "/home/node/.openclaw/workspace/jannetje"');
    expect(digitalOceanExample).not.toContain('workspace: "/data/openclaw/workspace/');
  });
});
