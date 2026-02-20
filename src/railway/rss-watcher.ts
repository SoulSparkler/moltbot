import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { canonicalizeEtsyListingUrl, postFacebookPageEtsyListing } from "../infra/meta-facebook.js";
import {
  fetchMePermissions,
  type InstagramBusinessAccount,
  type MetaPageAccessTokenResolution,
  MetaGraphRequestError,
  publishInstagramPhoto,
  resolveFacebookPageAccessToken,
  resolveInstagramBusinessAccount,
} from "../infra/meta-instagram.js";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const TELEGRAM_POLL_TIMEOUT_SECONDS = 25;
const MAX_SEEN_IDS = 500;
const STATE_PATH = "/data/.openclaw/state/etsy_rss.json";
const META_REQUIRED_PERMISSIONS = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
] as const;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const ETSY_SHOP_RSS_URL = process.env.ETSY_SHOP_RSS_URL?.trim() ?? "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID?.trim() ?? "";
const TELEGRAM_POLLING_ENABLED = process.env.RUN_TELEGRAM_POLLING === "true";
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN?.trim() ?? "";
const META_PAGE_ACCESS_TOKEN = process.env.META_PAGE_ACCESS_TOKEN?.trim() ?? "";
const META_PAGE_ID = process.env.META_PAGE_ID?.trim() ?? "";
const FACEBOOK_ENABLED_TOGGLE = resolveBooleanToggle("FACEBOOK_ENABLED", "RSS_FACEBOOK_ENABLED");
const INSTAGRAM_ENABLED_TOGGLE = resolveBooleanToggle("INSTAGRAM_ENABLED", "RSS_INSTAGRAM_ENABLED");
const FACEBOOK_ENABLED = FACEBOOK_ENABLED_TOGGLE.enabled;
const RSS_FACEBOOK_VERIFY_ATTACHMENT = process.env.RSS_FACEBOOK_VERIFY_ATTACHMENT === "1";
const RSS_FACEBOOK_VERIFY_DELAY_MS = toNumberOrUndefined(process.env.RSS_FACEBOOK_VERIFY_DELAY_MS);
const INSTAGRAM_ENABLED = INSTAGRAM_ENABLED_TOGGLE.enabled;
const RSS_INSTAGRAM_IMAGE_URL_OVERRIDE = process.env.RSS_INSTAGRAM_IMAGE_URL_OVERRIDE?.trim() ?? "";
const RSS_INSTAGRAM_POLL_INTERVAL_MS = toNumberOrUndefined(
  process.env.RSS_INSTAGRAM_POLL_INTERVAL_MS,
);
const RSS_INSTAGRAM_POLL_TIMEOUT_MS = toNumberOrUndefined(
  process.env.RSS_INSTAGRAM_POLL_TIMEOUT_MS,
);
const RSS_INSTAGRAM_TEST_IMAGE_URL = process.env.RSS_INSTAGRAM_TEST_IMAGE_URL?.trim() ?? "";
const ROTATION_ENABLED = toBooleanOrUndefined(process.env.ROTATION_ENABLED) ?? false;
const ROTATION_COOLDOWN_HOURS = toNumberOrUndefined(process.env.ROTATION_COOLDOWN_HOURS) ?? 24;
const FORCE_ROTATION_POST = toBooleanOrUndefined(process.env.FORCE_ROTATION_POST) ?? false;
const CHECK_INTERVAL_MS = resolveCheckIntervalMs(process.env.RSS_CHECK_INTERVAL_MS);
const HEALTH_PORT = toNumberOrUndefined(process.env.PORT) ?? 8080;
const RSS_DISABLE_HEALTH_SERVER = process.env.RSS_DISABLE_HEALTH_SERVER === "1";
let alertsEnabledMemo: boolean | null = null;
let facebookEnabledMemo: boolean | null = null;
let instagramEnabledMemo: boolean | null = null;
let forceRotationConsumed = false;
let metaPermissionsMemo: {
  ok: boolean;
  status: number;
  permissions: Array<{ permission: string; status: string }> | null;
} | null = null;
let metaPageTokenMemo: {
  token: string;
  source: "env" | MetaPageAccessTokenResolution["source"];
  pageName: string | null;
  fingerprint: string;
  meAccountsStatus: MetaPageAccessTokenResolution["meAccountsStatus"] | null;
} | null = null;
let instagramBusinessMemo: InstagramBusinessAccount | null | undefined = undefined;

type FeedItem = {
  id: string;
  title: string;
  link: string;
  publishedAt?: string;
  publishedAtMs?: number;
};

type WatcherState = {
  seenIds: string[];
  igFailedIds?: string[];
  initialized: boolean;
  telegramOffset: number;
  last_rotation_at?: string;
  last_posted_id?: string;
  posted_at_by_id?: Record<string, string>;
};

type TelegramUpdatesResponse = {
  ok?: boolean;
  result?: Array<{
    update_id?: number;
    message?: {
      text?: string;
      chat?: { id?: number | string };
    };
  }>;
  description?: string;
};

let currentState: WatcherState = {
  seenIds: [],
  igFailedIds: [],
  initialized: false,
  telegramOffset: 0,
};
let checkInFlight: Promise<void> | null = null;
let queuedManualRun = false;

function resolveCheckIntervalMs(raw: string | undefined): number {
  if (!raw) {
    return SIX_HOURS_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return SIX_HOURS_MS;
  }
  return parsed;
}

