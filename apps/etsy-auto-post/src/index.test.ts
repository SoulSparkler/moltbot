import { describe, expect, it } from "vitest";
import { canonicalizeEtsyUrl } from "./lib/meta-facebook.js";
import {
  buildShareAndSaveUrl,
  composeCaptionWithShareUrl,
  extractListingId,
  extractRssImageUrl,
  classifyFeedItems,
  isDuplicate,
  shouldPostNow,
} from "./index.js";

describe("canonicalizeEtsyUrl", () => {
  it("normalizes locale-prefixed listing URLs and strips query params", () => {
    expect(
      canonicalizeEtsyUrl("https://www.etsy.com/nl/listing/12345/slug-title?ref=rss&utm_source=x"),
    ).toBe("https://www.etsy.com/listing/12345/slug-title");
  });
});

describe("share-and-save URLs", () => {
  it("builds Facebook share URL on the shop domain with expected UTM params", () => {
    const url = buildShareAndSaveUrl("https://www.etsy.com/listing/12345/slug-title?ref=rss", "facebook");
    expect(url).toBe(
      "https://tresortendance.etsy.com/listing/12345/slug-title?ref=rss&utm_source=facebook&utm_medium=organic&utm_campaign=autopost",
    );
  });

  it("builds Instagram share URL on the shop domain with expected UTM params", () => {
    const url = buildShareAndSaveUrl("https://www.etsy.com/listing/12345/slug-title", "instagram");
    expect(url).toBe(
      "https://tresortendance.etsy.com/listing/12345/slug-title?utm_source=instagram&utm_medium=organic&utm_campaign=autopost",
    );
  });

  it("composes captions so the Share & Save URL is present exactly once", () => {
    const share = "https://tresortendance.etsy.com/listing/12345";
    expect(composeCaptionWithShareUrl("Nice find", share)).toBe("Nice find\nhttps://tresortendance.etsy.com/listing/12345");
    expect(composeCaptionWithShareUrl("", share)).toBe("https://tresortendance.etsy.com/listing/12345");
  });
});

describe("extractListingId", () => {
  it("returns the numeric listing id from Etsy URLs", () => {
    expect(extractListingId("https://www.etsy.com/nl/listing/987654321/cool-item?ref=rss")).toBe(
      "987654321",
    );
    expect(extractListingId("https://www.etsy.com/listing/55555/abc")).toBe("55555");
  });
});

describe("isDuplicate", () => {
  const nowMs = Date.UTC(2025, 0, 1);

  it("treats listings posted within the dedupe window as duplicates", () => {
    const state = {
      seenIds: [],
      initialized: true,
      telegramOffset: 0,
      posted_listing_ids: { "123": new Date(nowMs - 2 * 60 * 60 * 1000).toISOString() },
    };

    expect(isDuplicate("123", state, nowMs, { dedupeWindowMs: 30 * 24 * 60 * 60 * 1000 })).toBe(
      true,
    );
  });

  it("allows listings after the dedupe window", () => {
    const state = {
      seenIds: [],
      initialized: true,
      telegramOffset: 0,
      posted_listing_ids: { "123": new Date(nowMs - 40 * 24 * 60 * 60 * 1000).toISOString() },
    };

    expect(isDuplicate("123", state, nowMs, { dedupeWindowMs: 30 * 24 * 60 * 60 * 1000 })).toBe(
      false,
    );
  });
});

