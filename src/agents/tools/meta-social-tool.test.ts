import { afterEach, describe, expect, it, vi } from "vitest";
import { createMetaSocialTool } from "./meta-social-tool.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createMetaSocialTool", () => {
  const previousFetch = global.fetch;

  afterEach(() => {
    vi.unstubAllEnvs();
    // @ts-expect-error test cleanup
    global.fetch = previousFetch;
  });

  it("returns null when disabled", () => {
    expect(createMetaSocialTool({ config: {} })).toBeNull();
  });

  it("reports missing env vars during status checks", async () => {
    const mockFetch = vi.fn();
    // @ts-expect-error test mock
    global.fetch = mockFetch;

    const tool = createMetaSocialTool({
      config: { tools: { metaSocial: { enabled: true } } },
    });
    const result = await tool?.execute?.("1", { action: "status" });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result?.details).toMatchObject({
      ok: false,
      missingEnv: ["META_PAGE_ID", "META_ACCESS_TOKEN or META_PAGE_ACCESS_TOKEN"],
      env: {
        pageIdPresent: false,
        accessTokenPresent: false,
        pageAccessTokenPresent: false,
      },
    });
  });

  it("publishes a Facebook photo post with a page access token", async () => {
    vi.stubEnv("META_PAGE_ID", "page123");
    vi.stubEnv("META_PAGE_ACCESS_TOKEN", "page-token");

    const mockFetch = vi.fn(async (input: string | URL) => {
      expect(String(input)).toBe("https://graph.facebook.com/v18.0/page123/photos");
      return jsonResponse(200, {
        id: "photo123",
        post_id: "page123_post456",
      });
    });
    // @ts-expect-error test mock
    global.fetch = mockFetch;

    const tool = createMetaSocialTool({
      config: { tools: { metaSocial: { enabled: true } } },
    });
    const result = await tool?.execute?.("1", {
      action: "publish",
      platform: "facebook",
      message: "Nieuwe post",
      imageUrl: "https://cdn.example.com/item.jpg",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const request = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = String(request?.body ?? "");
    expect(body).toContain("url=https%3A%2F%2Fcdn.example.com%2Fitem.jpg");
    expect(body).toContain("caption=Nieuwe+post");
    expect(result?.details).toMatchObject({
      ok: true,
      platform: "facebook",
      pageId: "page123",
      pageTokenSource: "page_access_token",
      results: {
        facebook: {
          photoId: "photo123",
          postId: "page123_post456",
        },
      },
      errors: [],
    });
  });

  it("publishes to Instagram after resolving a page token from /me/accounts", async () => {
    vi.stubEnv("META_PAGE_ID", "page123");
    vi.stubEnv("META_ACCESS_TOKEN", "system-token");

    const mockFetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (
        url === "https://graph.facebook.com/v18.0/me/accounts?fields=id,name,access_token&limit=200"
      ) {
        return jsonResponse(200, {
          data: [{ id: "page123", name: "Shop Page", access_token: "page-token" }],
        });
      }
      if (
        url ===
        "https://graph.facebook.com/v18.0/page123?fields=instagram_business_account{id,username}"
      ) {
        return jsonResponse(200, {
          instagram_business_account: { id: "ig123", username: "shop_ig" },
        });
      }
      if (url === "https://graph.facebook.com/v18.0/ig123/media") {
        const body = String(init?.body ?? "");
        expect(body).toContain("image_url=https%3A%2F%2Fcdn.example.com%2Fitem.jpg");
        expect(body).toContain(
          "caption=Look+at+this%0A%0Ahttps%3A%2F%2Fexample.com%2Flisting%2F42",
        );
        return jsonResponse(200, { id: "creation123" });
      }
      if (url === "https://graph.facebook.com/v18.0/creation123?fields=status_code") {
        return jsonResponse(200, { status_code: "FINISHED" });
      }
      if (url === "https://graph.facebook.com/v18.0/ig123/media_publish") {
        return jsonResponse(200, { id: "media123" });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    // @ts-expect-error test mock
    global.fetch = mockFetch;

    const tool = createMetaSocialTool({
      config: { tools: { metaSocial: { enabled: true } } },
    });
    const result = await tool?.execute?.("1", {
      action: "publish",
      platform: "instagram",
      message: "Look at this",
      imageUrl: "https://cdn.example.com/item.jpg",
      linkUrl: "https://example.com/listing/42",
    });

    expect(mockFetch).toHaveBeenCalledTimes(5);
    expect(result?.details).toMatchObject({
      ok: true,
      platform: "instagram",
      pageId: "page123",
      pageTokenSource: "me_accounts",
      results: {
        instagram: {
          igUserId: "ig123",
          creationId: "creation123",
          mediaId: "media123",
        },
      },
      errors: [],
    });
  });
});