function toNumberOrUndefined(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toBooleanOrUndefined(raw: string | undefined): boolean | undefined {
  if (!raw) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

type BooleanToggleResolution = {
  enabled: boolean;
  primaryEnv: string;
  primaryRaw: string | null;
  legacyEnv?: string;
  legacyRaw?: string | null;
};

function resolveBooleanToggle(primaryEnv: string, legacyEnv?: string): BooleanToggleResolution {
  const primaryRaw = process.env[primaryEnv] ?? null;
  const legacyRaw = legacyEnv ? (process.env[legacyEnv] ?? null) : null;
  const raw = primaryRaw ?? legacyRaw ?? undefined;
  return {
    enabled: toBooleanOrUndefined(raw) ?? false,
    primaryEnv,
    primaryRaw,
    ...(legacyEnv ? { legacyEnv, legacyRaw } : {}),
  };
}

function formatEnvValue(raw: string | null | undefined): string {
  if (raw == null || raw === "") {
    return "<unset>";
  }
  return raw;
}

function stripCdata(raw: string): string {
  return raw
    .replace(/^<!\[CDATA\[/, "")
    .replace(/\]\]>$/, "")
    .trim();
}

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_match, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    });
}

function findTagText(block: string, tags: string[]): string {
  for (const tag of tags) {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
    const match = re.exec(block);
    if (match && match[1]) {
      return decodeXmlEntities(stripCdata(match[1]));
    }
  }
  return "";
}

function findLinkValue(block: string): string {
  const atomLink = /<link\b[^>]*\bhref="([^"]+)"[^>]*>/i.exec(block);
  if (atomLink?.[1]) {
    return decodeXmlEntities(atomLink[1].trim());
  }
  return findTagText(block, ["link"]);
}

function parseFeedItems(xml: string): FeedItem[] {
  const itemBlocks = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((match) => match[0]);
  const entryBlocks = [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((match) => match[0]);
  const blocks = itemBlocks.length > 0 ? itemBlocks : entryBlocks;

  const parsed = blocks
    .map((block) => {
      const title = findTagText(block, ["title"]).trim();
      const link = findLinkValue(block).trim();
      const id =
        findTagText(block, ["guid", "id"]).trim() ||
        link ||
        title ||
        `${Date.now()}-${Math.random()}`;
      const publishedAt =
        findTagText(block, ["pubDate", "published", "updated", "dc:date"]).trim() || undefined;
      const publishedAtMs = publishedAt ? Date.parse(publishedAt) : Number.NaN;
      return {
        id,
        title: title || "(untitled)",
        link,
        publishedAt,
        publishedAtMs: Number.isFinite(publishedAtMs) ? publishedAtMs : undefined,
      };
    })
    .filter((item) => item.id.trim().length > 0);

  return parsed.toSorted((a, b) => (b.publishedAtMs ?? 0) - (a.publishedAtMs ?? 0));
}

async function loadState(): Promise<WatcherState> {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<WatcherState>;
    const seenIds = Array.isArray(parsed.seenIds)
      ? parsed.seenIds.filter((entry): entry is string => typeof entry === "string")
      : [];
    const igFailedIds = Array.isArray(parsed.igFailedIds)
      ? parsed.igFailedIds.filter((entry): entry is string => typeof entry === "string")
      : [];
    const initialized = parsed.initialized === true;
    const telegramOffset =
      typeof parsed.telegramOffset === "number" && Number.isFinite(parsed.telegramOffset)
        ? parsed.telegramOffset
        : 0;
    const lastRotationAt =
      typeof parsed.last_rotation_at === "string" &&
      Number.isFinite(Date.parse(parsed.last_rotation_at))
        ? parsed.last_rotation_at
        : undefined;
    const lastPostedId =
      typeof parsed.last_posted_id === "string" ? parsed.last_posted_id.trim() : "";
    const postedAtByIdRaw =
      parsed.posted_at_by_id && typeof parsed.posted_at_by_id === "object"
        ? parsed.posted_at_by_id
        : null;
    const postedAtById =
      postedAtByIdRaw && !Array.isArray(postedAtByIdRaw)
        ? Object.fromEntries(
            Object.entries(postedAtByIdRaw as Record<string, unknown>)
              .map(([key, value]) => [key, typeof value === "string" ? value.trim() : ""])
              .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1]))
              .map(([key, value]) =>
                Number.isFinite(Date.parse(value)) ? ([key, value] as const) : ([key, ""] as const),
              )
              .filter((entry) => Boolean(entry[1])),
          )
        : undefined;
    return {
      seenIds: seenIds.slice(0, MAX_SEEN_IDS),
      igFailedIds: igFailedIds.slice(0, MAX_SEEN_IDS),
      initialized,
      telegramOffset,
      ...(lastRotationAt ? { last_rotation_at: lastRotationAt } : {}),
      ...(lastPostedId ? { last_posted_id: lastPostedId } : {}),
      ...(postedAtById && Object.keys(postedAtById).length > 0
        ? { posted_at_by_id: postedAtById }
        : {}),
    };
  } catch {
    return {
      seenIds: [],
      igFailedIds: [],
      initialized: false,
      telegramOffset: 0,
    };
  }
}

