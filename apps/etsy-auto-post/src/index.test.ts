import { describe, expect, it } from "vitest";
import { canonicalizeEtsyUrl } from "./lib/meta-facebook.js";
import {
  buildShareAndSaveUrl,
  composeCaptionWithShareUrl,
  extractListingId,
  extractRssImageUrl,
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
