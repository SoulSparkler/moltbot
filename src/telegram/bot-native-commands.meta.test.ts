import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ChannelGroupPolicy } from "../config/group-policy.js";
import type { TelegramAccountConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn(async () => []),
}));

type HandlerCtx = {
  message?: {
    chat: { id: number; type: "private" | "group" | "supergroup" };
    from?: { id: number; username?: string };
    message_id: number;
    date: number;
  };
  match?: string;
};

function createRegistration(params?: { allowFrom?: Array<string | number> }) {
  const handlers: Record<string, (ctx: HandlerCtx) => Promise<void>> = {};
  const setMyCommands = vi.fn().mockResolvedValue(undefined);
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const bot = {
    api: {
      setMyCommands,
      sendMessage,
    },
    command: (name: string, handler: (ctx: HandlerCtx) => Promise<void>) => {
      handlers[name] = handler;
    },
  } as const;
  registerTelegramNativeCommands({
    bot: bot as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
    cfg: {} as OpenClawConfig,
    runtime: {} as RuntimeEnv,
    accountId: "default",
    telegramCfg: {} as TelegramAccountConfig,
    allowFrom: params?.allowFrom ?? [],
    groupAllowFrom: [],
    replyToMode: "off",
    textLimit: 4096,
    useAccessGroups: false,
    nativeEnabled: true,
    nativeSkillsEnabled: false,
    nativeDisabledExplicit: false,
    resolveGroupPolicy: () =>
      ({
        allowlistEnabled: false,
        allowed: true,
      }) as ChannelGroupPolicy,
    resolveTelegramGroupConfig: () => ({
      groupConfig: undefined,
      topicConfig: undefined,
    }),
    shouldSkipUpdate: () => false,
    opts: { token: "telegram-token" },
  });
  return {
    handlers,
    setMyCommands,
    sendMessage,
  };
}

describe("telegram meta diagnostics commands", () => {
  const fetchMock = vi.fn();
  const originalMetaAccessToken = process.env.META_ACCESS_TOKEN;
  const originalMetaPageId = process.env.META_PAGE_ID;
  const originalMetaAppId = process.env.META_APP_ID;
  const originalMetaAppSecret = process.env.META_APP_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.META_ACCESS_TOKEN;
    delete process.env.META_PAGE_ID;
    delete process.env.META_APP_ID;
    delete process.env.META_APP_SECRET;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.META_ACCESS_TOKEN = originalMetaAccessToken;
    process.env.META_PAGE_ID = originalMetaPageId;
    process.env.META_APP_ID = originalMetaAppId;
    process.env.META_APP_SECRET = originalMetaAppSecret;
  });

  it("registers /meta_status and /meta_debug as native Telegram commands", () => {
    const { handlers, setMyCommands } = createRegistration();
    const registered = setMyCommands.mock.calls[0]?.[0] as Array<{ command: string }>;
    const commandNames = new Set(registered.map((command) => command.command));

    expect(commandNames.has("meta_status")).toBe(true);
    expect(commandNames.has("meta_debug")).toBe(true);
    expect(typeof handlers.meta_status).toBe("function");
    expect(typeof handlers.meta_debug).toBe("function");
  });

  it("/meta_status reports HTTP status and error_subcode without leaking token", async () => {
    process.env.META_ACCESS_TOKEN = "meta-system-user-token";
    process.env.META_PAGE_ID = "123456789";
    fetchMock.mockResolvedValue({
      status: 400,
      ok: false,
      text: async () =>
        JSON.stringify({
          error: {
            message: "Invalid OAuth access token.",
            type: "OAuthException",
            code: 190,
            error_subcode: 1234567,
          },
        }),
    } as Response);

    const { handlers, sendMessage } = createRegistration({
      allowFrom: ["999"], // Should still run because /meta_status is not admin-gated.
    });
    await handlers.meta_status?.({
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 111, username: "unauthorized" },
        message_id: 1,
        date: 1,
      },
      match: "",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.facebook.com/v18.0/123456789?fields=id,name",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer meta-system-user-token",
        }),
      }),
    );
    const text = sendMessage.mock.calls[0]?.[1] as string;
    expect(text).toContain("status: 400");
    expect(text).toContain("error_subcode: 1234567");
    expect(text).not.toContain("meta-system-user-token");
  });

  it("/meta_debug is admin-only", async () => {
    process.env.META_ACCESS_TOKEN = "meta-system-user-token";
    process.env.META_APP_ID = "123";
    process.env.META_APP_SECRET = "secret";
    const { handlers, sendMessage } = createRegistration({
      allowFrom: ["999"],
    });

    await handlers.meta_debug?.({
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 111, username: "unauthorized" },
        message_id: 1,
        date: 1,
      },
      match: "",
    });

    expect(sendMessage).toHaveBeenCalledWith(123, "You are not authorized to use this command.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("/meta_debug returns only requested token fields for a valid System User token", async () => {
    process.env.META_ACCESS_TOKEN = "meta_system_user_token";
    process.env.META_APP_ID = "123";
    process.env.META_APP_SECRET = "secret";
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () =>
        JSON.stringify({
          data: {
            is_valid: true,
            type: "SYSTEM_USER",
            expires_at: 1700000000,
            app_id: "123",
            scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
            user_id: "ignored",
          },
        }),
    } as Response);

    const { handlers, sendMessage } = createRegistration({
      allowFrom: ["111"],
    });
    await handlers.meta_debug?.({
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 111, username: "admin" },
        message_id: 1,
        date: 1,
      },
      match: "",
    });

    const requestUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(requestUrl).toContain("https://graph.facebook.com/v18.0/debug_token?");
    expect(requestUrl).toContain("input_token=meta_system_user_token");
    expect(requestUrl).toContain("access_token=123%7Csecret");

    const text = sendMessage.mock.calls[0]?.[1] as string;
    expect(text).toBe(
      [
        "is_valid: true",
        "token_type: SYSTEM_USER",
        "expires_at: 1700000000",
        "app_id: 123",
        "scopes: whatsapp_business_management, whatsapp_business_messaging",
      ].join("\n"),
    );
    expect(text).not.toContain("meta_system_user_token");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("user_id");
  });
});