async function saveState(state: WatcherState): Promise<void> {
  const postedAtByIdEntries = Object.entries(state.posted_at_by_id ?? {})
    .map(([key, value]) => [key.trim(), value.trim()] as const)
    .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1]))
    .map(([key, value]) => [key, value, Date.parse(value)] as const)
    .filter((entry): entry is [string, string, number] => Number.isFinite(entry[2]));

  postedAtByIdEntries.sort((a, b) => b[2] - a[2]);
  const normalizedPostedAtById =
    postedAtByIdEntries.length > 0
      ? Object.fromEntries(
          postedAtByIdEntries
            .slice(0, MAX_SEEN_IDS)
            .map(([key, value]) => [key, new Date(Date.parse(value)).toISOString()] as const),
        )
      : undefined;

  const normalizedLastRotationAt =
    typeof state.last_rotation_at === "string" &&
    Number.isFinite(Date.parse(state.last_rotation_at))
      ? new Date(Date.parse(state.last_rotation_at)).toISOString()
      : undefined;
  const normalizedLastPostedId =
    typeof state.last_posted_id === "string" && state.last_posted_id.trim()
      ? state.last_posted_id.trim()
      : undefined;

  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(
    STATE_PATH,
    JSON.stringify(
      {
        ...state,
        ...(normalizedLastRotationAt ? { last_rotation_at: normalizedLastRotationAt } : {}),
        ...(normalizedLastPostedId ? { last_posted_id: normalizedLastPostedId } : {}),
        ...(normalizedPostedAtById ? { posted_at_by_id: normalizedPostedAtById } : {}),
        seenIds: state.seenIds.slice(0, MAX_SEEN_IDS),
        igFailedIds: state.igFailedIds?.slice(0, MAX_SEEN_IDS) ?? [],
      },
      null,
      2,
    ),
    "utf8",
  );
}

function alertsEnabled(): boolean {
  if (alertsEnabledMemo !== null) {
    return alertsEnabledMemo;
  }
  if (!TELEGRAM_BOT_TOKEN) {
    alertsEnabledMemo = false;
    console.info("[rss] TELEGRAM_BOT_TOKEN missing; alerts disabled.");
    return alertsEnabledMemo;
  }
  if (!TELEGRAM_CHAT_ID) {
    alertsEnabledMemo = false;
    console.info("[rss] TELEGRAM_CHAT_ID missing; alerts disabled.");
    return alertsEnabledMemo;
  }
  alertsEnabledMemo = true;
  console.info("[rss] Telegram alerts enabled.");
  return alertsEnabledMemo;
}

function facebookEnabled(): boolean {
  if (facebookEnabledMemo !== null) {
    return facebookEnabledMemo;
  }

  if (!FACEBOOK_ENABLED) {
    facebookEnabledMemo = false;
    console.info('[rss] facebook disabled; skipping (set FACEBOOK_ENABLED="true" to enable).');
    return facebookEnabledMemo;
  }
  if (!META_ACCESS_TOKEN && !META_PAGE_ACCESS_TOKEN) {
    facebookEnabledMemo = false;
    console.info(
      "[rss] META_ACCESS_TOKEN and META_PAGE_ACCESS_TOKEN missing; Facebook posts disabled.",
    );
    return facebookEnabledMemo;
  }
  if (!META_PAGE_ID) {
    facebookEnabledMemo = false;
    console.info("[rss] META_PAGE_ID missing; Facebook posts disabled.");
    return facebookEnabledMemo;
  }

  facebookEnabledMemo = true;
  console.info(
    `[rss] Facebook posts enabled. verify_attachment=${RSS_FACEBOOK_VERIFY_ATTACHMENT ? "yes" : "no"}`,
  );
  return facebookEnabledMemo;
}

function instagramEnabled(): boolean {
  if (instagramEnabledMemo !== null) {
    return instagramEnabledMemo;
  }

  if (!INSTAGRAM_ENABLED) {
    instagramEnabledMemo = false;
    console.info('[rss] instagram disabled; skipping (set INSTAGRAM_ENABLED="true" to enable).');
    return instagramEnabledMemo;
  }
  if (!META_ACCESS_TOKEN && !META_PAGE_ACCESS_TOKEN) {
    instagramEnabledMemo = false;
    console.info(
      "[rss] META_ACCESS_TOKEN and META_PAGE_ACCESS_TOKEN missing; Instagram posts disabled.",
    );
    return instagramEnabledMemo;
  }
  if (!META_PAGE_ID) {
    instagramEnabledMemo = false;
    console.info("[rss] META_PAGE_ID missing; Instagram posts disabled.");
    return instagramEnabledMemo;
  }

  instagramEnabledMemo = true;
  console.info("[rss] Instagram posts enabled.");
  return instagramEnabledMemo;
}

