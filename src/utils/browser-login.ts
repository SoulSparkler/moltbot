/**
 * Browser automation for Google/Gmail login
 *
 * Workflow:
 * 1. Navigate to https://accounts.google.com/signin
 * 2. Fill email field (from user input)
 * 3. Click Next
 * 4. Fill password field (with credential from 1Password, in memory)
 * 5. Click Next
 * 6. Handle 2FA if needed (user completes manually)
 * 7. Verify login success (look for Gmail inbox or account selector)
 * 8. Return authenticated browser session
 *
 * @module browser-login
 */

import type { BrowserContext, Page } from "playwright-core";
import { retrieveCredentialFromOP } from "./credential-handler.js";

/**
 * Login options
 */
export interface GmailLoginOptions {
  /** Email address to use for login */
  email: string;
  /** 1Password vault path (e.g., "op://Private/gmail/app-password") */
  opVaultPath: string;
  /** Timeout for login operations (default: 30000ms) */
  timeout?: number;
  /** Whether to wait for 2FA completion (default: true) */
  wait2FA?: boolean;
}

/**
 * Login result
 */
export interface LoginResult {
  /** Whether login was successful */
  success: boolean;
  /** Error message if login failed */
  error?: string;
  /** Whether 2FA is required */
  requires2FA?: boolean;
}

/**
 * Maximum retries for transient failures
 */
const MAX_RETRIES = 3;

/**
 * Default timeout for login operations
 */
const DEFAULT_TIMEOUT = 30000;

/**
 * Login to Gmail using browser automation and 1Password credentials
 *
 * @param {BrowserContext} context - Playwright browser context
 * @param {GmailLoginOptions} options - Login options
 * @returns {Promise<LoginResult>} Login result
 *
 * @example
 * const context = await browser.newContext();
 * const result = await loginToGmailWithOP(context, {
 *   email: "user@gmail.com",
 *   opVaultPath: "op://Private/gmail/app-password"
 * });
 */
export async function loginToGmailWithOP(
  context: BrowserContext,
  options: GmailLoginOptions,
): Promise<LoginResult> {
  const { email, opVaultPath, timeout = DEFAULT_TIMEOUT, wait2FA = true } = options;

  let credential: string | undefined;
  let page: Page | undefined;

  try {
    // Step 1: Retrieve credential from 1Password
    try {
      credential = await retrieveCredentialFromOP(opVaultPath);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to retrieve credential: ${errorMessage}`,
      };
    }

    // Step 2: Create new page and navigate to Google sign-in
    page = await context.newPage();

    let retries = 0;
    let navigationSuccess = false;

    while (retries < MAX_RETRIES && !navigationSuccess) {
      try {
        await page.goto("https://accounts.google.com/signin", {
          timeout,
          waitUntil: "domcontentloaded",
        });
        navigationSuccess = true;
      } catch (error) {
        retries++;
        if (retries >= MAX_RETRIES) {
          return {
            success: false,
            error: "Failed to navigate to Google sign-in page after multiple retries",
          };
        }
        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    // Step 3: Fill email field
    try {
      // Wait for email input field
      const emailInput = await page.waitForSelector('input[type="email"]', {
        timeout,
      });

      if (!emailInput) {
        return {
          success: false,
          error: "Email input field not found on sign-in page",
        };
      }

      // Fill email
      await emailInput.fill(email);

      // Click Next button
      await page.click('#identifierNext button, button[type="button"]');

      // Wait for navigation or password field
      await page.waitForTimeout(2000);
    } catch (error) {
      return {
        success: false,
        error: "Failed to fill email field or click Next",
      };
    }

    // Step 4: Fill password field
    try {
      // Wait for password input field
      const passwordInput = await page.waitForSelector('input[type="password"]', {
        timeout,
      });

      if (!passwordInput) {
        return {
          success: false,
          error: "Password input field not found (email may be incorrect)",
        };
      }

      // Fill password (credential is in memory only)
      await passwordInput.fill(credential);

      // Clear credential from memory immediately
      credential = undefined;

      // Click Next button
      await page.click('#passwordNext button, button[type="button"]');

      // Wait for navigation
      await page.waitForTimeout(3000);
    } catch (error) {
      // Clear credential from memory
      credential = undefined;

      return {
        success: false,
        error: "Failed to fill password field or click Next",
      };
    }

    // Step 5: Check for 2FA
    const current = page.url();
    if (
      current.includes("challenge") ||
      current.includes("verification") ||
      current.includes("2fa") ||
      current.includes("totp")
    ) {
      if (wait2FA) {
        // Wait for user to complete 2FA (up to 2 minutes)
        try {
          await page.waitForNavigation({
            timeout: 120000,
            waitUntil: "domcontentloaded",
          });
        } catch {
          return {
            success: false,
            error: "2FA timeout - please complete 2-factor authentication manually",
            requires2FA: true,
          };
        }
      } else {
        return {
          success: false,
          error: "2FA required - please complete 2-factor authentication",
          requires2FA: true,
        };
      }
    }

    // Step 6: Verify login success
    try {
      // Wait a bit for final redirect
      await page.waitForTimeout(2000);

      const finalUrl = page.url();

      // Check if we're logged in
      if (
        finalUrl.includes("myaccount.google.com") ||
        finalUrl.includes("mail.google.com") ||
        finalUrl.includes("accounts.google.com/signin/v2/challenge")
      ) {
        return {
          success: true,
        };
      }

      // Check if we're still on sign-in page (login failed)
      if (finalUrl.includes("accounts.google.com/signin")) {
        return {
          success: false,
          error: "Login failed - please verify your email and password are correct",
        };
      }

      // Default to success if we're no longer on sign-in page
      return {
        success: true,
      };
    } catch (error) {
      return {
        success: false,
        error: "Failed to verify login success",
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Unexpected error during login: ${errorMessage}`,
    };
  } finally {
    // Clear credential from memory
    credential = undefined;
  }
}

/**
 * Navigate to Gmail inbox after successful login
 *
 * @param {Page} page - Playwright page
 * @param {number} timeout - Timeout for navigation (default: 30000ms)
 * @returns {Promise<boolean>} Whether navigation was successful
 */
export async function navigateToGmailInbox(
  page: Page,
  timeout: number = DEFAULT_TIMEOUT,
): Promise<boolean> {
  try {
    await page.goto("https://mail.google.com/mail/u/0/#inbox", {
      timeout,
      waitUntil: "domcontentloaded",
    });

    // Wait for Gmail to load
    await page.waitForTimeout(3000);

    return true;
  } catch {
    return false;
  }
}

/**
 * Check if browser context is logged into Gmail
 *
 * @param {BrowserContext} context - Playwright browser context
 * @returns {Promise<boolean>} Whether the context is logged in
 */
export async function isLoggedIntoGmail(context: BrowserContext): Promise<boolean> {
  let page: Page | undefined;

  try {
    page = await context.newPage();

    await page.goto("https://accounts.google.com", {
      timeout: 10000,
      waitUntil: "domcontentloaded",
    });

    await page.waitForTimeout(2000);

    const url = page.url();

    // If we're redirected to myaccount, we're logged in
    if (url.includes("myaccount.google.com")) {
      return true;
    }

    // If we're still on accounts.google.com but see account selector, we're logged in
    const accountSelector = await page.$('[data-email]');
    if (accountSelector) {
      return true;
    }

    return false;
  } catch {
    return false;
  } finally {
    if (page) {
      await page.close().catch(() => {
        /* ignore close errors */
      });
    }
  }
}
