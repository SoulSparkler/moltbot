---
name: clawbrowser
description: "Headless browser automation using Playwright CLI. Supports login flows, form filling, image uploads from Google Drive, posting content, and social platform automation on Railway."
metadata: {"openclaw":{"emoji":"🌐","requires":{"bins":["npx"]}}}
---

# Clawbrowser Skill

Headless browser automation for Railway using Playwright CLI. Designed for cloud-only operation without local machine access or UI.

## Configuration

Persistent sessions are stored in: `/data/playwright-sessions`
Downloads directory: `/data/playwright-downloads`
Output (screenshots, traces): `/data/playwright-output`

## Environment Variables

- `PLAYWRIGHT_CLI_SESSION_DIR`: Session storage directory (default: `/data/playwright-sessions`)
- `PLAYWRIGHT_BROWSERS_PATH`: Browser binaries location (default: `/data/playwright-browsers`)
- `PLAYWRIGHT_DOWNLOADS_PATH`: Download directory (default: `/data/playwright-downloads`)

## Usage

### Basic Navigation

```bash
# Open a URL
npx playwright-cli open https://example.com

# Take a screenshot
npx playwright-cli screenshot https://example.com output.png
```

### Persistent Sessions

Sessions preserve cookies, localStorage, and authentication state across runs.

```bash
# Use a named session (auto-creates if doesn't exist)
npx playwright-cli --session=google-account open https://accounts.google.com

# List available sessions
ls -la /data/playwright-sessions/
```

### Social Platform Automation

```bash
# Login to a platform (session persists)
npx playwright-cli --session=facebook open https://facebook.com

# Navigate and interact
npx playwright-cli --session=facebook click 'text=Create Post'
npx playwright-cli --session=facebook fill '[aria-label="What\'s on your mind?"]' 'My post content'

# Upload image (from Google Drive download)
npx playwright-cli --session=facebook setInputFiles '[type="file"]' /data/workspace/image.jpg

# Click publish
npx playwright-cli --session=facebook click 'text=Post'
```

### Screenshots and Debugging

```bash
# Take a screenshot for debugging
npx playwright-cli --session=myapp screenshot /data/playwright-output/debug.png

# Generate trace for failed operations
npx playwright-cli --trace on --session=myapp open https://example.com
```

## Railway-Specific Notes

- **Headless only**: No GUI or VNC available
- **Sandbox disabled**: Uses `--no-sandbox` and `--disable-dev-shm-usage` flags (required for Docker)
- **Persistent storage**: All sessions/downloads/output use `/data` volume
- **Memory limits**: Single worker, optimized for Railway's constraints
- **Network**: Full internet access for logins and API calls

## Security

- ❌ No credentials hardcoded or stored in repo
- ❌ No passwords in logs
- ✅ Session cookies stored in `/data/playwright-sessions` (volume-mounted)
- ✅ Google account: moonshinespiritbsc@gmail.com (bot account, pre-authenticated on platforms)

## Google Drive Integration

Images and documents are downloaded from Google Drive to `/data/workspace` before upload:

```bash
# Download from Google Drive (via helper script)
node /app/scripts/gdrive-download.js <fileId> /data/workspace/image.jpg

# Upload to platform
npx playwright-cli --session=instagram setInputFiles '[type="file"]' /data/workspace/image.jpg
```

## Session Management

### Create a new session

```bash
npx playwright-cli --session=new-account open https://platform.com
```

### Reset a session (logout/clear cookies)

```bash
rm -rf /data/playwright-sessions/new-account
```

### List all sessions

```bash
ls -la /data/playwright-sessions/
```

## Troubleshooting

### Browser not launching

Check Chromium installation:
```bash
npx playwright install chromium --with-deps
```

### Session not persisting

Verify session directory exists and is writable:
```bash
ls -la /data/playwright-sessions/
```

### Screenshots failing

Ensure output directory exists:
```bash
mkdir -p /data/playwright-output
```

## Platform-Specific Examples

### Facebook

```bash
# Login (first time)
npx playwright-cli --session=fb open https://facebook.com

# Post with image
npx playwright-cli --session=fb click 'text=Create Post'
npx playwright-cli --session=fb fill '[aria-label="What\'s on your mind?"]' 'Post text'
npx playwright-cli --session=fb setInputFiles '[type="file"]' /data/workspace/photo.jpg
npx playwright-cli --session=fb click '[aria-label="Post"]'
```

### Instagram

```bash
# Login
npx playwright-cli --session=ig open https://instagram.com

# Create post
npx playwright-cli --session=ig click '[aria-label="New post"]'
npx playwright-cli --session=ig setInputFiles '[type="file"]' /data/workspace/photo.jpg
npx playwright-cli --session=ig click 'text=Next'
npx playwright-cli --session=ig fill '[aria-label="Write a caption..."]' 'Caption here'
npx playwright-cli --session=ig click 'text=Share'
```

### LinkedIn

```bash
# Login
npx playwright-cli --session=li open https://linkedin.com

# Create post
npx playwright-cli --session=li click 'text=Start a post'
npx playwright-cli --session=li fill '[aria-label="Share a post"]' 'Post content'
npx playwright-cli --session=li click '[aria-label="Add media"]'
npx playwright-cli --session=li setInputFiles '[type="file"]' /data/workspace/photo.jpg
npx playwright-cli --session=li click 'text=Post'
```

## Notes

- Selectors may change as platforms update their UI
- Use screenshot debugging to verify selector accuracy
- Session cookies expire after platform-defined timeouts
- Re-authenticate when sessions expire
