# Clawbrowser Skill

Headless browser automation for OpenClaw on Railway using Playwright CLI.

## Quick Start

### 1. Setup Environment Variables (Railway)

```bash
# Required
PLAYWRIGHT_BROWSERS_PATH=/data/playwright-browsers
PLAYWRIGHT_CLI_SESSION_DIR=/data/playwright-sessions
PLAYWRIGHT_DOWNLOADS_PATH=/data/playwright-downloads

# Optional: Google Drive (choose one method)
GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON=<base64-encoded-json>
# OR
GOOGLE_DRIVE_CLIENT_ID=<client-id>
GOOGLE_DRIVE_CLIENT_SECRET=<client-secret>
GOOGLE_DRIVE_REFRESH_TOKEN=<refresh-token>
```

### 2. Test Browser

```bash
railway run bash -c "npx playwright-cli open https://example.com"
railway run bash -c "npx playwright-cli screenshot https://example.com /data/playwright-output/test.png"
```

### 3. Create Persistent Session

```bash
railway run bash -c "npx playwright-cli --session=facebook open https://facebook.com"
```

### 4. Download from Google Drive

```bash
railway run bash -c "node /app/scripts/gdrive-download.js <file-id> /data/workspace/image.jpg"
```

### 5. Upload to Platform

```bash
railway run bash -c "npx playwright-cli --session=facebook setInputFiles '[type=\"file\"]' /data/workspace/image.jpg"
```

## Features

✅ Headless Chromium (Railway-safe)
✅ Persistent sessions (cookies, localStorage)
✅ Google Drive integration (read-only)
✅ Screenshot/trace debugging
✅ Multi-platform support (Facebook, Instagram, LinkedIn, etc.)
✅ No local machine required
✅ Cloud-only operation

## Documentation

- **Setup Guide**: `../../CLAWBROWSER_RAILWAY_SETUP.md`
- **Test Checklist**: `../../CLAWBROWSER_TEST_CHECKLIST.md`
- **Skill Reference**: `SKILL.md`

## Architecture

```
User → Jannetje → Clawbrowser Skill → Playwright CLI → Chromium
                      ↓
                 Google Drive API → Assets
                      ↓
                 Social Platforms
```

## Session Storage

Sessions are stored in `/data/playwright-sessions/<session-name>/`:
- `cookies.json` - Browser cookies
- `localStorage.json` - Local storage
- `sessionStorage.json` - Session storage
- `state.json` - Browser state

## Troubleshooting

### Browser not launching
```bash
railway run bash -c "npx playwright install chromium --with-deps"
```

### Session not persisting
```bash
railway run bash -c "ls -la /data/playwright-sessions/"
```

### File upload failing
```bash
railway run bash -c "ls -la /data/workspace/ && file /data/workspace/image.jpg"
```

### Debugging selectors
```bash
railway run bash -c "npx playwright-cli --session=debug screenshot /data/playwright-output/debug.png"
```

## Security

- ❌ No credentials hardcoded
- ❌ No passwords in logs
- ✅ Service account for Drive (read-only)
- ✅ Bot account for social logins (moonshinespiritbsc@gmail.com)
- ✅ Volume-mounted persistent storage

## Support

For issues or questions, see the main documentation files or Railway logs:

```bash
railway logs --tail 100
```
