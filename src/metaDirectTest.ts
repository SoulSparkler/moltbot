import { resolveFacebookPageAccessToken } from "./infra/meta-instagram.js";

const META_GRAPH_API_BASE = "https://graph.facebook.com/v18.0";

function formatTokenFingerprint(token: string | undefined | null): string {
  if (!token) {
    return "<missing>";
  }
  const trimmed = token.trim();
  if (trimmed.length <= 10) {
    return `${trimmed.slice(0, 3)}...${trimmed.slice(-3)}`;
  }
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)} (${trimmed.length})`;
}

function isMetaDiagEnabled(): boolean {
  const raw = process.env.META_DIAG?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

async function readJsonSafe(response: Response) {
  const text = await response.text();
  try {
    return { text, body: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { text, body: null };
  }
}

function extractError(body: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const candidate = (body as { error?: unknown }).error;
  return candidate && typeof candidate === "object" ? (candidate as Record<string, unknown>) : null;
}

function formatGraphScalar(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : fallback;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return fallback;
}

function logGraphErrorDetails(error: Record<string, unknown> | null, prefix: string) {
  if (!error) {
    return;
  }
  const code = error?.code;
  const subcode = error?.error_subcode;
  if (code !== undefined || subcode !== undefined) {
    console.log(
      `${prefix} error.code=${formatGraphScalar(code, "<none>")} error_subcode=${formatGraphScalar(
        subcode,
        "<none>",
      )}`,
    );
  }
}

function buildGraphPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

async function runMetaGetCheck(pageId: string, token: string, fingerprint: string) {
  const path = buildGraphPath(`${encodeURIComponent(pageId)}?fields=id,name`);
  const url = `${META_GRAPH_API_BASE}${path}`;
  console.log(`META TEST: GET ${path} token=${fingerprint}`);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const { text, body } = await readJsonSafe(response);
    const error = extractError(body);

    console.log(`META TEST STATUS: ${response.status}`);
    console.log(`META TEST RESPONSE: ${text}`);
    logGraphErrorDetails(error, "META TEST");
  } catch (err) {
    console.error("META TEST ERROR:", err);
  }
}

async function runMetaPostDiag(pageId: string, token: string, fingerprint: string) {
  const path = buildGraphPath(`${encodeURIComponent(pageId)}/feed`);
  const url = `${META_GRAPH_API_BASE}${path}`;
  const now = new Date().toISOString();
  const body = new URLSearchParams({
    message: `OpenClaw META_DIAG probe ${now}`,
    published: "false",
  });

  console.log(`META TEST: POST ${path} token=${fingerprint}`);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });

    const { text, body: json } = await readJsonSafe(response);
    const error = extractError(json);

    console.log(`META TEST STATUS: ${response.status}`);
    console.log(`META TEST RESPONSE: ${text}`);
    logGraphErrorDetails(error, "META TEST");
  } catch (err) {
    console.error("META TEST ERROR:", err);
  }
}

export async function runMetaDirectTest() {
  const bootstrapToken = process.env.META_ACCESS_TOKEN?.trim() ?? "";
  const pageTokenOverride = process.env.META_PAGE_ACCESS_TOKEN?.trim() ?? "";
  const pageId = process.env.META_PAGE_ID?.trim() ?? "";

  if (!pageId || (!bootstrapToken && !pageTokenOverride)) {
    const missing: string[] = [];
    if (!pageId) {
      missing.push("META_PAGE_ID");
    }
    if (!bootstrapToken && !pageTokenOverride) {
      missing.push("META_ACCESS_TOKEN or META_PAGE_ACCESS_TOKEN");
    }
    console.log(`META TEST: Missing env vars: ${missing.join(", ")}`);
    return;
  }

  const getToken = bootstrapToken || pageTokenOverride;
  const getFingerprint = formatTokenFingerprint(getToken);
  await runMetaGetCheck(pageId, getToken, getFingerprint);

  if (isMetaDiagEnabled()) {
    if (pageTokenOverride) {
      const fingerprint = formatTokenFingerprint(pageTokenOverride);
      await runMetaPostDiag(pageId, pageTokenOverride, fingerprint);
      return;
    }

    if (!bootstrapToken) {
      console.log(
        "META TEST: Skipping POST /feed diag (META_PAGE_ACCESS_TOKEN not set and META_ACCESS_TOKEN missing).",
      );
      return;
    }

    try {
      const resolved = await resolveFacebookPageAccessToken({
        pageId,
        accessToken: bootstrapToken,
      });
      if (resolved.source !== "me_accounts") {
        console.log(
          `META TEST: Skipping POST /feed diag (unable to resolve Page token via /me/accounts matched_page=${String(
            resolved.meAccountsStatus.matchedPage,
          )}). Set META_PAGE_ACCESS_TOKEN to override.`,
        );
        return;
      }

      const fingerprint = formatTokenFingerprint(resolved.token);
      await runMetaPostDiag(pageId, resolved.token, fingerprint);
    } catch (error) {
      console.log(
        `META TEST: Skipping POST /feed diag (page token resolution failed: ${String(error)})`,
      );
    }
  }
}
