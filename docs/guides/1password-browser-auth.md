---
title: "1Password + Browser Authentication Guide"
summary: "Secure credential handling for browser automation using 1Password CLI"
---

# 1Password + Browser Authentication Guide

## Overview

This guide explains how to use 1Password CLI with browser automation for secure credential management in OpenClaw/Moltbot. This approach is designed for:

- **Jannetje bot** running on Railway
- **Any bot** that needs to authenticate with web services (Gmail, GitHub, etc.)
- **Zero-trust credential handling** - no passwords in environment variables or code

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Bot Agent (Jannetje)                                    │
│  ┌──────────────────────────────────────────────────┐  │
│  │ User Request: "Send email to john@example.com"   │  │
│  └──────────────────────────────────────────────────┘  │
│                          ▼                              │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Credential Handler                               │  │
│  │  • Create tmux session                           │  │
│  │  • Execute: op read op://vault/item/field        │  │
│  │  • Capture credential (in memory only)           │  │
│  │  • Kill tmux session                             │  │
│  │  • Return credential                             │  │
│  └──────────────────────────────────────────────────┘  │
│                          ▼                              │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Browser Login Handler                            │  │
│  │  • Navigate to login page                        │  │
│  │  • Fill email field                              │  │
│  │  • Fill password field (from memory)             │  │
│  │  • Handle 2FA                                    │  │
│  │  • Verify login success                          │  │
│  │  • Clear credential from memory                  │  │
│  └──────────────────────────────────────────────────┘  │
│                          ▼                              │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Browser Context                                  │  │
│  │  • Authenticated session (cookies)               │  │
│  │  • Subsequent operations use same session        │  │
│  │  • No credential re-retrieval needed             │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                          ▲
                          │
                  (retrieves secrets)
                          │
┌─────────────────────────────────────────────────────────┐
│ 1Password (Source of Truth)                            │
│  Vault: Private                                         │
│    └── Gmail                                            │
│         ├── username: user@gmail.com                    │
│         └── app-password: [encrypted]                   │
└─────────────────────────────────────────────────────────┘
```

## Features

✅ **Zero-Trust Credentials**
- No passwords in environment variables
- No passwords in code or configuration files
- No passwords in logs or error messages

✅ **Secure Retrieval**
- Credentials stored encrypted in 1Password
- Retrieved at runtime via `op` CLI
- Executed in isolated tmux sessions
- Kept in memory only (never written to disk)

✅ **Session Persistence**
- Browser cookies maintain authenticated sessions
- No need to re-retrieve credentials for subsequent operations
- Session state managed by browser context

✅ **Error Handling**
- User-friendly error messages
- No credential or vault path exposure
- Graceful handling of 2FA, network errors, and timeouts

## Prerequisites

### Local Development

1. **1Password CLI** installed:
   ```bash
   # macOS
   brew install 1password-cli

   # Linux (Debian/Ubuntu)
   curl -sS https://downloads.1password.com/linux/keys/1password.asc | \
     sudo gpg --dearmor --output /usr/share/keyrings/1password-archive-keyring.gpg
   echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/$(dpkg --print-architecture) stable main" | \
     sudo tee /etc/apt/sources.list.d/1password.list
   sudo apt update && sudo apt install 1password-cli
   ```

2. **1Password Desktop App Integration**:
   - Open 1Password → Settings → Developer
   - Enable "Integrate with 1Password CLI"
   - Enable "Connect with 1Password CLI"

3. **Sign in**:
   ```bash
   op signin my.1password.com
   ```

4. **Verify**:
   ```bash
   op whoami
   ```

### Railway Deployment

The Dockerfile already includes:
- ✅ 1Password CLI installation
- ✅ tmux for isolated sessions
- ✅ Playwright for browser automation

You only need to set environment variables:

```bash
# Required
OP_ACCOUNT=my.1password.com

# Choose authentication method:
# Option 1: Service Account (Recommended)
OP_SERVICE_ACCOUNT_TOKEN=ops_...

# Option 2: Connect Server
OP_CONNECT_HOST=https://connect.example.com
OP_CONNECT_TOKEN=...
```

See [Railway Secrets Setup](../railway-secrets.md) for detailed instructions.

## Setup Guide

### Step 1: Create App-Specific Password

**NEVER use your main account password!**

For Gmail/Google:
1. Go to https://myaccount.google.com/security
2. Enable 2-Step Verification (required)
3. Go to "App Passwords"
4. Create new app password for "Mail"
5. Copy the 16-character password

For other services:
- **GitHub**: Personal Access Tokens
- **Slack**: App tokens
- **Twitter**: API keys
- etc.

### Step 2: Store in 1Password

1. Create new item in 1Password:
   - Type: Email or Login
   - Title: "Gmail - Jannetje Bot"
   - Username: your-email@gmail.com
   - Password: paste the app password
   - Vault: Private (or your preferred vault)

2. Test retrieval:
   ```bash
   op read "op://Private/Gmail - Jannetje Bot/password"
   ```

### Step 3: Use in Code

```typescript
import { chromium } from "playwright-core";
import { loginToGmailWithOP } from "./utils/browser-login.js";
import { verifyCredentialHandler } from "./utils/credential-handler.js";

