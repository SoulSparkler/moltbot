const META_GRAPH_API_BASE = "https://graph.facebook.com/v18.0";

type MetaGraphResponse = {
  ok: boolean;
  status: number;
  text: string;
  body: Record<string, unknown> | null;
};

export type MetaGraphErrorSummary = {
  message: string | null;
  type: string | null;
  code: string | null;
  subcode: string | null;
  fbtraceId: string | null;
  userTitle: string | null;
  userMessage: string | null;
  isTransient: boolean | null;
};

export class MetaGraphRequestError extends Error {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly status: number;
  readonly error: MetaGraphErrorSummary | null;
  readonly responseText: string;

  constructor(params: {
    method: "GET" | "POST";
    url: string;
    response: MetaGraphResponse;
    fallback: string;
  }) {
    super(formatGraphErrorMessage({ response: params.response, fallback: params.fallback }));
    this.name = "MetaGraphRequestError";
    this.method = params.method;
    this.url = params.url;
    this.status = params.response.status;
    this.error = summarizeGraphError(params.response.body);
    this.responseText = params.response.text;
  }
}

export type MetaPageAccessTokenResolution = {
  token: string;
  source: "provided" | "me_accounts";
  pageName: string | null;
  meAccountsStatus: {
    attempted: boolean;
    ok: boolean;
    status: number | null;
    error: MetaGraphErrorSummary | null;
    matchedPage: boolean;
  };
};

export type InstagramBusinessAccount = {
  id: string;
  username: string | null;
};

export type InstagramPublishResult = {
  igUserId: string;
  creationId: string;
  mediaId: string;
};

type InstagramContainerStatusCode =
  | "EXPIRED"
  | "ERROR"
  | "FINISHED"
  | "IN_PROGRESS"
  | "PUBLISHED"
  | "UNKNOWN";

type CachedEntry<T> = { expiresAtMs: number; value: T };
const instagramBusinessCache = new Map<string, CachedEntry<InstagramBusinessAccount>>();

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function toStringValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "bigint") {
    return String(value);
  }
  return null;
}

async function fetchGraph(
  fetchImpl: typeof fetch,
  params: {
    url: string;
    method: "GET" | "POST";
    accessToken: string;
    body?: BodyInit;
    contentType?: string;
  },
): Promise<MetaGraphResponse> {
  const response = await fetchImpl(params.url, {
    method: params.method,
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      ...(params.contentType ? { "content-type": params.contentType } : {}),
    },
    body: params.body,
  });

  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  if (text.trim()) {
    try {
      body = asRecord(JSON.parse(text));
    } catch {
      body = null;
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    text,
    body,
  };
}

function extractGraphError(body: Record<string, unknown> | null): Record<string, unknown> | null {
  return asRecord(body?.error);
}

export function summarizeGraphError(
  body: Record<string, unknown> | null,
): MetaGraphErrorSummary | null {
  const error = extractGraphError(body);
  if (!error) {
    return null;
  }
  const message = toStringValue(error.message);
  const type = toStringValue(error.type);
  const code = toStringValue(error.code);
  const subcode = toStringValue(error.error_subcode);
  const fbtraceId = toStringValue(error.fbtrace_id);
  const userTitle = toStringValue(error.error_user_title);
  const userMessage = toStringValue(error.error_user_msg);
  const isTransient =
    typeof error.is_transient === "boolean" ? (error.is_transient as boolean) : null;

  return {
    message,
    type,
    code,
    subcode,
    fbtraceId,
    userTitle,
    userMessage,
    isTransient,
  };
}

function formatGraphErrorMessage(params: {
  response: MetaGraphResponse;
  fallback: string;
}): string {
  const summary = summarizeGraphError(params.response.body);
  const pieces = [`status=${params.response.status}`];
  if (summary?.message) {
    pieces.push(`error_message=${summary.message}`);
  }
  if (summary?.code) {
    pieces.push(`error_code=${summary.code}`);
  }
  if (summary?.subcode) {
    pieces.push(`error_subcode=${summary.subcode}`);
  }
  if (summary?.fbtraceId) {
    pieces.push(`fbtrace_id=${summary.fbtraceId}`);
  }
  if (pieces.length === 1 && params.response.text.trim()) {
    pieces.push(`response=${params.response.text.trim().slice(0, 300)}`);
  }
  return `${params.fallback} (${pieces.join(" ")})`;
}