describe("classifyFeedItems", () => {
  const nowMs = Date.UTC(2025, 0, 2, 12, 0, 0);

  it("marks recently posted listings as duplicates", () => {
    const state = {
      seenIds: [],
      initialized: true,
      telegramOffset: 0,
      posted_listing_ids: { "123": new Date(nowMs - 2 * 60 * 60 * 1000).toISOString() },
    };

    const feedItems = [
      {
        id: "https://www.etsy.com/listing/123/first",
        title: "Item 123",
        link: "https://www.etsy.com/listing/123/first",
        publishedAt: new Date(nowMs - 3 * 60 * 60 * 1000).toISOString(),
        publishedAtMs: nowMs - 3 * 60 * 60 * 1000,
      },
      {
        id: "https://www.etsy.com/listing/456/second",
        title: "Item 456",
        link: "https://www.etsy.com/listing/456/second",
        publishedAt: new Date(nowMs - 1 * 60 * 60 * 1000).toISOString(),
        publishedAtMs: nowMs - 1 * 60 * 60 * 1000,
      },
    ];

    const result = classifyFeedItems({
      feedItems,
      state,
      gate: { ok: true },
      nowMs,
      ignoreDedupe: false,
    });

    expect(result.decisions[0].decision).toBe("SKIP");
    expect(result.decisions[0].reason).toBe("dedupe_window");
    expect(result.decisions[0].lastPostedAt).toBe(state.posted_listing_ids["123"]);
    expect(result.eligibleCandidates.map((c) => c.listingId)).toEqual(["456"]);
  });

  it("allows manual override of dedupe", () => {
    const state = {
      seenIds: [],
      initialized: true,
      telegramOffset: 0,
      posted_listing_ids: { "123": new Date(nowMs - 2 * 60 * 60 * 1000).toISOString() },
    };

    const feedItems = [
      {
        id: "https://www.etsy.com/listing/123/first",
        title: "Item 123",
        link: "https://www.etsy.com/listing/123/first",
        publishedAt: new Date(nowMs - 3 * 60 * 60 * 1000).toISOString(),
        publishedAtMs: nowMs - 3 * 60 * 60 * 1000,
      },
    ];

    const result = classifyFeedItems({
      feedItems,
      state,
      gate: { ok: true },
      nowMs,
      ignoreDedupe: true,
    });

    expect(result.decisions[0].decision).toBe("NEW");
    expect(result.decisions[0].reason).toBe("dedupe_ignored");
    expect(result.eligibleCandidates.map((c) => c.listingId)).toEqual(["123"]);
  });

  it("marks duplicate listing IDs in the same feed", () => {
    const state = { seenIds: [], initialized: true, telegramOffset: 0 };
    const feedItems = [
      {
        id: "https://www.etsy.com/listing/999/first",
        title: "Item A",
        link: "https://www.etsy.com/listing/999/first",
      },
      {
        id: "https://www.etsy.com/listing/999/second",
        title: "Item A duplicate",
        link: "https://www.etsy.com/listing/999/second",
      },
    ];

    const result = classifyFeedItems({
      feedItems,
      state,
      gate: { ok: true },
      nowMs,
    });

    expect(result.decisions[0].decision).toBe("NEW");
    expect(result.decisions[1].decision).toBe("SKIP");
    expect(result.decisions[1].reason).toBe("duplicate_in_feed");
    expect(result.eligibleCandidates).toHaveLength(1);
    expect(result.eligibleCandidates[0].listingId).toBe("999");
  });
});

describe("shouldPostNow", () => {
  const nowMs = Date.UTC(2025, 0, 1, 12, 0, 0);

  it("blocks when the daily cap is already met", () => {
    const state = {
      seenIds: [],
      initialized: true,
      telegramOffset: 0,
      posted_listing_ids: { "111": new Date(nowMs - 2 * 60 * 60 * 1000).toISOString() },
    };

    expect(shouldPostNow(state, nowMs, { maxPostsPerDay: 1 }).ok).toBe(false);
  });

  it("blocks when the minimum interval has not elapsed", () => {
    const state = {
      seenIds: [],
      initialized: true,
      telegramOffset: 0,
      last_successful_post_at: new Date(nowMs - 1 * 60 * 60 * 1000).toISOString(),
    };

    const result = shouldPostNow(state, nowMs, { minPostIntervalMs: 24 * 60 * 60 * 1000 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("min_interval");
  });

  it("blocks when a recent attempt happened even without a recorded success", () => {
    const state = {
      seenIds: [],
      initialized: true,
      telegramOffset: 0,
      last_attempted_post_at: new Date(nowMs - 2 * 60 * 60 * 1000).toISOString(),
    };

    const result = shouldPostNow(state, nowMs, { minPostIntervalMs: 24 * 60 * 60 * 1000 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("min_interval");
  });
});

describe("extractRssImageUrl", () => {
  it("extracts the first image src from an RSS description block", () => {
    const html =
      '<p><img src="https://i.etsystatic.com/12345/r/il_rss.jpg" alt="Example" /></p><p>Body</p>';
    expect(extractRssImageUrl(html)).toBe("https://i.etsystatic.com/12345/r/il_rss.jpg");
  });
});
