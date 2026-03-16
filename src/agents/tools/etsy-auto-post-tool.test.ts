import { afterEach, describe, expect, it, vi } from "vitest";
import { createEtsyAutoPostTool } from "./etsy-auto-post-tool.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createEtsyAutoPostTool", () => {
  const previousFetch = global.fetch;

  afterEach(() => {
    vi.unstubAllEnvs();
    // @ts-expect-error test cleanup
    global.fetch = previousFetch;
  });

  it("returns null when disabled and no remote is configured", () => {
    expect(createEtsyAutoPostTool({ config: {} })).toBeNull();
  });

  it("reports missing remote config when enabled without a base URL", async () => {
    const tool = createEtsyAutoPostTool({
      config: { tools: { etsyAutoPost: { enabled: true } } },
    });

    const result = await tool?.execute?.("1", { action: "status" });

    expect(result?.details).toMatchObject({
      ok: false,
      error: "Etsy autopost service is not configured.",
      missingConfig: ["tools.etsyAutoPost.baseUrl or ETSY_AUTO_POST_URL"],
      env: {
        baseUrlPresent: false,
        tokenPresent: false,
      },
    });
  });

  it("checks sidecar status via /self-check", async () => {
    vi.stubEnv("ETSY_AUTO_POST_URL", "https://etsy.example.com/");

    const mockFetch = vi.fn(async (input: string | URL) => {
      expect(String(input)).toBe("https://etsy.example.com/self-check");
      return jsonResponse(200, {
        ok: true,
        service: "etsy-auto-post",
      });
    });
    // @ts-expect-error test mock
    global.fetch = mockFetch;

    const tool = createEtsyAutoPostTool({ config: {} });
    const result = await tool?.execute?.("1", { action: "status" });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result?.details).toMatchObject({
      ok: true,
      action: "status",
      baseUrl: "https://etsy.example.com",
      status: 200,
      response: {
        ok: true,
        service: "etsy-auto-post",
      },
    });
  });

  it("triggers a manual run with bearer auth", async () => {
    vi.stubEnv("ETSY_AUTO_POST_URL", "https://etsy.example.com");
    vi.stubEnv("ETSY_AUTO_POST_TOKEN", "shared-token");

    const mockFetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://etsy.example.com/manual-run");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe(
        "Bearer shared-token",
      );
      return jsonResponse(200, {
        ok: true,
        run: {
          trigger: "manual",
          postedCount: 1,
        },
      });
    });
    // @ts-expect-error test mock
    global.fetch = mockFetch;

    const tool = createEtsyAutoPostTool({ config: {} });
    const result = await tool?.execute?.("1", { action: "run" });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result?.details).toMatchObject({
      ok: true,
      action: "run",
      status: 200,
      response: {
        ok: true,
        run: {
          trigger: "manual",
          postedCount: 1,
        },
      },
    });
  });
});
