import "server-only";

import { callMissionGateway, loadMissionGatewayConnection } from "./gateway-rpc";

type AnyRecord = Record<string, unknown>;

type ConfigSnapshot = {
  path?: string | null;
  config?: AnyRecord | null;
};

type GatewayAgentRow = {
  id: string;
  name?: string;
  identity?: {
    name?: string;
    emoji?: string;
    avatarUrl?: string;
  };
};

type AgentsListResult = {
  defaultId: string;
  agents: GatewayAgentRow[];
};

type GatewaySessionRow = {
  key: string;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  updatedAt: number | null;
  model?: string;
  modelProvider?: string;
  thinkingLevel?: string;
  surface?: string;
  subject?: string;
  space?: string;
};

type SessionsListResult = {
  sessions: GatewaySessionRow[];
};

type SkillStatusEntry = {
  name: string;
  description: string;
  source: string;
  skillKey: string;
  bundled?: boolean;
  emoji?: string;
  homepage?: string;
  eligible: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  missing: {
    bins?: string[];
    anyBins?: string[];
    env?: string[];
    config?: string[];
    os?: string[];
  };
};

type SkillStatusReport = {
  workspaceDir: string;
  managedSkillsDir: string;
  skills: SkillStatusEntry[];
};

export type MissionToolPolicy = {
  profile: string | null;
  allow: string[];
  alsoAllow: string[];
  deny: string[];
};

export type MissionAgent = {
  id: string;
  name: string;
  emoji: string;
  avatarUrl: string | null;
  workspaceDir: string | null;
  managedSkillsDir: string | null;
  model: string | null;
  subagentModel: string | null;
  subagentThinking: string | null;
  allowAgents: string[];
  toolPolicy: MissionToolPolicy;
  subagentToolPolicy: MissionToolPolicy;
  sessionCount: number;
  subagentCount: number;
  customToolCount: number;
};

export type MissionSubagent = {
  key: string;
  agentId: string;
  title: string;
  preview: string | null;
  updatedAt: number | null;
  model: string | null;
  thinkingLevel: string | null;
};

export type MissionTool = {
  agentId: string;
  name: string;
  description: string;
  skillKey: string;
  source: string;
  emoji: string | null;
  homepage: string | null;
  status: "ready" | "needs-setup" | "disabled" | "blocked";
  missing: string[];
};

export type MissionSession = {
  key: string;
  agentId: string;
  title: string;
  preview: string | null;
  updatedAt: number | null;
  model: string | null;
};

export type MissionSnapshot = {
  generatedAt: string;
  gateway: {
    connected: boolean;
    error: string | null;
  };
  configPath: string | null;
  summary: {
    agents: number;
    subagents: number;
    customTools: number;
    sessions: number;
  };
  agents: MissionAgent[];
  subagents: MissionSubagent[];
  tools: MissionTool[];
  sessions: MissionSession[];
};

function asRecord(value: unknown): AnyRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AnyRecord)
    : undefined;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

function parseSessionAgentId(key: string): string {
  const match = /^agent:([^:]+):/.exec(key);
  return match?.[1] ?? "main";
}

function isSubagentSession(key: string) {
  return key.includes(":subagent:");
}

function readModelSelection(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  const record = asRecord(value);
  return asString(record?.primary);
}

function readToolPolicy(...sources: Array<unknown>): MissionToolPolicy {
  let profile: string | null = null;
  const allow: string[] = [];
  const alsoAllow: string[] = [];
  const deny: string[] = [];

  for (const source of sources) {
    const record = asRecord(source);
    if (!record) {
      continue;
    }
    profile = asString(record.profile) ?? profile;
    allow.push(...asStringArray(record.allow));
    alsoAllow.push(...asStringArray(record.alsoAllow));
    deny.push(...asStringArray(record.deny));
  }

  return {
    profile,
    allow: uniqueStrings(allow),
    alsoAllow: uniqueStrings(alsoAllow),
    deny: uniqueStrings(deny),
  };
}

