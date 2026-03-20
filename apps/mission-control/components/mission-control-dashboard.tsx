"use client";

import { startTransition, useDeferredValue, useEffect, useState } from "react";
import type {
  MissionAgent,
  MissionSession,
  MissionSnapshot,
  MissionTool,
  MissionToolPolicy,
} from "../lib/mission-data";

type DashboardProps = {
  initialSnapshot: MissionSnapshot;
};

const TOOL_STATUS_LABELS: Record<MissionTool["status"], string> = {
  ready: "Ready",
  "needs-setup": "Needs Setup",
  disabled: "Disabled",
  blocked: "Blocked",
};

function formatRelativeTime(value: number | null) {
  if (!value) {
    return "No activity yet";
  }

  const deltaMs = Date.now() - value;
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) {
    return "Just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function joinList(values: string[]) {
  return values.length > 0 ? values.join(", ") : "None";
}

function filterByAgent<T extends { agentId: string }>(items: T[], agentId: string | null) {
  return agentId ? items.filter((item) => item.agentId === agentId) : items;
}

function matchesToolQuery(tool: MissionTool, query: string) {
  if (!query) {
    return true;
  }
  const haystack = `${tool.name} ${tool.description} ${tool.skillKey} ${tool.source}`.toLowerCase();
  return haystack.includes(query);
}

function PolicyBlock({
  title,
  policy,
  emptyLabel,
}: {
  title: string;
  policy: MissionToolPolicy;
  emptyLabel: string;
}) {
  const hasSignals =
    Boolean(policy.profile) ||
    policy.allow.length > 0 ||
    policy.alsoAllow.length > 0 ||
    policy.deny.length > 0;

  return (
    <div className="policy-block">
      <div className="policy-title">{title}</div>
      {hasSignals ? (
        <div className="policy-list">
          <span className="policy-pill policy-pill--neutral">
            Profile: {policy.profile ?? "default"}
          </span>
          {policy.allow.length > 0 ? (
            <span className="policy-pill policy-pill--positive">
              Allow: {joinList(policy.allow)}
            </span>
          ) : null}
          {policy.alsoAllow.length > 0 ? (
            <span className="policy-pill policy-pill--positive">
              Also Allow: {joinList(policy.alsoAllow)}
            </span>
          ) : null}
          {policy.deny.length > 0 ? (
            <span className="policy-pill policy-pill--warning">
              Deny: {joinList(policy.deny)}
            </span>
          ) : null}
        </div>
      ) : (
        <div className="policy-empty">{emptyLabel}</div>
      )}
    </div>
  );
}

function AgentCard({ agent }: { agent: MissionAgent }) {
  return (
    <article className="agent-card">
      <div className="agent-card__header">
        <div className="agent-badge">
          <span className="agent-badge__emoji">{agent.emoji || "AI"}</span>
          <div>
            <div className="agent-badge__name">{agent.name}</div>
            <div className="agent-badge__id">{agent.id}</div>
          </div>
        </div>
        <div className="agent-stats">
          <span>{agent.sessionCount} sessions</span>
          <span>{agent.subagentCount} subagents</span>
          <span>{agent.customToolCount} custom tools</span>
        </div>
      </div>

      <dl className="agent-meta">
        <div>
          <dt>Workspace</dt>
          <dd>{agent.workspaceDir ?? "Inherited from gateway defaults"}</dd>
        </div>
        <div>
          <dt>Managed Skills</dt>
          <dd>{agent.managedSkillsDir ?? "No skills folder detected yet"}</dd>
        </div>
        <div>
          <dt>Primary Model</dt>
          <dd>{agent.model ?? "Default gateway model"}</dd>
        </div>
        <div>
          <dt>Subagent Model</dt>
          <dd>{agent.subagentModel ?? "Inherit parent model"}</dd>
        </div>
        <div>
          <dt>Subagent Thinking</dt>
          <dd>{agent.subagentThinking ?? "Inherit parent thinking"}</dd>
        </div>
        <div>
          <dt>Allowed Spawn Targets</dt>
          <dd>{agent.allowAgents.length > 0 ? joinList(agent.allowAgents) : "Self only"}</dd>
        </div>
      </dl>

      <div className="agent-policies">
        <PolicyBlock
          title="Main Tool Policy"
          policy={agent.toolPolicy}
          emptyLabel="Using the gateway defaults."
        />
        <PolicyBlock
          title="Subagent Tool Policy"
          policy={agent.subagentToolPolicy}
          emptyLabel="Subagents inherit the default tool envelope."
        />
      </div>
    </article>
  );
}