async function sendEmail() {
  // 1. Verify 1Password is accessible
  const { opInstalled, signedIn } = await verifyCredentialHandler();

  if (!opInstalled || !signedIn) {
    throw new Error("1Password CLI not accessible");
  }

  // 2. Launch browser
  const browser = await chromium.launch();
  const context = await browser.newContext();

  // 3. Authenticate with Gmail
  const result = await loginToGmailWithOP(context, {
    email: "user@gmail.com",
    opVaultPath: "op://Private/Gmail - Jannetje Bot/password"
  });

  if (!result.success) {
    throw new Error(`Login failed: ${result.error}`);
  }

  // 4. Now authenticated - send email
  const page = await context.newPage();
  await page.goto("https://mail.google.com");
  // ... send email logic ...

  // 5. Send another email (session persists!)
  await page.goto("https://mail.google.com/mail/u/0/#compose");
  // ... send another email ...

  // 6. Cleanup
  await context.close();
  await browser.close();
}
```

## API Reference

### Credential Handler

#### `verifyOPAccess(): Promise<boolean>`

Verify 1Password CLI is accessible and signed in.

```typescript
const isSignedIn = await verifyOPAccess();
if (!isSignedIn) {
  console.error("Please unlock 1Password");
}
```

#### `retrieveCredentialFromOP(opPath: string): Promise<string>`

Retrieve credential from 1Password vault.

```typescript
const password = await retrieveCredentialFromOP("op://Private/Gmail/password");
// Use password immediately
// Password is automatically cleared from memory
```

**Parameters:**
- `opPath`: 1Password vault path (e.g., `op://Private/Gmail/password`)

**Returns:** Credential value (in memory only)

**Throws:**
- `Error` if 1Password CLI not installed
- `Error` if 1Password app is locked
- `Error` if credential not found

#### `verifyCredentialHandler(): Promise<{ opInstalled: boolean; signedIn: boolean }>`

Verify credential handler is working properly.

```typescript
const { opInstalled, signedIn } = await verifyCredentialHandler();
console.log(`OP installed: ${opInstalled}, Signed in: ${signedIn}`);
```

### Browser Login

#### `loginToGmailWithOP(context: BrowserContext, options: GmailLoginOptions): Promise<LoginResult>`

Login to Gmail using 1Password credentials.

```typescript
const result = await loginToGmailWithOP(context, {
  email: "user@gmail.com",
  opVaultPath: "op://Private/Gmail/password",
  timeout: 30000,      // optional, default: 30000ms
  wait2FA: true        // optional, default: true
});

if (result.success) {
  console.log("Logged in successfully!");
} else {
  console.error(`Login failed: ${result.error}`);
  if (result.requires2FA) {
    console.log("Please complete 2FA");
  }
}
```

**Options:**
- `email`: Email address to use for login
- `opVaultPath`: 1Password vault path for password
- `timeout`: Timeout for login operations (default: 30000ms)
- `wait2FA`: Whether to wait for 2FA completion (default: true)

**Returns:** `LoginResult`
- `success: boolean` - Whether login was successful
- `error?: string` - Error message if login failed
- `requires2FA?: boolean` - Whether 2FA is required

#### `navigateToGmailInbox(page: Page, timeout?: number): Promise<boolean>`

Navigate to Gmail inbox after successful login.

```typescript
const success = await navigateToGmailInbox(page);
if (success) {
  console.log("Navigated to inbox");
}
```

#### `isLoggedIntoGmail(context: BrowserContext): Promise<boolean>`

Check if browser context is logged into Gmail.

```typescript
const loggedIn = await isLoggedIntoGmail(context);
if (loggedIn) {
  console.log("Already logged in, skip authentication");
}
```

## Examples

### Example 1: Simple Email Send

```typescript
import { chromium } from "playwright-core";
import { loginToGmailWithOP } from "./utils/browser-login.js";

async function sendSimpleEmail() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  try {
    // Authenticate
    await loginToGmailWithOP(context, {
      email: "jannetje@example.com",
      opVaultPath: "op://Private/Jannetje Gmail/password"
    });

    // Navigate to compose
    const page = await context.newPage();
    await page.goto("https://mail.google.com/mail/u/0/#compose");

    // Fill email form
    await page.fill('[name="to"]', 'recipient@example.com');
    await page.fill('[name="subject"]', 'Hello from Jannetje');
    await page.fill('[role="textbox"]', 'This is an automated email!');

    // Send
    await page.click('button[aria-label="Send"]');
    console.log("✅ Email sent!");
  } finally {
    await context.close();
    await browser.close();
  }
}
```