export async function resolveFacebookPageAccessToken(params: {
  pageId: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<MetaPageAccessTokenResolution> {
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("META_GRAPH_UNAVAILABLE: fetch is not available in this runtime.");
  }

  const pageId = params.pageId.trim();
  if (!pageId) {
    throw new Error("META_GRAPH_CONFIG_INVALID: pageId is missing.");
  }

  const accessToken = params.accessToken.trim();
  if (!accessToken) {
    throw new Error("META_GRAPH_CONFIG_INVALID: accessToken is missing.");
  }

  const url = `${META_GRAPH_API_BASE}/me/accounts?fields=id,name,access_token&limit=200`;
  const response = await fetchGraph(fetchImpl, { url, method: "GET", accessToken });
  if (!response.ok) {
    return {
      token: accessToken,
      source: "provided",
      pageName: null,
      meAccountsStatus: {
        attempted: true,
        ok: false,
        status: response.status,
        error: summarizeGraphError(response.body),
        matchedPage: false,
      },
    };
  }

  const data = response.body?.data;
  if (!Array.isArray(data)) {
    return {
      token: accessToken,
      source: "provided",
      pageName: null,
      meAccountsStatus: {
        attempted: true,
        ok: true,
        status: response.status,
        error: null,
        matchedPage: false,
      },
    };
  }

  const match = data
    .map((entry) => asRecord(entry))
    .find((entry) => toStringValue(entry?.id) === pageId);

  const pageToken = match ? toStringValue(match.access_token) : null;
  const pageName = match ? toStringValue(match.name) : null;
  if (!pageToken) {
    return {
      token: accessToken,
      source: "provided",
      pageName,
      meAccountsStatus: {
        attempted: true,
        ok: true,
        status: response.status,
        error: null,
        matchedPage: Boolean(match),
      },
    };
  }

  return {
    token: pageToken,
    source: "me_accounts",
    pageName,
    meAccountsStatus: {
      attempted: true,
      ok: true,
      status: response.status,
      error: null,
      matchedPage: true,
    },
  };
}

export async function fetchMePermissions(params: {
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<{
  ok: boolean;
  status: number;
  permissions: Array<{ permission: string; status: string }> | null;
  error: MetaGraphErrorSummary | null;
}> {
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("META_GRAPH_UNAVAILABLE: fetch is not available in this runtime.");
  }

  const accessToken = params.accessToken.trim();
  if (!accessToken) {
    throw new Error("META_GRAPH_CONFIG_INVALID: accessToken is missing.");
  }

  const url = `${META_GRAPH_API_BASE}/me/permissions`;
  const response = await fetchGraph(fetchImpl, { url, method: "GET", accessToken });
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      permissions: null,
      error: summarizeGraphError(response.body),
    };
  }

  const data = response.body?.data;
  if (!Array.isArray(data)) {
    return { ok: true, status: response.status, permissions: null, error: null };
  }

  const permissions = data
    .map((entry) => asRecord(entry))
    .map((entry) => ({
      permission: toStringValue(entry?.permission) ?? "",
      status: toStringValue(entry?.status) ?? "",
    }))
    .filter((entry) => entry.permission && entry.status);

  return { ok: true, status: response.status, permissions, error: null };
}

export async function resolveInstagramBusinessAccount(params: {
  pageId: string;
  pageAccessToken: string;
  fetchImpl?: typeof fetch;
  cacheTtlMs?: number;
}): Promise<InstagramBusinessAccount | null> {
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("META_GRAPH_UNAVAILABLE: fetch is not available in this runtime.");
  }

  const pageId = params.pageId.trim();
  if (!pageId) {
    throw new Error("META_GRAPH_CONFIG_INVALID: pageId is missing.");
  }

  const accessToken = params.pageAccessToken.trim();
  if (!accessToken) {
    throw new Error("META_GRAPH_CONFIG_INVALID: pageAccessToken is missing.");
  }

  const cacheKey = pageId;
  const now = Date.now();
  const cached = instagramBusinessCache.get(cacheKey);
  if (cached && cached.expiresAtMs > now) {
    return cached.value;
  }

  const url = `${META_GRAPH_API_BASE}/${encodeURIComponent(pageId)}?fields=instagram_business_account{id,username}`;
  const response = await fetchGraph(fetchImpl, { url, method: "GET", accessToken });
  if (!response.ok) {
    throw new MetaGraphRequestError({
      method: "GET",
      url,
      response,
      fallback: "META_GRAPH_GET_FAILED: instagram_business_account",
    });
  }

  const account = asRecord(response.body?.instagram_business_account);
  const id = toStringValue(account?.id);
  if (!id) {
    return null;
  }
  const entry: InstagramBusinessAccount = {
    id,
    username: toStringValue(account?.username),
  };

  instagramBusinessCache.set(cacheKey, {
    value: entry,
    expiresAtMs: now + (params.cacheTtlMs ?? 12 * 60 * 60 * 1000),
  });

  return entry;
}

