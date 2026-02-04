# Railway Secrets Setup for 1Password Integration

## Overview

This document describes how to securely manage credentials for your Moltbot/OpenClaw deployment on Railway using 1Password CLI.

## Security Model

**Zero-Trust Credentials Policy**:
- **NEVER** store passwords in Railway environment variables
- **NEVER** commit credentials to code or configuration files
- **ALWAYS** use 1Password as the source of truth for all secrets
- **ALWAYS** retrieve credentials at runtime via `op` CLI
- **ALWAYS** keep credentials in memory only (never write to disk or logs)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Railway Container                                           │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Moltbot Gateway                                      │  │
│  │  ├── Environment: OP_ACCOUNT=my.1password.com       │  │
│  │  ├── 1Password CLI: op read op://vault/item/field   │  │
│  │  └── Credential Handler: retrieve → use → discard   │  │
│  └──────────────────────────────────────────────────────┘  │
│                          ▲                                  │
│                          │                                  │
│                  (authenticated via                         │
│                   service account or                        │
│                   connect token)                            │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 1Password (Cloud)                                           │
│  Vault: Private                                             │
│    └── Email Accounts                                       │
│         └── Gmail                                           │
│              ├── username: user@gmail.com                   │
│              └── app-password: [encrypted]                  │
└─────────────────────────────────────────────────────────────┘
```

## Required Railway Environment Variables

### Minimal Setup (1Password Account Only)

In your Railway dashboard, set **only** this variable:

| Variable Name | Value | Description |
|--------------|-------|-------------|
| `OP_ACCOUNT` | `my.1password.com` | Your 1Password account signin address |

**IMPORTANT**: Do **NOT** set these variables:
- ❌ `GMAIL_PASSWORD`
- ❌ `GOOGLE_APP_PASSWORD`
- ❌ `EMAIL_PASSWORD`
- ❌ Any other credential values

These credentials live **encrypted in 1Password**, not in Railway environment variables.

### Authentication Options for Railway

Railway is a headless environment, so you need one of these authentication methods:

#### Option 1: Service Account (Recommended for Production)

1. Create a 1Password service account:
   - Go to 1Password → Settings → Developer → Service Accounts
   - Create a new service account with read access to your vault
   - Copy the service account token

2. Add to Railway:
   ```bash
   OP_SERVICE_ACCOUNT_TOKEN=ops_...your_token_here
   ```

3. The `op` CLI will automatically authenticate using this token.

#### Option 2: Connect Server Token (For Teams)

1. Set up 1Password Connect:
   - Deploy 1Password Connect server
   - Create a Connect token with vault access

2. Add to Railway:
   ```bash
   OP_CONNECT_HOST=https://your-connect-server.com
   OP_CONNECT_TOKEN=your-connect-token
   ```

#### Option 3: Account Token (Development Only)

⚠️ **Not recommended for production** - requires manual signin

1. Sign in locally:
   ```bash
   op signin my.1password.com
   ```

2. Get session token:
   ```bash
   op account get
   ```

3. Add to Railway (expires after 30 minutes of inactivity):
   ```bash
   OP_SESSION_my=token_here
   ```

## Local Development Setup

### Prerequisites

1. **Install 1Password CLI**:
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

2. **Enable Desktop App Integration**:
   - Open 1Password desktop app
   - Go to Settings → Developer
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

### Creating App-Specific Passwords (Google/Gmail)

**NEVER use your main Google password for automation!**

1. Go to https://myaccount.google.com/security
2. Enable 2-Step Verification (required)
3. Go to App Passwords
4. Create a new app password for "Mail"
5. Copy the 16-character password (looks like: `abcd efgh ijkl mnop`)
6. **Store in 1Password**:
   - Create new item: "Email" or "Login"
   - Title: "Gmail - Jannetje Bot"
   - Username: your-email@gmail.com
   - Password: paste the app password
   - Vault: Private (or your preferred vault)

### Storing Credentials in 1Password

1. **Create structured vault paths**:
   ```
   op://Private/Gmail/username        → your-email@gmail.com
   op://Private/Gmail/app-password    → abcd efgh ijkl mnop
   ```

2. **Test retrieval locally**:
   ```bash
   op read "op://Private/Gmail/username"
   op read "op://Private/Gmail/app-password"
   ```

3. **NEVER log the values**:
   ```bash
   # ❌ WRONG - exposes credential in terminal history
   echo $(op read "op://Private/Gmail/app-password")

   # ✅ CORRECT - use directly in code
   PASSWORD=$(op read "op://Private/Gmail/app-password")
   # ... use PASSWORD in script, never echo it
   ```

## Using Credentials in Code

### TypeScript/JavaScript (Moltbot)

```typescript
import { retrieveCredentialFromOP } from "./utils/credential-handler.js";
import { loginToGmailWithOP } from "./utils/browser-login.js";