function formatTokenFingerprint(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) {
    return "<missing>";
  }
  if (trimmed.length <= 12) {
    return `${trimmed.slice(0, 3)}...${trimmed.slice(-3)}`;
  }
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)} (${trimmed.length})`;
}

function logMeta(event: string, data: Record<string, unknown>) {
  console.log(`[rss][meta] ${event} ${JSON.stringify(data)}`);
}

type MetaHealthcheckStatus = {
  page_access_ok: boolean;
  page_id_found: boolean;
  ig_linked: boolean;
  missing_permissions: string[];
  error?: string;
};

function parseIsoTimestampMs(raw: string | undefined): number | null {
  if (typeof raw !== "string") {
    return null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

async function runMetaHealthcheck(): Promise<MetaHealthcheckStatus> {
  const missingPermissions = new Set<string>(META_REQUIRED_PERMISSIONS);
  const errors: string[] = [];
  let pageIdFound = false;
  let pageAccessOk = false;
  let igLinked = false;

  if (!META_PAGE_ID || (!META_ACCESS_TOKEN && !META_PAGE_ACCESS_TOKEN)) {
    const missingConfig: string[] = [];
    if (!META_PAGE_ID) {
      missingConfig.push("META_PAGE_ID");
    }
    if (!META_ACCESS_TOKEN && !META_PAGE_ACCESS_TOKEN) {
      missingConfig.push("META_ACCESS_TOKEN");
      missingConfig.push("META_PAGE_ACCESS_TOKEN");
    }
    const status: MetaHealthcheckStatus = {
      page_access_ok: false,
      page_id_found: false,
      ig_linked: false,
      missing_permissions: Array.from(missingPermissions),
      error: `missing_config:${missingConfig.join(",")}`,
    };
    logMeta("healthcheck", status);
    return status;
  }

  let pageToken: Awaited<ReturnType<typeof resolveMetaPageTokenOnce>> | null = null;
  try {
    pageToken = await resolveMetaPageTokenOnce();
    pageIdFound =
      pageToken.source === "env" ? true : Boolean(pageToken.meAccountsStatus?.matchedPage);
  } catch (error) {
    errors.push(`page_token_failed:${String(error)}`);
  }

  if (META_ACCESS_TOKEN) {
    try {
      const permissions = await fetchMePermissions({ accessToken: META_ACCESS_TOKEN });
      if (!permissions.ok || !permissions.permissions) {
        errors.push(`me_permissions_failed:status=${permissions.status}`);
      } else {
        for (const entry of permissions.permissions) {
          if (entry.status.trim().toLowerCase() === "granted") {
            missingPermissions.delete(entry.permission);
          }
        }
      }
    } catch (error) {
      errors.push(`me_permissions_failed:${String(error)}`);
    }
  } else {
    errors.push("me_permissions_skipped:missing_META_ACCESS_TOKEN");
  }

  if (pageToken && pageToken.token) {
    try {
      const instagramBusiness = await resolveInstagramBusinessAccount({
        pageId: META_PAGE_ID,
        pageAccessToken: pageToken.token,
        cacheTtlMs: 5 * 60 * 1000,
      });
      pageAccessOk = true;
      igLinked = Boolean(instagramBusiness?.id);
    } catch (error) {
      errors.push(`page_ig_link_failed:${String(error)}`);
    }
  }

  const status: MetaHealthcheckStatus = {
    page_access_ok: pageAccessOk,
    page_id_found: pageIdFound,
    ig_linked: igLinked,
    missing_permissions: Array.from(missingPermissions),
    ...(errors.length > 0 ? { error: errors.join(" | ") } : {}),
  };

  logMeta("healthcheck", status);
  if (status.page_access_ok && !status.ig_linked) {
    console.info(
      "[rss][meta] Instagram business account not linked to this Page; IG posting cannot work.",
    );
  }

  return status;
}

async function sendTelegramText(text: string): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return false;
  }

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      chat_id: toNumberOrUndefined(TELEGRAM_CHAT_ID) ?? TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    description?: string;
  };

  if (!response.ok || payload.ok !== true) {
    const description = payload.description ?? `HTTP ${response.status}`;
    console.log(`[rss] Telegram send failed: ${description}`);
    if (description.toLowerCase().includes("chat not found")) {
      console.log(
        `[rss] Telegram chat not found. Verify TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID}" is numeric and belongs to this bot conversation.`,
      );
    }
    return false;
  }

  return true;
}

async function postFacebookItem(item: FeedItem): Promise<void> {
  if (!facebookEnabled()) {
    return;
  }
  if (!item.link) {
    console.log(`[rss] Facebook post skipped: missing item.link for "${item.title}"`);
    return;
  }

  try {
    const pageToken = await resolveMetaPageTokenOnce();
    logMeta("facebook_publish_attempt", {
      feedItemId: item.id,
      pageId: META_PAGE_ID,
      tokenSource: pageToken.source,
      tokenFingerprint: pageToken.fingerprint,
      listingUrl: item.link,
    });

    const result = await postFacebookPageEtsyListing({
      pageId: META_PAGE_ID,
      accessToken: pageToken.token,
      message: item.title,
      etsyListingUrl: item.link,
      verifyAttachment: RSS_FACEBOOK_VERIFY_ATTACHMENT,
      verifyRetryDelayMs: RSS_FACEBOOK_VERIFY_DELAY_MS ?? 15_000,
    });

    const attachmentStatus =
      result.attachmentVerification?.hasAttachment === true
        ? "attachment=ok"
        : result.attachmentVerification?.hasAttachment === false
          ? "attachment=missing"
          : result.attachmentVerification?.hasAttachment === null
            ? "attachment=unknown"
            : "attachment=unchecked";

    console.log(`[rss] Facebook post created: id=${result.postId} ${attachmentStatus}`);
    logMeta("facebook_publish_ok", {
      pageId: META_PAGE_ID,
      postId: result.postId,
      attachmentStatus,
    });
  } catch (error) {
    console.log(`[rss] Facebook post failed: ${String(error)}`);
    logMeta("facebook_publish_failed", {
      feedItemId: item.id,
      pageId: META_PAGE_ID,
      error: String(error),
    });
  }
}

async function logMetaTokenPermissionsOnce(): Promise<void> {
  if (metaPermissionsMemo !== null) {
    return;
  }

  if (!META_ACCESS_TOKEN) {
    metaPermissionsMemo = { ok: false, status: -1, permissions: null };
    logMeta("me_permissions_skipped", { reason: "META_ACCESS_TOKEN missing" });
    return;
  }

  try {
    const result = await fetchMePermissions({ accessToken: META_ACCESS_TOKEN });
    metaPermissionsMemo = { ok: result.ok, status: result.status, permissions: result.permissions };
    logMeta("me_permissions", {
      ok: result.ok,
      status: result.status,
      permissions: result.permissions ?? null,
      error: result.error ?? null,
    });
  } catch (error) {
    metaPermissionsMemo = { ok: false, status: -1, permissions: null };
    logMeta("me_permissions_error", { error: String(error) });
  }
}

