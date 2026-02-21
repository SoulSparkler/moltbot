import { describe, expect, it, vi } from "vitest";
import {
  MetaGraphRequestError,
  publishInstagramPhoto,
  resolveFacebookPageAccessToken,
  resolveInstagramBusinessAccount,
} from "./meta-instagram.js";

describe("resolveFacebookPageAccessToken", () => {
  it("uses /me/accounts to derive a Page access token when available", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          data: [{ id: "123", name: "My Page", access_token: "page-token" }],
        }),
    } as Response);

    const result = await resolveFacebookPageAccessToken({
      pageId: "123",
      accessToken: "system-user-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.token).toBe("page-token");
    expect(result.source).toBe("me_accounts");
    expect(result.pageName).toBe("My Page");
    expect(result.meAccountsStatus.ok).toBe(true);
    expect(result.meAccountsStatus.matchedPage).toBe(true);

    const [requestUrl, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      "https://graph.facebook.com/v18.0/me/accounts?fields=id,name,access_token&limit=200",
    );
    expect(requestInit).toEqual(
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer system-user-token",
        }),
      }),
    );
  });
});

describe("resolveInstagramBusinessAccount", () => {
  it("returns instagram_business_account details and caches them", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          instagram_business_account: { id: "ig123", username: "myig" },
        }),
    } as Response);

    const first = await resolveInstagramBusinessAccount({
      pageId: "page-cache-1",
      pageAccessToken: "page-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
      cacheTtlMs: 60_000,
    });
    const second = await resolveInstagramBusinessAccount({
      pageId: "page-cache-1",
      pageAccessToken: "page-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
      cacheTtlMs: 60_000,
    });

    expect(first).toEqual({ id: "ig123", username: "myig" });
    expect(second).toEqual({ id: "ig123", username: "myig" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("publishInstagramPhoto", () => {
  it("creates a container, polls status, then publishes", async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: "creation123" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status_code: "FINISHED" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: "media456" }),
      } as Response);

    const result = await publishInstagramPhoto({
      igUserId: "ig123",
      accessToken: "page-token",
      imageUrl: "https://example.com/image.jpg",
      caption: "Hello",
      fetchImpl: fetchMock as unknown as typeof fetch,
      pollIntervalMs: 1,
      pollTimeoutMs: 50,
    });

    expect(result).toEqual({ igUserId: "ig123", creationId: "creation123", mediaId: "media456" });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [containerUrl, containerInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(containerUrl)).toBe("https://graph.facebook.com/v18.0/ig123/media");
    expect(containerInit?.method).toBe("POST");
    expect(containerInit?.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer page-token",
        "content-type": "application/x-www-form-urlencoded",
      }),
    );

    const containerBody = containerInit?.body as URLSearchParams;
    expect(containerBody.toString()).toContain("image_url=https%3A%2F%2Fexample.com%2Fimage.jpg");
    expect(containerBody.toString()).toContain("caption=Hello");

    const statusUrl = String(fetchMock.mock.calls[1]?.[0]);
    expect(statusUrl).toBe("https://graph.facebook.com/v18.0/creation123?fields=status_code");

    const publishUrl = String(fetchMock.mock.calls[2]?.[0]);
    expect(publishUrl).toBe("https://graph.facebook.com/v18.0/ig123/media_publish");
    const publishBody = fetchMock.mock.calls[2]?.[1]?.body as URLSearchParams;
    expect(publishBody.toString()).toContain("creation_id=creation123");
  });

  it("throws a MetaGraphRequestError when container creation fails", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          error: {
            message: "Bad token",
            type: "OAuthException",
            code: 190,
            error_subcode: 123,
            fbtrace_id: "trace",
          },
        }),
    } as Response);

    let caught: unknown;
    try {
      await publishInstagramPhoto({
        igUserId: "ig123",
        accessToken: "page-token",
        imageUrl: "https://example.com/image.jpg",
        fetchImpl: fetchMock as unknown as typeof fetch,
        pollUntilFinished: false,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MetaGraphRequestError);
    const err = caught as MetaGraphRequestError;
    expect(err.status).toBe(400);
    expect(err.error?.code).toBe("190");
    expect(err.error?.subcode).toBe("123");
    expect(err.error?.fbtraceId).toBe("trace");
    expect(err.error?.message).toBe("Bad token");
  });

  it("retries transient errors when creating a container", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);

    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () =>
          JSON.stringify({
            error: {
              message: "An unexpected error has occurred. Please retry later.",
              code: 2,
              is_transient: true,
              fbtrace_id: "trace",
            },
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: "creation123" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: "media456" }),
      } as Response);

    const promise = publishInstagramPhoto({
      igUserId: "ig123",
      accessToken: "page-token",
      imageUrl: "https://example.com/image.jpg",
      caption: "Hello",
      fetchImpl: fetchMock as unknown as typeof fetch,
      pollUntilFinished: false,
    });

    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual({
      igUserId: "ig123",
      creationId: "creation123",
      mediaId: "media456",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("retry op=create_container attempt=2/4 delay_ms=2000 status=500"),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("fbtrace_id=trace"));
    expect(errorSpy).not.toHaveBeenCalled();

    randomSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    vi.useRealTimers();
  });

  it("retries transient errors when publishing a container", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: "creation123" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () =>
          JSON.stringify({
            error: {
              message: "An unexpected error has occurred. Please retry later.",
              code: 2,
              is_transient: true,
              fbtrace_id: "trace",
            },
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: "media456" }),
      } as Response);

    const promise = publishInstagramPhoto({
      igUserId: "ig123",
      accessToken: "page-token",
      imageUrl: "https://example.com/image.jpg",
      caption: "Hello",
      fetchImpl: fetchMock as unknown as typeof fetch,
      pollUntilFinished: false,
    });

    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual({
      igUserId: "ig123",
      creationId: "creation123",
      mediaId: "media456",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("retry op=publish_container attempt=2/4 delay_ms=2000 status=500"),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("fbtrace_id=trace"));
    expect(errorSpy).not.toHaveBeenCalled();

    randomSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    vi.useRealTimers();
  });

  it("gives up after exhausting transient publish retries", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);

    const transientErrorResponse = {
      ok: false,
      status: 500,
      text: async () =>
        JSON.stringify({
          error: {
            message: "An unexpected error has occurred. Please retry later.",
            code: 2,
            is_transient: true,
            fbtrace_id: "trace",
          },
        }),
    } as Response;

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: "creation123" }),
      } as Response)
      .mockResolvedValueOnce(transientErrorResponse)
      .mockResolvedValueOnce(transientErrorResponse)
      .mockResolvedValueOnce(transientErrorResponse)
      .mockResolvedValueOnce(transientErrorResponse);

    const promise = publishInstagramPhoto({
      igUserId: "ig123",
      accessToken: "page-token",
      imageUrl: "https://example.com/image.jpg",
      fetchImpl: fetchMock as unknown as typeof fetch,
      pollUntilFinished: false,
    });
    const handled = promise.then(
      () => null,
      (err) => err,
    );

    await vi.runAllTimersAsync();

    await expect(handled).resolves.toBeInstanceOf(MetaGraphRequestError);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("give_up op=publish_container attempts=4/4 status=500"),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("fbtrace_id=trace"));

    randomSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    vi.useRealTimers();
  });
});
