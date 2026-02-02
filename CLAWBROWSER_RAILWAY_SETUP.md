# Clawbrowser Railway Setup

Complete setup for headless browser automation on Railway using Playwright CLI.

## Overview

This setup provides Jannetje (OpenClaw agent) with headless browser capabilities for:
- Logging into websites
- Filling forms
- Uploading images from Google Drive
- Posting content to social platforms
- Replying to posts and messages
- Managing accounts and groups

## Architecture

- **Platform**: Railway (Docker, cloud-only)
- **Browser**: Playwright CLI with Chromium
- **Sessions**: Persistent via Railway volume (`/data`)
- **Assets**: Google Drive (read-only)
- **Account**: moonshinespiritbsc@gmail.com (pre-authenticated bot account)

## File Structure

```
/home/user/moltbot/
├── Dockerfile                          # Updated with Playwright dependencies
├── docker-entrypoint.sh                # Environment variables for Playwright
├── playwright-cli.json                 # Playwright configuration
├── scripts/
│   └── gdrive-download.js              # Google Drive downloader
└── skills/
    └── clawbrowser/
        └── SKILL.md                    # Clawbrowser skill documentation
```

## Railway Configuration

### Volume Mount
- **Path**: `/data`
- **Size**: 1 GB
- **Contents**:
  - `/data/.clawdbot` - OpenClaw config
  - `/data/playwright-sessions` - Persistent browser sessions
  - `/data/playwright-downloads` - Downloaded files
  - `/data/playwright-output` - Screenshots, traces, videos
  - `/data/playwright-browsers` - Chromium binary
  - `/data/workspace` - Temporary workspace for Drive files

### Environment Variables

Set these in Railway:

```bash
# Playwright configuration
PLAYWRIGHT_BROWSERS_PATH=/data/playwright-browsers
PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
PLAYWRIGHT_CLI_SESSION_DIR=/data/playwright-sessions
PLAYWRIGHT_DOWNLOADS_PATH=/data/playwright-downloads

# Google Drive authentication (choose one method)

# Method 1: Service Account (recommended)
GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON=<base64-encoded-service-account-json>

# Method 2: OAuth2
GOOGLE_DRIVE_CLIENT_ID=<client-id>
GOOGLE_DRIVE_CLIENT_SECRET=<client-secret>
GOOGLE_DRIVE_REFRESH_TOKEN=<refresh-token>
```

## Google Drive Setup

### Option 1: Service Account (Recommended)

1. Create a service account in Google Cloud Console
2. Download the JSON key
3. Share your Drive folder with the service account email
4. Base64 encode the JSON key:
   ```bash
   cat service-account.json | base64 -w 0
   ```
5. Set `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON` in Railway

### Option 2: OAuth2

1. Create OAuth2 credentials in Google Cloud Console
2. Use the OAuth2 playground to get a refresh token
3. Set `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`, and `GOOGLE_DRIVE_REFRESH_TOKEN`

### Sharing Permissions

- Share all asset folders/files with the service account email
- Grant "Viewer" access (read-only)
- No need to share entire Drive, only specific folders

## Playwright CLI Configuration

See `playwright-cli.json` for full configuration. Key settings:

- **Browser**: Chromium (headless)
- **Viewport**: 1280x720
- **Sandbox**: Disabled (required for Docker)
- **Workers**: 1 (memory optimization)
- **Retries**: 2
- **Timeout**: 60s

### Railway-Safe Flags

```bash
--no-sandbox
--disable-dev-shm-usage
--disable-setuid-sandbox
--disable-gpu
```

## Usage Examples

### Basic Navigation

```bash
npx playwright-cli open https://example.com
npx playwright-cli screenshot https://example.com /data/playwright-output/example.png
```

### Persistent Sessions

```bash
# Create/use a session
npx playwright-cli --session=facebook open https://facebook.com

# Session persists across restarts
npx playwright-cli --session=facebook open https://facebook.com/messages
```

### Download from Google Drive + Upload to Platform

```bash
# 1. Download image from Google Drive
node /app/scripts/gdrive-download.js 1abc123def456 /data/workspace/photo.jpg

# 2. Open platform with persistent session
npx playwright-cli --session=instagram open https://instagram.com

# 3. Upload the image
npx playwright-cli --session=instagram click '[aria-label="New post"]'
npx playwright-cli --session=instagram setInputFiles '[type="file"]' /data/workspace/photo.jpg
npx playwright-cli --session=instagram click 'text=Next'
```

### Debugging Failed Operations

```bash
# Take a screenshot
npx playwright-cli --session=myapp screenshot /data/playwright-output/debug.png

# Enable trace
npx playwright-cli --trace on --session=myapp open https://example.com

# View traces (download from Railway)
railway run bash
ls -la /data/playwright-output/
```

## Session Management

### List Sessions

```bash
railway run bash
ls -la /data/playwright-sessions/
```

### Reset a Session

```bash
railway run bash
rm -rf /data/playwright-sessions/session-name
```

### Backup Sessions