function labelForSession(session: GatewaySessionRow) {
  return (
    session.label?.trim() ||
    session.displayName?.trim() ||
    session.derivedTitle?.trim() ||
    session.subject?.trim() ||
    session.key
  );
}

function previewForSession(session: GatewaySessionRow) {
  return session.lastMessagePreview?.trim() || null;
}

function modelLabel(provider?: string | null, model?: string | null) {
  const parts = [provider?.trim(), model?.trim()].filter(Boolean);
  return parts.length > 0 ? parts.join("/") : null;
}

function mapAgentConfig(config: AnyRecord | null) {
  const agentsRoot = asRecord(config?.agents);
  const list = Array.isArray(agentsRoot?.list) ? agentsRoot.list : [];
  const byId = new Map<string, AnyRecord>();

  for (const entry of list) {
    const record = asRecord(entry);
    const id = asString(record?.id);
    if (record && id) {
      byId.set(id, record);
    }
  }

  return {
    defaults: asRecord(agentsRoot?.defaults),
    byId,
  };
}

function mapSkillStatusToTools(agentId: string, report: SkillStatusReport | null): MissionTool[] {
  if (!report) {
    return [];
  }

  return report.skills
    .filter((skill) => skill.bundled !== true)
    .map((skill) => {
      const missing = uniqueStrings([
        ...(skill.missing.bins ?? []),
        ...(skill.missing.anyBins ?? []),
        ...(skill.missing.env ?? []),
        ...(skill.missing.config ?? []),
        ...(skill.missing.os ?? []),
      ]);
      const status = skill.blockedByAllowlist
        ? "blocked"
        : skill.disabled
          ? "disabled"
          : skill.eligible && missing.length === 0
            ? "ready"
            : "needs-setup";
      return {
        agentId,
        name: skill.name,
        description: skill.description,
        skillKey: skill.skillKey,
        source: skill.source,
        emoji: skill.emoji?.trim() || null,
        homepage: skill.homepage?.trim() || null,
        status,
        missing,
      } satisfies MissionTool;
    });
}

async function loadSkillReports(
  agentIds: string[],
  connection: Awaited<ReturnType<typeof loadMissionGatewayConnection>>,
) {
  const settled = await Promise.all(
    agentIds.map(async (agentId) => {
      try {
        const report = await callMissionGateway<SkillStatusReport>(connection, {
          method: "skills.status",
          params: { agentId },
          timeoutMs: 10_000,
        });
        return [agentId, report] as const;
      } catch {
        return [agentId, null] as const;
      }
    }),
  );

  return new Map<string, SkillStatusReport | null>(settled);
}

