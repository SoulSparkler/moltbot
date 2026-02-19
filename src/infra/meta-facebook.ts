const META_GRAPH_API_BASE = "https://graph.facebook.com/v18.0";

type MetaGraphResponse = {
  ok: boolean;
  status: number;
  text: string;
  body: Record<string, unknown> | null;
};

export type FacebookAttachmentVerificationResult = {
  checked: true;
  hasAttachment: boolean | null;
  retried: boolean;
};

export type FacebookPageEtsyListingPostResult = {
  postId: string;
  message: string;
  link: string;
  attachmentVerification?: FacebookAttachmentVerificationResult;
};

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

function sleep(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripUrlsFromMessage(raw: string): string {
  const input = (raw || "").trim();
  if (!input) {
    return "";
  }

  // Facebook link previews are most reliable when the URL is provided via the Graph API `link`
  // field rather than embedded in the `message` text.
  const withoutUrls = input
    .replace(/\bhttps?:\/\/[^\s)]+/gi, "")
    .replace(/\bwww\.[^\s)]+/gi, "")
    .replace(/\b(?:etsy\.com|etsy\.me)\/[^\s)]+/gi, "");

  return withoutUrls
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function canonicalizeEtsyListingUrl(raw: string): string {
  const input = raw.trim();
  if (!input) {
    throw new Error("ETSY_URL_INVALID: Empty URL.");
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`ETSY_URL_INVALID: Unable to parse URL: "${raw}"`);
  }

  const hostname = parsed.hostname.trim().toLowerCase();
  if (hostname === "etsy.me") {
    throw new Error(`ETSY_URL_INVALID: Shortened Etsy URLs are not allowed: "${raw}"`);
  }

  if (!hostname.endsWith("etsy.com")) {
    throw new Error(`ETSY_URL_INVALID: Not an Etsy URL: "${raw}"`);
  }

  const pathname = parsed.pathname.replace(/^\/[a-z]{2}(?:-[a-z]{2})?\/listing\//i, "/listing/");

  const match = /^\/listing\/(\d+)(?:\/([^/?#]+))?/i.exec(pathname);
  if (!match) {
    throw new Error(`ETSY_URL_INVALID: Not a listing URL: "${raw}"`);
  }

  const listingId = match[1];
  const slug = match[2]?.trim();

  parsed.protocol = "https:";
  parsed.username = "";
  parsed.password = "";
  parsed.hostname = "www.etsy.com";
  parsed.pathname = slug ? `/listing/${listingId}/${slug}` : `/listing/${listingId}`;
  parsed.search = "";
  parsed.hash = "";

  return parsed.toString();
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

function formatGraphErrorMessage(params: {
  response: MetaGraphResponse;
  fallback: string;
}): string {
  const error = extractGraphError(params.response.body);
  const pieces = [`status=${params.response.status}`];
  const errorMessage = toStringValue(error?.message);
  if (errorMessage) {
    pieces.push(`error_message=${errorMessage}`);
  }
  const errorCode = toStringValue(error?.code);
  if (errorCode) {
    pieces.push(`error_code=${errorCode}`);
  }
  const errorSubcode = toStringValue(error?.error_subcode);
  if (errorSubcode) {
    pieces.push(`error_subcode=${errorSubcode}`);
  }
  if (pieces.length === 1 && params.response.text.trim()) {
    pieces.push(`response=${params.response.text.trim().slice(0, 300)}`);
  }
  return `${params.fallback} (${pieces.join(" ")})`;
}

async function postHasAttachment(params: {
  fetchImpl: typeof fetch;
  postId: string;
  accessToken: string;
}): Promise<boolean | null> {
  const url = `${META_GRAPH_API_BASE}/${encodeURIComponent(params.postId)}?fields=attachments`;
  const response = await fetchGraph(params.fetchImpl, {
    url,
    method: "GET",
    accessToken: params.accessToken,
  });
  if (!response.ok) {
    return null;
  }

  const attachments = asRecord(response.body?.attachments);
  const data = attachments?.data;
  if (Array.isArray(data)) {
    return data.length > 0;
  }
  return false;
}

export async function postFacebookPageEtsyListing(params: {
  pageId: string;
  accessToken: string;
  message: string;
  etsyListingUrl: string;
  fetchImpl?: typeof fetch;
  verifyAttachment?: boolean;
  verifyRetryDelayMs?: number;
}): Promise<FacebookPageEtsyListingPostResult> {
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

  const link = canonicalizeEtsyListingUrl(params.etsyListingUrl);
  const message = stripUrlsFromMessage(params.message);

  const url = `${META_GRAPH_API_BASE}/${encodeURIComponent(pageId)}/feed`;
  const body = new URLSearchParams({
    link,
    ...(message ? { message } : {}),
  });

  const response = await fetchGraph(fetchImpl, {
    url,
    method: "POST",
    accessToken,
    body,
    contentType: "application/x-www-form-urlencoded",
  });

  if (!response.ok) {
    throw new Error(
      formatGraphErrorMessage({ response, fallback: "META_GRAPH_POST_FAILED: create_feed_post" }),
    );
  }

  const postId = toStringValue(response.body?.id);
  if (!postId) {
    throw new Error(
      formatGraphErrorMessage({
        response,
        fallback: "META_GRAPH_POST_FAILED: create_feed_post_missing_id",
      }),
    );
  }

  const verifyAttachment = params.verifyAttachment === true;
  if (!verifyAttachment) {
    return {
      postId,
      message,
      link,
    };
  }

  const retryDelayMs = params.verifyRetryDelayMs ?? 15_000;

  const first = await postHasAttachment({ fetchImpl, postId, accessToken });
  if (first === true) {
    return {
      postId,
      message,
      link,
      attachmentVerification: {
        checked: true,
        hasAttachment: true,
        retried: false,
      },
    };
  }

  if (first === null) {
    return {
      postId,
      message,
      link,
      attachmentVerification: {
        checked: true,
        hasAttachment: null,
        retried: false,
      },
    };
  }

  await sleep(retryDelayMs);
  const second = await postHasAttachment({ fetchImpl, postId, accessToken });

  return {
    postId,
    message,
    link,
    attachmentVerification: {
      checked: true,
      hasAttachment: second,
      retried: true,
    },
  };
}
