import { describe, it, expect } from "vitest";
import {
  sanitizeInstagramImageUrl,
  isInstagramSafeAspectRatio,
  computeInstagramPadding,
  storeTempImage,
  getTempImage,
  clearTempImage,
} from "./instagram-image.js";

describe("sanitizeInstagramImageUrl", () => {
  it("decodes &amp; HTML entities in query string", () => {
    const raw =
      "https://i.etsystatic.com/12345/r/il_794xN.123.jpg?version=0&amp;impolicy=letterbox";
    expect(sanitizeInstagramImageUrl(raw)).toBe(
      "https://i.etsystatic.com/12345/r/il_794xN.123.jpg?version=0&impolicy=letterbox",
    );
  });

  it("decodes numeric HTML entities", () => {
    const raw = "https://i.etsystatic.com/img&#46;jpg";
    expect(sanitizeInstagramImageUrl(raw)).toBe(
      "https://i.etsystatic.com/img.jpg",
    );
  });

  it("decodes hex HTML entities", () => {
    const raw = "https://i.etsystatic.com/img&#x2E;jpg";
    expect(sanitizeInstagramImageUrl(raw)).toBe(
      "https://i.etsystatic.com/img.jpg",
    );
  });

  it("upgrades http to https", () => {
    const raw = "http://i.etsystatic.com/12345/r/il_794xN.123.jpg";
    expect(sanitizeInstagramImageUrl(raw)).toBe(
      "https://i.etsystatic.com/12345/r/il_794xN.123.jpg",
    );
  });

  it("fixes protocol-relative URLs", () => {
    const raw = "//i.etsystatic.com/12345/r/il_794xN.123.jpg";
    expect(sanitizeInstagramImageUrl(raw)).toBe(
      "https://i.etsystatic.com/12345/r/il_794xN.123.jpg",
    );
  });

  it("returns clean URL unchanged", () => {
    const clean = "https://i.etsystatic.com/12345/r/il_794xN.123.jpg";
    expect(sanitizeInstagramImageUrl(clean)).toBe(clean);
  });

  it("trims whitespace", () => {
    const raw = "  https://i.etsystatic.com/img.jpg  ";
    expect(sanitizeInstagramImageUrl(raw)).toBe(
      "https://i.etsystatic.com/img.jpg",
    );
  });
});

describe("isInstagramSafeAspectRatio", () => {
  it("accepts 1:1 square", () => {
    expect(isInstagramSafeAspectRatio(1080, 1080)).toBe(true);
  });

  it("accepts 4:5 portrait (lower limit)", () => {
    expect(isInstagramSafeAspectRatio(1080, 1350)).toBe(true);
  });

  it("accepts 1.91:1 landscape (upper limit)", () => {
    expect(isInstagramSafeAspectRatio(1080, 565)).toBe(true);
  });

  it("accepts 4:3 landscape", () => {
    expect(isInstagramSafeAspectRatio(1200, 900)).toBe(true);
  });

  it("rejects very tall portrait (2:5)", () => {
    expect(isInstagramSafeAspectRatio(400, 1000)).toBe(false);
  });

  it("rejects very wide panorama (3:1)", () => {
    expect(isInstagramSafeAspectRatio(3000, 1000)).toBe(false);
  });

  it("rejects zero dimensions", () => {
    expect(isInstagramSafeAspectRatio(0, 1000)).toBe(false);
    expect(isInstagramSafeAspectRatio(1000, 0)).toBe(false);
  });
});

describe("computeInstagramPadding", () => {
  it("returns zero padding for safe ratio", () => {
    const pad = computeInstagramPadding(1080, 1080);
    expect(pad.padLeft).toBe(0);
    expect(pad.padRight).toBe(0);
    expect(pad.padTop).toBe(0);
    expect(pad.padBottom).toBe(0);
  });

  it("adds horizontal padding for too-tall image", () => {
    // 400x1000 → ratio 0.4, needs to be 0.8
    // target width = 1000 * 0.8 = 800
    const pad = computeInstagramPadding(400, 1000);
    expect(pad.targetWidth).toBe(800);
    expect(pad.targetHeight).toBe(1000);
    expect(pad.padLeft + pad.padRight).toBe(400);
    expect(pad.padTop).toBe(0);
    expect(pad.padBottom).toBe(0);
  });

  it("adds vertical padding for too-wide image", () => {
    // 3000x1000 → ratio 3.0, needs to be 1.91
    // target height = ceil(3000 / 1.91) = 1571
    const pad = computeInstagramPadding(3000, 1000);
    expect(pad.targetWidth).toBe(3000);
    expect(pad.targetHeight).toBeGreaterThan(1000);
    expect(pad.padTop + pad.padBottom).toBe(pad.targetHeight - 1000);
    expect(pad.padLeft).toBe(0);
    expect(pad.padRight).toBe(0);
  });

  it("distributes padding evenly", () => {
    const pad = computeInstagramPadding(400, 1000);
    expect(Math.abs(pad.padLeft - pad.padRight)).toBeLessThanOrEqual(1);
  });
});

describe("temp image store", () => {
  it("stores and retrieves an image", () => {
    const buf = Buffer.from("test-image-data");
    storeTempImage("test-1", buf, "image/jpeg");
    const result = getTempImage("test-1");
    expect(result).not.toBeNull();
    expect(result!.buffer).toBe(buf);
    expect(result!.contentType).toBe("image/jpeg");
    clearTempImage("test-1");
  });

  it("returns null for missing ID", () => {
    expect(getTempImage("nonexistent")).toBeNull();
  });

  it("clears an image", () => {
    const buf = Buffer.from("test-image-data");
    storeTempImage("test-2", buf, "image/jpeg");
    clearTempImage("test-2");
    expect(getTempImage("test-2")).toBeNull();
  });
});
