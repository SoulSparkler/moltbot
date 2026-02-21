import { describe, expect, it, vi } from "vitest";
import {
  canonicalizeEtsyListingUrl,
  postFacebookPageEtsyListing,
  postFacebookPagePhoto,
} from "./meta-facebook.js";

describe("canonicalizeEtsyListingUrl", () => {
  it("normalizes Etsy listing URLs and strips query/hash", () => {
    expect(
      canonicalizeEtsyListingUrl(
        "https://www.etsy.com/listing/1234567890/vintage-vase?utm_source=x&ref=y#reviews",
      ),
    ).toBe("https://www.etsy.com/listing/1234567890/vintage-vase");
  });

  it("accepts locale-prefixed listing URLs", () => {
    expect(
      canonicalizeEtsyListingUrl(
        "https://www.etsy.com/en-gb/listing/1234567890/vintage-vase?utm_source=x#reviews",
      ),
    ).toBe("https://www.etsy.com/listing/1234567890/vintage-vase");
  });

  it("rejects shortened etsy.me URLs", () => {
    expect(() => canonicalizeEtsyListingUrl("https://etsy.me/abc123")).toThrow(
      /Shortened Etsy URLs are not allowed/,
    );
  });

  it("rejects non-listing Etsy URLs", () => {
    expect(() => canonicalizeEtsyListingUrl("https://www.etsy.com/shop/MyShop")).toThrow(
      /Not a listing URL/,
    );
  });
});

describe("postFacebookPageEtsyListing", () => {
  it("always uses the Graph API `link` field and strips URLs from message text", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: "123_456" }),
    } as Response);

    const result = await postFacebookPageEtsyListing({
      pageId: "123",
      accessToken: "token",
      message: "Beautiful vintage piece https://www.etsy.com/listing/1234567890/vintage-vase?ref=x",
      etsyListingUrl: "https://www.etsy.com/listing/1234567890/vintage-vase?ref=x&utm_source=y",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.postId).toBe("123_456");
    expect(result.message).toBe("Beautiful vintage piece");
    expect(result.link).toBe("https://www.etsy.com/listing/1234567890/vintage-vase");

    const [requestUrl, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe("https://graph.facebook.com/v18.0/123/feed");
    expect(requestInit).toEqual(
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token",
          "content-type": "application/x-www-form-urlencoded",
        }),
      }),
    );

    const body = requestInit?.body as URLSearchParams;
    expect(body.toString()).toContain(
      "link=https%3A%2F%2Fwww.etsy.com%2Flisting%2F1234567890%2Fvintage-vase",
    );
    expect(body.toString()).toContain("message=Beautiful+vintage+piece");
    expect(body.toString()).not.toContain("ref%3D");
  });

  it("optionally verifies attachments with a single delayed retry", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: "123_456" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ attachments: { data: [] } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ attachments: { data: [{ id: "att" }] } }),
      } as Response);

    const pending = postFacebookPageEtsyListing({
      pageId: "123",
      accessToken: "token",
      message: "Hello",
      etsyListingUrl: "https://www.etsy.com/listing/1234567890/vintage-vase",
      fetchImpl: fetchMock as unknown as typeof fetch,
      verifyAttachment: true,
      verifyRetryDelayMs: 10,
    });

    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.attachmentVerification).toEqual({
      checked: true,
      hasAttachment: true,
      retried: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);

    const attachmentRequestUrl = String(fetchMock.mock.calls[1]?.[0]);
    expect(attachmentRequestUrl).toContain(
      "https://graph.facebook.com/v18.0/123_456?fields=attachments",
    );

    vi.useRealTimers();
  });
});

describe("postFacebookPagePhoto", () => {
  it("POSTs /photos with url + caption and returns the Graph id", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: "photo_123", post_id: "123_456" }),
    } as Response);

    const result = await postFacebookPagePhoto({
      pageId: "123",
      accessToken: "token",
      imageUrl: "https://i.etsystatic.com/12345/r/il_rss.jpg",
      caption: "A beautiful vintage vase.\nhttps://www.etsy.com/listing/1234567890/vintage-vase",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toEqual({
      photoId: "photo_123",
      postId: "123_456",
      caption: "A beautiful vintage vase.\nhttps://www.etsy.com/listing/1234567890/vintage-vase",
      imageUrl: "https://i.etsystatic.com/12345/r/il_rss.jpg",
    });

    const [requestUrl, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe("https://graph.facebook.com/v18.0/123/photos");
    expect(requestInit).toEqual(
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token",
          "content-type": "application/x-www-form-urlencoded",
        }),
      }),
    );

    const body = requestInit?.body as URLSearchParams;
    expect(body.toString()).toContain(
      "url=https%3A%2F%2Fi.etsystatic.com%2F12345%2Fr%2Fil_rss.jpg",
    );
    expect(body.toString()).toContain("published=true");
    expect(body.toString()).toContain(
      "caption=A+beautiful+vintage+vase.%0Ahttps%3A%2F%2Fwww.etsy.com%2Flisting%2F1234567890%2Fvintage-vase",
    );
  });
});