export async function getMissionControlSnapshot(): Promise<MissionSnapshot> {
  const connection = await loadMissionGatewayConnection();

  try {
    const [agentsResult, sessionsResult, configResult] = await Promise.all([
      callMissionGateway<AgentsListResult>(connection, {
        method: "agents.list",
        params: {},
        timeoutMs: 10_000,
      }),
      callMissionGateway<SessionsListResult>(connection, {
        method: "sessions.list",
        params: {
          limit: 200,
          includeGlobal: true,
          includeUnknown: false,
          includeDerivedTitles: true,
          includeLastMessage: true,
        },
        timeoutMs: 10_000,
      }),
      callMissionGateway<ConfigSnapshot>(connection, {
        method: "config.get",
        params: {},
        timeoutMs: 10_000,
      }),
    ]);

    const config = asRecord(configResult.config) ?? null;
    const { defaults, byId } = mapAgentConfig(config);
    const defaultModel = readModelSelection(defaults?.model);
    const defaultSubagents = asRecord(defaults?.subagents);
    const globalTools = asRecord(config?.tools);
    const globalSubagentTools = asRecord(asRecord(globalTools?.subagents)?.tools);
    const gatewayAgents = Array.isArray(agentsResult.agents) ? agentsResult.agents : [];
    const sessions = Array.isArray(sessionsResult.sessions) ? sessionsResult.sessions : [];
    const agentIds = uniqueStrings([
      agentsResult.defaultId,
      ...gatewayAgents.map((agent) => agent.id),
      ...sessions.map((session) => parseSessionAgentId(session.key)),
    ]);
    const skillReports = await loadSkillReports(agentIds, connection);
    const tools = agentIds.flatMap((agentId) =>
      mapSkillStatusToTools(agentId, skillReports.get(agentId) ?? null),
    );

    const agents = agentIds
      .map((agentId) => {
        const gatewayAgent = gatewayAgents.find((agent) => agent.id === agentId);
        const agentConfig = byId.get(agentId);
        const skillReport = skillReports.get(agentId) ?? null;
        const subagentsConfig = asRecord(agentConfig?.subagents);
        const toolPolicy = readToolPolicy(globalTools, agentConfig?.tools);
        const subagentToolPolicy = readToolPolicy(globalSubagentTools, subagentsConfig?.tools);
        const sessionsForAgent = sessions.filter((session) => parseSessionAgentId(session.key) === agentId);
        const subagentSessions = sessionsForAgent.filter((session) => isSubagentSession(session.key));

        return {
          id: agentId,
          name:
            gatewayAgent?.name?.trim() ||
            gatewayAgent?.identity?.name?.trim() ||
            agentId,
          emoji: gatewayAgent?.identity?.emoji?.trim() || "",
          avatarUrl: gatewayAgent?.identity?.avatarUrl?.trim() || null,
          workspaceDir:
            skillReport?.workspaceDir?.trim() ||
            asString(agentConfig?.workspace) ||
            null,
          managedSkillsDir:
            skillReport?.managedSkillsDir?.trim() || null,
          model: readModelSelection(agentConfig?.model) ?? defaultModel,
          subagentModel:
            readModelSelection(subagentsConfig?.model) ?? readModelSelection(defaultSubagents?.model),
          subagentThinking:
            asString(subagentsConfig?.thinking) ?? asString(defaultSubagents?.thinking),
          allowAgents: asStringArray(subagentsConfig?.allowAgents),
          toolPolicy,
          subagentToolPolicy,
          sessionCount: sessionsForAgent.length,
          subagentCount: subagentSessions.length,
          customToolCount: tools.filter((tool) => tool.agentId === agentId).length,
        } satisfies MissionAgent;
      })
      .toSorted((a, b) => a.name.localeCompare(b.name));

    const subagents = sessions
      .filter((session) => isSubagentSession(session.key))
      .map((session) => ({
        key: session.key,
        agentId: parseSessionAgentId(session.key),
        title: labelForSession(session),
        preview: previewForSession(session),
        updatedAt: session.updatedAt,
        model: modelLabel(session.modelProvider, session.model),
        thinkingLevel: session.thinkingLevel?.trim() || null,
      }))
      .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

    const recentSessions = sessions
      .filter((session) => !isSubagentSession(session.key))
      .map((session) => ({
        key: session.key,
        agentId: parseSessionAgentId(session.key),
        title: labelForSession(session),
        preview: previewForSession(session),
        updatedAt: session.updatedAt,
        model: modelLabel(session.modelProvider, session.model),
      }))
      .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

    return {
      generatedAt: new Date().toISOString(),
      gateway: {
        connected: true,
        error: null,
      },
      configPath: asString(configResult.path),
      summary: {
        agents: agents.length,
        subagents: subagents.length,
        customTools: tools.length,
        sessions: recentSessions.length,
      },
      agents,
      subagents,
      tools: [...tools].toSorted((a, b) => {
        const agentOrder = a.agentId.localeCompare(b.agentId);
        if (agentOrder !== 0) {
          return agentOrder;
        }
        return a.name.localeCompare(b.name);
      }),
      sessions: recentSessions,
    };
  } catch (error) {
    return {
      generatedAt: new Date().toISOString(),
      gateway: {
        connected: false,
        error: error instanceof Error ? error.message : String(error),
      },
      configPath: connection.configPath,
      summary: {
        agents: 0,
        subagents: 0,
        customTools: 0,
        sessions: 0,
      },
      agents: [],
      subagents: [],
      tools: [],
      sessions: [],
    };
  }
}
