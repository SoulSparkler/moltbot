# Clawbrowser Quick Reference

Fast reference for common Clawbrowser operations on Railway.

## Common Commands

### Basic Operations

```bash
# Open URL
npx playwright-cli open <url>

# Open with session
npx playwright-cli --session=<name> open <url>

# Take screenshot
npx playwright-cli screenshot <url> <output-path>

# Take screenshot with session
npx playwright-cli --session=<name> screenshot <output-path>
```

### Interactions

```bash
# Click element
npx playwright-cli --session=<name> click '<selector>'

# Fill input
npx playwright-cli --session=<name> fill '<selector>' '<text>'

# Upload file
npx playwright-cli --session=<name> setInputFiles '<selector>' <file-path>

# Press key
npx playwright-cli --session=<name> press '<selector>' '<key>'

# Wait for selector
npx playwright-cli --session=<name> waitForSelector '<selector>'
```

### Google Drive

```bash
# Download file
node /app/scripts/gdrive-download.js <file-id> <output-path>

# Example
node /app/scripts/gdrive-download.js 1abc123def /data/workspace/image.jpg
```

### Session Management

```bash
# List sessions
ls -la /data/playwright-sessions/

# Delete session
rm -rf /data/playwright-sessions/<name>

# Backup session
tar czf /tmp/backup.tar.gz /data/playwright-sessions/<name>
```

## Selector Types

```bash
# By text
'text=Login'
'text=/Log.*in/i'  # Regex

# By role + name
'role=button[name="Submit"]'

# By aria-label
'[aria-label="Search"]'

# By placeholder
'[placeholder="Email"]'

# By type
'[type="email"]'
'[type="file"]'

# CSS selector
'.class-name'
'#element-id'
'button.primary'

# XPath
'xpath=//button[@type="submit"]'
```

## Platform-Specific Selectors

### Facebook

```bash
# Create post
'[aria-label="What\'s on your mind?"]'

# Post button
'[aria-label="Post"]'

# Photo/video button
'[aria-label="Photo/video"]'

# File input
'[type="file"]'
```

### Instagram

```bash
# New post button
'[aria-label="New post"]'

# File input
'[type="file"]'

# Next button
'text=Next'

# Caption field
'[aria-label="Write a caption..."]'

# Share button
'text=Share'
```

### LinkedIn

```bash
# Start post
'text=Start a post'

# Post text area
'[aria-label="Share a post"]'

# Add media
'[aria-label="Add media"]'

# Post button
'text=Post'
```

## Railway Commands

### Deploy & Logs

```bash
# Deploy
railway up

# View logs
railway logs

# Tail logs
railway logs --tail 100

# Restart service
railway restart
```

### Shell Access

```bash
# Open shell
railway run bash

# Run single command
railway run bash -c "<command>"

# Examples
railway run bash -c "ls -la /data/"
railway run bash -c "npx playwright-cli --version"
```

### Environment Variables

```bash
# Set variable
railway variables set KEY=value

# List variables
railway variables

# Delete variable
railway variables delete KEY
```

## Debugging

### Screenshots

```bash
# Take screenshot
npx playwright-cli --session=debug screenshot /data/playwright-output/debug.png

# Download screenshot (from Railway shell)
railway run bash -c "cat /data/playwright-output/debug.png" > local-debug.png
```

### Traces

```bash
# Enable tracing
npx playwright-cli --trace on --session=debug open <url>

# View traces (download first)
railway run bash -c "ls -la /data/playwright-output/"
npx playwright show-trace /path/to/trace.zip
```

### Logs

```bash
# View Railway logs
railway logs --tail 100

# View Playwright output
railway run bash -c "ls -la /data/playwright-output/"
railway run bash -c "cat /data/playwright-output/*.log"
```

### Disk Usage

```bash
# Check disk space
railway run bash -c "df -h /data"

# Check directory sizes
railway run bash -c "du -sh /data/*"

# Clean up old files
railway run bash -c "find /data/playwright-downloads -mtime +7 -delete"
railway run bash -c "find /data/workspace -mtime +1 -delete"
```

## Complete Workflow Examples

### Post to Facebook with Drive Image

```bash
# 1. SSH to Railway
railway run bash

# 2. Download image from Drive
node /app/scripts/gdrive-download.js 1abc123def /data/workspace/photo.jpg

# 3. Open Facebook with session
npx playwright-cli --session=fb open https://facebook.com

# 4. Click create post
npx playwright-cli --session=fb click '[aria-label="What'\''s on your mind?"]'

# 5. Type post text
npx playwright-cli --session=fb fill '[aria-label="What'\''s on your mind?"]' 'My post content'

# 6. Click photo/video button
npx playwright-cli --session=fb click '[aria-label="Photo/video"]'

# 7. Upload file
npx playwright-cli --session=fb setInputFiles '[type="file"]' /data/workspace/photo.jpg

# 8. Click post
npx playwright-cli --session=fb click '[aria-label="Post"]'

# 9. Take screenshot to verify
npx playwright-cli --session=fb screenshot /data/playwright-output/posted.png
```