### Example 2: Multiple Emails (Session Persistence)

```typescript
async function sendMultipleEmails(recipients: string[]) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  try {
    // Authenticate once
    await loginToGmailWithOP(context, {
      email: "jannetje@example.com",
      opVaultPath: "op://Private/Jannetje Gmail/password"
    });

    // Send to multiple recipients (session persists!)
    for (const recipient of recipients) {
      const page = await context.newPage();
      await page.goto("https://mail.google.com/mail/u/0/#compose");

      await page.fill('[name="to"]', recipient);
      await page.fill('[name="subject"]', 'Bulk message');
      await page.fill('[role="textbox"]', `Hello ${recipient}!`);
      await page.click('button[aria-label="Send"]');

      console.log(`✅ Sent to ${recipient}`);
      await page.close();
    }
  } finally {
    await context.close();
    await browser.close();
  }
}
```

### Example 3: With Error Handling

```typescript
async function robustEmailSend() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  try {
    // Verify 1Password first
    const { opInstalled, signedIn } = await verifyCredentialHandler();

    if (!opInstalled) {
      throw new Error("1Password CLI not installed");
    }

    if (!signedIn) {
      throw new Error("1Password app is locked. Please unlock it.");
    }

    // Check if already logged in
    const alreadyLoggedIn = await isLoggedIntoGmail(context);

    if (!alreadyLoggedIn) {
      const result = await loginToGmailWithOP(context, {
        email: "jannetje@example.com",
        opVaultPath: "op://Private/Jannetje Gmail/password",
        timeout: 30000,
        wait2FA: true
      });

      if (!result.success) {
        if (result.requires2FA) {
          throw new Error("2FA required. Please complete authentication.");
        }
        throw new Error(`Login failed: ${result.error}`);
      }
    }

    // Send email
    const page = await context.newPage();
    await page.goto("https://mail.google.com/mail/u/0/#compose");
    // ... send email logic ...

    console.log("✅ Email sent successfully!");
  } catch (error) {
    console.error("❌ Error:", error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}
```

## Security Best Practices

### ✅ DO

1. **Always use app-specific passwords** (never main account passwords)
2. **Store credentials in 1Password** as the single source of truth
3. **Retrieve credentials at runtime** using `op` CLI
4. **Clear credentials from memory** after use (automatic)
5. **Use browser session cookies** for persistence
6. **Verify 1Password access** before attempting retrieval
7. **Handle errors gracefully** without exposing credentials
8. **Audit vault access** regularly
9. **Rotate credentials** quarterly or when exposed

### ❌ DON'T

1. **Store passwords in environment variables**
2. **Commit credentials to Git**
3. **Log credential values** to console or files
4. **Store credentials in browser localStorage**
5. **Cache credentials** across operations
6. **Use main account passwords** for automation
7. **Share credentials** via chat or email
8. **Expose vault paths** in error messages

## Troubleshooting

### "1Password CLI (op) is not installed"

**Local:**
```bash
brew install 1password-cli  # macOS
# or follow Linux installation steps above
```

**Railway:** Dockerfile already includes it. Verify build logs.

### "1Password app is locked"

**Local:** Unlock 1Password desktop app

**Railway:** Using desktop app integration in headless environment
- Solution: Use service account token instead
- Set `OP_SERVICE_ACCOUNT_TOKEN` in Railway

### "account is not signed in"

**Local:**
```bash
op signin my.1password.com
```

**Railway:** Missing authentication
- Verify `OP_SERVICE_ACCOUNT_TOKEN` is set
- Check token has vault access permissions

### "Credential not found in 1Password"

Verify vault path:
```bash
# Test retrieval
op read "op://VaultName/ItemName/FieldName"

# List vaults
op vault list

# List items
op item list --vault Private
```

### Login fails but credential is correct

1. **Check for 2FA requirement**: Google may require 2FA even with app passwords
2. **Verify app password is fresh**: Create a new one if it's old
3. **Check account security settings**: Google may block "less secure apps"
4. **Try with headless: false**: See what's happening in the browser

### Session doesn't persist

1. **Check browser context**: Ensure same context is used for all operations
2. **Verify cookies**: Context should maintain cookies automatically
3. **Don't create new context**: Reuse the authenticated context

## Resources

- [1Password CLI Documentation](https://developer.1password.com/docs/cli/)
- [Railway Secrets Setup](../railway-secrets.md)
- [Credential Security Policy](../security/credential-policy.md)
- [Playwright Documentation](https://playwright.dev/)
- [Google App Passwords](https://myaccount.google.com/apppasswords)

## Support

For issues:
1. Check Railway logs for errors
2. Verify `op whoami` works: `railway run op whoami`
3. Test credential retrieval: `railway run op read "op://vault/item/field"`
4. Run example: `pnpm tsx examples/gmail-login-example.ts`
5. Review credential policy: [docs/security/credential-policy.md](../security/credential-policy.md)
