import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractEtsyListingImageUrlFromHtml,
  extractEtsyRssImageUrl,
  extractJsonLdDescriptionFromHtml,
  extractJsonLdNameFromHtml,
  extractOgDescriptionFromHtml,
  extractOgTitleFromHtml,
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

  it("normalizes Etsy listing URLs to canonical host, strips slug, and keeps query params", () => {
    process.env.ETSY_SHARE_AND_SAVE_DOMAIN = "tresortendance.etsy.com";

    const url = toShareAndSaveUrl("https://www.etsy.com/listing/12345/vintage-vase?ref=rss", {
      utm_source: "facebook",
      utm_medium: "organic",
      utm_campaign: "autopost",
    });

    expect(url).toBe(
      "https://www.etsy.com/listing/12345?ref=rss&utm_source=facebook&utm_medium=organic&utm_campaign=autopost",
    );
  });

  it("does not duplicate existing UTM params and preserves other query params", () => {
    const url = toShareAndSaveUrl(
      "https://www.etsy.com/listing/99999/abc?utm_source=orig&utm_medium=paid&utm_campaign=old&ref=rss",
      { utm_source: "facebook", utm_medium: "organic", utm_campaign: "autopost" },
    );

    expect(url).toBe(
      "https://www.etsy.com/listing/99999?utm_source=facebook&utm_medium=organic&utm_campaign=autopost&ref=rss",
    );
  });

  it("ignores custom share-and-save domain overrides and keeps canonical Etsy host", () => {
    process.env.ETSY_SHARE_AND_SAVE_DOMAIN = "https://customshop.etsy.com/";
    const url = toShareAndSaveUrl("https://www.etsy.com/listing/888/slug");
    expect(url).toBe("https://www.etsy.com/listing/888");
  });

  it("falls back to the original URL for non-Etsy links", () => {
    const input = "https://example.com/post/123";
    expect(
      toShareAndSaveUrl(input, { utm_source: "facebook", utm_medium: "organic" }),
    ).toBe(input);
  });

  it("keeps canonical Etsy host even when share-and-save domain env is provided", () => {
    process.env.ETSY_SHARE_AND_SAVE_DOMAIN = "customshop.etsy.com";
    const url = toShareAndSaveUrl("https://www.etsy.com/listing/99999/abc");
    expect(url).toBe("https://www.etsy.com/listing/99999");
  });
});

describe("extractOgTitleFromHtml", () => {
  it("extracts og:title from meta tag", () => {
    const html = '<html><head><meta property="og:title" content="Vintage Italian Vase" /></head></html>';
    expect(extractOgTitleFromHtml(html)).toBe("Vintage Italian Vase");
  });

  it("returns null when og:title is missing", () => {
    const html = "<html><head><title>Page</title></head></html>";
    expect(extractOgTitleFromHtml(html)).toBeNull();
  });
});

describe("extractOgDescriptionFromHtml", () => {
  it("extracts og:description from meta tag", () => {
    const html = '<html><head><meta property="og:description" content="Beautiful hand-painted vase from Italy." /></head></html>';
    expect(extractOgDescriptionFromHtml(html)).toBe("Beautiful hand-painted vase from Italy.");
  });

  it("returns null when og:description is missing", () => {
    const html = '<html><head><meta property="og:title" content="Title" /></head></html>';
    expect(extractOgDescriptionFromHtml(html)).toBeNull();
  });
});

describe("extractJsonLdNameFromHtml", () => {
  it("extracts name from JSON-LD script block", () => {
    const html = [
      "<html><head>",
      '<script type="application/ld+json">',
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Product",
        name: "Vintage Crystal Glass",
        image: "https://example.com/img.jpg",
      }),
      "</script>",
      "</head></html>",
    ].join("");
    expect(extractJsonLdNameFromHtml(html)).toBe("Vintage Crystal Glass");
  });

  it("returns null when no name is present", () => {
    const html = [
      "<html><head>",
      '<script type="application/ld+json">',
      JSON.stringify({ "@context": "https://schema.org", "@type": "Product" }),
      "</script>",
      "</head></html>",
    ].join("");
    expect(extractJsonLdNameFromHtml(html)).toBeNull();
  });
});

describe("extractJsonLdDescriptionFromHtml", () => {
  it("extracts description from JSON-LD script block", () => {
    const html = [
      "<html><head>",
      '<script type="application/ld+json">',
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Product",
        name: "Vase",
        description: "A beautiful vintage ceramic vase from the 1950s.",
      }),
      "</script>",
      "</head></html>",
    ].join("");
    expect(extractJsonLdDescriptionFromHtml(html)).toBe("A beautiful vintage ceramic vase from the 1950s.");
  });

  it("returns null when no description is present", () => {
    const html = [
      "<html><head>",
      '<script type="application/ld+json">',
      JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: "Vase" }),
      "</script>",
      "</head></html>",
    ].join("");
    expect(extractJsonLdDescriptionFromHtml(html)).toBeNull();
  });

  it("extracts description from @graph nodes", () => {
    const html = [
      "<html><head>",
      '<script type="application/ld+json">',
      JSON.stringify({
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "Product", name: "Plate", description: "Vintage French plate." },
        ],
      }),
      "</script>",
      "</head></html>",
    ].join("");
    expect(extractJsonLdDescriptionFromHtml(html)).toBe("Vintage French plate.");
  });
});
