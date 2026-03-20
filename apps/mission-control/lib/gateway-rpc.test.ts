import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function writeGatewayConfig(configPath: string, payload: unknown) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(payload, null, 2), "utf8");
}

describe("loadMissionGatewayConnection", () => {
  it("prefers explicit Mission Control gateway env overrides", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mission-control-"));
    const configPath = path.join(root, "state", "openclaw.json");

    await writeGatewayConfig(configPath, {
      gateway: {
        mode: "local",
        bind: "loopback",
        port: 18789,
        auth: { token: "config-token" },
      },
    });

    vi.stubEnv("OPENCLAW_MISSION_CONTROL_CONFIG_PATH", configPath);
    vi.stubEnv("OPENCLAW_MISSION_CONTROL_GATEWAY_URL", "ws://openclaw-gateway:18789");
    vi.stubEnv("OPENCLAW_MISSION_CONTROL_GATEWAY_TOKEN", "mission-token");

    const { loadMissionGatewayConnection } = await import("./gateway-rpc");
    const connection = await loadMissionGatewayConnection();

    expect(connection.configPath).toBe(configPath);
    expect(connection.url).toBe("ws://openclaw-gateway:18789");
    expect(connection.token).toBe("mission-token");
    expect(connection.rejectUnauthorized).toBe(true);
  });

  it("falls back to OPENCLAW_STATE_DIR when explicit Mission Control config path is unset", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mission-control-"));
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");

    await writeGatewayConfig(configPath, {
      gateway: {
        mode: "local",
        bind: "loopback",
        port: 19001,
        auth: { token: "config-token" },
      },
    });

    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const { loadMissionGatewayConnection } = await import("./gateway-rpc");
    const connection = await loadMissionGatewayConnection();

    expect(connection.configPath).toBe(configPath);
    expect(connection.url).toBe("ws://127.0.0.1:19001");
    expect(connection.token).toBe("config-token");
    expect(connection.rejectUnauthorized).toBe(true);
  });
});
