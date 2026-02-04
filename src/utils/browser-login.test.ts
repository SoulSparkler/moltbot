import { beforeEach, describe, expect, it, vi } from "vitest";

const credentialHandlerMock = vi.hoisted(() => ({
  retrieveCredentialFromOP: vi.fn(),
}));

vi.mock("./credential-handler.js", () => credentialHandlerMock);

import { isLoggedIntoGmail, loginToGmailWithOP, navigateToGmailInbox } from "./browser-login.js";

describe("browser-login", () => {
  let mockContext: any;
  let mockPage: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock page
    mockPage = {
      goto: vi.fn(),
      waitForSelector: vi.fn(),
      click: vi.fn(),
      waitForTimeout: vi.fn(),
      waitForNavigation: vi.fn(),
      url: vi.fn(),
      close: vi.fn(),
      $: vi.fn(),
    };

    // Mock context
    mockContext = {
      newPage: vi.fn().mockResolvedValue(mockPage),
    };
  });

  describe("loginToGmailWithOP", () => {
    it("should login successfully with valid credentials", async () => {
      // Mock credential retrieval
      credentialHandlerMock.retrieveCredentialFromOP.mockResolvedValue("test-password");

      // Mock successful navigation
      mockPage.goto.mockResolvedValue(undefined);

      // Mock email input
      const emailInput = { fill: vi.fn() };
      mockPage.waitForSelector.mockResolvedValueOnce(emailInput);

      // Mock password input
      const passwordInput = { fill: vi.fn() };
      mockPage.waitForSelector.mockResolvedValueOnce(passwordInput);

      // Mock URL checks (successful login)
      mockPage.url.mockReturnValueOnce("https://accounts.google.com/challenge");
      mockPage.url.mockReturnValueOnce("https://myaccount.google.com");

      const result = await loginToGmailWithOP(mockContext, {
        email: "test@gmail.com",
        opVaultPath: "op://Private/Gmail/password",
      });

      expect(result.success).toBe(true);
      expect(credentialHandlerMock.retrieveCredentialFromOP).toHaveBeenCalledWith(
        "op://Private/Gmail/password",
      );
      expect(emailInput.fill).toHaveBeenCalledWith("test@gmail.com");
      expect(passwordInput.fill).toHaveBeenCalledWith("test-password");
    });

    it("should handle credential retrieval failure", async () => {
      // Mock credential retrieval failure
      credentialHandlerMock.retrieveCredentialFromOP.mockRejectedValue(
        new Error("1Password app is locked"),
      );

      const result = await loginToGmailWithOP(mockContext, {
        email: "test@gmail.com",
        opVaultPath: "op://Private/Gmail/password",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to retrieve credential");
    });

    it("should handle navigation failure", async () => {
      // Mock credential retrieval
      credentialHandlerMock.retrieveCredentialFromOP.mockResolvedValue("test-password");

      // Mock navigation failure
      mockPage.goto.mockRejectedValue(new Error("Network error"));

      const result = await loginToGmailWithOP(mockContext, {
        email: "test@gmail.com",
        opVaultPath: "op://Private/Gmail/password",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to navigate");
    });

    it("should handle email input not found", async () => {
      // Mock credential retrieval
      credentialHandlerMock.retrieveCredentialFromOP.mockResolvedValue("test-password");

      // Mock successful navigation
      mockPage.goto.mockResolvedValue(undefined);

      // Mock email input not found
      mockPage.waitForSelector.mockResolvedValueOnce(null);

      const result = await loginToGmailWithOP(mockContext, {
        email: "test@gmail.com",
        opVaultPath: "op://Private/Gmail/password",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Email input field not found");
    });

    it("should handle password input not found", async () => {
      // Mock credential retrieval
      credentialHandlerMock.retrieveCredentialFromOP.mockResolvedValue("test-password");

      // Mock successful navigation
      mockPage.goto.mockResolvedValue(undefined);

      // Mock email input found
      const emailInput = { fill: vi.fn() };
      mockPage.waitForSelector.mockResolvedValueOnce(emailInput);

      // Mock password input not found
      mockPage.waitForSelector.mockResolvedValueOnce(null);

      const result = await loginToGmailWithOP(mockContext, {
        email: "test@gmail.com",
        opVaultPath: "op://Private/Gmail/password",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Password input field not found");
    });

    it("should handle 2FA requirement", async () => {
      // Mock credential retrieval
      credentialHandlerMock.retrieveCredentialFromOP.mockResolvedValue("test-password");

      // Mock successful navigation
      mockPage.goto.mockResolvedValue(undefined);

      // Mock email and password inputs
      const emailInput = { fill: vi.fn() };
      const passwordInput = { fill: vi.fn() };
      mockPage.waitForSelector.mockResolvedValueOnce(emailInput);
      mockPage.waitForSelector.mockResolvedValueOnce(passwordInput);

      // Mock URL showing 2FA challenge
      mockPage.url.mockReturnValue("https://accounts.google.com/challenge/totp");

      // Mock 2FA timeout
      mockPage.waitForNavigation.mockRejectedValue(new Error("Timeout"));

      const result = await loginToGmailWithOP(mockContext, {
        email: "test@gmail.com",
        opVaultPath: "op://Private/Gmail/password",
        wait2FA: true,
      });

      expect(result.success).toBe(false);
      expect(result.requires2FA).toBe(true);
      expect(result.error).toContain("2FA timeout");
    });

    it("should retry on transient navigation failures", async () => {
      // Mock credential retrieval
      credentialHandlerMock.retrieveCredentialFromOP.mockResolvedValue("test-password");

      // Mock navigation failures then success
      mockPage.goto
        .mockRejectedValueOnce(new Error("Network error"))
        .mockRejectedValueOnce(new Error("Network error"))
        .mockResolvedValueOnce(undefined);

      // Mock email and password inputs
      const emailInput = { fill: vi.fn() };
      const passwordInput = { fill: vi.fn() };
      mockPage.waitForSelector.mockResolvedValueOnce(emailInput);
      mockPage.waitForSelector.mockResolvedValueOnce(passwordInput);

      // Mock successful login
      mockPage.url.mockReturnValue("https://myaccount.google.com");

      const result = await loginToGmailWithOP(mockContext, {
        email: "test@gmail.com",
        opVaultPath: "op://Private/Gmail/password",
      });

      expect(result.success).toBe(true);
      expect(mockPage.goto).toHaveBeenCalledTimes(3);
    });
  });

  describe("navigateToGmailInbox", () => {
    it("should navigate to Gmail inbox successfully", async () => {
      mockPage.goto.mockResolvedValue(undefined);

      const result = await navigateToGmailInbox(mockPage);

      expect(result).toBe(true);
      expect(mockPage.goto).toHaveBeenCalledWith(
        "https://mail.google.com/mail/u/0/#inbox",
        expect.any(Object),
      );
    });

    it("should handle navigation failure", async () => {
      mockPage.goto.mockRejectedValue(new Error("Network error"));

      const result = await navigateToGmailInbox(mockPage);

      expect(result).toBe(false);
    });
  });

  describe("isLoggedIntoGmail", () => {
    it("should return true when redirected to myaccount", async () => {
      mockPage.goto.mockResolvedValue(undefined);
      mockPage.url.mockReturnValue("https://myaccount.google.com");

      const result = await isLoggedIntoGmail(mockContext);

      expect(result).toBe(true);
    });

    it("should return true when account selector is present", async () => {
      mockPage.goto.mockResolvedValue(undefined);
      mockPage.url.mockReturnValue("https://accounts.google.com");
      mockPage.$.mockResolvedValue({ data: "account-selector" });

      const result = await isLoggedIntoGmail(mockContext);

      expect(result).toBe(true);
    });

    it("should return false when not logged in", async () => {
      mockPage.goto.mockResolvedValue(undefined);
      mockPage.url.mockReturnValue("https://accounts.google.com/signin");
      mockPage.$.mockResolvedValue(null);

      const result = await isLoggedIntoGmail(mockContext);

      expect(result).toBe(false);
    });

    it("should handle errors gracefully", async () => {
      mockPage.goto.mockRejectedValue(new Error("Network error"));

      const result = await isLoggedIntoGmail(mockContext);

      expect(result).toBe(false);
    });

    it("should close page after check", async () => {
      mockPage.goto.mockResolvedValue(undefined);
      mockPage.url.mockReturnValue("https://myaccount.google.com");

      await isLoggedIntoGmail(mockContext);

      expect(mockPage.close).toHaveBeenCalled();
    });
  });
});