async function resolveMetaPageTokenOnce(): Promise<{
  token: string;
  source: "env" | MetaPageAccessTokenResolution["source"];
  pageName: string | null;
  fingerprint: string;
  meAccountsStatus: MetaPageAccessTokenResolution["meAccountsStatus"] | null;
}> {
  if (metaPageTokenMemo) {
    return metaPageTokenMemo;
  }

  if (META_PAGE_ACCESS_TOKEN) {
    const fingerprint = formatTokenFingerprint(META_PAGE_ACCESS_TOKEN);
    metaPageTokenMemo = {
      token: META_PAGE_ACCESS_TOKEN,
      source: "env",
      pageName: null,
      fingerprint,
      meAccountsStatus: null,
    };
    logMeta("page_token_resolved", {
      pageId: META_PAGE_ID,
      pageName: null,
      tokenSource: "env",
      tokenFingerprint: fingerprint,
      meAccounts: null,
    });
    return metaPageTokenMemo;
  }

  if (!META_ACCESS_TOKEN) {
    throw new Error(
      "META_GRAPH_CONFIG_INVALID: META_ACCESS_TOKEN is missing and META_PAGE_ACCESS_TOKEN is not set.",
    );
  }

  const resolution = await resolveFacebookPageAccessToken({
    pageId: META_PAGE_ID,
    accessToken: META_ACCESS_TOKEN,
  });

  const fingerprint = formatTokenFingerprint(resolution.token);
  metaPageTokenMemo = {
    token: resolution.token,
    source: resolution.source,
    pageName: resolution.pageName,
    fingerprint,
    meAccountsStatus: resolution.meAccountsStatus,
  };

  logMeta("page_token_resolved", {
    pageId: META_PAGE_ID,
    pageName: resolution.pageName,
    tokenSource: resolution.source,
    tokenFingerprint: fingerprint,
    meAccounts: resolution.meAccountsStatus,
  });

  return metaPageTokenMemo;
}

async function resolveInstagramBusinessOnce(): Promise<InstagramBusinessAccount | null> {
  if (instagramBusinessMemo !== undefined) {
    return instagramBusinessMemo;
  }

  const pageToken = await resolveMetaPageTokenOnce();
  const resolved = await resolveInstagramBusinessAccount({
    pageId: META_PAGE_ID,
    pageAccessToken: pageToken.token,
  });

  instagramBusinessMemo = resolved;
  logMeta("instagram_business_account", {
    pageId: META_PAGE_ID,
    igId: resolved?.id ?? null,
    igUsername: resolved?.username ?? null,
  });

  return instagramBusinessMemo;
}

async function resolveEtsyListingOgImageUrl(listingUrl: string): Promise<string> {
  const canonical = canonicalizeEtsyListingUrl(listingUrl);
  const response = await fetch(canonical, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "user-agent": "OpenClawRSS/1.0",
    },
  });
  if (!response.ok) {
    throw new Error(`ETSY_IMAGE_FETCH_FAILED: HTTP ${response.status}`);
  }

  const html = await response.text();
  const candidates: RegExp[] = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["'][^>]*>/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["'][^>]*>/i,
  ];

  for (const re of candidates) {
    const match = re.exec(html);
    const url = match?.[1]?.trim();
    if (url) {
      return url;
    }
  }

  throw new Error("ETSY_IMAGE_NOT_FOUND: missing og:image");
}

async function postInstagramItem(item: FeedItem): Promise<{ ok: boolean; igId: string | null }> {
  if (!instagramEnabled()) {
    console.log("[rss] instagram disabled; skipping");
    return { ok: true, igId: null };
  }

  if (!item.link) {
    console.log(`[rss] Instagram post skipped: missing item.link for "${item.title}"`);
    return { ok: false, igId: null };
  }
  console.log("[rss] instagram enabled; attempting publish");

  let igId: string | null = null;
  let imageUrlForLog: string | null = null;
  let tokenSourceForLog: string | null = null;
  let tokenFingerprintForLog: string | null = null;
  try {
    await logMetaTokenPermissionsOnce();

    const pageToken = await resolveMetaPageTokenOnce();
    tokenSourceForLog = pageToken.source;
    tokenFingerprintForLog = pageToken.fingerprint;
    const instagramBusiness = await resolveInstagramBusinessOnce();
    igId = instagramBusiness?.id ?? null;
    if (!instagramBusiness?.id) {
      logMeta("instagram_not_linked", {
        pageId: META_PAGE_ID,
        reason:
          "instagram_business_account missing (Page not linked to an Instagram business/pro account)",
      });
      return { ok: false, igId: null };
    }

    const caption = item.title.trim();
    const imageUrl =
      RSS_INSTAGRAM_IMAGE_URL_OVERRIDE || (await resolveEtsyListingOgImageUrl(item.link));
    imageUrlForLog = imageUrl;

    logMeta("instagram_publish_attempt", {
      feedItemId: item.id,
      pageId: META_PAGE_ID,
      igId: instagramBusiness.id,
      tokenSource: pageToken.source,
      tokenFingerprint: pageToken.fingerprint,
      imageUrl,
      captionPreview: caption.slice(0, 120),
    });

    const result = await publishInstagramPhoto({
      igUserId: instagramBusiness.id,
      accessToken: pageToken.token,
      imageUrl,
      caption,
      pollIntervalMs: RSS_INSTAGRAM_POLL_INTERVAL_MS ?? 2_000,
      pollTimeoutMs: RSS_INSTAGRAM_POLL_TIMEOUT_MS ?? 60_000,
    });

    logMeta("instagram_publish_ok", {
      pageId: META_PAGE_ID,
      igId: result.igUserId,
      creationId: result.creationId,
      mediaId: result.mediaId,
    });

    return { ok: true, igId: instagramBusiness.id };
  } catch (error) {
    if (error instanceof MetaGraphRequestError) {
      logMeta("instagram_publish_failed", {
        feedItemId: item.id,
        listingUrl: item.link,
        pageId: META_PAGE_ID,
        igId,
        tokenSource: tokenSourceForLog,
        tokenFingerprint: tokenFingerprintForLog,
        imageUrl: imageUrlForLog,
        request: { method: error.method, url: error.url },
        status: error.status,
        error: error.error,
      });
      return { ok: false, igId };
    }

    logMeta("instagram_publish_failed", {
      feedItemId: item.id,
      listingUrl: item.link,
      pageId: META_PAGE_ID,
      igId,
      tokenSource: tokenSourceForLog,
      tokenFingerprint: tokenFingerprintForLog,
      imageUrl: imageUrlForLog,
      error: String(error),
    });
    return { ok: false, igId };
  }
}

