import { Pool } from "pg";

export type PostingPlatform = "facebook" | "instagram" | "pinterest";

export type PostingHistorySnapshot = {
  /** listingId -> platform -> ISO posted_at */
  perListingPlatform: Map<string, Map<PostingPlatform, string>>;
  /** listingId -> last posted ISO (latest across platforms) */
  perListingLatest: Map<string, string>;
  /** platform -> count in the last 24h window */
  perPlatform24hCount: Record<PostingPlatform, number>;
  /** platform -> last posted ISO (if any) */
  perPlatformLatest: Record<PostingPlatform, string | null>;
  /** latest post timestamp across all platforms */
  latestOverall: string | null;
};

const DATABASE_URL = process.env.DATABASE_URL?.trim() ?? process.env.RAILWAY_DATABASE_URL?.trim() ?? "";

let pool: Pool | null = null;

export function databaseUrlPresent(): boolean {
  return Boolean(DATABASE_URL);
}

export function getPool(): Pool {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is missing; set Railway PostgreSQL connection string.");
  }
  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: 4,
      idleTimeoutMillis: 30_000,
    });
    pool.on("error", (error) => {
      console.error(`[db] pool error: ${String(error)}`);
    });
  }
  return pool;
}

export async function ensureSchema(): Promise<void> {
  const client = getPool();
  await client.query(`
    CREATE TABLE IF NOT EXISTS feed_items (
      id BIGSERIAL PRIMARY KEY,
      listing_id TEXT NOT NULL,
      guid TEXT,
      link TEXT,
      title TEXT,
      published_at TIMESTAMPTZ,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT feed_items_listing_id_unique UNIQUE (listing_id)
    );

    CREATE TABLE IF NOT EXISTS post_history (
      id BIGSERIAL PRIMARY KEY,
      listing_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      link TEXT,
      title TEXT,
      posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      extra JSONB,
      CONSTRAINT post_history_listing_platform_unique UNIQUE (listing_id, platform)
    );

    CREATE INDEX IF NOT EXISTS post_history_platform_posted_idx
      ON post_history (platform, posted_at DESC);
    CREATE INDEX IF NOT EXISTS post_history_posted_idx
      ON post_history (posted_at DESC);
  `);
}

export async function recordFeedItem(params: {
  listingId: string;
  guid?: string | null;
  link?: string | null;
  title?: string | null;
  publishedAt?: string | null;
}): Promise<void> {
  const client = getPool();
  await client.query(
    `
    INSERT INTO feed_items (listing_id, guid, link, title, published_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (listing_id) DO UPDATE
      SET last_seen_at = NOW(),
          guid = COALESCE(EXCLUDED.guid, feed_items.guid),
          link = COALESCE(EXCLUDED.link, feed_items.link),
          title = COALESCE(EXCLUDED.title, feed_items.title),
          published_at = COALESCE(EXCLUDED.published_at, feed_items.published_at);
    `,
    [
      params.listingId,
      params.guid ?? null,
      params.link ?? null,
      params.title ?? null,
      params.publishedAt ? new Date(params.publishedAt) : null,
    ],
  );
}

export async function recordPostSuccess(params: {
  listingId: string;
  platform: PostingPlatform;
  link?: string | null;
  title?: string | null;
  postedAt?: Date;
  extra?: Record<string, unknown> | null;
}): Promise<void> {
  const client = getPool();
  const postedAt = params.postedAt ?? new Date();
  await client.query(
    `
    INSERT INTO post_history (listing_id, platform, link, title, posted_at, extra)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (listing_id, platform) DO UPDATE
      SET posted_at = EXCLUDED.posted_at,
          link = COALESCE(EXCLUDED.link, post_history.link),
          title = COALESCE(EXCLUDED.title, post_history.title),
          extra = COALESCE(EXCLUDED.extra, post_history.extra);
    `,
    [
      params.listingId,
      params.platform,
      params.link ?? null,
      params.title ?? null,
      postedAt,
      params.extra ?? null,
    ],
  );
}

export async function loadPostingHistorySnapshot(params: {
  nowMs: number;
  dedupeWindowMs: number;
}): Promise<PostingHistorySnapshot> {
  const client = getPool();
  const now = params.nowMs;
  const rows = await client.query<{
    listing_id: string;
    platform: PostingPlatform;
    posted_at: Date;
  }>(
    `
    SELECT listing_id, platform, posted_at
    FROM post_history
    WHERE posted_at >= NOW() - ($1 * INTERVAL '1 millisecond')
    `,
    [Math.max(params.dedupeWindowMs, 24 * 60 * 60 * 1000)],
  );

  const perListingPlatform = new Map<string, Map<PostingPlatform, string>>();
  const perListingLatest = new Map<string, string>();
  const perPlatform24hCount: Record<PostingPlatform, number> = {
    facebook: 0,
    instagram: 0,
    pinterest: 0,
  };
  const perPlatformLatest: Record<PostingPlatform, string | null> = {
    facebook: null,
    instagram: null,
    pinterest: null,
  };
  let latestOverall: string | null = null;

  for (const row of rows.rows) {
    const postedIso = row.posted_at.toISOString();
    const platform = row.platform as PostingPlatform;
    let platformMap = perListingPlatform.get(row.listing_id);
    if (!platformMap) {
      platformMap = new Map<PostingPlatform, string>();
      perListingPlatform.set(row.listing_id, platformMap);
    }
    const existing = platformMap.get(platform);
    if (!existing || Date.parse(postedIso) > Date.parse(existing)) {
      platformMap.set(platform, postedIso);
    }

    const existingLatest = perListingLatest.get(row.listing_id);
    if (!existingLatest || Date.parse(postedIso) > Date.parse(existingLatest)) {
      perListingLatest.set(row.listing_id, postedIso);
    }

    if (now - row.posted_at.getTime() < 24 * 60 * 60 * 1000) {
      perPlatform24hCount[platform] = (perPlatform24hCount[platform] ?? 0) + 1;
    }

    const latestForPlatform = perPlatformLatest[platform];
    if (!latestForPlatform || Date.parse(postedIso) > Date.parse(latestForPlatform)) {
      perPlatformLatest[platform] = postedIso;
    }

    if (!latestOverall || Date.parse(postedIso) > Date.parse(latestOverall)) {
      latestOverall = postedIso;
    }
  }

  return {
    perListingPlatform,
    perListingLatest,
    perPlatform24hCount,
    perPlatformLatest,
    latestOverall,
  };
}