async function sendEmail(context: BrowserContext, email: string) {
  // Retrieve credential securely
  const result = await loginToGmailWithOP(context, {
    email: email,
    opVaultPath: "op://Private/Gmail/app-password"
  });

  if (!result.success) {
    throw new Error(`Login failed: ${result.error}`);
  }

  // Now authenticated - send email
  // Credential is already cleared from memory
}
```

### Key Security Principles

1. **Retrieve on-demand**:
   ```typescript
   // ✅ CORRECT - retrieve when needed
   const password = await retrieveCredentialFromOP(path);
   await usePassword(password);
   // password cleared from memory automatically

   // ❌ WRONG - storing credential
   this.storedPassword = await retrieveCredentialFromOP(path);
   ```

2. **Never log credentials**:
   ```typescript
   // ✅ CORRECT
   console.log("Authenticating with Gmail...");

   // ❌ WRONG
   console.log(`Password: ${password}`);
   ```

3. **Use session cookies for persistence**:
   ```typescript
   // After successful login, browser context maintains session via cookies
   // No need to re-login for subsequent operations
   await loginToGmailWithOP(context, options);

   // Session persists in context
   await sendEmail(context, recipient, subject, body);
   await sendEmail(context, anotherRecipient, subject, body); // reuses session
   ```

## Railway Deployment Workflow

### 1. Local Testing

```bash
# Test credential retrieval
op read "op://Private/Gmail/app-password"

# Test login locally
pnpm openclaw test:gmail-login
```

### 2. Configure Railway Secrets

In Railway dashboard → Variables:

```bash
# Required
OP_ACCOUNT=my.1password.com

# Choose one authentication method:

# Option 1: Service Account (Recommended)
OP_SERVICE_ACCOUNT_TOKEN=ops_...

# Option 2: Connect Server
OP_CONNECT_HOST=https://connect.your-domain.com
OP_CONNECT_TOKEN=...

# Option 3: Session Token (Dev only, expires)
OP_SESSION_my=...
```

### 3. Deploy and Verify

```bash
# Deploy
railway up

# Check logs
railway logs

# Verify op CLI works
railway run op whoami
```

### 4. Test Credential Retrieval

In Railway logs, you should see:

```
✅ 1Password CLI installed: 2.x.x
✅ Authenticated as: user@example.com
✅ Retrieved credential from op://Private/Gmail/app-password
🔒 Credential cleared from memory
```

**You should NEVER see the actual credential value in logs!**

## Troubleshooting

### "1Password app is locked"

**Local**: Unlock 1Password desktop app

**Railway**: You're using desktop app integration in headless environment
- Solution: Use service account token instead
- Set `OP_SERVICE_ACCOUNT_TOKEN` in Railway

### "account is not signed in"

**Local**: Run `op signin my.1password.com`

**Railway**: Missing authentication
- Verify `OP_SERVICE_ACCOUNT_TOKEN` is set
- Check token has vault access permissions

### "Credential not found in 1Password"

**Verify vault path syntax**:
```bash
# Correct format
op://VaultName/ItemName/FieldName

# Examples
op://Private/Gmail/app-password
op://Work/Slack/api-token
op://Personal/Database/password
```

**List your vaults**:
```bash
op vault list
```

**List items in vault**:
```bash
op item list --vault Private
```

### "Failed to retrieve credential"

**Check permissions**:
```bash
# Service account must have read access to the vault
op vault user list Private
```

**Test manually in Railway**:
```bash
railway run op read "op://Private/Gmail/app-password"
```

### Credential appears in logs

**IMMEDIATELY**:
1. Rotate the credential (create new app password)
2. Update 1Password vault with new value
3. Fix the logging code
4. Verify credential is never logged again

## Best Practices

### ✅ DO

1. **Use app-specific passwords** for services that support them
2. **Store credentials in 1Password** as the single source of truth
3. **Retrieve credentials at runtime** using `op` CLI
4. **Clear credentials from memory** after use
5. **Use browser session cookies** for persistence
6. **Audit vault access** regularly
7. **Rotate credentials** quarterly or when exposed

### ❌ DON'T

1. **Store passwords in environment variables** (Railway or .env files)
2. **Commit credentials to Git** (even in .gitignore files)
3. **Log credential values** to console or files
4. **Store credentials in browser localStorage** or sessionStorage
5. **Cache credentials** across multiple operations
6. **Use main account passwords** (always use app-specific passwords)
7. **Share credentials** via chat or email

## Advanced: Credential Rotation

### Automated Rotation (Recommended)

1. **Set up rotation in 1Password**:
   - 1Password can auto-rotate certain service passwords
   - Configure rotation schedule in item settings

2. **Handle rotation in code**:
   ```typescript
   // Credentials are fetched fresh on each operation
   // No code changes needed for rotation
   const password = await retrieveCredentialFromOP(path);
   ```

### Manual Rotation

1. **Create new app password** in service (Google, etc.)
2. **Update 1Password item** with new value
3. **No deployment needed** - code retrieves latest value
4. **Revoke old password** after verification

## Security Checklist

Before deploying to Railway, verify:

- [ ] 1Password CLI is installed in Dockerfile
- [ ] `OP_ACCOUNT` is set in Railway variables
- [ ] Service account token or Connect token is configured
- [ ] No passwords are in Railway variables
- [ ] No passwords are committed to Git
- [ ] Credentials are never logged
- [ ] App-specific passwords are used (not main passwords)
- [ ] 2FA is enabled on all accounts
- [ ] Credential retrieval is tested locally
- [ ] Session persistence uses cookies only
- [ ] Vault access is audited regularly

## Support

For 1Password CLI issues, see:
- Documentation: https://developer.1password.com/docs/cli/
- Get started: https://developer.1password.com/docs/cli/get-started/
- Service accounts: https://developer.1password.com/docs/service-accounts/

For Moltbot/OpenClaw credential issues:
- Check Railway logs for error messages
- Verify `op whoami` works in Railway: `railway run op whoami`
- Test credential retrieval: `railway run op read "op://vault/item/field"`