async function postInstagramTest(): Promise<boolean> {
  if (!instagramEnabled()) {
    return false;
  }

  if (!RSS_INSTAGRAM_TEST_IMAGE_URL) {
    console.log("[rss] Instagram test skipped: RSS_INSTAGRAM_TEST_IMAGE_URL missing.");
    return false;
  }

  try {
    await logMetaTokenPermissionsOnce();
    const pageToken = await resolveMetaPageTokenOnce();
    const instagramBusiness = await resolveInstagramBusinessOnce();
    if (!instagramBusiness?.id) {
      logMeta("instagram_not_linked", {
        pageId: META_PAGE_ID,
        reason:
          "instagram_business_account missing (Page not linked to an Instagram business/pro account)",
      });
      return false;
    }

    const caption = `OpenClaw IG test ${new Date().toISOString()}`;

    logMeta("instagram_test_attempt", {
      pageId: META_PAGE_ID,
      igId: instagramBusiness.id,
      tokenSource: pageToken.source,
      tokenFingerprint: pageToken.fingerprint,
      imageUrl: RSS_INSTAGRAM_TEST_IMAGE_URL,
    });

    const result = await publishInstagramPhoto({
      igUserId: instagramBusiness.id,
      accessToken: pageToken.token,
      imageUrl: RSS_INSTAGRAM_TEST_IMAGE_URL,
      caption,
      pollIntervalMs: RSS_INSTAGRAM_POLL_INTERVAL_MS ?? 2_000,
      pollTimeoutMs: RSS_INSTAGRAM_POLL_TIMEOUT_MS ?? 60_000,
    });

    logMeta("instagram_test_ok", {
      pageId: META_PAGE_ID,
      igId: result.igUserId,
      creationId: result.creationId,
      mediaId: result.mediaId,
    });
    return true;
  } catch (error) {
    if (error instanceof MetaGraphRequestError) {
      logMeta("instagram_test_failed", {
        pageId: META_PAGE_ID,
        igId: instagramBusinessMemo?.id ?? null,
        request: { method: error.method, url: error.url },
        status: error.status,
        error: error.error,
      });
    } else {
      logMeta("instagram_test_failed", {
        pageId: META_PAGE_ID,
        igId: instagramBusinessMemo?.id ?? null,
        error: String(error),
      });
    }
    return false;
  }
}

function formatFeedItemMessage(item: FeedItem): string {
  const lines = [`[ETSY RSS] ${item.title}`];
  if (item.link) {
    lines.push(item.link);
  }
  if (item.publishedAt) {
    lines.push(`Published: ${item.publishedAt}`);
  }
  return lines.join("\n");
}

async function fetchFeed(url: string): Promise<FeedItem[]> {
  const response = await fetch(url, {
    headers: {
      accept: "application/rss+xml, application/xml, text/xml, */*",
    },
  });
  if (!response.ok) {
    throw new Error(`Feed request failed (HTTP ${response.status})`);
  }
  const xml = await response.text();
  return parseFeedItems(xml);
}

type RotationSelection =
  | { item: FeedItem; reason: "never_posted" | "stale_30d" | "least_recent"; allowRecent: boolean }
  | { item: null; reason: "no_candidates" | "no_eligible" };

function selectRotationItem(params: {
  items: FeedItem[];
  state: WatcherState;
  nowMs: number;
  allowRecent: boolean;
}): RotationSelection {
  const lastPostedId = params.state.last_posted_id?.trim() ?? "";
  const postedAtById = params.state.posted_at_by_id ?? {};
  const candidates = params.items.filter(
    (item) => item.link && item.id && item.id !== lastPostedId,
  );
  if (candidates.length === 0) {
    return { item: null, reason: "no_candidates" };
  }

  const neverPosted = candidates.filter((item) => !postedAtById[item.id]);
  if (neverPosted.length > 0) {
    return { item: neverPosted[0], reason: "never_posted", allowRecent: params.allowRecent };
  }

  const posted = candidates
    .map((item) => {
      const postedAt = postedAtById[item.id];
      const postedAtMs = parseIsoTimestampMs(postedAt);
      return postedAtMs == null ? null : { item, postedAtMs };
    })
    .filter((entry): entry is { item: FeedItem; postedAtMs: number } => Boolean(entry));

  const stale = posted.filter((entry) => params.nowMs - entry.postedAtMs >= THIRTY_DAYS_MS);
  if (stale.length > 0) {
    stale.sort((a, b) => a.postedAtMs - b.postedAtMs);
    return { item: stale[0].item, reason: "stale_30d", allowRecent: params.allowRecent };
  }

  if (params.allowRecent && posted.length > 0) {
    posted.sort((a, b) => a.postedAtMs - b.postedAtMs);
    return { item: posted[0].item, reason: "least_recent", allowRecent: params.allowRecent };
  }

  return { item: null, reason: "no_eligible" };
}

function recordPostedItem(
  state: WatcherState,
  params: { itemId: string; postedAtIso: string },
): void {
  state.last_posted_id = params.itemId;
  if (!state.posted_at_by_id) {
    state.posted_at_by_id = {};
  }
  state.posted_at_by_id[params.itemId] = params.postedAtIso;
}