### Reply to Instagram DM

```bash
# 1. Open Instagram inbox
npx playwright-cli --session=ig open https://instagram.com/direct/inbox/

# 2. Click on conversation
npx playwright-cli --session=ig click 'text=<username>'

# 3. Type message
npx playwright-cli --session=ig fill '[aria-label="Message"]' 'Hi! Thanks for reaching out.'

# 4. Press Enter to send
npx playwright-cli --session=ig press '[aria-label="Message"]' 'Enter'
```

### Multi-Platform Post

```bash
# Download image once
node /app/scripts/gdrive-download.js 1abc123def /data/workspace/photo.jpg

# Post to Facebook
npx playwright-cli --session=fb open https://facebook.com
npx playwright-cli --session=fb click '[aria-label="What'\''s on your mind?"]'
npx playwright-cli --session=fb fill '[aria-label="What'\''s on your mind?"]' 'My post'
npx playwright-cli --session=fb click '[aria-label="Photo/video"]'
npx playwright-cli --session=fb setInputFiles '[type="file"]' /data/workspace/photo.jpg
npx playwright-cli --session=fb click '[aria-label="Post"]'

# Post to Instagram
npx playwright-cli --session=ig open https://instagram.com
npx playwright-cli --session=ig click '[aria-label="New post"]'
npx playwright-cli --session=ig setInputFiles '[type="file"]' /data/workspace/photo.jpg
npx playwright-cli --session=ig click 'text=Next'
npx playwright-cli --session=ig fill '[aria-label="Write a caption..."]' 'My post'
npx playwright-cli --session=ig click 'text=Share'

# Post to LinkedIn
npx playwright-cli --session=li open https://linkedin.com
npx playwright-cli --session=li click 'text=Start a post'
npx playwright-cli --session=li click '[aria-label="Add media"]'
npx playwright-cli --session=li setInputFiles '[type="file"]' /data/workspace/photo.jpg
npx playwright-cli --session=li fill '[aria-label="Share a post"]' 'My post'
npx playwright-cli --session=li click 'text=Post'
```

## Tips & Tricks

### Use Sessions for Everything
Always use `--session=<name>` to persist login state

### Escape Single Quotes
When using selectors with single quotes in bash:
```bash
# Wrong
npx playwright-cli click '[aria-label="What's on your mind?"]'

# Right
npx playwright-cli click '[aria-label="What'\''s on your mind?"]'
```

### Wait for Dynamic Content
Some platforms load content dynamically:
```bash
npx playwright-cli --session=fb waitForSelector '[aria-label="Post"]'
npx playwright-cli --session=fb click '[aria-label="Post"]'
```

### Take Screenshots for Debugging
When selectors don't work, take a screenshot first:
```bash
npx playwright-cli --session=debug screenshot /data/playwright-output/debug.png
```

### Clean Up Workspace
Delete files after upload to save space:
```bash
rm /data/workspace/*.jpg
```

### Use Variables for Repeated Values
```bash
SESSION=fb
POST_TEXT="My post content"
IMAGE_PATH=/data/workspace/photo.jpg

npx playwright-cli --session=$SESSION click '[aria-label="What'\''s on your mind?"]'
npx playwright-cli --session=$SESSION fill '[aria-label="What'\''s on your mind?"]' "$POST_TEXT"
npx playwright-cli --session=$SESSION setInputFiles '[type="file"]' "$IMAGE_PATH"
```

## Common Errors

### `browserType.launch: Executable doesn't exist`
**Fix**: `npx playwright install chromium --with-deps`

### `locator.click: Target closed`
**Fix**: Selector wrong or page changed. Take screenshot to debug.

### `Timeout 30000ms exceeded`
**Fix**: Element not found or page slow. Use `waitForSelector` first.

### `Error: ENOENT: no such file or directory`
**Fix**: File doesn't exist. Check path with `ls -la`.

### `Permission denied`
**Fix**: Check file permissions. Railway volume should be writable.

### `Out of memory`
**Fix**: Close browser between operations. Reduce workers to 1.

## Useful Aliases (add to ~/.bashrc in Railway)

```bash
alias pw='npx playwright-cli'
alias pws='npx playwright-cli --session'
alias gdd='node /app/scripts/gdrive-download.js'
alias sessions='ls -la /data/playwright-sessions/'
alias screenshots='ls -la /data/playwright-output/'
alias cleanup='find /data/workspace -type f -delete'
```

Then use:
```bash
pw open https://example.com
pws=fb open https://facebook.com
gdd 1abc123def /data/workspace/image.jpg
sessions
screenshots
cleanup
```
