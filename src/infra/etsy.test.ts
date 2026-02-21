import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractEtsyListingImageUrlFromHtml, extractEtsyRssImageUrl } from "./etsy.js";

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
