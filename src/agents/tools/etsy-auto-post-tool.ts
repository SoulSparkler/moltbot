import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult } from "./common.js";

const ETSY_AUTO_POST_ACTIONS = ["status", "diagnostics", "run"] as const;

const EtsyAutoPostToolSchema = Type.Object(
  {
    action: stringEnum(ETSY_AUTO_POST_ACTIONS, {
      description:
        "Use status to inspect the Etsy autopost service, diagnostics for feed eligibility details, or run to trigger an immediate manual autopost check.",
    }),
  },
  { additionalProperties: false },
);

type EtsyAutoPostHttpResponse = {
  ok: boolean;
  status: number;
  text: string;
  body: unknown;
};

function normalizeBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.replace(/\/+$/, "");
}

function resolveEtsyAutoPostConfig(config?: OpenClawConfig) {
  const toolConfig = config?.tools?.etsyAutoPost;
  const baseUrl = normalizeBaseUrl(
    toolConfig?.baseUrl ??
      process.env.ETSY_AUTO_POST_URL ??
      process.env.ETSY_AUTO_POST_BASE_URL ??
      undefined,
  );
  const token =
    toolConfig?.token?.trim() ??
    process.env.ETSY_AUTO_POST_TOKEN?.trim() ??
    process.env.RSS_API_TOKEN?.trim() ??
    "";
  const enabled =
    toolConfig?.enabled === false ? false : toolConfig?.enabled === true || Boolean(baseUrl);
  const missingConfig = baseUrl ? [] : ["tools.etsyAutoPost.baseUrl or ETSY_AUTO_POST_URL"];
  return {
    enabled,
    baseUrl,
    token,
    missingConfig,
    env: {
      baseUrlPresent: Boolean(baseUrl),
      tokenPresent: Boolean(token),
    },
  };
}

async function fetchJson(params: {
  url: string;
  method: "GET" | "POST";
  token?: string;
}): Promise<EtsyAutoPostHttpResponse> {
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  if (params.method === "POST") {
    headers["content-type"] = "application/json";
  }
  if (params.token?.trim()) {
    headers.authorization = `Bearer ${params.token.trim()}`;
  }
  const response = await fetch(params.url, {
    method: params.method,
    headers,
    body: params.method === "POST" ? "{}" : undefined,
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text || null;
  }
  return {
    ok: response.ok,
    status: response.status,
    text,
    body,
  };
}

export function createEtsyAutoPostTool(options?: { config?: OpenClawConfig }): AnyAgentTool | null {
  const remote = resolveEtsyAutoPostConfig(options?.config);
  if (!remote.enabled) {
    return null;
  }

  return {
    label: "Etsy Auto Post",
    name: "etsy_auto_post",
    description:
      "Check the Etsy autopost service, inspect listing diagnostics, or trigger a manual Etsy listing autopost run. Prefer this for Etsy shop autoposting; use meta_social only for direct custom Meta posts.",
    parameters: EtsyAutoPostToolSchema,
    execute: async (_toolCallId, args) => {
      const actionRaw =
        args && typeof args === "object" && "action" in args && typeof args.action === "string"
          ? args.action.trim().toLowerCase()
          : "";
      const action = actionRaw as (typeof ETSY_AUTO_POST_ACTIONS)[number];
      if (!ETSY_AUTO_POST_ACTIONS.includes(action)) {
        return jsonResult({
          ok: false,
          error: `Unsupported action: ${actionRaw || "<missing>"}`,
        });
      }

      const resolved = resolveEtsyAutoPostConfig(options?.config);
      if (!resolved.baseUrl) {
        return jsonResult({
          ok: false,
          error: "Etsy autopost service is not configured.",
          missingConfig: resolved.missingConfig,
          env: resolved.env,
        });
      }

      const endpoint =
        action === "status"
          ? "/self-check"
          : action === "diagnostics"
            ? "/diagnostics"
            : "/manual-run";
      const method = action === "run" ? "POST" : "GET";

      try {
        const response = await fetchJson({
          url: `${resolved.baseUrl}${endpoint}`,
          method,
          token: resolved.token,
        });
        return jsonResult({
          ok: response.ok,
          action,
          baseUrl: resolved.baseUrl,
          status: response.status,
          response: response.body,
        });
      } catch (error) {
        return jsonResult({
          ok: false,
          action,
          baseUrl: resolved.baseUrl,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
