import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { canonicalizeEtsyListingUrl, postFacebookPageEtsyListing } from "../infra/meta-facebook.js";
import {
  fetchMePermissions,
  type InstagramBusinessAccount,
  MetaGraphRequestError,
  publishInstagramPhoto,
  resolveFacebookPageAccessToken,
  resolveInstagramBusinessAccount,
} from "../infra/meta-instagram.js";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const TELEGRAM_POLL_TIMEOUT_SECONDS = 25;
const MAX_SEEN_IDS = 500;
const STATE_PATH = "/data/.openclaw/state/etsy_rss.json";

const ETSY_SHOP_RSS_URL = process.env.ETSY_SHOP_RSS_URL?.trim() ?? "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID?.trim() ?? "";
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN?.trim() ?? "";
const META_PAGE_ID = process.env.META_PAGE_ID?.trim() ?? "";
const RSS_FACEBOOK_ENABLED = process.env.RSS_FACEBOOK_ENABLED === "1";
const RSS_FACEBOOK_VERIFY_ATTACHMENT = process.env.RSS_FACEBOOK_VERIFY_ATTACHMENT === "1";
const RSS_FACEBOOK_VERIFY_DELAY_MS = toNumberOrUndefined(process.env.RSS_FACEBOOK_VERIFY_DELAY_MS);
const RSS_INSTAGRAM_ENABLED = process.env.RSS_INSTAGRAM_ENABLED === "1";
const RSS_INSTAGRAM_IMAGE_URL_OVERRIDE = process.env.RSS_INSTAGRAM_IMAGE_URL_OVERRIDE?.trim() ?? "";
const RSS_INSTAGRAM_POLL_INTERVAL_MS = toNumberOrUndefined(
  process.env.RSS_INSTAGRAM_POLL_INTERVAL_MS,
);
const RSS_INSTAGRAM_POLL_TIMEOUT_MS = toNumberOrUndefined(
  process.env.RSS_INSTAGRAM_POLL_TIMEOUT_MS,
);
const RSS_INSTAGRAM_TEST_IMAGE_URL = process.env.RSS_INSTAGRAM_TEST_IMAGE_URL?.trim() ?? "";
const CHECK_INTERVAL_MS = resolveCheckIntervalMs(process.env.RSS_CHECK_INTERVAL_MS);
const HEALTH_PORT = toNumberOrUndefined(process.env.PORT) ?? 8080;
const RSS_DISABLE_HEALTH_SERVER = process.env.RSS_DISABLE_HEALTH_SERVER === "1";
let alertsEnabledMemo: boolean | null = null;
let facebookEnabledMemo: boolean | null = null;
let instagramEnabledMemo: boolean | null = null;
let metaPermissionsMemo: {
  ok: boolean;
  status: number;
  permissions: Array<{ permission: string; status: string }> | null;
} | null = null;
let metaPageTokenMemo: {
  token: string;
  source: "provided" | "me_accounts";
  pageName: string | null;
  fingerprint: string;
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
    return {
      seenIds: seenIds.slice(0, MAX_SEEN_IDS),
      igFailedIds: igFailedIds.slice(0, MAX_SEEN_IDS),
      initialized,
      telegramOffset,
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
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(
    STATE_PATH,
    JSON.stringify(
      {
        ...state,
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

  if (!RSS_FACEBOOK_ENABLED) {
    facebookEnabledMemo = false;
    console.info("[rss] RSS_FACEBOOK_ENABLED is not set; Facebook posts disabled.");
    return facebookEnabledMemo;
  }
  if (!META_ACCESS_TOKEN) {
    facebookEnabledMemo = false;
    console.info("[rss] META_ACCESS_TOKEN missing; Facebook posts disabled.");
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

  if (!RSS_INSTAGRAM_ENABLED) {
    instagramEnabledMemo = false;
    console.info("[rss] RSS_INSTAGRAM_ENABLED is not set; Instagram posts disabled.");
    return instagramEnabledMemo;
  }
  if (!META_ACCESS_TOKEN) {
    instagramEnabledMemo = false;
    console.info("[rss] META_ACCESS_TOKEN missing; Instagram posts disabled.");
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
    const result = await postFacebookPageEtsyListing({
      pageId: META_PAGE_ID,
      accessToken: META_ACCESS_TOKEN,
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
  } catch (error) {
    console.log(`[rss] Facebook post failed: ${String(error)}`);
  }
}

async function logMetaTokenPermissionsOnce(): Promise<void> {
  if (metaPermissionsMemo !== null) {
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
  source: "provided" | "me_accounts";
  pageName: string | null;
  fingerprint: string;
}> {
  if (metaPageTokenMemo) {
    return metaPageTokenMemo;
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
    return { ok: true, igId: null };
  }

  if (!item.link) {
    console.log(`[rss] Instagram post skipped: missing item.link for "${item.title}"`);
    return { ok: false, igId: null };
  }

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

async function runCheck(trigger: "startup" | "scheduled" | "manual"): Promise<void> {
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
      if (trigger === "manual" && alertsEnabled()) {
        await sendTelegramText("RSS run complete: no new items.");
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
    `RSS watcher boot: ETSY_SHOP_RSS_URL present=${ETSY_SHOP_RSS_URL ? "yes" : "no"}, state_path=${STATE_PATH}, facebook=${RSS_FACEBOOK_ENABLED ? "on" : "off"}, instagram=${RSS_INSTAGRAM_ENABLED ? "on" : "off"}`,
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
