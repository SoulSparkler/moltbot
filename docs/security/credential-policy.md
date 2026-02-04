---
summary: "Security policy for credential handling in OpenClaw agents"
title: "Credential Security Policy"
---

# Credential Security Policy

## Overview

This document defines the security policy for credential handling in OpenClaw agents, particularly for bots deployed on Railway or other cloud platforms.

## Core Principles

### Zero-Trust Credentials

OpenClaw agents follow a **zero-trust credential policy**:

1. **Never store passwords** in environment variables, configuration files, or code
2. **Always use 1Password** as the single source of truth for secrets
3. **Retrieve credentials on-demand** via `op` CLI in isolated tmux sessions
4. **Keep credentials in memory only** during active operations
5. **Clear credentials immediately** after use
6. **Use session persistence** via browser cookies, not stored credentials

### Defense in Depth

Multiple layers protect credentials:

- **Encryption at rest**: 1Password vault (AES-256)
- **Encryption in transit**: HTTPS for 1Password API
- **Isolated execution**: tmux sessions for `op` commands
- **Memory-only handling**: credentials never written to disk or logs
- **Session-based persistence**: browser cookies for authenticated sessions
- **Automatic cleanup**: tmux sessions killed after credential retrieval

## Agent Responsibilities

### What Agents MUST DO

1. **Guide users to create app-specific passwords**
   - For Gmail/Google: https://myaccount.google.com/apppasswords
   - For GitHub: Personal Access Tokens
   - For Slack: App tokens (not workspace tokens)
   - Never ask for main account passwords

2. **Instruct users to store credentials in 1Password**
   - Provide clear vault path examples: `op://Private/Gmail/app-password`
   - Explain the benefits of centralized secret management
   - Verify credentials are stored before proceeding

3. **Retrieve credentials using the credential handler**
   ```typescript
   import { retrieveCredentialFromOP } from "./utils/credential-handler.js";

   const password = await retrieveCredentialFromOP("op://Private/Gmail/app-password");
   // Use password immediately
   await authenticate(password);
   // Password is automatically cleared
   ```

4. **Maintain session state via browser cookies**
   - After successful login, browser context maintains session
   - No need to re-retrieve credentials for subsequent operations
   - Session cookies are handled by browser context, not manually stored

5. **Handle errors gracefully without exposing vault paths**
   ```typescript
   // ✅ CORRECT
   throw new Error("Failed to retrieve credential from 1Password. Please verify the vault path and ensure the 1Password app is unlocked.");

   // ❌ WRONG
   throw new Error(`Failed to retrieve op://Private/Gmail/app-password`);
   ```

### What Agents MUST NEVER DO

1. **Never ask users to paste passwords into chat**
   ```
   ❌ "Please paste your Gmail password here"
   ✅ "Please store your Gmail app password in 1Password at op://Private/Gmail/app-password"
   ```

2. **Never store credentials in files**
   ```typescript
   // ❌ WRONG
   fs.writeFileSync('password.txt', password);
   memory.save('password', password);

   // ✅ CORRECT
   const password = await retrieveCredentialFromOP(path);
   await usePassword(password);
   // password cleared from memory
   ```

3. **Never log credential values**
   ```typescript
   // ❌ WRONG
   console.log(`Using password: ${password}`);
   logger.debug({ password });

   // ✅ CORRECT
   console.log("Authenticating with Gmail...");
   logger.debug({ action: "gmail_auth", status: "in_progress" });
   ```

4. **Never accept passwords through any channel other than 1Password**
   - Not via chat messages
   - Not via command-line arguments
   - Not via environment variables
   - Only via `op read` from 1Password vault

5. **Never store credentials in browser localStorage or sessionStorage**
   ```typescript
   // ❌ WRONG
   localStorage.setItem('password', password);
   sessionStorage.setItem('token', token);

   // ✅ CORRECT
   // Cookies are automatically managed by browser context
   await context.newPage(); // session persists via cookies
   ```

## Workflow for Email/Gmail Tasks

When a user asks to send email, the agent should follow this workflow:

### 1. Verify Prerequisites

```typescript
// Check if 1Password CLI is accessible
const { opInstalled, signedIn } = await verifyCredentialHandler();

if (!opInstalled) {
  throw new Error("1Password CLI is not installed. Please install it from https://developer.1password.com/docs/cli/");
}

if (!signedIn) {
  throw new Error("1Password app is locked. Please unlock it and try again.");
}
```

### 2. Guide User to Create App Password

```
"To send email securely, you'll need to create a Google app-specific password:

1. Go to https://myaccount.google.com/security
2. Enable 2-Step Verification (if not already enabled)
3. Go to 'App Passwords'
4. Create a new app password for 'Mail'
5. Copy the 16-character password

Store this password in 1Password:
- Create a new item (type: Email or Login)
- Title: Gmail - Bot Name
- Username: your-email@gmail.com
- Password: paste the app password
- Vault: Private (or your preferred vault)

What is your Gmail email address?"
```

### 3. Request Vault Path

```
"What is the 1Password vault path for your Gmail app password?

Example: op://Private/Gmail/app-password

