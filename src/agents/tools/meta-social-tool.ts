import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult } from "./common.js";

const META_GRAPH_API_BASE = "https://graph.facebook.com/v18.0";
const META_SOCIAL_ACTIONS = ["status", "publish"] as const;
const META_SOCIAL_PLATFORMS = ["facebook", "instagram", "both"] as const;
const META_REQUIRED_PERMISSIONS = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
] as const;

const MetaSocialToolSchema = Type.Object(
  {
    action: stringEnum(META_SOCIAL_ACTIONS, {
      description: "Use status to verify Meta setup, or publish to post content.",
    }),
    platform: optionalStringEnum(META_SOCIAL_PLATFORMS, {
      description: "Publish target. Required for action=publish.",
    }),
    message: Type.Optional(
      Type.String({
        description: "Caption or post text. Required unless image-only Instagram is intended.",
      }),
    ),
    imageUrl: Type.Optional(
      Type.String({
        description:
          "Public http(s) image URL. Required for Instagram. Facebook uses a photo post when provided.",
      }),
    ),
    linkUrl: Type.Optional(
      Type.String({
        description:
          "Optional public http(s) link. Facebook feed posts use this as the link field. Instagram appends it to the caption.",
      }),
    ),
    publishToFeed: Type.Optional(
      Type.Boolean({
        description:
          "Facebook only. Force a feed/link post instead of a photo post when imageUrl is also present.",
      }),
    ),
    dryRun: Type.Optional(
      Type.Boolean({
        description: "Validate config and planned actions without calling the Meta Graph API.",
      }),
    ),
  },
  { additionalProperties: false },
);

type MetaGraphResponse = {
  ok: boolean;
  status: number;
  text: string;
  body: Record<string, unknown> | null;
};

type MetaGraphErrorSummary = {
  message: string | null;
  type: string | null;
  code: string | null;
  subcode: string | null;
  fbtraceId: string | null;
  userTitle: string | null;
  userMessage: string | null;
  isTransient: boolean | null;
};

type MetaPageAccessTokenResolution = {
  token: string;
  source: "provided" | "me_accounts" | "page_access_token";
  pageName: string | null;
  meAccountsStatus: {
    attempted: boolean;
    ok: boolean;
    status: number | null;
    error: MetaGraphErrorSummary | null;
    matchedPage: boolean;
  } | null;
};

type InstagramBusinessAccount = {
  id: string;
  username: string | null;
};

type InstagramPublishResult = {
  igUserId: string;
  creationId: string;
  mediaId: string;
};

class MetaGraphRequestError extends Error {
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function toStringValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "bigint") {
    return String(value);
  }
  return null;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePublicHttpUrl(raw: string, label: string): string {
  const input = raw.trim();
  if (!input) {
    throw new Error(`${label} is required.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http or https.`);
  }

  return parsed.toString();
}