async function runCheck(trigger: "startup" | "scheduled" | "manual"): Promise<void> {
  await runMetaHealthcheck();

  if (!ETSY_SHOP_RSS_URL) {
    if (trigger === "startup") {
      console.log("[rss] ETSY_SHOP_RSS_URL is missing; watcher idle.");
    }
    return;
  }

  try {
    const items = await fetchFeed(ETSY_SHOP_RSS_URL);
    if (items.length === 0) {
      console.log(`[rss] ${trigger}: feed returned 0 items.`);
      return;
    }

    const known = new Set(currentState.seenIds);
    const newItems = items.filter((item) => !known.has(item.id));

    if (!currentState.initialized) {
      currentState.initialized = true;
      currentState.seenIds = items.map((item) => item.id).slice(0, MAX_SEEN_IDS);
      await saveState(currentState);
      console.log(`[rss] Initialized state with ${currentState.seenIds.length} items.`);
      if (trigger === "manual" && alertsEnabled()) {
        await sendTelegramText(`RSS run complete: 0 new items (initialized baseline).`);
      }
      return;
    }

    if (newItems.length === 0) {
      console.log(`[rss] ${trigger}: no new items.`);

      const nowMs = Date.now();
      const cooldownHours = Number.isFinite(ROTATION_COOLDOWN_HOURS)
        ? Math.max(0, ROTATION_COOLDOWN_HOURS)
        : 24;
      const cooldownMs = cooldownHours * 60 * 60 * 1000;
      const lastRotationMs = parseIsoTimestampMs(currentState.last_rotation_at);
      const cooldownOk = lastRotationMs == null || nowMs - lastRotationMs >= cooldownMs;
      const forceThisRun = FORCE_ROTATION_POST && !forceRotationConsumed;
      const rotationAllowed = forceThisRun || (ROTATION_ENABLED && cooldownOk);

      if (!rotationAllowed) {
        if (!ROTATION_ENABLED && !forceThisRun) {
          console.log("[rss] No new items; rotation skipped (disabled).");
        } else if (!cooldownOk && !forceThisRun) {
          console.log("[rss] No new items; rotation skipped (cooldown).");
        } else {
          console.log("[rss] No new items; rotation skipped.");
        }

        if (trigger === "manual" && alertsEnabled()) {
          await sendTelegramText("RSS run complete: no new items.");
        }
        return;
      }

      if (!facebookEnabled() && !instagramEnabled()) {
        console.log("[rss] No new items; rotation skipped (no channels enabled).");
        if (trigger === "manual" && alertsEnabled()) {
          await sendTelegramText("RSS run complete: no new items.");
        }
        return;
      }

      if (forceThisRun) {
        forceRotationConsumed = true;
        console.log("[rss] MODE=FORCE_ROTATION_POST");
      }

      const selection = selectRotationItem({
        items,
        state: currentState,
        nowMs,
        allowRecent: forceThisRun,
      });

      if (!selection.item) {
        console.log(`[rss] No new items; rotation skipped (${selection.reason}).`);
        if (trigger === "manual" && alertsEnabled()) {
          await sendTelegramText("RSS run complete: no new items.");
        }
        return;
      }

      console.log(
        `[rss] Rotation selected: id=${selection.item.id} reason=${selection.reason} allow_recent=${selection.allowRecent ? "yes" : "no"}`,
      );

      await postFacebookItem(selection.item);
      const igResult = await postInstagramItem(selection.item);
      if (!igResult.ok) {
        currentState.igFailedIds = [
          selection.item.id,
          ...(currentState.igFailedIds ?? []).filter((entry) => entry !== selection.item.id),
        ].slice(0, MAX_SEEN_IDS);
      }

      const postedAtIso = new Date().toISOString();
      recordPostedItem(currentState, { itemId: selection.item.id, postedAtIso });
      currentState.last_rotation_at = postedAtIso;
      await saveState(currentState);
      console.log(`[rss] Rotation post complete: id=${selection.item.id}`);

      if (trigger === "manual" && alertsEnabled()) {
        await sendTelegramText(`RSS run complete: rotation post delivered (no new items).`);
      }
      return;
    }

    const sortedNew = [...newItems].toSorted(
      (a, b) => (a.publishedAtMs ?? 0) - (b.publishedAtMs ?? 0),
    );
    if (alertsEnabled()) {
      for (const item of sortedNew) {
        await sendTelegramText(formatFeedItemMessage(item));
        await postFacebookItem(item);
        const igResult = await postInstagramItem(item);
        if (!igResult.ok) {
          currentState.igFailedIds = [
            item.id,
            ...(currentState.igFailedIds ?? []).filter((entry) => entry !== item.id),
          ].slice(0, MAX_SEEN_IDS);
        }
        recordPostedItem(currentState, { itemId: item.id, postedAtIso: new Date().toISOString() });
      }
      if (trigger === "manual") {
        await sendTelegramText(`RSS run complete: ${sortedNew.length} new item(s).`);
      }
    } else {
      console.log(`[rss] ${trigger}: ${sortedNew.length} new item(s), alerts disabled.`);
      for (const item of sortedNew) {
        await postFacebookItem(item);
        const igResult = await postInstagramItem(item);
        if (!igResult.ok) {
          currentState.igFailedIds = [
            item.id,
            ...(currentState.igFailedIds ?? []).filter((entry) => entry !== item.id),
          ].slice(0, MAX_SEEN_IDS);
        }
        recordPostedItem(currentState, { itemId: item.id, postedAtIso: new Date().toISOString() });
      }
    }

    const merged = [...sortedNew.map((item) => item.id), ...currentState.seenIds];
    currentState.seenIds = Array.from(new Set(merged)).slice(0, MAX_SEEN_IDS);
    await saveState(currentState);
    console.log(`[rss] ${trigger}: delivered ${sortedNew.length} new item(s).`);
  } catch (error) {
    console.log(`[rss] ${trigger} check failed: ${String(error)}`);
    if (trigger === "manual" && alertsEnabled()) {
      await sendTelegramText(`RSS run failed: ${String(error)}`);
    }
  }
}

