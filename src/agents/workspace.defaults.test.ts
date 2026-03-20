import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("DEFAULT_AGENT_WORKSPACE_DIR", () => {
  it("prefers OPENCLAW_WORKSPACE_DIR at module import time", async () => {
    const workspaceDir = path.join(path.sep, "srv", "openclaw-workspace");
    vi.stubEnv("OPENCLAW_WORKSPACE_DIR", workspaceDir);
    vi.stubEnv("OPENCLAW_HOME", path.join(path.sep, "srv", "openclaw-home"));
    vi.resetModules();

    const mod = await import("./workspace.js");
    expect(mod.DEFAULT_AGENT_WORKSPACE_DIR).toBe(path.resolve(workspaceDir));
  });

  it("uses OPENCLAW_HOME at module import time", async () => {
    const home = path.join(path.sep, "srv", "openclaw-home");
    vi.stubEnv("OPENCLAW_HOME", home);
    vi.stubEnv("HOME", path.join(path.sep, "home", "other"));
    vi.resetModules();

    const mod = await import("./workspace.js");
    expect(mod.DEFAULT_AGENT_WORKSPACE_DIR).toBe(
      path.join(path.resolve(home), ".openclaw", "workspace"),
    );
  });
});
