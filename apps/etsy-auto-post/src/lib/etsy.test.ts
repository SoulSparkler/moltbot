import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractEtsyListingImageUrlFromHtml,
  extractEtsyRssImageUrl,
  toShareAndSaveUrl,
} from "./etsy.js";

describe("extractEtsyListingImageUrlFromHtml", () => {
  it("prefers og:image over JSON-LD images when both exist", async () => {
    const html = await readFile(
      new URL("./fixtures/etsy-listing.og-image.html", import.meta.url),
      "utf8",
    );
    const result = extractEtsyListingImageUrlFromHtml(html);
    expect(result).toEqual({
      url: "https://i.etsystatic.com/12345/r/il_og.jpg",
      source: "og_image",
    });
  });

  it("falls back to JSON-LD image when og:image is missing", () => {
    const html = [
      "<!doctype html>",
      "<html><head>",
      '<script type="application/ld+json">',
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Product",
        image: ["https://i.etsystatic.com/12345/r/il_jsonld.jpg"],
      }),
      "</script>",
      "</head><body></body></html>",
    ].join("\n");

    const result = extractEtsyListingImageUrlFromHtml(html);
    expect(result).toEqual({
      url: "https://i.etsystatic.com/12345/r/il_jsonld.jpg",
      source: "json_ld",
    });
  });
});

describe("extractEtsyRssImageUrl", () => {
  it("extracts the first <img src> URL from RSS <description>", () => {
    const item = {
      description:
        '<p class="image"><img src="https://i.etsystatic.com/12345/r/il_rss.jpg" alt="Example" width="570" height="456" /></p>',
    };

    expect(extractEtsyRssImageUrl(item)).toBe("https://i.etsystatic.com/12345/r/il_rss.jpg");
  });
});

describe("toShareAndSaveUrl", () => {
  const originalDomain = process.env.ETSY_SHARE_AND_SAVE_DOMAIN;

  afterEach(() => {
    if (originalDomain === undefined) {
      delete process.env.ETSY_SHARE_AND_SAVE_DOMAIN;
    } else {
      process.env.ETSY_SHARE_AND_SAVE_DOMAIN = originalDomain;
    }
  });

  it("rewrites Etsy listing URLs to the shop domain and keeps slug + query params", () => {
    process.env.ETSY_SHARE_AND_SAVE_DOMAIN = "tresortendance.etsy.com";

    const url = toShareAndSaveUrl("https://www.etsy.com/listing/12345/vintage-vase?ref=rss", {
      utm_source: "facebook",
      utm_medium: "organic",
      utm_campaign: "autopost",
    });

    expect(url).toBe(
      "https://tresortendance.etsy.com/listing/12345/vintage-vase?ref=rss&utm_source=facebook&utm_medium=organic&utm_campaign=autopost",
    );
  });

  it("falls back to the original URL for non-Etsy links", () => {
    const input = "https://example.com/post/123";
    expect(
      toShareAndSaveUrl(input, { utm_source: "facebook", utm_medium: "organic" }),
    ).toBe(input);
  });

  it("uses the configured share-and-save domain when provided", () => {
    process.env.ETSY_SHARE_AND_SAVE_DOMAIN = "customshop.etsy.com";
    const url = toShareAndSaveUrl("https://www.etsy.com/listing/99999/abc");
    expect(url).toBe("https://customshop.etsy.com/listing/99999/abc");
  });
});
