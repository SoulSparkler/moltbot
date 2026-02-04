/**
 * Example: Gmail Login with 1Password Integration
 *
 * This example demonstrates how to:
 * 1. Verify 1Password CLI is accessible
 * 2. Retrieve credentials securely from 1Password
 * 3. Authenticate with Gmail using browser automation
 * 4. Maintain session via cookies
 * 5. Handle errors gracefully
 *
 * Prerequisites:
 * - 1Password CLI installed (brew install 1password-cli)
 * - 1Password desktop app unlocked
 * - Desktop app integration enabled in 1Password settings
 * - Google app-specific password created and stored in 1Password
 *
 * @example
 * pnpm tsx examples/gmail-login-example.ts
 */

import { chromium } from "playwright-core";
import { isLoggedIntoGmail, loginToGmailWithOP } from "../src/utils/browser-login.js";
import { verifyCredentialHandler } from "../src/utils/credential-handler.js";

async function main() {
  console.log("🔐 Gmail Login Example with 1Password Integration\n");

  // Step 1: Verify 1Password CLI is accessible
  console.log("Step 1: Verifying 1Password CLI...");
  const { opInstalled, signedIn } = await verifyCredentialHandler();

  if (!opInstalled) {
    console.error("❌ 1Password CLI is not installed.");
    console.error("   Install: brew install 1password-cli");
    process.exit(1);
  }

  console.log("✅ 1Password CLI is installed");

  if (!signedIn) {
    console.error("❌ 1Password app is locked or not signed in.");
    console.error("   Please unlock the 1Password desktop app and try again.");
    process.exit(1);
  }

  console.log("✅ 1Password app is unlocked\n");

  // Step 2: Get user input (in real usage, this comes from agent conversation)
  const email = process.env.GMAIL_EMAIL || "user@gmail.com";
  const opVaultPath = process.env.OP_VAULT_PATH || "op://Private/Gmail/app-password";

  console.log(`Step 2: Using credentials for ${email}`);
  console.log(`   Vault path: ${opVaultPath}\n`);

  // Step 3: Launch browser
  console.log("Step 3: Launching browser...");
  const browser = await chromium.launch({
    headless: false, // Set to true for production
  });

  const context = await browser.newContext();
  console.log("✅ Browser launched\n");

  try {
    // Step 4: Check if already logged in
    console.log("Step 4: Checking if already logged in...");
    const alreadyLoggedIn = await isLoggedIntoGmail(context);

    if (alreadyLoggedIn) {
      console.log("✅ Already logged into Gmail\n");
    } else {
      console.log("ℹ️  Not logged in, proceeding with authentication\n");

      // Step 5: Authenticate with Gmail
      console.log("Step 5: Authenticating with Gmail...");
      console.log("   📥 Retrieving credential from 1Password...");

      const result = await loginToGmailWithOP(context, {
        email,
        opVaultPath,
        timeout: 30000,
        wait2FA: true,
      });

      if (!result.success) {
        console.error(`❌ Login failed: ${result.error}`);

        if (result.requires2FA) {
          console.error("   Please complete 2-factor authentication on your device");
        }

        process.exit(1);
      }

      console.log("✅ Successfully authenticated with Gmail");
      console.log("   🔒 Credential cleared from memory\n");
    }

    // Step 6: Verify session persists
    console.log("Step 6: Verifying session persistence...");
    const stillLoggedIn = await isLoggedIntoGmail(context);

    if (stillLoggedIn) {
      console.log("✅ Session persists via browser cookies\n");
    } else {
      console.error("❌ Session not maintained");
      process.exit(1);
    }

    // Step 7: Example - Navigate to Gmail inbox
    console.log("Step 7: Navigating to Gmail inbox...");
    const page = await context.newPage();
    await page.goto("https://mail.google.com/mail/u/0/#inbox", {
      waitUntil: "domcontentloaded",
    });

    console.log("✅ Successfully navigated to Gmail inbox\n");

    // Wait for user to see the result
    console.log("🎉 Success! Browser will remain open for 10 seconds...");
    await page.waitForTimeout(10000);
  } catch (error) {
    console.error("❌ Error:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    // Cleanup
    await context.close();
    await browser.close();
    console.log("\n✅ Browser closed");
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
