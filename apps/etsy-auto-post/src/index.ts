import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractEtsyListingImageUrlFromHtml,
  extractEtsyRssImageUrl,
  toShareAndSaveUrl,
} from "./lib/etsy.js";
import { canonicalizeEtsyUrl, postFacebookPagePhoto } from "./lib/meta-facebook.js";
import {
  fetchMePermissions,
  type InstagramBusinessAccount,
  type MetaPageAccessTokenResolution,
  MetaGraphRequestError,
  publishInstagramPhoto,
  resolveFacebookPageAccessToken,
  resolveInstagramBusinessAccount,
} from "./lib/meta-instagram.js";

const SERVICE_NAME = "etsy-auto-post";
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const TELEGRAM_POLL_TIMEOUT_SECONDS = 25;
const MAX_SEEN_IDS = 500;
const DEFAULT_STATE_PATH = "/data/.openclaw/state/etsy_rss.json";
const STATE_PATH = resolveStatePath(process.env.RSS_STATE_PATH, DEFAULT_STATE_PATH);
const META_REQUIRED_PERMISSIONS = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
] as const;

const ETSY_SHOP_RSS_URL = process.env.ETSY_SHOP_RSS_URL?.trim() ?? "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID?.trim() ?? "";
const TELEGRAM_POLLING_ENABLED = process.env.RUN_TELEGRAM_POLLING === "true";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() ?? "";
const RSS_TRANSLATION_OPENAI_MODEL =
  process.env.RSS_TRANSLATION_OPENAI_MODEL?.trim() ?? "gpt-4o-mini";
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN?.trim() ?? "";
const META_PAGE_ACCESS_TOKEN = process.env.META_PAGE_ACCESS_TOKEN?.trim() ?? "";
const META_PAGE_ID = process.env.META_PAGE_ID?.trim() ?? "";
const FACEBOOK_ENABLED_TOGGLE = resolveBooleanToggle("FACEBOOK_ENABLED", "RSS_FACEBOOK_ENABLED");
const INSTAGRAM_ENABLED_TOGGLE = resolveBooleanToggle("INSTAGRAM_ENABLED", "RSS_INSTAGRAM_ENABLED");
const FACEBOOK_ENABLED = FACEBOOK_ENABLED_TOGGLE.enabled;
const RSS_FACEBOOK_VERIFY_ATTACHMENT = process.env.RSS_FACEBOOK_VERIFY_ATTACHMENT === "1";
const INSTAGRAM_ENABLED = INSTAGRAM_ENABLED_TOGGLE.enabled;
const RSS_INSTAGRAM_IMAGE_URL_OVERRIDE = process.env.RSS_INSTAGRAM_IMAGE_URL_OVERRIDE?.trim() ?? "";
const RSS_INSTAGRAM_POLL_INTERVAL_MS = toNumberOrUndefined(
  process.env.RSS_INSTAGRAM_POLL_INTERVAL_MS,
);
const RSS_INSTAGRAM_POLL_TIMEOUT_MS = toNumberOrUndefined(
  process.env.RSS_INSTAGRAM_POLL_TIMEOUT_MS,
);
const RSS_INSTAGRAM_TEST_IMAGE_URL = process.env.RSS_INSTAGRAM_TEST_IMAGE_URL?.trim() ?? "";
const PINTEREST_ACCESS_TOKEN = process.env.PINTEREST_ACCESS_TOKEN?.trim() ?? "";
const PINTEREST_BOARD_ID = process.env.PINTEREST_BOARD_ID?.trim() ?? "";
const PINTEREST_TEST_MODE = process.env.PINTEREST_TEST_MODE === "true";
const PINTEREST_TEST_IMAGE_URL = "https://via.placeholder.com/1000x1500.png";
const PINTEREST_TEST_LINK = "https://tresortendance.etsy.com";
const PINTEREST_TEST_TITLE = "TEST PIN - Jannetje";
const PINTEREST_TEST_DESCRIPTION = "Smoke test";
const CHECK_INTERVAL_MS = resolveCheckIntervalMs(process.env.RSS_CHECK_INTERVAL_MS);
const HEALTH_PORT = toNumberOrUndefined(process.env.PORT) ?? 8080;
const RSS_DISABLE_HEALTH_SERVER = process.env.RSS_DISABLE_HEALTH_SERVER === "1";
const MAX_POSTS_PER_DAY = Math.max(1, toNumberOrUndefined(process.env.MAX_POSTS_PER_DAY) ?? 1);
const MIN_POST_INTERVAL_HOURS = toNumberOrUndefined(process.env.MIN_POST_INTERVAL_HOURS) ?? 24;
const DEDUPE_DAYS = Math.max(1, toNumberOrUndefined(process.env.DEDUPE_DAYS) ?? 30);
const MIN_POST_INTERVAL_MS = Math.max(0, MIN_POST_INTERVAL_HOURS * 60 * 60 * 1000);
const DEDUPE_WINDOW_MS = DEDUPE_DAYS * 24 * 60 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = Math.max(
  5 * 60 * 1000,
  toNumberOrUndefined(process.env.RSS_HEARTBEAT_INTERVAL_MS) ?? 10 * 60 * 1000,
);
const IGNORE_DEDUPE =
  process.env.RSS_IGNORE_DEDUPE === "1" ||
  process.env.RSS_IGNORE_DEDUPE === "true" ||
  process.env.IGNORE_DEDUPE === "1" ||
  process.env.IGNORE_DEDUPE === "true";
const SHARE_AND_SAVE_MEDIUM = "organic";
const SHARE_AND_SAVE_CAMPAIGN = "autopost";

export function buildShareAndSaveUrl(
  listingUrl: string,
  source: "facebook" | "instagram",
): string {
  return toShareAndSaveUrl(listingUrl, {
    utm_source: source,
    utm_medium: SHARE_AND_SAVE_MEDIUM,
    utm_campaign: SHARE_AND_SAVE_CAMPAIGN,
  });
}

export function composeCaptionWithShareUrl(
  captionText: string,
  shareAndSaveUrl: string,
): string {
  return captionText ? `${captionText}\n${shareAndSaveUrl}` : shareAndSaveUrl;
}
let alertsEnabledMemo: boolean | null = null;
type FacebookEnablement = {
  enabled: boolean;
  reason?: string;
  missingEnv?: string[];
};

let facebookEnablementMemo: FacebookEnablement | null = null;
let instagramEnabledMemo: boolean | null = null;
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
  description?: string;
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
  last_successful_post_at?: string;
  last_successful_fb_post_at?: string;
  last_successful_ig_post_at?: string;
  last_attempted_post_at?: string;
  posted_listing_ids?: Record<string, string>;
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
let pinterestTestTriggered = false;
let lastRunSummary: RunSummary | null = null;
const STARTED_AT_ISO = new Date().toISOString();

type BuildInfo = {
  commitSha: string;
  commitSource: string;
  buildTime: string;
  buildTimeSource: string;
  version: string;
  startedAt: string;
  cwd: string;
};

type EmbeddedBuildInfo = {
  commitSha?: string;
  commitSource?: string;
  buildTime?: string;
  buildTimeSource?: string;
};

const COMMIT_ENV_KEYS = [
  "RAILWAY_GIT_COMMIT_SHA",
  "RAILWAY_COMMIT_SHA",
  "GIT_COMMIT_SHA",
  "GIT_SHA",
  "GITHUB_SHA",
  "VERCEL_GIT_COMMIT_SHA",
  "SOURCE_VERSION",
  "COMMIT_SHA",
];

const BUILD_TIME_ENV_KEYS = [
  "RAILWAY_BUILD_TIME",
  "RAILWAY_DEPLOY_TIME",
  "VERCEL_DEPLOYMENT_CREATED_AT",
  "BUILD_TIME",
  "BUILD_TIMESTAMP",
];

let resolvedBuildInfo: BuildInfo | null = null;

function resolveStatePath(overrideRaw: string | undefined, fallback: string): string {
  const candidate = overrideRaw?.trim() || fallback;
  return isAbsolute(candidate) ? candidate : resolvePath(process.cwd(), candidate);
}

function resolveEnvValue(keys: string[]): { value: string | null; source: string | null } {
  for (const key of keys) {
    const value = process.env[key];
    if (value && value.trim()) {
      return { value: value.trim(), source: key };
    }
  }
  return { value: null, source: null };
}