```bash
# From Railway CLI
railway run bash -c "tar czf /tmp/sessions-backup.tar.gz /data/playwright-sessions"
railway run bash -c "cat /tmp/sessions-backup.tar.gz" > sessions-backup.tar.gz
```

## Social Platform Examples

### Facebook

```bash
# Login (first time)
npx playwright-cli --session=fb open https://facebook.com
# Complete login manually or via automation

# Post with image
node /app/scripts/gdrive-download.js <image-id> /data/workspace/photo.jpg
npx playwright-cli --session=fb open https://facebook.com
npx playwright-cli --session=fb click '[aria-label="What\'s on your mind?"]'
npx playwright-cli --session=fb fill '[aria-label="What\'s on your mind?"]' 'My post'
npx playwright-cli --session=fb click '[aria-label="Photo/video"]'
npx playwright-cli --session=fb setInputFiles '[type="file"]' /data/workspace/photo.jpg
npx playwright-cli --session=fb click '[aria-label="Post"]'
```

### Instagram

```bash
# Login
npx playwright-cli --session=ig open https://instagram.com

# Post image
node /app/scripts/gdrive-download.js <image-id> /data/workspace/photo.jpg
npx playwright-cli --session=ig click '[aria-label="New post"]'
npx playwright-cli --session=ig setInputFiles '[type="file"]' /data/workspace/photo.jpg
npx playwright-cli --session=ig click 'text=Next'
npx playwright-cli --session=ig fill '[aria-label="Write a caption..."]' 'My caption'
npx playwright-cli --session=ig click 'text=Share'
```

### LinkedIn

```bash
# Login
npx playwright-cli --session=li open https://linkedin.com

# Post with image
node /app/scripts/gdrive-download.js <image-id> /data/workspace/photo.jpg
npx playwright-cli --session=li click 'text=Start a post'
npx playwright-cli --session=li click '[aria-label="Add media"]'
npx playwright-cli --session=li setInputFiles '[type="file"]' /data/workspace/photo.jpg
npx playwright-cli --session=li fill '[aria-label="Share a post"]' 'My post'
npx playwright-cli --session=li click 'text=Post'
```

## Troubleshooting

### Browser Not Launching

**Symptom**: `browserType.launch: Executable doesn't exist`

**Solution**:
```bash
railway run bash
npx playwright install chromium --with-deps
```

### Session Not Persisting

**Symptom**: Login state lost after restart

**Solution**: Verify volume mount and session directory
```bash
railway run bash
ls -la /data/playwright-sessions/
```

### Memory Issues

**Symptom**: `Out of memory` or `Process killed`

**Solution**: Reduce workers and limit browser instances
- Set `workers: 1` in `playwright-cli.json`
- Close browser between operations
- Use `--disable-dev-shm-usage` flag (already set)

### Upload Failing

**Symptom**: File upload not working

**Solution**: Check file exists and permissions
```bash
railway run bash
ls -la /data/workspace/
file /data/workspace/photo.jpg
```

### Selectors Not Found

**Symptom**: `locator.click: Target closed` or `Timeout 30000ms exceeded`

**Solution**: Take screenshot and verify selectors
```bash
npx playwright-cli --session=myapp screenshot /data/playwright-output/debug.png
railway run bash -c "cat /data/playwright-output/debug.png" > debug.png
```

## Security Best Practices

- ✅ Use service account for Google Drive (not personal OAuth)
- ✅ Store credentials as Railway environment variables (not in code)
- ✅ Limit Drive permissions to specific shared folders
- ✅ Use bot account for social logins (moonshinespiritbsc@gmail.com)
- ✅ Never commit credentials or tokens to repo
- ✅ Rotate sessions periodically to prevent staleness
- ❌ Don't log credentials or cookies
- ❌ Don't share screenshots that contain sensitive data

## Testing Checklist

See `CLAWBROWSER_TEST_CHECKLIST.md` for comprehensive testing steps.

## Integration with Jannetje

Once deployed, Jannetje can use Clawbrowser via the skill system:

```
User: "Post this image to Facebook: <drive-link>"

Jannetje:
1. Extracts Drive file ID from link
2. Downloads image: node /app/scripts/gdrive-download.js <id> /data/workspace/image.jpg
3. Opens Facebook: npx playwright-cli --session=fb open https://facebook.com
4. Creates post and uploads image
5. Confirms success
```

## Maintenance

### Update Chromium

```bash
railway run bash
npx playwright install chromium --force
```

### Clear Old Downloads

```bash
railway run bash
find /data/playwright-downloads -mtime +7 -delete
find /data/workspace -mtime +1 -delete
```

### Monitor Disk Usage

```bash
railway run bash
df -h /data
du -sh /data/*
```

## Support

For issues:
1. Check Railway logs: `railway logs`
2. Check Playwright output: `ls -la /data/playwright-output/`
3. Take screenshots for debugging
4. Verify environment variables are set

## Next Steps

1. Deploy to Railway
2. Set environment variables
3. Configure Google Drive service account
4. Test basic navigation
5. Test persistent sessions
6. Test Google Drive download
7. Test social platform automation
8. Integrate with Jannetje agent
