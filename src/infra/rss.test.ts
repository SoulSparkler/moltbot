import { describe, expect, it } from "vitest";
import { extractRssImgSrc } from "./rss.js";

describe("extractRssImgSrc", () => {
  it("returns null for empty inputs", () => {
    expect(extractRssImgSrc(undefined)).toBeNull();
    expect(extractRssImgSrc(null)).toBeNull();
    expect(extractRssImgSrc("   ")).toBeNull();
  });

  it("extracts the first etsystatic image URL when present", () => {
    const html =
      '<p><img src="https://example.com/preview.png" /></p><p><img src="https://i.etsystatic.com/12345/r/il_rss.jpg" /></p>';
    expect(extractRssImgSrc(html)).toBe("https://i.etsystatic.com/12345/r/il_rss.jpg");
  });

  it("falls back to the first http(s) image when no etsystatic host exists", () => {
    const html =
      '<p><img src="data:image/png;base64,AAAA" /></p><p><img src="https://cdn.example.com/item.jpg" /></p>';
    expect(extractRssImgSrc(html)).toBe("https://cdn.example.com/item.jpg");
  });

  it("decodes basic HTML entities in src attributes", () => {
    const html =
      '<img src="https://i.etsystatic.com/12345/r/il_rss.jpg?foo=1&amp;bar=2" alt="Example" />';
    expect(extractRssImgSrc(html)).toBe("https://i.etsystatic.com/12345/r/il_rss.jpg?foo=1&bar=2");
  });
});