async function createInstagramContainer(params: {
  fetchImpl: typeof fetch;
  igUserId: string;
  accessToken: string;
  imageUrl: string;
  caption?: string;
}): Promise<string> {
  const url = `${META_GRAPH_API_BASE}/${encodeURIComponent(params.igUserId)}/media`;
  const body = new URLSearchParams({
    image_url: params.imageUrl,
    ...(params.caption?.trim() ? { caption: params.caption.trim() } : {}),
  });

  const response = await fetchGraph(params.fetchImpl, {
    url,
    method: "POST",
    accessToken: params.accessToken,
    body,
    contentType: "application/x-www-form-urlencoded",
  });

  if (!response.ok) {
    throw new MetaGraphRequestError({
      method: "POST",
      url,
      response,
      fallback: "META_IG_POST_FAILED: create_container",
    });
  }

  const creationId = toStringValue(response.body?.id);
  if (!creationId) {
    throw new MetaGraphRequestError({
      method: "POST",
      url,
      response,
      fallback: "META_IG_POST_FAILED: create_container_missing_id",
    });
  }

  return creationId;
}

async function fetchContainerStatus(params: {
  fetchImpl: typeof fetch;
  creationId: string;
  accessToken: string;
}): Promise<InstagramContainerStatusCode> {
  const url = `${META_GRAPH_API_BASE}/${encodeURIComponent(params.creationId)}?fields=status_code`;
  const response = await fetchGraph(params.fetchImpl, {
    url,
    method: "GET",
    accessToken: params.accessToken,
  });
  if (!response.ok) {
    return "UNKNOWN";
  }

  const statusRaw = toStringValue(response.body?.status_code);
  if (!statusRaw) {
    return "UNKNOWN";
  }

  const normalized = statusRaw.trim().toUpperCase();
  switch (normalized) {
    case "IN_PROGRESS":
    case "FINISHED":
    case "ERROR":
    case "EXPIRED":
    case "PUBLISHED":
      return normalized as InstagramContainerStatusCode;
    default:
      return "UNKNOWN";
  }
}

async function publishInstagramContainer(params: {
  fetchImpl: typeof fetch;
  igUserId: string;
  creationId: string;
  accessToken: string;
}): Promise<string> {
  const url = `${META_GRAPH_API_BASE}/${encodeURIComponent(params.igUserId)}/media_publish`;
  const body = new URLSearchParams({ creation_id: params.creationId });
  const response = await fetchGraph(params.fetchImpl, {
    url,
    method: "POST",
    accessToken: params.accessToken,
    body,
    contentType: "application/x-www-form-urlencoded",
  });

  if (!response.ok) {
    throw new MetaGraphRequestError({
      method: "POST",
      url,
      response,
      fallback: "META_IG_POST_FAILED: publish_container",
    });
  }

  const mediaId = toStringValue(response.body?.id);
  if (!mediaId) {
    throw new MetaGraphRequestError({
      method: "POST",
      url,
      response,
      fallback: "META_IG_POST_FAILED: publish_missing_id",
    });
  }

  return mediaId;
}

export async function publishInstagramPhoto(params: {
  igUserId: string;
  accessToken: string;
  imageUrl: string;
  caption?: string;
  fetchImpl?: typeof fetch;
  pollUntilFinished?: boolean;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}): Promise<InstagramPublishResult> {
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("META_GRAPH_UNAVAILABLE: fetch is not available in this runtime.");
  }

  const igUserId = params.igUserId.trim();
  if (!igUserId) {
    throw new Error("META_IG_CONFIG_INVALID: igUserId is missing.");
  }

  const accessToken = params.accessToken.trim();
  if (!accessToken) {
    throw new Error("META_GRAPH_CONFIG_INVALID: accessToken is missing.");
  }

  const imageUrl = params.imageUrl.trim();
  if (!imageUrl) {
    throw new Error("META_IG_CONFIG_INVALID: imageUrl is missing.");
  }

  const creationId = await createInstagramContainer({
    fetchImpl,
    igUserId,
    accessToken,
    imageUrl,
    caption: params.caption,
  });

  if (params.pollUntilFinished !== false) {
    const startedAt = Date.now();
    const timeoutMs = params.pollTimeoutMs ?? 60_000;
    const intervalMs = params.pollIntervalMs ?? 2_000;
    while (Date.now() - startedAt < timeoutMs) {
      const status = await fetchContainerStatus({ fetchImpl, creationId, accessToken });
      if (status === "FINISHED") {
        break;
      }
      if (status === "ERROR" || status === "EXPIRED") {
        throw new Error(`META_IG_CONTAINER_FAILED: status_code=${status}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  const mediaId = await publishInstagramContainer({ fetchImpl, igUserId, creationId, accessToken });

  return { igUserId, creationId, mediaId };
}