function SessionRail({
  title,
  sessions,
}: {
  title: string;
  sessions: MissionSession[];
}) {
  return (
    <section className="panel">
      <div className="panel__header">
        <h2>{title}</h2>
      </div>
      {sessions.length > 0 ? (
        <div className="session-list">
          {sessions.map((session) => (
            <article key={session.key} className="session-card">
              <div className="session-card__top">
                <span className="session-card__agent">{session.agentId}</span>
                <span className="session-card__time">{formatRelativeTime(session.updatedAt)}</span>
              </div>
              <h3>{session.title}</h3>
              <p>{session.preview ?? "No transcript preview yet."}</p>
              <div className="session-card__meta">
                <span>{session.model ?? "Inherited model"}</span>
                <span className="session-card__key">{session.key}</span>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-panel">Nothing to show for this filter yet.</div>
      )}
    </section>
  );
}

export function MissionControlDashboard({ initialSnapshot }: DashboardProps) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState("all");
  const [toolQuery, setToolQuery] = useState("");
  const deferredToolQuery = useDeferredValue(toolQuery.trim().toLowerCase());
  const activeAgentId = selectedAgentId === "all" ? null : selectedAgentId;

  async function refreshSnapshot() {
    setRefreshing(true);
    try {
      const response = await fetch("/api/mission", {
        cache: "no-store",
      });
      const next = (await response.json()) as MissionSnapshot;
      startTransition(() => {
        setSnapshot(next);
      });
    } catch {
      // Keep the current snapshot; the gateway status panel already shows stale/failed state.
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshSnapshot();
    }, 12_000);
    return () => window.clearInterval(timer);
  }, []);

  const visibleAgents = activeAgentId
    ? snapshot.agents.filter((agent) => agent.id === activeAgentId)
    : snapshot.agents;
  const visibleSubagents = filterByAgent(snapshot.subagents, activeAgentId).slice(0, 18);
  const visibleTools = filterByAgent(snapshot.tools, activeAgentId)
    .filter((tool) => matchesToolQuery(tool, deferredToolQuery))
    .slice(0, 24);
  const visibleSessions = filterByAgent(snapshot.sessions, activeAgentId).slice(0, 10);

  return (
    <main className="mission-shell">
      <section className="hero">
        <div className="hero__copy">
          <p className="eyebrow">Mission Control</p>
          <h1>Keep every agent, subagent, and custom tool in one live board.</h1>
          <p className="hero__lede">
            This dashboard reads directly from your local gateway so you can see who is active,
            which subagents spun up, and which toolkits still need setup before the next build run.
          </p>
        </div>

        <div className="hero__status">
          <div className={`status-card ${snapshot.gateway.connected ? "is-live" : "is-down"}`}>
            <div className="status-card__title">Gateway</div>
            <div className="status-card__value">
              {snapshot.gateway.connected ? "Connected" : "Unavailable"}
            </div>
            <div className="status-card__meta">
              {snapshot.gateway.connected
                ? `Last refresh ${formatRelativeTime(new Date(snapshot.generatedAt).getTime())}`
                : snapshot.gateway.error ?? "The local gateway could not be reached."}
            </div>
          </div>

          <div className="summary-grid">
            <div className="summary-tile">
              <span className="summary-tile__label">Agents</span>
              <strong>{snapshot.summary.agents}</strong>
            </div>
            <div className="summary-tile">
              <span className="summary-tile__label">Subagents</span>
              <strong>{snapshot.summary.subagents}</strong>
            </div>
            <div className="summary-tile">
              <span className="summary-tile__label">Custom Tools</span>
              <strong>{snapshot.summary.customTools}</strong>
            </div>
            <div className="summary-tile">
              <span className="summary-tile__label">Sessions</span>
              <strong>{snapshot.summary.sessions}</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="toolbar">
        <label className="toolbar__field">
          <span>Focus Agent</span>
          <select value={selectedAgentId} onChange={(event) => setSelectedAgentId(event.target.value)}>
            <option value="all">All agents</option>
            {snapshot.agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>

        <label className="toolbar__field toolbar__field--wide">
          <span>Find A Tool</span>
          <input
            type="search"
            value={toolQuery}
            onChange={(event) => setToolQuery(event.target.value)}
            placeholder="Search by tool name, skill key, or source"
          />
        </label>

        <button type="button" className="refresh-button" onClick={() => void refreshSnapshot()}>
          {refreshing ? "Refreshing..." : "Refresh board"}
        </button>
      </section>

      {snapshot.configPath ? (
        <div className="config-note">Config source: {snapshot.configPath}</div>
      ) : null}

      <section className="panel">
        <div className="panel__header">
          <h2>Agent Constellation</h2>
          <p>Configuration, workspace, model, and tool posture for each tracked agent.</p>
        </div>
        {visibleAgents.length > 0 ? (
          <div className="agent-grid">
            {visibleAgents.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
        ) : (
          <div className="empty-panel">No agents matched the current filter.</div>
        )}
      </section>

      <div className="split-panels">
        <SessionRail title="Subagent Watchfloor" sessions={visibleSubagents} />
        <SessionRail title="Recent Session Deck" sessions={visibleSessions} />
      </div>

      <section className="panel">
        <div className="panel__header">
          <h2>Tool Forge</h2>
          <p>
            Custom skills and toolkits detected in each workspace. This is the quickest way to see
            what we built, what is blocked, and what still needs binaries or env setup.
          </p>
        </div>
        {visibleTools.length > 0 ? (
          <div className="tool-grid">
            {visibleTools.map((tool) => (
              <article key={`${tool.agentId}:${tool.skillKey}`} className="tool-card">
                <div className="tool-card__top">
                  <span className="tool-card__agent">{tool.agentId}</span>
                  <span className={`tool-status tool-status--${tool.status}`}>
                    {TOOL_STATUS_LABELS[tool.status]}
                  </span>
                </div>
                <h3>
                  {tool.emoji ? `${tool.emoji} ` : ""}
                  {tool.name}
                </h3>
                <p>{tool.description || "No description yet."}</p>
                <div className="tool-card__meta">
                  <span>Key: {tool.skillKey}</span>
                  <span>Source: {tool.source}</span>
                  {tool.homepage ? <span>Home: {tool.homepage}</span> : null}
                </div>
                {tool.missing.length > 0 ? (
                  <div className="tool-card__missing">Missing: {joinList(tool.missing)}</div>
                ) : (
                  <div className="tool-card__missing tool-card__missing--ready">
                    No blockers detected.
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-panel">
            No custom tools matched this filter yet. Add skills to an agent workspace and they will
            show up here automatically.
          </div>
        )}
      </section>
    </main>
  );
}