async function scheduleCheck(trigger: "startup" | "scheduled" | "manual"): Promise<void> {
  if (checkInFlight) {
    if (trigger === "manual") {
      queuedManualRun = true;
    }
    return;
  }

  checkInFlight = runCheck(trigger)
    .catch((error) => {
      console.log(`[rss] unexpected check error: ${String(error)}`);
    })
    .finally(async () => {
      checkInFlight = null;
      if (queuedManualRun) {
        queuedManualRun = false;
        await scheduleCheck("manual");
      }
    });

  await checkInFlight;
}

async function pollTelegramForCommands(): Promise<void> {
  if (!TELEGRAM_POLLING_ENABLED) {
    console.log('[rss] Telegram command polling disabled (RUN_TELEGRAM_POLLING !== "true").');
    return;
  }
  if (!TELEGRAM_BOT_TOKEN) {
    console.log("[rss] Telegram command polling disabled (missing TELEGRAM_BOT_TOKEN).");
    return;
  }
  if (!TELEGRAM_CHAT_ID) {
    console.log("[rss] Telegram command polling disabled (missing TELEGRAM_CHAT_ID).");
    return;
  }

  while (true) {
    try {
      const params = new URLSearchParams({
        timeout: String(TELEGRAM_POLL_TIMEOUT_SECONDS),
        allowed_updates: JSON.stringify(["message"]),
      });
      if (currentState.telegramOffset > 0) {
        params.set("offset", String(currentState.telegramOffset));
      }

      const response = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?${params.toString()}`,
      );
      if (!response.ok) {
        throw new Error(`getUpdates failed (HTTP ${response.status})`);
      }

      const payload = (await response.json()) as TelegramUpdatesResponse;
      if (!payload.ok) {
        throw new Error(payload.description || "getUpdates failed");
      }

      const updates = payload.result ?? [];
      for (const update of updates) {
        const updateId = update.update_id;
        if (typeof updateId === "number") {
          currentState.telegramOffset = Math.max(currentState.telegramOffset, updateId + 1);
        }

        const text = update.message?.text?.trim() ?? "";
        const chatIdRaw = update.message?.chat?.id;
        const incomingChatId =
          typeof chatIdRaw === "number" || typeof chatIdRaw === "string" ? String(chatIdRaw) : "";
        if (!incomingChatId || incomingChatId !== TELEGRAM_CHAT_ID) {
          continue;
        }
        if (text.startsWith("/rss_run")) {
          await sendTelegramText("Running RSS check now.");
          await scheduleCheck("manual");
          continue;
        }

        if (text.startsWith("/ig_test")) {
          await sendTelegramText("Running Instagram test post now.");
          const ok = await postInstagramTest();
          await sendTelegramText(
            ok ? "Instagram test post complete." : "Instagram test post failed (see logs).",
          );
          continue;
        }
      }

      await saveState(currentState);
    } catch (error) {
      console.log(`[rss] Telegram poll failed: ${String(error)}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

async function main(): Promise<void> {
  console.log(`telegram.polling.enabled=${TELEGRAM_POLLING_ENABLED}`);
  console.log(
    `[rss] toggles: FACEBOOK_ENABLED=${FACEBOOK_ENABLED} (FACEBOOK_ENABLED=${formatEnvValue(FACEBOOK_ENABLED_TOGGLE.primaryRaw)}, RSS_FACEBOOK_ENABLED=${formatEnvValue(FACEBOOK_ENABLED_TOGGLE.legacyRaw)}), INSTAGRAM_ENABLED=${INSTAGRAM_ENABLED} (INSTAGRAM_ENABLED=${formatEnvValue(INSTAGRAM_ENABLED_TOGGLE.primaryRaw)}, RSS_INSTAGRAM_ENABLED=${formatEnvValue(INSTAGRAM_ENABLED_TOGGLE.legacyRaw)}), ROTATION_ENABLED=${ROTATION_ENABLED} (ROTATION_ENABLED=${formatEnvValue(process.env.ROTATION_ENABLED)})`,
  );
  if (!RSS_DISABLE_HEALTH_SERVER) {
    const healthServer = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    });
    await new Promise<void>((resolve, reject) => {
      healthServer.once("error", reject);
      healthServer.listen(HEALTH_PORT, "0.0.0.0", () => {
        console.log(`[rss] health server listening on http://0.0.0.0:${HEALTH_PORT}/health`);
        resolve();
      });
    });
  }

  console.log(
    `RSS watcher boot: ETSY_SHOP_RSS_URL present=${ETSY_SHOP_RSS_URL ? "yes" : "no"}, state_path=${STATE_PATH}, facebook=${FACEBOOK_ENABLED ? "on" : "off"}, instagram=${INSTAGRAM_ENABLED ? "on" : "off"}, rotation=${ROTATION_ENABLED ? "on" : "off"}, rotation_cooldown_hours=${ROTATION_COOLDOWN_HOURS}, force_rotation=${FORCE_ROTATION_POST ? "on" : "off"}`,
  );
  currentState = await loadState();
  await saveState(currentState);

  await scheduleCheck("startup");
  setInterval(() => {
    void scheduleCheck("scheduled");
  }, CHECK_INTERVAL_MS).unref();
  void pollTelegramForCommands();
}

void main().catch((error) => {
  console.error(`[rss] fatal startup error: ${String(error)}`);
  process.exitCode = 1;
});