function isEnoent(error: unknown): boolean {
  return Boolean((error as NodeJS.ErrnoException)?.code === "ENOENT");
}

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return null;
    }
    throw error;
  }
}

async function readEmbeddedBuildInfo(): Promise<EmbeddedBuildInfo | null> {
  try {
    const path = fileURLToPath(new URL("./build-info.json", import.meta.url));
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as EmbeddedBuildInfo;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function findGitRoot(): Promise<string | null> {
  let cursor = fileURLToPath(new URL(".", import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const headPath = join(cursor, ".git", "HEAD");
    const head = await readFileSafe(headPath);
    if (head) {
      return join(cursor, ".git");
    }
    const parent = resolvePath(cursor, "..");
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return null;
}

async function readGitSha(gitDir: string): Promise<string | null> {
  const headRaw = await readFileSafe(join(gitDir, "HEAD"));
  if (!headRaw) {
    return null;
  }
  const head = headRaw.trim();
  if (head.startsWith("ref:")) {
    const ref = head.slice("ref:".length).trim();
    return (await readFileSafe(join(gitDir, ref)))?.trim() ?? null;
  }
  return head || null;
}

async function resolveGitCommit(
  fallbackSha: string | null,
): Promise<{ sha: string | null; source: string }> {
  const envCommit = resolveEnvValue(COMMIT_ENV_KEYS);
  if (envCommit.value) {
    return { sha: envCommit.value, source: envCommit.source ?? "env" };
  }

  if (fallbackSha) {
    return { sha: fallbackSha, source: "embedded" };
  }

  const gitDir = await findGitRoot();
  if (!gitDir) {
    return { sha: null, source: "missing_git" };
  }

  const sha = await readGitSha(gitDir);
  return { sha, source: sha ? "git" : "git_missing_ref" };
}

async function resolvePackageVersion(): Promise<string> {
  try {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const json = JSON.parse(await readFile(pkgPath, "utf8")) as { version?: string };
    return json.version?.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

async function resolveBuildInfo(): Promise<BuildInfo> {
  const embedded = await readEmbeddedBuildInfo();
  const { sha, source } = await resolveGitCommit(embedded?.commitSha ?? null);
  const buildTimeEnv = resolveEnvValue(BUILD_TIME_ENV_KEYS);
  const buildTime = buildTimeEnv.value ?? embedded?.buildTime ?? STARTED_AT_ISO;
  const buildTimeSource =
    buildTimeEnv.source ??
    (buildTimeEnv.value ? "env" : embedded?.buildTime ? "embedded" : "startup");

  return {
    commitSha: sha ?? "unknown",
    commitSource: source,
    buildTime,
    buildTimeSource,
    version: await resolvePackageVersion(),
    startedAt: STARTED_AT_ISO,
    cwd: process.cwd(),
  };
}

function logBuildProof(info: BuildInfo): void {
  console.log(
    `[build] sha=${info.commitSha} source=${info.commitSource} version=${info.version} build_time=${info.buildTime} build_time_source=${info.buildTimeSource} start_time=${info.startedAt} service=${SERVICE_NAME}`,
  );
}

function logSelfCheck(info: BuildInfo): void {
  console.log(
    `[self-check] service=${SERVICE_NAME} cwd=${info.cwd} state_path=${STATE_PATH} rss_url=${ETSY_SHOP_RSS_URL || "missing"} facebook=${FACEBOOK_ENABLED ? "on" : "off"} instagram=${INSTAGRAM_ENABLED ? "on" : "off"} max_per_day=${MAX_POSTS_PER_DAY} min_interval_hours=${MIN_POST_INTERVAL_HOURS} dedupe_days=${DEDUPE_DAYS} ignore_dedupe=${IGNORE_DEDUPE} check_interval_ms=${CHECK_INTERVAL_MS} telegram_polling=${TELEGRAM_POLLING_ENABLED ? "on" : "off"} pinterest_test_mode=${PINTEREST_TEST_MODE ? "on" : "off"}`,
  );
}

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

const DUTCH_CAPTION_PATTERNS: RegExp[] = [
  /\b(de|het|een|en|van|met|voor|door|uit|bij|als|op|te|niet|wel|maar|ook|nog|naar|om|dat|die|dit|deze|zijn|haar|mijn|jouw|onze|jullie)\b/i,
  /\b(maat|kleur|staat|verzending|kosten|kijk|beschrijving)\b/i,
  /\b(glazen|vaas|vazen|schaal|schalen|bord|borden|kopje|kopjes|schotel|schoteltje|servies|porselein|kristal|kristallen|antiek|handgemaakt|handbeschilderd)\b/i,
  /\b(italiaanse|franse|keramische|dessertglazen|aardewerk|beeldje|zeldzaam|prachtig|mooi)\b/i,
  /\b(vintage)\s+(italiaanse|franse|keramische|dessertglazen|aardewerk|beeldje|set|middel|zeldzaam|mooi)\b/i,
  /ij/i, // catches lots of Dutch words containing "ij"
];

function stripHtmlToText(raw: string | undefined): string {
  const input = typeof raw === "string" ? raw.trim() : "";
  if (!input) {
    return "";
  }

  return input
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<\/div\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function stripUrlsFromText(raw: string): string {
  const input = raw.trim();
  if (!input) {
    return "";
  }

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

function truncateText(input: string, maxLength: number): string {
  const text = input.trim();
  if (!text) {
    return "";
  }
  if (!Number.isFinite(maxLength) || maxLength <= 0) {
    return "";
  }
  if (text.length <= maxLength) {
    return text;
  }
  if (maxLength <= 1) {
    return text.slice(0, maxLength);
  }
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function detectCaptionLanguage(text: string): "en" | "nl" {
  const trimmed = (text || "").trim();
  if (!trimmed) {
    return "en";
  }

  for (const pattern of DUTCH_CAPTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return "nl";
    }
  }

  return "en";
}

function extractEtsyListingLocaleFromUrl(raw: string): string | null {
  const input = raw.trim();
  if (!input) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }

  const hostname = parsed.hostname.trim().toLowerCase();
  if (hostname === "etsy.me" || !hostname.endsWith("etsy.com")) {
    return null;
  }

  const match = /^\/([a-z]{2})(?:-[a-z]{2})?\/listing\//i.exec(parsed.pathname);
  return match?.[1] ? match[1].toLowerCase() : null;
}

async function translateTextToEnglish(params: { text: string }): Promise<string | null> {
  const text = params.text.trim();
  if (!text || !OPENAI_API_KEY) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000).unref();

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: RSS_TRANSLATION_OPENAI_MODEL,
        temperature: 0.2,
        max_tokens: 240,
        messages: [
          {
            role: "system",
            content:
              "Translate the user-provided text to natural US English. Output ONLY the translation, with no preface and no quotation marks. Do not include any URLs.",
          },
          { role: "user", content: text },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const json = (await response.json().catch(() => null)) as {
      choices?: Array<{
        message?: { content?: string | null } | null;
      }>;
    } | null;

    const translated = json?.choices?.[0]?.message?.content;
    if (typeof translated !== "string") {
      return null;
    }

    const trimmed = translated.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
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
      const description =
        findTagText(block, ["description", "content:encoded", "content", "summary"]).trim() ||
        undefined;
      const publishedAt =
        findTagText(block, ["pubDate", "published", "updated", "dc:date"]).trim() || undefined;
      const publishedAtMs = publishedAt ? Date.parse(publishedAt) : Number.NaN;
      return {
        id,
        title: title || "(untitled)",
        link,
        ...(description ? { description } : {}),
        publishedAt,
        publishedAtMs: Number.isFinite(publishedAtMs) ? publishedAtMs : undefined,
      };
    })
    .filter((item) => item.id.trim().length > 0);

  return parsed.toSorted((a, b) => (b.publishedAtMs ?? 0) - (a.publishedAtMs ?? 0));
}

type ListingCandidate = FeedItem & {
  listingId: string;
  canonicalListingUrl: string;
};

type CaptionBuildResult = {
  captionText: string;
  captionSource: string;
  langDetected: "en" | "nl";
  translationApplied: boolean;
};

type ResolvedImage = {
  imageUrl: string;
  imageSource: string;
  imageHost: string | null;
};

type PublishResult = {
  attempted: boolean;
  ok: boolean;
  postId?: string | null;
  photoId?: string | null;
  creationId?: string | null;
  publishId?: string | null;
  status?: number | null;
  fbtraceId?: string | null;
  error?: unknown;
  skippedReason?: string;
};

type DiagnosticsDecision = {
  index: number;
  feedId: string;
  listingId: string | null;
  canonicalListingUrl: string | null;
  link: string;
  publishedAt: string | null;
  publishedAtMs: number | null;
  decision: "NEW" | "SKIP";
  reason: string;
  lastPostedAt?: string | null;
};

type DiagnosticsReport = {
  ok: boolean;
  rssUrl: string | null;
  fetchedCount: number;
  inspectedCount: number;
  ignoreDedupe: boolean;
  statePath: string;
  gate: {
    ok: boolean;
    reason?: string;
    maxPostsPerDay: number;
    minPostIntervalHours: number;
    last_successful_post_at?: string;
    last_attempted_post_at?: string;
  };
  items: DiagnosticsDecision[];
  error?: string;
  timestamp: string;
};

type RunSummary = {
  at: number;
  trigger: "startup" | "scheduled" | "manual";
  fetched: number;
  inspected: number;
  newItems: number;
  selectedListingId: string | null;
  gate: { ok: boolean; reason?: string };
  ignoreDedupe: boolean;
  lastSuccessfulPostAt?: string;
  lastAttemptedPostAt?: string;
  posted: { facebook: boolean; instagram: boolean };
};

function toListingCandidate(item: FeedItem): ListingCandidate | null {
  const listingId = extractListingId(item.link) ?? extractListingId(item.id);
  if (!listingId) {
    return null;
  }

  const rawUrl = item.link?.trim() || item.id?.trim() || "";
  const fallbackUrl = `https://www.etsy.com/listing/${listingId}`;

  let canonicalListingUrl: string;
  try {
    canonicalListingUrl = canonicalizeEtsyUrl(rawUrl || fallbackUrl);
  } catch {
    try {
      canonicalListingUrl = canonicalizeEtsyUrl(fallbackUrl);
    } catch {
      return null;
    }
  }

  return { ...item, listingId, canonicalListingUrl };
}

async function buildCaption(params: {
  item: FeedItem;
  canonicalListingUrl: string;
}): Promise<CaptionBuildResult> {
  const title = params.item.title.trim();
  const descriptionText = stripHtmlToText(params.item.description);
  const descriptionSnippet = truncateText(descriptionText, 200);

  const captionCandidate =
    title && descriptionSnippet ? `${title}\n\n${descriptionSnippet}` : title || descriptionSnippet;

  const captionSource = title
    ? descriptionSnippet
      ? "rss_title_description"
      : "rss_title"
    : descriptionSnippet
      ? "rss_description"
      : "fallback_generic_en";

  let captionText = stripUrlsFromText(captionCandidate) || "Listing available on Etsy.";

  const listingUrlLocale =
    extractEtsyListingLocaleFromUrl(params.item.link) ??
    extractEtsyListingLocaleFromUrl(params.item.id);

  let langDetected = detectCaptionLanguage(captionText);
  if (langDetected === "en" && listingUrlLocale === "nl") {
    langDetected = "nl";
  }

  let translationApplied = false;
  if (langDetected !== "en") {
    const translated = await translateTextToEnglish({ text: captionText });
    if (translated) {
      captionText = translated;
      translationApplied = true;
    } else {
      captionText = "Listing available on Etsy.";
    }
  }

  captionText = stripUrlsFromText(captionText) || "Listing available on Etsy.";

  console.log(
    `[caption] source=${captionSource} lang=${langDetected} translated=${translationApplied ? "yes" : "no"} length=${captionText.length}`,
  );

  return { captionText, captionSource, langDetected, translationApplied };
}

async function resolveImageForItem(params: {
  item: ListingCandidate;
  canonicalListingUrl: string;
}): Promise<ResolvedImage | null> {
  const rssImage = extractEtsyRssImageUrl(params.item);
  if (rssImage) {
    return {
      imageUrl: rssImage,
      imageSource: "rss_description_img",
      imageHost: urlHostOrNull(rssImage),
    };
  }

  try {
    const resolved = await resolveEtsyListingImageUrl(params.canonicalListingUrl);
    return {
      imageUrl: resolved.imageUrl,
      imageSource: resolved.imageSource,
      imageHost: urlHostOrNull(resolved.imageUrl),
    };
  } catch {
    return null;
  }
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
    const lastSuccessfulPostAt =
      typeof parsed.last_successful_post_at === "string" &&
      Number.isFinite(Date.parse(parsed.last_successful_post_at))
        ? parsed.last_successful_post_at
        : undefined;
    const lastSuccessfulFbPostAt =
      typeof parsed.last_successful_fb_post_at === "string" &&
      Number.isFinite(Date.parse(parsed.last_successful_fb_post_at))
        ? parsed.last_successful_fb_post_at
        : undefined;
    const lastSuccessfulIgPostAt =
      typeof parsed.last_successful_ig_post_at === "string" &&
      Number.isFinite(Date.parse(parsed.last_successful_ig_post_at))
        ? parsed.last_successful_ig_post_at
        : undefined;
    const lastAttemptedPostAt =
      typeof parsed.last_attempted_post_at === "string" &&
      Number.isFinite(Date.parse(parsed.last_attempted_post_at))
        ? parsed.last_attempted_post_at
        : undefined;
    const postedListingIdsRaw =
      parsed.posted_listing_ids && typeof parsed.posted_listing_ids === "object"
        ? parsed.posted_listing_ids
        : null;
    const postedListingIds =
      postedListingIdsRaw && !Array.isArray(postedListingIdsRaw)
        ? Object.fromEntries(
            Object.entries(postedListingIdsRaw as Record<string, unknown>)
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
      ...(lastSuccessfulPostAt ? { last_successful_post_at: lastSuccessfulPostAt } : {}),
      ...(lastSuccessfulFbPostAt ? { last_successful_fb_post_at: lastSuccessfulFbPostAt } : {}),
      ...(lastSuccessfulIgPostAt ? { last_successful_ig_post_at: lastSuccessfulIgPostAt } : {}),
      ...(lastAttemptedPostAt ? { last_attempted_post_at: lastAttemptedPostAt } : {}),
      ...(postedListingIds && Object.keys(postedListingIds).length > 0
        ? { posted_listing_ids: postedListingIds }
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

  const postedListingIdEntries = Object.entries(state.posted_listing_ids ?? {})
    .map(([key, value]) => [key.trim(), value.trim()] as const)
    .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1]))
    .map(([key, value]) => [key, value, Date.parse(value)] as const)
    .filter((entry): entry is [string, string, number] => Number.isFinite(entry[2]));

  postedListingIdEntries.sort((a, b) => b[2] - a[2]);
  const normalizedPostedListingIds =
    postedListingIdEntries.length > 0
      ? Object.fromEntries(
          postedListingIdEntries
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
  const normalizedLastSuccessfulPostAt =
    typeof state.last_successful_post_at === "string" &&
    Number.isFinite(Date.parse(state.last_successful_post_at))
      ? new Date(Date.parse(state.last_successful_post_at)).toISOString()
      : undefined;
  const normalizedLastSuccessfulFbPostAt =
    typeof state.last_successful_fb_post_at === "string" &&
    Number.isFinite(Date.parse(state.last_successful_fb_post_at))
      ? new Date(Date.parse(state.last_successful_fb_post_at)).toISOString()
      : undefined;
  const normalizedLastSuccessfulIgPostAt =
    typeof state.last_successful_ig_post_at === "string" &&
    Number.isFinite(Date.parse(state.last_successful_ig_post_at))
      ? new Date(Date.parse(state.last_successful_ig_post_at)).toISOString()
      : undefined;
  const normalizedLastAttemptedPostAt =
    typeof state.last_attempted_post_at === "string" &&
    Number.isFinite(Date.parse(state.last_attempted_post_at))
      ? new Date(Date.parse(state.last_attempted_post_at)).toISOString()
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
        ...(normalizedLastSuccessfulPostAt
          ? { last_successful_post_at: normalizedLastSuccessfulPostAt }
          : {}),
        ...(normalizedLastSuccessfulFbPostAt
          ? { last_successful_fb_post_at: normalizedLastSuccessfulFbPostAt }
          : {}),
        ...(normalizedLastSuccessfulIgPostAt
          ? { last_successful_ig_post_at: normalizedLastSuccessfulIgPostAt }
          : {}),
        ...(normalizedLastAttemptedPostAt
          ? { last_attempted_post_at: normalizedLastAttemptedPostAt }
          : {}),
        ...(normalizedPostedListingIds ? { posted_listing_ids: normalizedPostedListingIds } : {}),
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

function resolveFacebookEnablement(): FacebookEnablement {
  if (facebookEnablementMemo !== null) {
    return facebookEnablementMemo;
  }

  const missingEnv: string[] = [];

  if (!FACEBOOK_ENABLED) {
    missingEnv.push("FACEBOOK_ENABLED");
    facebookEnablementMemo = {
      enabled: false,
      reason: "FACEBOOK_ENABLED=false",
      missingEnv,
    };
    console.info('[rss] facebook disabled; set FACEBOOK_ENABLED="true" to enable.');
    return facebookEnablementMemo;
  }

  if (!META_ACCESS_TOKEN && !META_PAGE_ACCESS_TOKEN) {
    missingEnv.push("META_ACCESS_TOKEN", "META_PAGE_ACCESS_TOKEN");
    facebookEnablementMemo = {
      enabled: false,
      reason: "meta_access_token_missing",
      missingEnv,
    };
    console.info(
      "[rss] META_ACCESS_TOKEN and/or META_PAGE_ACCESS_TOKEN missing; Facebook posts disabled.",
    );
    return facebookEnablementMemo;
  }

  if (!META_PAGE_ID) {
    missingEnv.push("META_PAGE_ID");
    facebookEnablementMemo = {
      enabled: false,
      reason: "meta_page_id_missing",
      missingEnv,
    };
    console.info("[rss] META_PAGE_ID missing; Facebook posts disabled.");
    return facebookEnablementMemo;
  }

  facebookEnablementMemo = {
    enabled: true,
    reason: "enabled",
    missingEnv,
  };
  console.info(
    `[rss] Facebook posts enabled. verify_attachment=${RSS_FACEBOOK_VERIFY_ATTACHMENT ? "yes" : "no"}`,
  );
  return facebookEnablementMemo;
}

function facebookEnabled(): boolean {
  return resolveFacebookEnablement().enabled;
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

function urlHostOrNull(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  try {
    return new URL(raw).hostname;
  } catch {
    return null;
  }
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

export function extractListingId(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const input = raw.trim();
  if (!input) {
    return null;
  }

  const match = /\/listing\/(\d+)/i.exec(input);
  return match?.[1] ?? null;
}

export function extractRssImageUrl(descriptionHtml: string | null | undefined): string | null {
  return extractEtsyRssImageUrl({ description: descriptionHtml ?? "" });
}

export function shouldPostNow(
  state: WatcherState,
  nowMs: number,
  config?: { maxPostsPerDay?: number; minPostIntervalMs?: number },
): { ok: boolean; reason?: string } {
  const maxPerDay = Math.max(1, config?.maxPostsPerDay ?? MAX_POSTS_PER_DAY);
  const minIntervalMs = Math.max(0, config?.minPostIntervalMs ?? MIN_POST_INTERVAL_MS);
  const lastSuccessMs = parseIsoTimestampMs(state.last_successful_post_at);
  const lastAttemptMs = parseIsoTimestampMs(state.last_attempted_post_at);
  const postsInWindow = Object.values(state.posted_listing_ids ?? {}).filter((iso) => {
    const parsed = parseIsoTimestampMs(iso);
    return parsed != null && nowMs - parsed < 24 * 60 * 60 * 1000;
  }).length;

  if (postsInWindow >= maxPerDay) {
    return { ok: false, reason: "daily_limit" };
  }

  const latestAttemptMs =
    lastSuccessMs != null && lastAttemptMs != null
      ? Math.max(lastSuccessMs, lastAttemptMs)
      : (lastSuccessMs ?? lastAttemptMs);

  if (latestAttemptMs != null && nowMs - latestAttemptMs < minIntervalMs) {
    return { ok: false, reason: "min_interval" };
  }

  return { ok: true };
}

export function isDuplicate(
  listingId: string,
  state: WatcherState,
  nowMs: number,
  config?: { dedupeWindowMs?: number },
): boolean {
  const dedupeWindowMs = Math.max(0, config?.dedupeWindowMs ?? DEDUPE_WINDOW_MS);
  const postedIso = state.posted_listing_ids?.[listingId];
  const postedMs = postedIso ? parseIsoTimestampMs(postedIso) : null;
  if (postedMs == null) {
    return false;
  }
  return nowMs - postedMs < dedupeWindowMs;
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

async function postFacebookItem(params: {
  candidate: ListingCandidate;
  caption: CaptionBuildResult;
  image: ResolvedImage;
}): Promise<PublishResult> {
  const fbStatus = resolveFacebookEnablement();
  if (!fbStatus.enabled) {
    const missing = (fbStatus.missingEnv ?? []).join(",") || "none";
    console.log(
      `[publish] skipped reason=facebook_disabled missing_env=${missing} detail=${fbStatus.reason ?? "unknown"}`,
    );
    return { attempted: false, ok: false, skippedReason: "facebook_disabled" };
  }

  const pageToken = await resolveMetaPageTokenOnce();
  const shareAndSaveUrl = buildShareAndSaveUrl(params.candidate.canonicalListingUrl, "facebook");
  const caption = composeCaptionWithShareUrl(params.caption.captionText, shareAndSaveUrl);

  const logBase = {
    listingId: params.candidate.listingId,
    originalListingUrl: params.candidate.link ?? null,
    canonicalListingUrl: params.candidate.canonicalListingUrl,
    shareAndSaveUrl,
    metaAttachmentUrl: null as string | null,
    imageHost: params.image.imageHost,
    imageSource: params.image.imageSource,
    captionSource: params.caption.captionSource,
    langDetected: params.caption.langDetected,
    translationApplied: params.caption.translationApplied,
  };

  logMeta("facebook_publish_attempt", {
    ...logBase,
    pageId: META_PAGE_ID,
    tokenSource: pageToken.source,
    tokenFingerprint: pageToken.fingerprint,
  });

  console.log(
    `[publish] facebook attempt listing=${params.candidate.listingId} page_id=${META_PAGE_ID} image_host=${params.image.imageHost ?? "unknown"} caption_len=${caption.length} token_source=${pageToken.source}`,
  );

  try {
    const result = await postFacebookPagePhoto({
      pageId: META_PAGE_ID,
      accessToken: pageToken.token,
      imageUrl: params.image.imageUrl,
      caption,
    });

    const id = result.postId ?? result.photoId ?? null;
    if (!id) {
      throw new Error("FACEBOOK_POST_ID_MISSING");
    }

    logMeta("facebook_publish_ok", {
      ...logBase,
      pageId: META_PAGE_ID,
      publishMethod: "photos",
      id,
      photoId: result.photoId,
      postId: result.postId,
    });

    console.log(
      `[publish] facebook success listing=${params.candidate.listingId} photo_id=${result.photoId ?? "n/a"} post_id=${result.postId ?? "n/a"}`,
    );

    return {
      attempted: true,
      ok: true,
      photoId: result.photoId ?? null,
      postId: result.postId ?? null,
    };
  } catch (error) {
    const status =
      error instanceof MetaGraphRequestError
        ? error.status
        : ((error as { status?: number | undefined })?.status ?? null);
    const fbtraceId =
      error instanceof MetaGraphRequestError ? (error.error?.fbtraceId ?? null) : null;
    const errorPayload =
      error instanceof MetaGraphRequestError
        ? JSON.stringify(error.error ?? {})
        : (() => {
            try {
              return JSON.stringify(error);
            } catch {
              return String(error);
            }
          })();
    console.log(
      `[publish] facebook error listing=${params.candidate.listingId} status=${status ?? "unknown"} fbtrace_id=${fbtraceId ?? "none"} error=${errorPayload}`,
    );
    logMeta("facebook_publish_failed", {
      ...logBase,
      pageId: META_PAGE_ID,
      error: String(error),
      status,
      fbtrace_id: fbtraceId,
    });
    return { attempted: true, ok: false, error, status, fbtraceId };
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

const ETSY_LISTING_HTML_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

async function fetchEtsyListingHtml(params: { listingUrlNormalized: string }): Promise<string> {
  let lastStatus: number | null = null;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(params.listingUrlNormalized, {
        headers: {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          "user-agent": ETSY_LISTING_HTML_USER_AGENT,
        },
      });
      lastStatus = response.status;

      const html = await response.text();
      if (response.status === 200 && html.trim()) {
        return html;
      }
      lastError = `http_${response.status}_or_empty_body`;
    } catch (error) {
      lastError = error;
    }

    if (attempt < 2) {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
  }

  throw new Error(
    `ETSY_LISTING_HTML_FETCH_FAILED: status=${lastStatus ?? "network_error"} error=${String(
      lastError,
    )}`,
  );
}

async function resolveEtsyListingImageUrl(listingUrlNormalized: string): Promise<{
  listingUrlNormalized: string;
  imageUrl: string;
  imageSource: "og_image" | "json_ld";
}> {
  const html = await fetchEtsyListingHtml({ listingUrlNormalized });
  const extracted = extractEtsyListingImageUrlFromHtml(html);
  if (!extracted?.url) {
    throw new Error("ETSY_IMAGE_URL_MISSING: unable to extract og:image or JSON-LD image.");
  }
  return { listingUrlNormalized, imageUrl: extracted.url, imageSource: extracted.source };
}

async function postInstagramItem(params: {
  candidate: ListingCandidate;
  caption: CaptionBuildResult;
  image: ResolvedImage | null;
}): Promise<PublishResult & { igId: string | null }> {
  if (!instagramEnabled()) {
    return { ok: true, attempted: false, igId: null, skippedReason: "instagram_disabled" };
  }

  await logMetaTokenPermissionsOnce();

  const pageToken = await resolveMetaPageTokenOnce();
  const instagramBusiness = await resolveInstagramBusinessOnce();
  const igId = instagramBusiness?.id ?? null;
  if (!instagramBusiness?.id) {
    logMeta("instagram_not_linked", {
      pageId: META_PAGE_ID,
      reason:
        "instagram_business_account missing (Page not linked to an Instagram business/pro account)",
    });
    return { ok: false, attempted: true, igId, skippedReason: "ig_not_linked" };
  }

  let imageToUse = params.image;
  let imageSourceForLog = imageToUse?.imageSource ?? null;
  if (RSS_INSTAGRAM_IMAGE_URL_OVERRIDE) {
    imageToUse = {
      imageUrl: RSS_INSTAGRAM_IMAGE_URL_OVERRIDE,
      imageSource: "override",
      imageHost: urlHostOrNull(RSS_INSTAGRAM_IMAGE_URL_OVERRIDE),
    };
    imageSourceForLog = "override";
  }

  if (!imageToUse) {
    logMeta("instagram_publish_skipped", {
      listingId: params.candidate.listingId,
      canonicalListingUrl: params.candidate.canonicalListingUrl,
      reason: "image_missing",
    });
    return { ok: false, attempted: false, igId, skippedReason: "image_missing" };
  }

  const shareAndSaveUrl = buildShareAndSaveUrl(params.candidate.canonicalListingUrl, "instagram");
  const captionForPost = composeCaptionWithShareUrl(params.caption.captionText, shareAndSaveUrl);

  logMeta("instagram_publish_attempt", {
    listingId: params.candidate.listingId,
    originalListingUrl: params.candidate.link ?? null,
    canonicalListingUrl: params.candidate.canonicalListingUrl,
    shareAndSaveUrl,
    pageId: META_PAGE_ID,
    igId,
    tokenSource: pageToken.source,
    tokenFingerprint: pageToken.fingerprint,
    imageHost: imageToUse.imageHost,
    imageSource: imageSourceForLog,
    captionSource: params.caption.captionSource,
    langDetected: params.caption.langDetected,
    translationApplied: params.caption.translationApplied,
    captionPreview: params.caption.captionText.slice(0, 120),
  });

  console.log(
    `[publish] instagram attempt listing=${params.candidate.listingId} ig_id=${igId ?? "none"} image_host=${imageToUse.imageHost ?? "unknown"} caption_len=${captionForPost.length}`,
  );

  try {
    const result = await publishInstagramPhoto({
      igUserId: instagramBusiness.id,
      accessToken: pageToken.token,
      imageUrl: imageToUse.imageUrl,
      caption: captionForPost,
      pollIntervalMs: RSS_INSTAGRAM_POLL_INTERVAL_MS ?? 2_000,
      pollTimeoutMs: RSS_INSTAGRAM_POLL_TIMEOUT_MS ?? 60_000,
    });

    logMeta("instagram_publish_ok", {
      listingId: params.candidate.listingId,
      canonicalListingUrl: params.candidate.canonicalListingUrl,
      shareAndSaveUrl,
      pageId: META_PAGE_ID,
      igId: result.igUserId,
      creationId: result.creationId,
      mediaId: result.mediaId,
    });

    console.log(
      `[publish] instagram success listing=${params.candidate.listingId} media_id=${result.mediaId ?? "n/a"} creation_id=${result.creationId ?? "n/a"}`,
    );

    return {
      attempted: true,
      ok: true,
      igId,
      creationId: result.creationId,
      publishId: result.mediaId,
    };
  } catch (error) {
    console.log(
      `[publish] instagram error listing=${params.candidate.listingId} error=${String(error)}`,
    );
    if (error instanceof MetaGraphRequestError) {
      logMeta("instagram_publish_failed", {
        listingId: params.candidate.listingId,
        canonicalListingUrl: params.candidate.canonicalListingUrl,
        shareAndSaveUrl,
        pageId: META_PAGE_ID,
        igId,
        tokenSource: pageToken.source,
        tokenFingerprint: pageToken.fingerprint,
        imageHost: imageToUse.imageHost,
        imageSource: imageSourceForLog,
        captionSource: params.caption.captionSource,
        langDetected: params.caption.langDetected,
        translationApplied: params.caption.translationApplied,
        request: { method: error.method, url: error.url },
        status: error.status,
        error: error.error,
      });
      return {
        attempted: true,
        ok: false,
        igId,
        status: error.status,
        fbtraceId: error.error?.fbtraceId ?? null,
        error,
      };
    }

    logMeta("instagram_publish_failed", {
      listingId: params.candidate.listingId,
      canonicalListingUrl: params.candidate.canonicalListingUrl,
      shareAndSaveUrl,
      pageId: META_PAGE_ID,
      igId,
      imageHost: imageToUse.imageHost,
      imageSource: imageSourceForLog,
      captionSource: params.caption.captionSource,
      langDetected: params.caption.langDetected,
      translationApplied: params.caption.translationApplied,
      error: String(error),
    });
    return { attempted: true, ok: false, igId, error };
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
      imageHost: urlHostOrNull(RSS_INSTAGRAM_TEST_IMAGE_URL),
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

type PinterestTestResult = {
  ok: boolean;
  status: number;
  pinId: string | null;
  pinUrl: string | null;
  body: unknown;
};

function extractStringField(body: unknown, keys: string[]): string | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const record = body as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatBodyForLog(body: unknown): string {
  if (body === null || body === undefined) {
    return "null";
  }
  if (typeof body === "string") {
    return body;
  }
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

async function createTestPinterestPin(): Promise<PinterestTestResult> {
  if (!PINTEREST_ACCESS_TOKEN || !PINTEREST_BOARD_ID) {
    const missing: string[] = [];
    if (!PINTEREST_ACCESS_TOKEN) {
      missing.push("PINTEREST_ACCESS_TOKEN");
    }
    if (!PINTEREST_BOARD_ID) {
      missing.push("PINTEREST_BOARD_ID");
    }
    const message = `[pinterest] smoke test aborted: missing ${missing.join(", ")}`;
    console.log(message);
    return { ok: false, status: 400, pinId: null, pinUrl: null, body: { error: message } };
  }

  const payload = {
    board_id: PINTEREST_BOARD_ID,
    title: PINTEREST_TEST_TITLE,
    description: PINTEREST_TEST_DESCRIPTION,
    link: PINTEREST_TEST_LINK,
    media_source: {
      source_type: "image_url" as const,
      url: PINTEREST_TEST_IMAGE_URL,
    },
  };

  console.log(`[pinterest] creating test pin on board_id=${PINTEREST_BOARD_ID}`);

  const response = await fetch("https://api.pinterest.com/v5/pins", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${PINTEREST_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  const parsedBody = responseText ? safeJsonParse(responseText) : null;

  if (response.ok) {
    const pinId = extractStringField(parsedBody, ["id", "pin_id"]);
    const pinUrl = extractStringField(parsedBody, ["url", "link"]);
    console.log(
      `[pinterest] smoke test succeeded: status=${response.status} pin_id=${pinId ?? "unknown"} url=${pinUrl ?? "unknown"}`,
    );
    return { ok: true, status: response.status, pinId: pinId ?? null, pinUrl: pinUrl ?? null, body: parsedBody };
  }

  const bodyForLog = parsedBody ?? (responseText || "empty");
  console.log(
    `[pinterest] smoke test failed: status=${response.status} body=${formatBodyForLog(bodyForLog)}`,
  );

  return {
    ok: false,
    status: response.status,
    pinId: null,
    pinUrl: null,
    body: parsedBody ?? responseText,
  };
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

export function classifyFeedItems(params: {
  feedItems: FeedItem[];
  state: WatcherState;
  gate: ReturnType<typeof shouldPostNow>;
  nowMs: number;
  ignoreDedupe?: boolean;
}): { decisions: DiagnosticsDecision[]; eligibleCandidates: ListingCandidate[] } {
  const ignoreDedupe = params.ignoreDedupe === true;
  const seenListingIds = new Set<string>();
  const decisions: DiagnosticsDecision[] = [];
  const eligibleCandidates: ListingCandidate[] = [];

  for (let index = 0; index < params.feedItems.length; index += 1) {
    const item = params.feedItems[index];
    console.log(`[item] guid=${item.id || "n/a"} link=${item.link || "n/a"}`);
    const candidate = toListingCandidate(item);
    if (!candidate) {
      console.log(
        `[normalize] listingId=missing canonicalUrl=missing link=${item.link || "n/a"} guid=${item.id || "n/a"}`,
      );
      decisions.push({
        index: index + 1,
        feedId: item.id,
        listingId: null,
        canonicalListingUrl: null,
        link: item.link,
        publishedAt: item.publishedAt ?? null,
        publishedAtMs: item.publishedAtMs ?? null,
        decision: "SKIP",
        reason: "no_listing_id",
      });
      continue;
    }

    console.log(
      `[normalize] listingId=${candidate.listingId} canonicalUrl=${candidate.canonicalListingUrl}`,
    );

    const duplicateInFeed = seenListingIds.has(candidate.listingId);
    seenListingIds.add(candidate.listingId);

    let decision: DiagnosticsDecision["decision"] = "NEW";
    let reason = "eligible";
    const lastPostedAt = params.state.posted_listing_ids?.[candidate.listingId] ?? null;
    const dedupeHit = isDuplicate(candidate.listingId, params.state, params.nowMs);

    if (duplicateInFeed) {
      decision = "SKIP";
      reason = "duplicate_in_feed";
    } else if (!params.gate.ok) {
      decision = "SKIP";
      reason = `gated:${params.gate.reason ?? "unknown"}`;
    } else if (dedupeHit && !ignoreDedupe) {
      decision = "SKIP";
      reason = "dedupe_window";
    } else if (dedupeHit && ignoreDedupe) {
      decision = "NEW";
      reason = "dedupe_ignored";
    }

    decisions.push({
      index: index + 1,
      feedId: item.id,
      listingId: candidate.listingId,
      canonicalListingUrl: candidate.canonicalListingUrl,
      link: item.link,
      publishedAt: item.publishedAt ?? null,
      publishedAtMs: item.publishedAtMs ?? null,
      decision,
      reason,
      ...(lastPostedAt ? { lastPostedAt } : {}),
    });

    console.log(
      `[dedupe] listingId=${candidate.listingId} decision=${decision} reason=${reason} last_posted_at=${lastPostedAt ?? "none"} published_at=${candidate.publishedAt ?? "unknown"}`,
    );

    if (decision === "NEW") {
      eligibleCandidates.push(candidate);
    }
  }

  return { decisions, eligibleCandidates };
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
    console.log(`[rss] fetched trigger=${trigger} count=${items.length} url=${ETSY_SHOP_RSS_URL}`);
    if (items.length === 0) {
      console.log(`[rss] ${trigger}: feed returned 0 items.`);
      console.log(
        `[rss][metrics] trigger=${trigger} fetched=0 inspected=0 new=0 skipped_dedupe=0 skipped_feed_dup=0 skipped_missing_id=0 ignore_dedupe=${IGNORE_DEDUPE}`,
      );
      lastRunSummary = {
        at: Date.now(),
        trigger,
        fetched: 0,
        inspected: 0,
        newItems: 0,
        selectedListingId: null,
        gate: { ok: true },
        ignoreDedupe: IGNORE_DEDUPE,
        lastSuccessfulPostAt: currentState.last_successful_post_at,
        lastAttemptedPostAt: currentState.last_attempted_post_at,
        posted: { facebook: false, instagram: false },
      };
      return;
    }

    if (!currentState.initialized) {
      currentState.initialized = true;
      currentState.seenIds = [];
    }

    const nowMs = Date.now();
    const gate = shouldPostNow(currentState, nowMs);
    if (!gate.ok) {
      logMeta("skipped_due_to_daily_limit", {
        reason: gate.reason,
        last_successful_post_at: currentState.last_successful_post_at ?? null,
      });
      console.log(
        `[rss][metrics] trigger=${trigger} fetched=${items.length} inspected=0 new=0 skipped_dedupe=0 skipped_feed_dup=0 skipped_missing_id=0 gate_reason=${gate.reason ?? "unknown"} ignore_dedupe=${IGNORE_DEDUPE}`,
      );
      lastRunSummary = {
        at: nowMs,
        trigger,
        fetched: items.length,
        inspected: 0,
        newItems: 0,
        selectedListingId: null,
        gate,
        ignoreDedupe: IGNORE_DEDUPE,
        lastSuccessfulPostAt: currentState.last_successful_post_at,
        lastAttemptedPostAt: currentState.last_attempted_post_at,
        posted: { facebook: false, instagram: false },
      };
      return;
    }

    const classification = classifyFeedItems({
      feedItems: items,
      state: currentState,
      gate,
      nowMs,
      ignoreDedupe: IGNORE_DEDUPE,
    });

    const decisions = classification.decisions;
    const eligible = classification.eligibleCandidates;

    const skippedDedupe = decisions.filter((d) => d.reason.startsWith("dedupe")).length;
    const skippedFeedDup = decisions.filter((d) => d.reason === "duplicate_in_feed").length;
    const skippedMissingId = decisions.filter((d) => d.reason === "no_listing_id").length;

    for (const decision of decisions) {
      if (decision.decision === "SKIP") {
        console.log(
          `[rss][decision] listing=${decision.listingId ?? "n/a"} decision=SKIP reason=${decision.reason} published=${decision.publishedAt ?? "unknown"} last_posted_at=${decision.lastPostedAt ?? "never"} link=${decision.canonicalListingUrl ?? decision.link}`,
        );
      }
    }

    console.log(
      `[rss][metrics] trigger=${trigger} fetched=${items.length} inspected=${decisions.length} new=${eligible.length} skipped_dedupe=${skippedDedupe} skipped_feed_dup=${skippedFeedDup} skipped_missing_id=${skippedMissingId} ignore_dedupe=${IGNORE_DEDUPE}`,
    );

    if (eligible.length === 0) {
      logMeta("no_eligible_items", {
        reason: "duplicates_or_empty",
        dedupe_days: DEDUPE_DAYS,
        ignore_dedupe: IGNORE_DEDUPE,
        skipped_dedupe: skippedDedupe,
        skipped_feed_dup: skippedFeedDup,
        skipped_missing_id: skippedMissingId,
      });
      lastRunSummary = {
        at: nowMs,
        trigger,
        fetched: items.length,
        inspected: decisions.length,
        newItems: 0,
        selectedListingId: null,
        gate,
        ignoreDedupe: IGNORE_DEDUPE,
        lastSuccessfulPostAt: currentState.last_successful_post_at,
        lastAttemptedPostAt: currentState.last_attempted_post_at,
        posted: { facebook: false, instagram: false },
      };
      return;
    }

    eligible.sort((a, b) => {
      const left = a.publishedAtMs ?? 0;
      const right = b.publishedAtMs ?? 0;
      if (right !== left) {
        return right - left;
      }
      return a.listingId.localeCompare(b.listingId);
    });

    const selected = eligible[0];
    logMeta("candidate_selected", {
      listingId: selected.listingId,
      canonicalListingUrl: selected.canonicalListingUrl,
      publishedAt: selected.publishedAt ?? null,
      ignore_dedupe: IGNORE_DEDUPE,
    });

    const caption = await buildCaption({
      item: selected,
      canonicalListingUrl: selected.canonicalListingUrl,
    });
    const image = await resolveImageForItem({
      item: selected,
      canonicalListingUrl: selected.canonicalListingUrl,
    });

    if (!image) {
      logMeta("publish_skipped", {
        listingId: selected.listingId,
        canonicalListingUrl: selected.canonicalListingUrl,
        reason: "image_missing",
      });
      return;
    }

    const fbResult = await postFacebookItem({ candidate: selected, caption, image });
    const igResult = await postInstagramItem({ candidate: selected, caption, image });

    const attemptedAny = fbResult.attempted || igResult.attempted;
    if (attemptedAny) {
      currentState.last_attempted_post_at = new Date(nowMs).toISOString();
    }

    const fbSuccess =
      fbResult.ok && fbResult.attempted && Boolean(fbResult.postId || fbResult.photoId);
    const igSuccess =
      igResult.ok &&
      igResult.attempted &&
      Boolean(igResult.publishId || igResult.creationId || igResult.postId);
    const anySuccess = fbSuccess || igSuccess;

    if (igResult.attempted && !igResult.ok) {
      currentState.igFailedIds = [
        selected.listingId,
        ...(currentState.igFailedIds ?? []).filter((entry) => entry !== selected.listingId),
      ].slice(0, MAX_SEEN_IDS);
    } else if (igResult.attempted) {
      currentState.igFailedIds = (currentState.igFailedIds ?? []).filter(
        (entry) => entry !== selected.listingId,
      );
    }

    if (anySuccess) {
      const postedAtIso = new Date(nowMs).toISOString();
      recordPostedItem(currentState, { itemId: selected.listingId, postedAtIso });
      currentState.posted_listing_ids = {
        [selected.listingId]: postedAtIso,
        ...currentState.posted_listing_ids,
      };
      currentState.last_successful_post_at = postedAtIso;
      if (fbSuccess) {
        currentState.last_successful_fb_post_at = postedAtIso;
      }
      if (igSuccess) {
        currentState.last_successful_ig_post_at = postedAtIso;
      }
      currentState.last_rotation_at = postedAtIso;
      logMeta("publish_complete", {
        listingId: selected.listingId,
        canonicalListingUrl: selected.canonicalListingUrl,
        fb_success: fbSuccess,
        ig_success: igSuccess,
      });
    } else {
      logMeta("publish_failed", {
        listingId: selected.listingId,
        canonicalListingUrl: selected.canonicalListingUrl,
        fb_attempted: fbResult.attempted,
        ig_attempted: igResult.attempted,
      });
    }

    console.log(
      `[rss][metrics] posted_fb=${fbSuccess ? 1 : 0} posted_ig=${igSuccess ? 1 : 0} attempted_fb=${fbResult.attempted ? 1 : 0} attempted_ig=${igResult.attempted ? 1 : 0} ignore_dedupe=${IGNORE_DEDUPE}`,
    );

    currentState.seenIds = Array.from(
      new Set([selected.id, ...currentState.seenIds].filter(Boolean)),
    ).slice(0, MAX_SEEN_IDS);
    await saveState(currentState);

    lastRunSummary = {
      at: nowMs,
      trigger,
      fetched: items.length,
      inspected: decisions.length,
      newItems: eligible.length,
      selectedListingId: selected.listingId,
      gate,
      ignoreDedupe: IGNORE_DEDUPE,
      lastSuccessfulPostAt: currentState.last_successful_post_at,
      lastAttemptedPostAt: currentState.last_attempted_post_at,
      posted: { facebook: fbSuccess, instagram: igSuccess },
    };
  } catch (error) {
    console.log(`[rss] ${trigger} check failed: ${String(error)}`);
    if (trigger === "manual" && alertsEnabled()) {
      await sendTelegramText(`RSS run failed: ${String(error)}`);
    }
  }
}

async function collectDiagnostics(limit = 5): Promise<DiagnosticsReport> {
  const nowMs = Date.now();
  const state = await loadState();
  const gate = shouldPostNow(state, nowMs);

  if (!ETSY_SHOP_RSS_URL) {
    return {
      ok: false,
      rssUrl: null,
      fetchedCount: 0,
      inspectedCount: 0,
      ignoreDedupe: IGNORE_DEDUPE,
      statePath: STATE_PATH,
      gate: {
        ...gate,
        maxPostsPerDay: MAX_POSTS_PER_DAY,
        minPostIntervalHours: MIN_POST_INTERVAL_HOURS,
        last_successful_post_at: state.last_successful_post_at,
        last_attempted_post_at: state.last_attempted_post_at,
      },
      items: [],
      error: "rss_url_missing",
      timestamp: new Date(nowMs).toISOString(),
    };
  }

  let feedItems: FeedItem[];
  try {
    feedItems = await fetchFeed(ETSY_SHOP_RSS_URL);
  } catch (error) {
    return {
      ok: false,
      rssUrl: ETSY_SHOP_RSS_URL,
      fetchedCount: 0,
      inspectedCount: 0,
      ignoreDedupe: IGNORE_DEDUPE,
      statePath: STATE_PATH,
      gate: {
        ...gate,
        maxPostsPerDay: MAX_POSTS_PER_DAY,
        minPostIntervalHours: MIN_POST_INTERVAL_HOURS,
        last_successful_post_at: state.last_successful_post_at,
        last_attempted_post_at: state.last_attempted_post_at,
      },
      items: [],
      error: `feed_fetch_failed:${String(error)}`,
      timestamp: new Date(nowMs).toISOString(),
    };
  }

  const inspected = feedItems.slice(0, Math.max(1, limit));
  const classification = classifyFeedItems({
    feedItems: inspected,
    state,
    gate,
    nowMs,
    ignoreDedupe: IGNORE_DEDUPE,
  });

  return {
    ok: true,
    rssUrl: ETSY_SHOP_RSS_URL,
    fetchedCount: feedItems.length,
    inspectedCount: inspected.length,
    ignoreDedupe: IGNORE_DEDUPE,
    statePath: STATE_PATH,
    gate: {
      ...gate,
      maxPostsPerDay: MAX_POSTS_PER_DAY,
      minPostIntervalHours: MIN_POST_INTERVAL_HOURS,
      last_successful_post_at: state.last_successful_post_at,
      last_attempted_post_at: state.last_attempted_post_at,
    },
    items: classification.decisions,
    timestamp: new Date(nowMs).toISOString(),
  };
}

async function runDiagnostics(): Promise<void> {
  const buildInfo = await resolveBuildInfo();
  resolvedBuildInfo = buildInfo;
  logBuildProof(buildInfo);
  logSelfCheck(buildInfo);

  const report = await collectDiagnostics();
  if (!report.ok) {
    console.log(
      `[diagnostics] ok=${report.ok} rss_url=${report.rssUrl ?? "missing"} state_path=${report.statePath} error=${report.error ?? "unknown"}`,
    );
    return;
  }

  const eligibleCount = report.items.filter((item) => item.decision === "NEW").length;
  console.log(
    `[diagnostics] rss_url=${report.rssUrl} state_path=${report.statePath} fetched=${report.fetchedCount} inspected=${report.inspectedCount} new=${eligibleCount} gate_ok=${report.gate.ok} gate_reason=${report.gate.reason ?? "none"} ignore_dedupe=${report.ignoreDedupe} last_successful_post_at=${report.gate.last_successful_post_at ?? "n/a"} last_attempted_post_at=${report.gate.last_attempted_post_at ?? "n/a"}`,
  );

  for (const item of report.items) {
    const lastPosted = item.lastPostedAt ?? "never";
    console.log(
      `[diagnostics] #${item.index} listing=${item.listingId ?? "n/a"} published=${item.publishedAt ?? "unknown"} decision=${item.decision} reason=${item.reason} last_posted_at=${lastPosted} link=${item.canonicalListingUrl ?? item.link}`,
    );
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

function logHeartbeat(): void {
  const now = Date.now();
  const last = lastRunSummary;
  const nextAtMs = last ? last.at + CHECK_INTERVAL_MS : now + CHECK_INTERVAL_MS;
  const nextInMs = Math.max(0, nextAtMs - now);
  console.log(
    `[rss][heartbeat] now=${new Date(now).toISOString()} last_run=${last ? new Date(last.at).toISOString() : "never"} last_trigger=${last?.trigger ?? "n/a"} last_gate_ok=${last?.gate.ok ?? false} last_gate_reason=${last?.gate.reason ?? "none"} last_selected=${last?.selectedListingId ?? "none"} last_successful_post_at=${currentState.last_successful_post_at ?? "none"} last_attempted_post_at=${currentState.last_attempted_post_at ?? "none"} next_run_in_ms=${nextInMs} ignore_dedupe=${IGNORE_DEDUPE} state_path=${STATE_PATH}`,
  );
}

async function main(): Promise<void> {
  const buildInfo = await resolveBuildInfo();
  resolvedBuildInfo = buildInfo;
  logBuildProof(buildInfo);
  logSelfCheck(buildInfo);
  console.log(`telegram.polling.enabled=${TELEGRAM_POLLING_ENABLED}`);
  console.log(
    `[rss] toggles: FACEBOOK_ENABLED=${FACEBOOK_ENABLED} (FACEBOOK_ENABLED=${formatEnvValue(FACEBOOK_ENABLED_TOGGLE.primaryRaw)}, RSS_FACEBOOK_ENABLED=${formatEnvValue(FACEBOOK_ENABLED_TOGGLE.legacyRaw)}), INSTAGRAM_ENABLED=${INSTAGRAM_ENABLED} (INSTAGRAM_ENABLED=${formatEnvValue(INSTAGRAM_ENABLED_TOGGLE.primaryRaw)}, RSS_INSTAGRAM_ENABLED=${formatEnvValue(INSTAGRAM_ENABLED_TOGGLE.legacyRaw)})`,
  );
  if (!RSS_DISABLE_HEALTH_SERVER) {
    const healthServer = createServer((req, res) => {
      const buildForResponse =
        resolvedBuildInfo ??
        ({
          commitSha: "unknown",
          commitSource: "unresolved",
          buildTime: STARTED_AT_ISO,
          buildTimeSource: "startup",
          version: "unknown",
          startedAt: STARTED_AT_ISO,
          cwd: process.cwd(),
        } satisfies BuildInfo);
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname === "/self-check") {
        void (async () => {
          const metaStatus = await runMetaHealthcheck().catch((error) => ({
            page_access_ok: false,
            page_id_found: false,
            ig_linked: false,
            missing_permissions: Array.from(META_REQUIRED_PERMISSIONS),
            error: `meta_healthcheck_failed:${String(error)}`,
          }));
          const fbStatus = resolveFacebookEnablement();
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              ok: true,
              service: SERVICE_NAME,
              build: buildForResponse,
              config: {
                cwd: process.cwd(),
                statePath: STATE_PATH,
                stateDir: dirname(STATE_PATH),
                rssUrl: ETSY_SHOP_RSS_URL || null,
                rssUrlPresent: Boolean(ETSY_SHOP_RSS_URL),
                facebookEnabled: fbStatus.enabled,
                facebookReason: fbStatus.reason ?? null,
                facebookMissingEnv: fbStatus.missingEnv ?? [],
                instagramEnabled: INSTAGRAM_ENABLED,
                maxPostsPerDay: MAX_POSTS_PER_DAY,
                minPostIntervalHours: MIN_POST_INTERVAL_HOURS,
                dedupeDays: DEDUPE_DAYS,
                ignoreDedupe: IGNORE_DEDUPE,
                checkIntervalMs: CHECK_INTERVAL_MS,
                telegramPollingEnabled: TELEGRAM_POLLING_ENABLED,
                rssInstagramImageOverride: RSS_INSTAGRAM_IMAGE_URL_OVERRIDE || null,
                rssInstagramTestImage: RSS_INSTAGRAM_TEST_IMAGE_URL || null,
                pinterestTestMode: PINTEREST_TEST_MODE,
              },
              meta: {
                accessTokenPresent: Boolean(META_ACCESS_TOKEN),
                pageAccessTokenPresent: Boolean(META_PAGE_ACCESS_TOKEN),
                pageId: META_PAGE_ID || null,
                pageAccessOk: metaStatus.page_access_ok,
                pageIdFound: metaStatus.page_id_found,
                igLinked: metaStatus.ig_linked,
                requiredPermissions: META_REQUIRED_PERMISSIONS,
                missingPermissions: metaStatus.missing_permissions,
                error: metaStatus.error ?? null,
              },
            }),
          );
        })().catch((error) => {
          if (!res.writableEnded) {
            res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: String(error) }));
          }
        });
        return;
      }
      if (url.pathname === "/diagnostics") {
        void collectDiagnostics()
          .then((report) => {
            if (res.writableEnded) {
              return;
            }
            res.writeHead(report.ok ? 200 : 503, {
              "content-type": "application/json; charset=utf-8",
            });
            res.end(JSON.stringify(report));
          })
          .catch((error) => {
            if (!res.writableEnded) {
              res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ ok: false, error: `diagnostics_failed:${String(error)}` }));
            }
          });
        return;
      }
      if (url.pathname === "/pinterest_test" && PINTEREST_TEST_MODE) {
        if (req.method !== "POST") {
          res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "use POST /pinterest_test" }));
          return;
        }
        if (pinterestTestTriggered) {
          res.writeHead(429, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "pinterest test already triggered" }));
          return;
        }
        pinterestTestTriggered = true;
        void createTestPinterestPin()
          .then((result) => {
            if (res.writableEnded) {
              return;
            }
            res.writeHead(result.ok ? 200 : result.status || 500, {
              "content-type": "application/json; charset=utf-8",
            });
            res.end(JSON.stringify(result));
          })
          .catch((error) => {
            console.log(`[pinterest] smoke test handler error: ${String(error)}`);
            if (!res.writableEnded) {
              res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ ok: false, error: "pinterest test handler error" }));
            }
          });
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
    `RSS watcher boot: service=${SERVICE_NAME} sha=${resolvedBuildInfo?.commitSha ?? "unknown"} rss_url=${ETSY_SHOP_RSS_URL || "missing"} state_path=${STATE_PATH} cwd=${process.cwd()} facebook=${FACEBOOK_ENABLED ? "on" : "off"} instagram=${INSTAGRAM_ENABLED ? "on" : "off"} max_per_day=${MAX_POSTS_PER_DAY} min_interval_hours=${MIN_POST_INTERVAL_HOURS} dedupe_days=${DEDUPE_DAYS} ignore_dedupe=${IGNORE_DEDUPE} check_interval_ms=${CHECK_INTERVAL_MS}`,
  );
  currentState = await loadState();
  await saveState(currentState);

  await scheduleCheck("startup");
  setInterval(() => {
    void scheduleCheck("scheduled");
  }, CHECK_INTERVAL_MS).unref();
  logHeartbeat();
  setInterval(() => {
    logHeartbeat();
  }, HEARTBEAT_INTERVAL_MS).unref();
  void pollTelegramForCommands();
}

const CLI_MODE = (process.argv[2] ?? "").trim().toLowerCase();
const DIAGNOSTIC_MODE =
  CLI_MODE === "diagnose" ||
  CLI_MODE === "diag" ||
  CLI_MODE === "--diagnose" ||
  process.env.RSS_DIAGNOSTIC_MODE === "1";

if (process.env.VITEST_WORKER_ID === undefined) {
  const runner = DIAGNOSTIC_MODE ? runDiagnostics : main;
  void runner().catch((error) => {
    const label = DIAGNOSTIC_MODE ? "diagnostic" : "startup";
    console.error(`[rss] fatal ${label} error: ${String(error)}`);
    process.exitCode = 1;
  });
}
