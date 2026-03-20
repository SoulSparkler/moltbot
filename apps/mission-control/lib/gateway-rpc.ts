import "server-only";

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { WebSocket, type ClientOptions, type RawData } from "ws";

type AnyRecord = Record<string, unknown>;

type MissionGatewayConfig = {
  path: string | null;
  config: AnyRecord | null;
};

type MissionGatewayConnection = {
  configPath: string | null;
  url: string;
  token?: string;
  password?: string;
  rejectUnauthorized?: boolean;
};

type ResponseFrame = {
  type?: unknown;
  id?: unknown;
  ok?: unknown;
  payload?: unknown;
  error?: {
    message?: unknown;
  };
};

const DEFAULT_GATEWAY_PORT = 18789;
const PROTOCOL_VERSION = 3;
const DEFAULT_ROLE = "operator";
const DEFAULT_SCOPES = ["operator.admin", "operator.approvals", "operator.pairing"];
const CLIENT_ID = "gateway-client";
const CLIENT_MODE = "backend";

function asRecord(value: unknown): AnyRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AnyRecord)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveHomeDir(env: NodeJS.ProcessEnv = process.env) {
  return path.resolve(env.OPENCLAW_HOME || env.HOME || env.USERPROFILE || os.homedir());
}

function resolveStateDir(env: NodeJS.ProcessEnv = process.env) {
  const override = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }

  const homeDir = resolveHomeDir(env);
  const candidates = [
    path.join(homeDir, ".openclaw"),
    path.join(homeDir, ".clawdbot"),
    path.join(homeDir, ".moltbot"),
    path.join(homeDir, ".moldbot"),
  ];

  const existing = candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });

  return existing ?? candidates[0] ?? path.join(homeDir, ".openclaw");
}

function resolveConfigPath(env: NodeJS.ProcessEnv = process.env) {
  const explicit = env.OPENCLAW_CONFIG_PATH?.trim() || env.CLAWDBOT_CONFIG_PATH?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }

  const stateDir = resolveStateDir(env);
  const candidates = [
    path.join(stateDir, "openclaw.json"),
    path.join(stateDir, "clawdbot.json"),
    path.join(stateDir, "moltbot.json"),
    path.join(stateDir, "moldbot.json"),
  ];

  const existing = candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });

  return existing ?? candidates[0] ?? null;
}

async function readGatewayConfig(): Promise<MissionGatewayConfig> {
  const configPath = resolveConfigPath();
  if (!configPath) {
    return { path: null, config: null };
  }

  try {
    const raw = await fs.promises.readFile(configPath, "utf8");
    const parsed = asRecord(JSON5.parse(raw)) ?? null;
    return { path: configPath, config: parsed };
  } catch {
    return { path: configPath, config: null };
  }
}

function isTailnetIPv4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((value) => !Number.isFinite(value) || value < 0 || value > 255)) {
    return false;
  }
  const [first, second] = octets;
  return first === 100 && second >= 64 && second <= 127;
}

function pickPrimaryTailnetIPv4(): string | undefined {
  for (const entries of Object.values(os.networkInterfaces())) {
    const match = entries?.find((entry) => entry.family === "IPv4" && !entry.internal && isTailnetIPv4(entry.address));
    if (match?.address) {
      return match.address;
    }
  }
  return undefined;
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function resolveGatewayUrl(config: AnyRecord | null): { url: string; rejectUnauthorized: boolean } {
  const gateway = asRecord(config?.gateway);
  const remote = asRecord(gateway?.remote);
  const isRemoteMode = asString(gateway?.mode) === "remote";
  const remoteUrl = asString(remote?.url);
  if (isRemoteMode && remoteUrl) {
    return { url: remoteUrl, rejectUnauthorized: true };
  }

  const tlsEnabled = asRecord(gateway?.tls)?.enabled === true;
  const scheme = tlsEnabled ? "wss" : "ws";
  const portFromEnv = process.env.OPENCLAW_GATEWAY_PORT?.trim() || process.env.CLAWDBOT_GATEWAY_PORT?.trim();
  const parsedPort = portFromEnv ? Number.parseInt(portFromEnv, 10) : Number.NaN;
  const port =
    Number.isFinite(parsedPort) && parsedPort > 0
      ? parsedPort
      : typeof gateway?.port === "number" && gateway.port > 0
        ? gateway.port
        : DEFAULT_GATEWAY_PORT;
  const bind = asString(gateway?.bind) ?? "loopback";
  const customBindHost = asString(gateway?.customBindHost);
  const host =
    bind === "tailnet"
      ? pickPrimaryTailnetIPv4() ?? "127.0.0.1"
      : bind === "custom" && customBindHost
        ? customBindHost
        : "127.0.0.1";

  return {
    url: `${scheme}://${host}:${port}`,
    rejectUnauthorized: !tlsEnabled,
  };
}

function resolveAuth(config: AnyRecord | null) {
  const gateway = asRecord(config?.gateway);
  const remote = asRecord(gateway?.remote);
  const auth = asRecord(gateway?.auth);
  const isRemoteMode = asString(gateway?.mode) === "remote";

  return {
    token:
      process.env.OPENCLAW_GATEWAY_TOKEN?.trim() ||
      process.env.CLAWDBOT_GATEWAY_TOKEN?.trim() ||
      (isRemoteMode ? asString(remote?.token) : undefined) ||
      asString(auth?.token),
    password:
      process.env.OPENCLAW_GATEWAY_PASSWORD?.trim() ||
      process.env.CLAWDBOT_GATEWAY_PASSWORD?.trim() ||
      (isRemoteMode ? asString(remote?.password) : undefined) ||
      asString(auth?.password),
  };
}

export async function loadMissionGatewayConnection(): Promise<MissionGatewayConnection> {
  const { path: configPath, config } = await readGatewayConfig();
  const { url, rejectUnauthorized } = resolveGatewayUrl(config);
  const auth = resolveAuth(config);

  return {
    configPath,
    url,
    token: auth.token,
    password: auth.password,
    rejectUnauthorized,
  };
}

async function waitForOpen(ws: WebSocket, timeoutMs: number) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`gateway timeout after ${timeoutMs}ms while opening websocket`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      ws.off("open", handleOpen);
      ws.off("close", handleClose);
      ws.off("error", handleError);
    };

    const handleOpen = () => {
      cleanup();
      resolve();
    };

    const handleClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(new Error(`gateway closed (${code}): ${reason.toString("utf8")}`));
    };

    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };

    ws.on("open", handleOpen);
    ws.on("close", handleClose);
    ws.on("error", handleError);
  });
}

