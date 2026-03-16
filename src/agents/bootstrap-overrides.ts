import fs from "node:fs/promises";
import path from "node:path";
import { parseIdentityMarkdown } from "./identity-file.js";
import { resolveWorkspaceTemplateDir } from "./workspace-templates.js";
import {
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_USER_FILENAME,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

const JANNETJE_AGENT_ID = "jannetje";
const JANNETJE_TEMPLATE_FILES = {
  [DEFAULT_IDENTITY_FILENAME]: "IDENTITY.jannetje.md",
  [DEFAULT_SOUL_FILENAME]: "SOUL.jannetje.md",
  [DEFAULT_USER_FILENAME]: "USER.jannetje.md",
} as const;

type JannetjeTemplateTarget = keyof typeof JANNETJE_TEMPLATE_FILES;

let cachedTemplates:
  | Promise<{
      defaults: Record<JannetjeTemplateTarget, string>;
      overrides: Record<JannetjeTemplateTarget, string>;
    }>
  | undefined;

function stripFrontMatter(content: string): string {
  if (!content.startsWith("---")) {
    return content;
  }
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) {
    return content;
  }
  return content.slice(endIndex + "\n---".length).replace(/^\s+/, "");
}

function normalizeTextForCompare(content: string): string {
  return stripFrontMatter(content).replace(/\r\n/g, "\n").trim();
}

function normalizeMarkdownLabel(label: string): string {
  return label.replace(/[*_]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function readMarkdownFieldValue(content: string, labels: string[]): string {
  const allowed = new Set(labels.map((label) => normalizeMarkdownLabel(label)));
  for (const rawLine of stripFrontMatter(content).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("-")) {
      continue;
    }
    const match = /^-\s*(.+?):\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const label = normalizeMarkdownLabel(match[1] ?? "");
    if (!allowed.has(label)) {
      continue;
    }
    const value = String(match[2] ?? "")
      .replace(/^[*_]+|[*_]+$/g, "")
      .trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function identityNeedsOverride(content: string): boolean {
  const parsed = parseIdentityMarkdown(stripFrontMatter(content));
  return !(parsed.name && parsed.creature && parsed.emoji);
}

function userNeedsOverride(content: string): boolean {
  return !(
    readMarkdownFieldValue(content, ["Name"]) &&
    readMarkdownFieldValue(content, ["What to call them", "Preferred address"])
  );
}

async function loadTemplateText(templateName: string): Promise<string> {
  const templateDir = await resolveWorkspaceTemplateDir();
  return normalizeTextForCompare(await fs.readFile(path.join(templateDir, templateName), "utf-8"));
}

async function loadJannetjeTemplates(): Promise<{
  defaults: Record<JannetjeTemplateTarget, string>;
  overrides: Record<JannetjeTemplateTarget, string>;
}> {
  cachedTemplates ??= (async () => ({
    defaults: {
      [DEFAULT_IDENTITY_FILENAME]: await loadTemplateText(DEFAULT_IDENTITY_FILENAME),
      [DEFAULT_SOUL_FILENAME]: await loadTemplateText(DEFAULT_SOUL_FILENAME),
      [DEFAULT_USER_FILENAME]: await loadTemplateText(DEFAULT_USER_FILENAME),
    },
    overrides: {
      [DEFAULT_IDENTITY_FILENAME]: await loadTemplateText(
        JANNETJE_TEMPLATE_FILES[DEFAULT_IDENTITY_FILENAME],
      ),
      [DEFAULT_SOUL_FILENAME]: await loadTemplateText(
        JANNETJE_TEMPLATE_FILES[DEFAULT_SOUL_FILENAME],
      ),
      [DEFAULT_USER_FILENAME]: await loadTemplateText(
        JANNETJE_TEMPLATE_FILES[DEFAULT_USER_FILENAME],
      ),
    },
  }))();
  return cachedTemplates;
}

function shouldOverrideJannetjeFile(params: {
  file: WorkspaceBootstrapFile;
  defaults: Record<JannetjeTemplateTarget, string>;
}): boolean {
  const { file, defaults } = params;
  if (file.missing) {
    return true;
  }
  const content = typeof file.content === "string" ? file.content : "";
  const normalized = normalizeTextForCompare(content);
  if (!normalized) {
    return true;
  }

  if (file.name === DEFAULT_IDENTITY_FILENAME) {
    return normalized === defaults[DEFAULT_IDENTITY_FILENAME] || identityNeedsOverride(content);
  }
  if (file.name === DEFAULT_USER_FILENAME) {
    return normalized === defaults[DEFAULT_USER_FILENAME] || userNeedsOverride(content);
  }
  if (file.name === DEFAULT_SOUL_FILENAME) {
    return normalized === defaults[DEFAULT_SOUL_FILENAME];
  }
  return false;
}

export async function applyBuiltInBootstrapFileOverrides(params: {
  files: WorkspaceBootstrapFile[];
  agentId?: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const agentId = params.agentId?.trim().toLowerCase();
  if (agentId !== JANNETJE_AGENT_ID) {
    return params.files;
  }

  const templates = await loadJannetjeTemplates();
  return params.files.flatMap((file) => {
    if (file.name === DEFAULT_BOOTSTRAP_FILENAME) {
      return [];
    }
    if (!(file.name in JANNETJE_TEMPLATE_FILES)) {
      return [file];
    }
    const target = file.name as JannetjeTemplateTarget;
    if (!shouldOverrideJannetjeFile({ file, defaults: templates.defaults })) {
      return [file];
    }
    return [
      {
        ...file,
        content: templates.overrides[target],
        missing: false,
      },
    ];
  });
}