You can find this by:
1. Opening 1Password
2. Finding your Gmail item
3. Right-clicking the password field
4. Selecting 'Copy Secret Reference'
"
```

### 4. Retrieve Credential and Authenticate

```typescript
try {
  const result = await loginToGmailWithOP(context, {
    email: userEmail,
    opVaultPath: userVaultPath
  });

  if (!result.success) {
    if (result.requires2FA) {
      console.log("2FA required. Please complete authentication on your device.");
      // Wait for user to complete 2FA
    } else {
      throw new Error(result.error);
    }
  }

  console.log("✅ Successfully authenticated with Gmail");
} catch (error) {
  // Handle error without exposing credential
  console.error("Authentication failed:", error.message);
}
```

### 5. Use Authenticated Session

```typescript
// After successful login, session persists in browser context
await sendEmail(context, recipient, subject, body);

// No need to re-authenticate for subsequent emails
await sendEmail(context, anotherRecipient, subject, body);

// Session maintained via browser cookies
```

## Error Handling Best Practices

### User-Facing Error Messages

Always sanitize error messages to prevent credential or vault path exposure:

```typescript
function sanitizeError(error: Error): string {
  let message = error.message;

  // Remove vault paths
  message = message.replace(/op:\/\/[^\s]+/g, "[vault path]");

  // Remove credential values (patterns that look like passwords/tokens)
  message = message.replace(/\b[A-Za-z0-9]{16,}\b/g, "[redacted]");

  // Remove email addresses if they appear with passwords
  message = message.replace(/\b[\w.-]+@[\w.-]+\.\w+\b.*password/gi, "[redacted]");

  return message;
}
```

### Common Error Scenarios

| Error | User Message | Action |
|-------|-------------|--------|
| 1Password app locked | "1Password app is locked. Please unlock it on your machine and try again." | Wait for user to unlock |
| Credential not found | "Could not find credential in 1Password. Please verify the vault path." | Ask user to check vault path |
| Invalid vault path | "Invalid vault path format. Please use format: op://VaultName/ItemName/FieldName" | Guide user to correct format |
| Network timeout | "Failed to connect to 1Password. Please check your internet connection." | Retry or ask user to check connection |
| 2FA required | "Google requires 2-factor authentication. Please complete it on your device." | Wait for user action |
| Session expired | "Session expired. Re-authenticating..." | Automatically re-authenticate |

## Testing and Verification

### Local Testing Checklist

Before deploying, verify:

- [ ] `op` CLI is installed: `op --version`
- [ ] 1Password desktop app integration is enabled
- [ ] Agent can retrieve test credential: `op read "op://Private/test/password"`
- [ ] Credential handler creates and destroys tmux sessions correctly
- [ ] Credentials are never logged to console or files
- [ ] Browser login completes successfully
- [ ] Session persists across multiple operations
- [ ] Error messages don't expose vault paths or credentials

### Railway/Production Checklist

Before production deployment:

- [ ] 1Password CLI is installed in Docker image
- [ ] `OP_ACCOUNT` is set in environment variables
- [ ] Service account token or Connect token is configured
- [ ] No passwords are in environment variables
- [ ] No passwords are committed to Git
- [ ] Credentials are retrieved at runtime only
- [ ] tmux is installed for isolated `op` sessions
- [ ] Error handling prevents credential exposure
- [ ] Session cookies provide persistence (not stored credentials)

## Compliance and Auditing

### Audit Log Requirements

All credential operations must be logged (without exposing the credential):

```typescript
// ✅ CORRECT
logger.info({
  action: "credential_retrieved",
  vault: "[redacted]",
  timestamp: Date.now(),
  success: true
});

// ❌ WRONG
logger.info({
  action: "credential_retrieved",
  vault: "op://Private/Gmail/app-password",
  credential: password,
  timestamp: Date.now()
});
```

### Retention Policy

- **Credentials in memory**: Cleared immediately after use
- **Tmux sessions**: Killed within 5 seconds of credential retrieval
- **Browser sessions**: Maintained as long as context exists, cleared on context close
- **Audit logs**: Retained indefinitely (no credential values)

### Access Control

- **1Password vault access**: Restricted to service account or Connect token
- **Railway environment variables**: Accessible only to deployment admins
- **Code repository**: No credentials ever committed
- **Logs**: No credentials ever logged

## Security Incident Response

### If a Credential is Exposed

1. **Immediately rotate the credential**:
   - Create new app password in service
   - Update 1Password vault with new value
   - Revoke old credential in service

2. **Audit the exposure**:
   - Check all logs for credential exposure
   - Identify how the credential was exposed
   - Document the incident

3. **Fix the vulnerability**:
   - Update code to prevent future exposure
   - Add tests to verify fix
   - Deploy updated code

4. **Notify affected parties**:
   - If credential was exposed in logs, notify users
   - Document remediation steps taken

### If 1Password is Compromised

1. **Rotate all credentials** stored in 1Password
2. **Create new service account** or Connect token
3. **Update Railway environment variables**
4. **Audit all agent sessions** for unauthorized access
5. **Review 1Password audit logs** for suspicious activity

## Resources

- [1Password CLI Documentation](https://developer.1password.com/docs/cli/)
- [1Password Service Accounts](https://developer.1password.com/docs/service-accounts/)
- [Railway Secrets Setup](../railway-secrets.md)
- [Browser Login Implementation](../../src/utils/browser-login.ts)
- [Credential Handler Implementation](../../src/utils/credential-handler.ts)

## Support

For questions or security concerns:

- Check Railway logs for error details
- Verify `op whoami` works: `railway run op whoami`
- Test credential retrieval: `railway run op read "op://vault/item/field"`
- Review audit logs for suspicious activity
- Contact security team if credential exposure is suspected
