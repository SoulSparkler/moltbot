const META_GRAPH_API_BASE = "https://graph.facebook.com/v18.0";

function formatTokenFingerprint(token: string | undefined | null): string {
  if (!token) {
    return "<missing>";
  }
  const trimmed = token.trim();
  if (trimmed.length <= 10) {
    return `${trimmed.slice(0, 3)}…${trimmed.slice(-3)}`;
  }
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)} (${trimmed.length})`;
}

function isMetaDiagEnabled(): boolean {
  const raw = process.env.META_DIAG?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

async function readJsonSafe(response: unknown) {
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

function logGraphErrorDetails(error: Record<string, unknown> | null, prefix: string) {
  if (!error) {
    return;
  }
  const code = error?.code;
  const subcode = error?.error_subcode;
  if (code !== undefined || subcode !== undefined) {
    console.log(
      `${prefix} error.code=${String(code ?? "<none>")} error_subcode=${String(subcode ?? "<none>")}`,
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
  const token = process.env.META_ACCESS_TOKEN;
  const pageId = process.env.META_PAGE_ID;

  if (!token || !pageId) {
    console.log("META TEST: Missing env vars");
    return;
  }

  const fingerprint = formatTokenFingerprint(token);
  await runMetaGetCheck(pageId, token, fingerprint);

  if (isMetaDiagEnabled()) {
    await runMetaPostDiag(pageId, token, fingerprint);
  }
}
