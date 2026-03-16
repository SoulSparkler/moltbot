import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearInternalHooks,
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { resolveBootstrapContextForRun, resolveBootstrapFilesForRun } from "./bootstrap-files.js";
import { resolveWorkspaceTemplateDir } from "./workspace-templates.js";

describe("resolveBootstrapFilesForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("applies bootstrap hook overrides", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles = [
        ...context.bootstrapFiles,
        {
          name: "EXTRA.md",
          path: path.join(context.workspaceDir, "EXTRA.md"),
          content: "extra",
          missing: false,
        },
      ];
    });

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    expect(files.some((file) => file.name === "EXTRA.md")).toBe(true);
  });
});

describe("resolveBootstrapContextForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("returns context files for hook-adjusted bootstrap files", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles = [
        ...context.bootstrapFiles,
        {
          name: "EXTRA.md",
          path: path.join(context.workspaceDir, "EXTRA.md"),
          content: "extra",
          missing: false,
        },
      ];
    });

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const result = await resolveBootstrapContextForRun({ workspaceDir });
    const extra = result.contextFiles.find((file) => file.path === "EXTRA.md");

    expect(extra?.content).toBe("extra");
  });

  it("overrides generic Jannetje persona files and removes BOOTSTRAP.md", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-jannetje-bootstrap-");
    const templateDir = await resolveWorkspaceTemplateDir();

    await Promise.all([
      fs.writeFile(
        path.join(workspaceDir, "IDENTITY.md"),
        await fs.readFile(path.join(templateDir, "IDENTITY.md"), "utf-8"),
        "utf-8",
      ),
      fs.writeFile(
        path.join(workspaceDir, "SOUL.md"),
        await fs.readFile(path.join(templateDir, "SOUL.md"), "utf-8"),
        "utf-8",
      ),
      fs.writeFile(
        path.join(workspaceDir, "USER.md"),
        await fs.readFile(path.join(templateDir, "USER.md"), "utf-8"),
        "utf-8",
      ),
      fs.writeFile(path.join(workspaceDir, "BOOTSTRAP.md"), "bootstrap", "utf-8"),
    ]);

    const result = await resolveBootstrapContextForRun({
      workspaceDir,
      agentId: "jannetje",
    });

    expect(result.bootstrapFiles.some((file) => file.name === "BOOTSTRAP.md")).toBe(false);
    expect(result.contextFiles.find((file) => file.path === "IDENTITY.md")?.content).toContain(
      "- **Name:** Jannetje",
    );
    expect(result.contextFiles.find((file) => file.path === "SOUL.md")?.content).toContain(
      "I am Jannetje",
    );
    expect(result.contextFiles.find((file) => file.path === "USER.md")?.content).toContain(
      "- **Name:** Loulou",
    );
  });

  it("preserves customized Jannetje identity and user files", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-jannetje-custom-");

    await Promise.all([
      fs.writeFile(
        path.join(workspaceDir, "IDENTITY.md"),
        [
          "# IDENTITY.md",
          "",
          "- **Name:** Jannetje",
          "- **Creature:** studio fox",
          "- **Emoji:** 🧡",
        ].join("\n"),
        "utf-8",
      ),
      fs.writeFile(
        path.join(workspaceDir, "USER.md"),
        ["# USER.md", "", "- **Name:** Loulou", "- **What to call them:** Lou"].join("\n"),
        "utf-8",
      ),
    ]);

    const result = await resolveBootstrapContextForRun({
      workspaceDir,
      agentId: "jannetje",
    });

    expect(result.contextFiles.find((file) => file.path === "IDENTITY.md")?.content).toContain(
      "studio fox",
    );
    expect(result.contextFiles.find((file) => file.path === "USER.md")?.content).toContain(
      "- **What to call them:** Lou",
    );
  });

  it("derives Jannetje overrides from the session key when agentId is omitted", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-jannetje-session-key-");
    const templateDir = await resolveWorkspaceTemplateDir();

    await fs.writeFile(
      path.join(workspaceDir, "IDENTITY.md"),
      await fs.readFile(path.join(templateDir, "IDENTITY.md"), "utf-8"),
      "utf-8",
    );

    const result = await resolveBootstrapContextForRun({
      workspaceDir,
      sessionKey: "agent:jannetje:main",
    });

    expect(result.contextFiles.find((file) => file.path === "IDENTITY.md")?.content).toContain(
      "- **Name:** Jannetje",
    );
  });
});