async function waitForResponse(ws: WebSocket, id: string, timeoutMs: number) {
  return await new Promise<ResponseFrame>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`gateway timeout after ${timeoutMs}ms waiting for ${id}`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", handleMessage);
      ws.off("close", handleClose);
      ws.off("error", handleError);
    };

    const handleMessage = (data: RawData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawDataToString(data));
      } catch {
        return;
      }
      const frame = parsed as ResponseFrame;
      if (frame.type !== "res" || frame.id !== id) {
        return;
      }
      cleanup();
      resolve(frame);
    };

    const handleClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(new Error(`gateway closed (${code}): ${reason.toString("utf8")}`));
    };

    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };

    ws.on("message", handleMessage);
    ws.on("close", handleClose);
    ws.on("error", handleError);
  });
}

async function closeWebSocket(ws: WebSocket) {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        // best-effort cleanup
      }
      resolve();
    }, 500);

    ws.once("close", () => {
      clearTimeout(timer);
      resolve();
    });

    try {
      ws.close();
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function connectGateway(
  ws: WebSocket,
  connection: MissionGatewayConnection,
  timeoutMs: number,
) {
  const id = randomUUID();
  ws.send(
    JSON.stringify({
      type: "req",
      id,
      method: "connect",
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: CLIENT_ID,
          displayName: "Mission Control",
          version: "0.1.0",
          platform: `nextjs-${process.platform}`,
          mode: CLIENT_MODE,
          instanceId: randomUUID(),
        },
        caps: [],
        role: DEFAULT_ROLE,
        scopes: DEFAULT_SCOPES,
        auth:
          connection.token || connection.password
            ? {
                token: connection.token,
                password: connection.password,
              }
            : undefined,
      },
    }),
  );

  const response = await waitForResponse(ws, id, timeoutMs);
  if (response.ok !== true) {
    const message =
      typeof response.error?.message === "string"
        ? response.error.message
        : "gateway connect failed";
    throw new Error(message);
  }
}

export async function callMissionGateway<T>(
  connection: MissionGatewayConnection,
  params: {
    method: string;
    params?: unknown;
    timeoutMs?: number;
  },
): Promise<T> {
  const timeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? params.timeoutMs
      : 10_000;

  const wsOptions: ClientOptions = {
    maxPayload: 25 * 1024 * 1024,
  };
  if (connection.url.startsWith("wss://") && connection.rejectUnauthorized === false) {
    wsOptions.rejectUnauthorized = false;
  }

  const ws = new WebSocket(connection.url, wsOptions);
  await waitForOpen(ws, timeoutMs);

  try {
    await connectGateway(ws, connection, timeoutMs);
    const id = randomUUID();
    ws.send(
      JSON.stringify({
        type: "req",
        id,
        method: params.method,
        params: params.params,
      }),
    );

    const response = await waitForResponse(ws, id, timeoutMs);
    if (response.ok !== true) {
      const message =
        typeof response.error?.message === "string"
          ? response.error.message
          : `gateway request failed: ${params.method}`;
      throw new Error(message);
    }

    return response.payload as T;
  } finally {
    await closeWebSocket(ws);
  }
}