async function fetchGraph(params: {
  url: string;
  method: "GET" | "POST";
  accessToken: string;
  body?: BodyInit;
  contentType?: string;
}): Promise<MetaGraphResponse> {
  if (!globalThis.fetch) {
    throw new Error("fetch is not available in this runtime.");
  }

  const response = await globalThis.fetch(params.url, {
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

function summarizeGraphError(body: Record<string, unknown> | null): MetaGraphErrorSummary | null {
  const error = asRecord(body?.error);
  if (!error) {
    return null;
  }
  const isTransientValue = error.is_transient ?? error.isTransient;
  return {
    message: toStringValue(error.message),
    type: toStringValue(error.type),
    code: toStringValue(error.code),
    subcode: toStringValue(error.error_subcode),
    fbtraceId: toStringValue(error.fbtrace_id),
    userTitle: toStringValue(error.error_user_title),
    userMessage: toStringValue(error.error_user_msg),
    isTransient: typeof isTransientValue === "boolean" ? isTransientValue : null,
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

async function resolveFacebookPageAccessToken(params: {
  pageId: string;
  accessToken: string;
  pageAccessToken?: string;
}): Promise<MetaPageAccessTokenResolution> {
  if (params.pageAccessToken?.trim()) {
    return {
      token: params.pageAccessToken.trim(),
      source: "page_access_token",
      pageName: null,
      meAccountsStatus: null,
    };
  }

  const pageId = params.pageId.trim();
  const accessToken = params.accessToken.trim();
  if (!pageId) {
    throw new Error("META_PAGE_ID is missing.");
  }
  if (!accessToken) {
    throw new Error("META_ACCESS_TOKEN is missing.");
  }

  const url = `${META_GRAPH_API_BASE}/me/accounts?fields=id,name,access_token&limit=200`;
  const response = await fetchGraph({
    url,
    method: "GET",
    accessToken,
  });

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

  const data = Array.isArray(response.body?.data) ? response.body.data : [];
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

async function fetchMePermissions(accessToken: string) {
  const token = accessToken.trim();
  if (!token) {
    throw new Error("META_ACCESS_TOKEN is missing.");
  }
  const url = `${META_GRAPH_API_BASE}/me/permissions`;
  const response = await fetchGraph({
    url,
    method: "GET",
    accessToken: token,
  });

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      permissions: null,
      error: summarizeGraphError(response.body),
    };
  }

  const data = Array.isArray(response.body?.data) ? response.body.data : [];
  const permissions = data
    .map((entry) => asRecord(entry))
    .map((entry) => ({
      permission: toStringValue(entry?.permission) ?? "",
      status: toStringValue(entry?.status) ?? "",
    }))
    .filter((entry) => entry.permission && entry.status);

  return {
    ok: true,
    status: response.status,
    permissions,
    error: null,
  };
}

async function resolveInstagramBusinessAccount(params: {
  pageId: string;
  pageAccessToken: string;
}): Promise<InstagramBusinessAccount | null> {
  const pageId = params.pageId.trim();
  const pageAccessToken = params.pageAccessToken.trim();
  if (!pageId) {
    throw new Error("META_PAGE_ID is missing.");
  }
  if (!pageAccessToken) {
    throw new Error("Meta Page access token is missing.");
  }

  const url = `${META_GRAPH_API_BASE}/${encodeURIComponent(pageId)}?fields=instagram_business_account{id,username}`;
  const response = await fetchGraph({
    url,
    method: "GET",
    accessToken: pageAccessToken,
  });

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

  return {
    id,
    username: toStringValue(account?.username),
  };
}

function isInstagramPublishRetryable(response: MetaGraphResponse): boolean {
  const error = summarizeGraphError(response.body);
  if (response.status >= 500) {
    return true;
  }
  if (error?.code === "2") {
    return true;
  }
  return error?.isTransient === true;
}

function sleep(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchGraphWithRetry(params: {
  url: string;
  accessToken: string;
  body: BodyInit;
  operation: "create_container" | "publish_container";
}): Promise<MetaGraphResponse> {
  const retryDelays = [2_000, 8_000, 20_000];
  let lastResponse: MetaGraphResponse | null = null;

  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    const response = await fetchGraph({
      url: params.url,
      method: "POST",
      accessToken: params.accessToken,
      body: params.body,
      contentType: "application/x-www-form-urlencoded",
    });
    lastResponse = response;

    if (response.ok || !isInstagramPublishRetryable(response) || attempt === retryDelays.length) {
      return response;
    }

    await sleep(retryDelays[attempt] ?? 0);
  }

  return (
    lastResponse ?? {
      ok: false,
      status: 0,
      text: "",
      body: null,
    }
  );
}

async function fetchInstagramContainerStatus(params: {
  creationId: string;
  accessToken: string;
}): Promise<string> {
  const url = `${META_GRAPH_API_BASE}/${encodeURIComponent(params.creationId)}?fields=status_code`;
  const response = await fetchGraph({
    url,
    method: "GET",
    accessToken: params.accessToken,
  });
  if (!response.ok) {
    return "UNKNOWN";
  }
  return toStringValue(response.body?.status_code)?.toUpperCase() ?? "UNKNOWN";
}

async function publishInstagramPhoto(params: {
  igUserId: string;
  accessToken: string;
  imageUrl: string;
  caption?: string;
}): Promise<InstagramPublishResult> {
  const igUserId = params.igUserId.trim();
  const accessToken = params.accessToken.trim();
  const imageUrl = normalizePublicHttpUrl(params.imageUrl, "imageUrl");
  if (!igUserId) {
    throw new Error("Instagram user id is missing.");
  }
  if (!accessToken) {
    throw new Error("Meta access token is missing.");
  }

  const createUrl = `${META_GRAPH_API_BASE}/${encodeURIComponent(igUserId)}/media`;
  const createBody = new URLSearchParams({
    image_url: imageUrl,
    ...(params.caption?.trim() ? { caption: params.caption.trim() } : {}),
  });
  const createResponse = await fetchGraphWithRetry({
    url: createUrl,
    accessToken,
    body: createBody,
    operation: "create_container",
  });

  if (!createResponse.ok) {
    throw new MetaGraphRequestError({
      method: "POST",
      url: createUrl,
      response: createResponse,
      fallback: "META_IG_POST_FAILED: create_container",
    });
  }

  const creationId = toStringValue(createResponse.body?.id);
  if (!creationId) {
    throw new MetaGraphRequestError({
      method: "POST",
      url: createUrl,
      response: createResponse,
      fallback: "META_IG_POST_FAILED: create_container_missing_id",
    });
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    const status = await fetchInstagramContainerStatus({ creationId, accessToken });
    if (status === "FINISHED") {
      break;
    }
    if (status === "ERROR" || status === "EXPIRED") {
      throw new Error(`META_IG_CONTAINER_FAILED: status_code=${status}`);
    }
    await sleep(2_000);
  }

  const publishUrl = `${META_GRAPH_API_BASE}/${encodeURIComponent(igUserId)}/media_publish`;
  const publishBody = new URLSearchParams({ creation_id: creationId });
  const publishResponse = await fetchGraphWithRetry({
    url: publishUrl,
    accessToken,
    body: publishBody,
    operation: "publish_container",
  });

  if (!publishResponse.ok) {
    throw new MetaGraphRequestError({
      method: "POST",
      url: publishUrl,
      response: publishResponse,
      fallback: "META_IG_POST_FAILED: publish_container",
    });
  }

  const mediaId = toStringValue(publishResponse.body?.id);
  if (!mediaId) {
    throw new MetaGraphRequestError({
      method: "POST",
      url: publishUrl,
      response: publishResponse,
      fallback: "META_IG_POST_FAILED: publish_missing_id",
    });
  }

  return { igUserId, creationId, mediaId };
}

async function postFacebookPageFeed(params: {
  pageId: string;
  accessToken: string;
  message?: string;
  linkUrl?: string;
}): Promise<{ postId: string; message: string; linkUrl: string | null }> {
  const pageId = params.pageId.trim();
  const accessToken = params.accessToken.trim();
  if (!pageId) {
    throw new Error("META_PAGE_ID is missing.");
  }
  if (!accessToken) {
    throw new Error("Meta access token is missing.");
  }

  const message = normalizeText(params.message);
  const linkUrl = params.linkUrl?.trim() ? normalizePublicHttpUrl(params.linkUrl, "linkUrl") : null;
  if (!message && !linkUrl) {
    throw new Error("Facebook publish needs message, linkUrl, or imageUrl.");
  }

  const url = `${META_GRAPH_API_BASE}/${encodeURIComponent(pageId)}/feed`;
  const body = new URLSearchParams({
    ...(message ? { message } : {}),
    ...(linkUrl ? { link: linkUrl } : {}),
  });
  const response = await fetchGraph({
    url,
    method: "POST",
    accessToken,
    body,
    contentType: "application/x-www-form-urlencoded",
  });

  if (!response.ok) {
    throw new MetaGraphRequestError({
      method: "POST",
      url,
      response,
      fallback: "META_GRAPH_POST_FAILED: create_feed_post",
    });
  }

  const postId = toStringValue(response.body?.id);
  if (!postId) {
    throw new MetaGraphRequestError({
      method: "POST",
      url,
      response,
      fallback: "META_GRAPH_POST_FAILED: create_feed_post_missing_id",
    });
  }

  return {
    postId,
    message,
    linkUrl,
  };
}

async function postFacebookPagePhoto(params: {
  pageId: string;
  accessToken: string;
  imageUrl: string;
  caption?: string;
}): Promise<{ photoId: string; postId: string | null; caption: string; imageUrl: string }> {
  const pageId = params.pageId.trim();
  const accessToken = params.accessToken.trim();
  const imageUrl = normalizePublicHttpUrl(params.imageUrl, "imageUrl");
  if (!pageId) {
    throw new Error("META_PAGE_ID is missing.");
  }
  if (!accessToken) {
    throw new Error("Meta access token is missing.");
  }

  const caption = normalizeText(params.caption);
  const url = `${META_GRAPH_API_BASE}/${encodeURIComponent(pageId)}/photos`;
  const body = new URLSearchParams({
    url: imageUrl,
    published: "true",
    ...(caption ? { caption } : {}),
  });
  const response = await fetchGraph({
    url,
    method: "POST",
    accessToken,
    body,
    contentType: "application/x-www-form-urlencoded",
  });

  if (!response.ok) {
    throw new MetaGraphRequestError({
      method: "POST",
      url,
      response,
      fallback: "META_GRAPH_POST_FAILED: create_photo_post",
    });
  }

  const photoId = toStringValue(response.body?.id);
  if (!photoId) {
    throw new MetaGraphRequestError({
      method: "POST",
      url,
      response,
      fallback: "META_GRAPH_POST_FAILED: create_photo_post_missing_id",
    });
  }

  return {
    photoId,
    postId: toStringValue(response.body?.post_id),
    caption,
    imageUrl,
  };
}

function buildInstagramCaption(message: string, linkUrl: string | null): string {
  const caption = message.trim();
  if (!linkUrl) {
    return caption;
  }
  if (!caption) {
    return linkUrl;
  }
  if (caption.includes(linkUrl)) {
    return caption;
  }
  return `${caption}\n\n${linkUrl}`;
}

function collectMetaEnvStatus() {
  const pageId = process.env.META_PAGE_ID?.trim() ?? "";
  const accessToken = process.env.META_ACCESS_TOKEN?.trim() ?? "";
  const pageAccessToken = process.env.META_PAGE_ACCESS_TOKEN?.trim() ?? "";
  const appId = process.env.META_APP_ID?.trim() ?? "";
  const appSecret = process.env.META_APP_SECRET?.trim() ?? "";
  const missingEnv: string[] = [];
  if (!pageId) {
    missingEnv.push("META_PAGE_ID");
  }
  if (!accessToken && !pageAccessToken) {
    missingEnv.push("META_ACCESS_TOKEN or META_PAGE_ACCESS_TOKEN");
  }

  return {
    pageId,
    accessToken,
    pageAccessToken,
    appId,
    appSecret,
    missingEnv,
    configured: {
      pageIdPresent: Boolean(pageId),
      accessTokenPresent: Boolean(accessToken),
      pageAccessTokenPresent: Boolean(pageAccessToken),
      appIdPresent: Boolean(appId),
      appSecretPresent: Boolean(appSecret),
    },
  };
}

async function resolveMetaStatus() {
  const envStatus = collectMetaEnvStatus();
  const errors: string[] = [];
  let pageToken: MetaPageAccessTokenResolution | null = null;
  let page: Record<string, unknown> | null = null;
  let permissions: {
    ok: boolean;
    status: number;
    granted: string[];
    missingRequired: string[];
    error: MetaGraphErrorSummary | null;
  } | null = null;
  let instagram: {
    linked: boolean;
    id: string | null;
    username: string | null;
    error: string | null;
  } | null = null;

  if (envStatus.pageId && (envStatus.accessToken || envStatus.pageAccessToken)) {
    try {
      pageToken = await resolveFacebookPageAccessToken({
        pageId: envStatus.pageId,
        accessToken: envStatus.accessToken,
        pageAccessToken: envStatus.pageAccessToken,
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (envStatus.pageId && pageToken?.token) {
    try {
      const pageResponse = await fetchGraph({
        url: `${META_GRAPH_API_BASE}/${encodeURIComponent(envStatus.pageId)}?fields=id,name`,
        method: "GET",
        accessToken: pageToken.token,
      });
      if (!pageResponse.ok) {
        errors.push(
          formatGraphErrorMessage({ response: pageResponse, fallback: "META_PAGE_GET_FAILED" }),
        );
      } else {
        page = {
          id: toStringValue(pageResponse.body?.id),
          name: toStringValue(pageResponse.body?.name),
        };
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    try {
      const account = await resolveInstagramBusinessAccount({
        pageId: envStatus.pageId,
        pageAccessToken: pageToken.token,
      });
      instagram = {
        linked: Boolean(account?.id),
        id: account?.id ?? null,
        username: account?.username ?? null,
        error: null,
      };
    } catch (error) {
      instagram = {
        linked: false,
        id: null,
        username: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (envStatus.accessToken) {
    try {
      const result = await fetchMePermissions(envStatus.accessToken);
      const granted = (result.permissions ?? [])
        .filter((entry) => entry.status === "granted")
        .map((entry) => entry.permission);
      permissions = {
        ok: result.ok,
        status: result.status,
        granted,
        missingRequired: META_REQUIRED_PERMISSIONS.filter((entry) => !granted.includes(entry)),
        error: result.error,
      };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    ok: envStatus.missingEnv.length === 0 && errors.length === 0,
    env: envStatus.configured,
    missingEnv: envStatus.missingEnv,
    pageToken,
    page,
    permissions,
    instagram,
    errors,
  };
}

function describeMetaError(error: unknown) {
  if (error instanceof MetaGraphRequestError) {
    return {
      message: error.message,
      status: error.status,
      error: error.error,
    };
  }
  if (error instanceof Error) {
    return {
      message: error.message,
    };
  }
  return {
    message: String(error),
  };
}

function buildPublishPlan(params: {
  platform: (typeof META_SOCIAL_PLATFORMS)[number];
  message: string;
  imageUrl: string;
  linkUrl: string;
  publishToFeed: boolean;
}) {
  const operations: string[] = [];
  const warnings: string[] = [];

  if (params.platform === "facebook" || params.platform === "both") {
    if (params.imageUrl && !params.publishToFeed) {
      operations.push("facebook_photo_post");
      if (params.linkUrl) {
        warnings.push("Facebook photo posts ignore linkUrl.");
      }
    } else {
      operations.push("facebook_feed_post");
    }
  }

  if (params.platform === "instagram" || params.platform === "both") {
    operations.push("instagram_photo_post");
    if (params.linkUrl) {
      warnings.push(
        "Instagram appends linkUrl into the caption because there is no separate link field.",
      );
    }
  }

  return { operations, warnings };
}

function validatePublishRequest(params: {
  platform: (typeof META_SOCIAL_PLATFORMS)[number];
  message: string;
  imageUrl: string;
  linkUrl: string;
}) {
  if (params.platform === "instagram" || params.platform === "both") {
    if (!params.imageUrl) {
      throw new Error("Instagram publishing requires imageUrl.");
    }
  }

  if (params.platform === "both" && !params.imageUrl) {
    throw new Error("Publishing to both Facebook and Instagram requires imageUrl.");
  }

  if (!params.message && !params.imageUrl && !params.linkUrl) {
    throw new Error("Provide at least one of message, imageUrl, or linkUrl.");
  }
}

async function publishMetaContent(params: {
  platform: (typeof META_SOCIAL_PLATFORMS)[number];
  message: string;
  imageUrl: string;
  linkUrl: string;
  publishToFeed: boolean;
  dryRun: boolean;
}) {
  validatePublishRequest(params);
  const envStatus = collectMetaEnvStatus();
  if (envStatus.missingEnv.length > 0) {
    return {
      ok: false,
      missingEnv: envStatus.missingEnv,
      error: "Meta publishing is not configured.",
    };
  }

  const plan = buildPublishPlan(params);
  if (params.dryRun) {
    return {
      ok: true,
      dryRun: true,
      platform: params.platform,
      plan,
      env: envStatus.configured,
    };
  }

  const pageToken = await resolveFacebookPageAccessToken({
    pageId: envStatus.pageId,
    accessToken: envStatus.accessToken,
    pageAccessToken: envStatus.pageAccessToken,
  });

  const results: Record<string, unknown> = {};
  const errors: Array<Record<string, unknown>> = [];

  if (params.platform === "facebook" || params.platform === "both") {
    try {
      results.facebook =
        params.imageUrl && !params.publishToFeed
          ? await postFacebookPagePhoto({
              pageId: envStatus.pageId,
              accessToken: pageToken.token,
              imageUrl: params.imageUrl,
              caption: params.message,
            })
          : await postFacebookPageFeed({
              pageId: envStatus.pageId,
              accessToken: pageToken.token,
              message: params.message,
              linkUrl: params.linkUrl || undefined,
            });
    } catch (error) {
      errors.push({
        platform: "facebook",
        ...describeMetaError(error),
      });
    }
  }

  if (params.platform === "instagram" || params.platform === "both") {
    try {
      const instagramBusiness = await resolveInstagramBusinessAccount({
        pageId: envStatus.pageId,
        pageAccessToken: pageToken.token,
      });
      if (!instagramBusiness?.id) {
        throw new Error(
          "instagram_business_account is missing. Link the Facebook Page to an Instagram Business or Creator account first.",
        );
      }
      results.instagram = await publishInstagramPhoto({
        igUserId: instagramBusiness.id,
        accessToken: pageToken.token,
        imageUrl: params.imageUrl,
        caption: buildInstagramCaption(params.message, params.linkUrl || null),
      });
    } catch (error) {
      errors.push({
        platform: "instagram",
        ...describeMetaError(error),
      });
    }
  }

  return {
    ok: errors.length === 0,
    platform: params.platform,
    pageId: envStatus.pageId,
    pageTokenSource: pageToken.source,
    plan,
    results,
    errors,
  };
}

export function createMetaSocialTool(options?: { config?: OpenClawConfig }): AnyAgentTool | null {
  if (options?.config?.tools?.metaSocial?.enabled !== true) {
    return null;
  }

  return {
    label: "Meta Social",
    name: "meta_social",
    description:
      "Check Meta setup or publish directly to a Facebook Page and/or its linked Instagram Business account. Only use when the user explicitly asks to post. Requires META_PAGE_ID plus META_ACCESS_TOKEN or META_PAGE_ACCESS_TOKEN.",
    parameters: MetaSocialToolSchema,
    execute: async (_toolCallId, args) => {
      try {
        const params = asRecord(args) ?? {};
        const action = normalizeText(params.action);
        if (action === "status") {
          return jsonResult(await resolveMetaStatus());
        }
        if (action !== "publish") {
          return jsonResult({ ok: false, error: `Unsupported action: ${action || "<missing>"}` });
        }

        const platform = normalizeText(params.platform) as (typeof META_SOCIAL_PLATFORMS)[number];
        if (!META_SOCIAL_PLATFORMS.includes(platform)) {
          return jsonResult({
            ok: false,
            error: "platform must be facebook, instagram, or both",
          });
        }

        const message = normalizeText(params.message);
        const imageUrl = normalizeText(params.imageUrl);
        const linkUrl = normalizeText(params.linkUrl);
        const publishToFeed = params.publishToFeed === true;
        const dryRun = params.dryRun === true;

        return jsonResult(
          await publishMetaContent({
            platform,
            message,
            imageUrl,
            linkUrl,
            publishToFeed,
            dryRun,
          }),
        );
      } catch (error) {
        return jsonResult({
          ok: false,
          ...describeMetaError(error),
        });
      }
    },
  };
}
