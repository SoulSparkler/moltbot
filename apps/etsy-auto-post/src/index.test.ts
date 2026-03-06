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
  truncateAtSentenceBoundary,
  buildFacebookCaption,
  buildInstagramCaption,
  buildPinterestCaption,
  toEnglishFetchUrl,
  stripEtsyShopSuffix,
} from "./index.js";

describe("canonicalizeEtsyUrl", () => {
  it("normalizes locale-prefixed listing URLs to slugless shop-domain form", () => {
    expect(
      canonicalizeEtsyUrl("https://www.etsy.com/nl/listing/12345/slug-title?ref=rss&utm_source=x"),
    ).toBe("https://tresortendance.etsy.com/listing/12345");
  });
});

describe("share-and-save URLs", () => {
  it("builds Facebook share URL on the shop domain, always slugless, with expected UTM params", () => {
    const url = buildShareAndSaveUrl("https://www.etsy.com/listing/12345/slug-title?ref=rss", "facebook");
    expect(url).toBe(
      "https://tresortendance.etsy.com/listing/12345?ref=rss&utm_source=facebook&utm_medium=organic&utm_campaign=autopost",
    );
  });

  it("builds Instagram share URL on the shop domain, always slugless, with expected UTM params", () => {
    const url = buildShareAndSaveUrl("https://www.etsy.com/listing/12345/slug-title", "instagram");
    expect(url).toBe(
      "https://tresortendance.etsy.com/listing/12345?utm_source=instagram&utm_medium=organic&utm_campaign=autopost",
    );
  });

  it("builds Pinterest share URL on the shop domain, always slugless", () => {
    const url = buildShareAndSaveUrl(
      "https://www.etsy.com/nl/listing/4465924335/vintage-laguiole-snijset-foo?ref=rss",
      "pinterest",
    );
    expect(url).toBe(
      "https://tresortendance.etsy.com/listing/4465924335?ref=rss&utm_source=pinterest&utm_medium=organic&utm_campaign=autopost",
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

  it("allows posting when only a recent attempt (no success) is recorded", () => {
    const state = {
      seenIds: [],
      initialized: true,
      telegramOffset: 0,
      last_attempted_post_at: new Date(nowMs - 2 * 60 * 60 * 1000).toISOString(),
    };

    // Failed attempts should NOT block the gate — only successful posts should.
    const result = shouldPostNow(state, nowMs, { minPostIntervalMs: 24 * 60 * 60 * 1000 });
    expect(result.ok).toBe(true);
  });
});

describe("extractRssImageUrl", () => {
  it("extracts the first image src from an RSS description block", () => {
    const html =
      '<p><img src="https://i.etsystatic.com/12345/r/il_rss.jpg" alt="Example" /></p><p>Body</p>';
    expect(extractRssImageUrl(html)).toBe("https://i.etsystatic.com/12345/r/il_rss.jpg");
  });
});

describe("truncateAtSentenceBoundary", () => {
  it("returns text unchanged when under the limit", () => {
    expect(truncateAtSentenceBoundary("Hello world.", 100)).toBe("Hello world.");
  });

  it("cuts at sentence-ending punctuation within the last 25%", () => {
    const text = "First sentence. Second sentence is longer and goes on. Third sentence continues here.";
    const result = truncateAtSentenceBoundary(text, 60);
    expect(result).toBe("First sentence. Second sentence is longer and goes on.");
    expect(result.length).toBeLessThanOrEqual(60);
  });

  it("never cuts mid-word", () => {
    const text = "This is a very long sentence without any punctuation marks whatsoever in the text";
    const result = truncateAtSentenceBoundary(text, 40);
    expect(result.length).toBeLessThanOrEqual(40);
    // Should end at a complete word, not mid-word
    expect(result).toBe("This is a very long sentence without");
    // Verify no partial word at the end
    expect(text.startsWith(result)).toBe(true);
  });

  it("cuts at last whitespace when no punctuation is found", () => {
    const text = "word1 word2 word3 word4 word5 word6 word7 word8 word9 word10";
    const result = truncateAtSentenceBoundary(text, 30);
    expect(result.length).toBeLessThanOrEqual(30);
    // Ends at a complete word boundary
    expect(result).toBe("word1 word2 word3 word4 word5");
  });

  it("returns empty string for empty input", () => {
    expect(truncateAtSentenceBoundary("", 100)).toBe("");
    expect(truncateAtSentenceBoundary("  ", 100)).toBe("");
  });

  it("respects exclamation and question marks as sentence boundaries", () => {
    const text = "What a find! This vintage piece is amazing! It features hand-painted details and original patina.";
    const result = truncateAtSentenceBoundary(text, 50);
    expect(result).toBe("What a find! This vintage piece is amazing!");
  });
});

describe("buildFacebookCaption", () => {
  const baseInfo = {
    title: "Vintage Italian Ceramic Vase",
    titleSource: "og_title" as const,
    description: "Beautiful hand-painted ceramic vase from the 1960s. Features floral motifs in blue and gold.",
    descriptionSource: "og_description" as const,
    canonicalUrl: "https://tresortendance.etsy.com/listing/12345",
  };
  const shareUrl = "https://tresortendance.etsy.com/listing/12345?utm_source=facebook&utm_medium=organic&utm_campaign=autopost";

  it("includes the Share & Save URL line", () => {
    const result = buildFacebookCaption(baseInfo, shareUrl);
    expect(result.captionText).toContain("Shop it here:");
    expect(result.captionText).toContain(shareUrl);
  });

  it("includes title as first line", () => {
    const result = buildFacebookCaption(baseInfo, shareUrl);
    const lines = result.captionText.split("\n");
    expect(lines[0]).toBe("Vintage Italian Ceramic Vase");
  });

  it("includes description between title and CTA", () => {
    const result = buildFacebookCaption(baseInfo, shareUrl);
    expect(result.captionText).toContain("Beautiful hand-painted ceramic vase");
  });

  it("does not contain /nl/ URLs", () => {
    const result = buildFacebookCaption(baseInfo, shareUrl);
    expect(result.captionText).not.toContain("/nl/");
  });

  it("does not truncate description mid-sentence", () => {
    const longDesc = "First sentence is complete. Second sentence also complete. Third sentence here too. Fourth and fifth sentences are here to push the length. Extra padding to make it really long and test the truncation boundary carefully.";
    const info = { ...baseInfo, description: longDesc };
    const result = buildFacebookCaption(info, shareUrl);
    // The description portion should end at a sentence boundary
    const descInCaption = result.captionText.split("\n").filter(Boolean);
    // Description should not end mid-word
    for (const line of descInCaption) {
      if (line.startsWith("Shop it here:") || line === baseInfo.title || line.startsWith("#")) {continue;}
      // Should end with punctuation or be a complete phrase
      expect(line).toMatch(/[.!?]$|^$/);
    }
  });
});

describe("buildInstagramCaption", () => {
  const baseInfo = {
    title: "Vintage French Porcelain Plate",
    titleSource: "og_title" as const,
    description: "Elegant porcelain plate with hand-painted floral design. Made in Limoges, France.",
    descriptionSource: "og_description" as const,
    canonicalUrl: "https://tresortendance.etsy.com/listing/12345",
  };

  it("includes hashtags line", () => {
    const result = buildInstagramCaption(baseInfo);
    expect(result.captionText).toMatch(/#vintage/);
    expect(result.captionText).toMatch(/#etsy/);
    expect(result.captionText).toMatch(/#etsyfinds/);
  });

  it("contains no raw URL", () => {
    const result = buildInstagramCaption(baseInfo);
    expect(result.captionText).not.toMatch(/https?:\/\//);
  });

  it("includes link-in-bio line instead of raw URL", () => {
    const result = buildInstagramCaption(baseInfo);
    expect(result.captionText.toLowerCase()).toContain("link in bio");
  });

  it("includes at least 10 hashtags", () => {
    const result = buildInstagramCaption(baseInfo);
    const hashtagCount = (result.captionText.match(/#\w+/g) ?? []).length;
    expect(hashtagCount).toBeGreaterThanOrEqual(10);
  });

  it("does not contain /nl/ URLs", () => {
    const result = buildInstagramCaption(baseInfo);
    expect(result.captionText).not.toContain("/nl/");
  });
});

describe("buildPinterestCaption", () => {
  const baseInfo = {
    title: "Vintage Crystal Wine Glasses Set of 6",
    titleSource: "og_title" as const,
    description: "Beautiful set of six vintage crystal wine glasses. Perfect for entertaining or as a collector's item.",
    descriptionSource: "og_description" as const,
    canonicalUrl: "https://tresortendance.etsy.com/listing/12345",
  };
  const shareUrl = "https://tresortendance.etsy.com/listing/12345?utm_source=pinterest&utm_medium=organic&utm_campaign=autopost";

  it("has title <= 100 chars", () => {
    const result = buildPinterestCaption(baseInfo, shareUrl);
    expect(result.title.length).toBeLessThanOrEqual(100);
  });

  it("includes hashtags in description", () => {
    const result = buildPinterestCaption(baseInfo, shareUrl);
    expect(result.description).toMatch(/#vintage/);
  });

  it("does not contain /nl/ URLs", () => {
    const result = buildPinterestCaption(baseInfo, shareUrl);
    expect(result.title).not.toContain("/nl/");
    expect(result.description).not.toContain("/nl/");
  });
});

describe("toEnglishFetchUrl", () => {
  it("strips /nl/ locale prefix from listing URL", () => {
    expect(
      toEnglishFetchUrl("https://www.etsy.com/nl/listing/4467098011/vintage-pradel-foo"),
    ).toBe("https://www.etsy.com/listing/4467098011/vintage-pradel-foo");
  });

  it("rewrites shop subdomain to www.etsy.com", () => {
    expect(
      toEnglishFetchUrl("https://tresortendance.etsy.com/listing/4467098011"),
    ).toBe("https://www.etsy.com/listing/4467098011");
  });

  it("strips both locale prefix and shop subdomain", () => {
    expect(
      toEnglishFetchUrl("https://tresortendance.etsy.com/nl/listing/12345/slug?ref=rss"),
    ).toBe("https://www.etsy.com/listing/12345/slug");
  });

  it("strips query params and hash", () => {
    expect(
      toEnglishFetchUrl("https://www.etsy.com/listing/99999/vase?ref=rss&utm_source=x#section"),
    ).toBe("https://www.etsy.com/listing/99999/vase");
  });

  it("returns input unchanged for non-Etsy URLs", () => {
    expect(toEnglishFetchUrl("https://example.com/page")).toBe("https://example.com/page");
  });

  it("never produces a URL containing /nl/", () => {
    const inputs = [
      "https://www.etsy.com/nl/listing/111/item",
      "https://tresortendance.etsy.com/nl/listing/222/item?ref=rss",
      "https://www.etsy.com/nl-BE/listing/333/item",
    ];
    for (const url of inputs) {
      expect(toEnglishFetchUrl(url)).not.toContain("/nl/");
      expect(toEnglishFetchUrl(url)).not.toContain("/nl-");
    }
  });
});

describe("stripEtsyShopSuffix", () => {
  it("strips ' by ShopName' suffix from title", () => {
    expect(stripEtsyShopSuffix("Vintage Vase by TresorTendance")).toBe("Vintage Vase");
  });

  it("is case-insensitive", () => {
    expect(stripEtsyShopSuffix("Vintage Vase By TresorTendance")).toBe("Vintage Vase");
  });

  it("leaves titles without suffix unchanged", () => {
    expect(stripEtsyShopSuffix("Vintage Vase")).toBe("Vintage Vase");
  });

  it("only strips the last occurrence", () => {
    expect(stripEtsyShopSuffix("Made by hand by TresorTendance")).toBe("Made by hand");
  });
});
