# Clawbrowser Test Checklist

Comprehensive testing checklist for Clawbrowser on Railway.

## Prerequisites

- [ ] Railway project deployed
- [ ] Volume mounted at `/data` (1GB+)
- [ ] Environment variables set (see CLAWBROWSER_RAILWAY_SETUP.md)
- [ ] Google Drive service account configured (if using Drive integration)

## Phase 1: Infrastructure Tests

### Docker Build

- [ ] Dockerfile builds successfully
  ```bash
  docker build -t moltbot-test .
  ```
- [ ] Playwright dependencies installed
- [ ] Chromium browser downloaded
- [ ] All directories created (`/data/playwright-sessions`, etc.)

### Environment Variables

- [ ] `PLAYWRIGHT_BROWSERS_PATH` set correctly
- [ ] `PLAYWRIGHT_CLI_SESSION_DIR` set correctly
- [ ] `PLAYWRIGHT_DOWNLOADS_PATH` set correctly
- [ ] Google Drive credentials available (if using)

### Railway Deployment

- [ ] Railway deployment successful
- [ ] Service starts without errors
- [ ] Volume mounted correctly
  ```bash
  railway run bash -c "df -h /data"
  ```
- [ ] Directories writable
  ```bash
  railway run bash -c "touch /data/playwright-sessions/test && rm /data/playwright-sessions/test"
  ```

## Phase 2: Playwright CLI Tests

### Basic Commands

- [ ] Playwright CLI available
  ```bash
  railway run bash -c "npx playwright-cli --version"
  ```
- [ ] Chromium launches successfully
  ```bash
  railway run bash -c "npx playwright-cli open https://example.com"
  ```
- [ ] Screenshots work
  ```bash
  railway run bash -c "npx playwright-cli screenshot https://example.com /data/playwright-output/test.png"
  ```
- [ ] Screenshot file created and readable
  ```bash
  railway run bash -c "ls -lh /data/playwright-output/test.png"
  ```

### Headless Operation

- [ ] Browser runs in headless mode (no GUI required)
- [ ] No sandbox errors
- [ ] No `/dev/shm` errors (--disable-dev-shm-usage working)
- [ ] Memory usage acceptable (<500MB per browser instance)

### Railway-Safe Flags

Verify these flags are working:
- [ ] `--no-sandbox` (no permission errors)
- [ ] `--disable-dev-shm-usage` (no shared memory errors)
- [ ] `--disable-setuid-sandbox` (no setuid errors)
- [ ] `--disable-gpu` (no GPU errors)

## Phase 3: Session Persistence Tests

### Session Creation

- [ ] Create a new session
  ```bash
  railway run bash -c "npx playwright-cli --session=test-session open https://example.com"
  ```
- [ ] Session directory created
  ```bash
  railway run bash -c "ls -la /data/playwright-sessions/test-session"
  ```
- [ ] Session files exist (cookies, localStorage)

### Session Reuse

- [ ] Navigate to a login page
  ```bash
  railway run bash -c "npx playwright-cli --session=login-test open https://github.com/login"
  ```
- [ ] Perform login (manual or automated)
- [ ] Close browser
- [ ] Reopen with same session
  ```bash
  railway run bash -c "npx playwright-cli --session=login-test open https://github.com"
  ```
- [ ] Verify still logged in (no login prompt)

### Session Persistence Across Restarts

- [ ] Create session with login state
- [ ] Restart Railway service
  ```bash
  railway restart
  ```
- [ ] Verify session still exists
  ```bash
  railway run bash -c "ls -la /data/playwright-sessions/"
  ```
- [ ] Reuse session and verify login state persists

### Session Management

- [ ] List all sessions
  ```bash
  railway run bash -c "ls -la /data/playwright-sessions/"
  ```
- [ ] Delete a session
  ```bash
  railway run bash -c "rm -rf /data/playwright-sessions/test-session"
  ```
- [ ] Verify session deleted

## Phase 4: Google Drive Integration Tests

### Authentication

- [ ] Service account JSON valid (if using)
- [ ] Environment variable set correctly
- [ ] Can authenticate with Google Drive API
  ```bash
  railway run bash -c "node /app/scripts/gdrive-download.js --test"
  ```

### File Download

- [ ] Share a test image with service account
- [ ] Download file from Google Drive
  ```bash
  railway run bash -c "node /app/scripts/gdrive-download.js <file-id> /data/workspace/test-image.jpg"
  ```
- [ ] Verify file downloaded
  ```bash
  railway run bash -c "ls -lh /data/workspace/test-image.jpg"
  railway run bash -c "file /data/workspace/test-image.jpg"
  ```
- [ ] Verify file is readable/valid image

### Permission Tests

- [ ] Download from shared folder (Viewer access)
- [ ] Attempt to download unshared file (should fail gracefully)
- [ ] Attempt to modify file (should fail - read-only)

## Phase 5: Social Platform Automation Tests

### Facebook

- [ ] Open Facebook
  ```bash
  railway run bash -c "npx playwright-cli --session=fb open https://facebook.com"
  ```
- [ ] Complete login (if not already logged in)
- [ ] Navigate to home feed
- [ ] Take screenshot to verify login
  ```bash
  railway run bash -c "npx playwright-cli --session=fb screenshot /data/playwright-output/fb-home.png"
  ```
- [ ] Click "Create Post" button
- [ ] Fill post text field
- [ ] Upload image from Drive
  ```bash
  railway run bash -c "node /app/scripts/gdrive-download.js <image-id> /data/workspace/fb-photo.jpg"
  railway run bash -c "npx playwright-cli --session=fb setInputFiles '[type=\"file\"]' /data/workspace/fb-photo.jpg"
  ```
- [ ] Click "Post" button
- [ ] Verify post created (screenshot or API check)

### Instagram

- [ ] Open Instagram
  ```bash
  railway run bash -c "npx playwright-cli --session=ig open https://instagram.com"
  ```
- [ ] Complete login (moonshinespiritbsc@gmail.com)
- [ ] Click "New post" button
- [ ] Upload image from Drive
- [ ] Add caption
- [ ] Click "Share" button
- [ ] Verify post created

### LinkedIn

- [ ] Open LinkedIn
- [ ] Complete login
- [ ] Click "Start a post"
- [ ] Add post content
- [ ] Upload image from Drive
- [ ] Click "Post" button
- [ ] Verify post created

### Private Messages

- [ ] Open platform inbox
- [ ] Navigate to a conversation
- [ ] Send a text message
- [ ] Send an image
- [ ] Verify messages sent

### Groups

- [ ] Navigate to a group
- [ ] Create a post in the group
- [ ] Upload image to group post
- [ ] Reply to existing group post
- [ ] Verify operations successful

## Phase 6: Error Handling Tests

### Network Errors

- [ ] Test with invalid URL
  ```bash
  railway run bash -c "npx playwright-cli open https://invalid-url-that-does-not-exist.com"
  ```
- [ ] Verify graceful failure (no crash)
- [ ] Verify error logged

### File Not Found

- [ ] Attempt to upload non-existent file
  ```bash
  railway run bash -c "npx playwright-cli --session=test setInputFiles '[type=\"file\"]' /data/workspace/nonexistent.jpg"
  ```
- [ ] Verify graceful failure

### Selector Not Found

- [ ] Attempt to click non-existent element
- [ ] Verify timeout
- [ ] Verify screenshot taken (if configured)

### Google Drive Errors

- [ ] Attempt to download non-existent file ID
- [ ] Verify error message clear
- [ ] Attempt to download file without permissions
- [ ] Verify 403 error handled gracefully

## Phase 7: Performance Tests

### Memory Usage

- [ ] Monitor memory during browser launch
  ```bash
  railway run bash -c "while true; do free -h; sleep 5; done" &
  railway run bash -c "npx playwright-cli open https://example.com"
  ```
- [ ] Verify memory usage <500MB per browser
- [ ] Verify no memory leaks after closing browser

### Concurrent Operations

- [ ] Run multiple sessions simultaneously
- [ ] Verify no conflicts
- [ ] Verify each session isolated

### Large File Uploads

- [ ] Download large image from Drive (5MB+)
- [ ] Upload to platform
- [ ] Verify upload completes without timeout

### Long-Running Sessions

- [ ] Keep session open for 30+ minutes
- [ ] Perform multiple operations
- [ ] Verify session remains stable

## Phase 8: Integration Tests

### Jannetje Agent Integration

- [ ] Jannetje can invoke Clawbrowser skill
- [ ] Jannetje can download from Drive
- [ ] Jannetje can post to social platforms
- [ ] Jannetje receives success/failure feedback
- [ ] Jannetje can handle errors gracefully

### End-to-End Workflows

#### Workflow 1: Facebook Post with Drive Image
- [ ] User sends Drive link to Jannetje
- [ ] Jannetje extracts file ID
- [ ] Jannetje downloads image
- [ ] Jannetje posts to Facebook
- [ ] Jannetje confirms success

#### Workflow 2: Multi-Platform Post
- [ ] Jannetje posts same content to Facebook, Instagram, LinkedIn
- [ ] All posts successful
- [ ] Proper session management (no conflicts)

#### Workflow 3: Reply to Messages
- [ ] Jannetje opens platform inbox
- [ ] Jannetje reads new messages
- [ ] Jannetje replies with text + image
- [ ] Messages sent successfully

## Phase 9: Debugging and Monitoring

### Logging

- [ ] Railway logs show Playwright output
- [ ] Errors clearly logged
- [ ] Screenshots captured on failure
- [ ] Traces captured on failure (if enabled)

### Screenshots

- [ ] Can take manual screenshots
- [ ] Automatic screenshots on failure
- [ ] Screenshots downloadable from Railway

### Traces

- [ ] Traces captured (if enabled)
- [ ] Traces downloadable
- [ ] Traces viewable locally (`npx playwright show-trace`)

## Phase 10: Security Tests

### Credentials

- [ ] No credentials in logs
- [ ] No credentials in screenshots
- [ ] No credentials in traces
- [ ] Environment variables not exposed

### Session Security

- [ ] Session files not publicly accessible
- [ ] Sessions encrypted at rest (Railway volume)
- [ ] Session cookies have proper flags

### Google Drive Security

- [ ] Service account has minimal permissions (Viewer only)
- [ ] Service account cannot modify files
- [ ] Service account limited to shared folders only

## Acceptance Criteria

All tests in the following phases must pass:
- [x] Phase 1: Infrastructure Tests
- [x] Phase 2: Playwright CLI Tests
- [x] Phase 3: Session Persistence Tests
- [x] Phase 4: Google Drive Integration Tests
- [x] Phase 5: Social Platform Automation Tests
- [x] Phase 6: Error Handling Tests
- [x] Phase 7: Performance Tests
- [x] Phase 8: Integration Tests
- [x] Phase 9: Debugging and Monitoring
- [x] Phase 10: Security Tests

## Known Limitations

Document any known limitations or issues:
- [ ] Platform-specific selector changes (requires maintenance)
- [ ] Session expiration (platform-dependent)
- [ ] Rate limiting (platform-dependent)
- [ ] CAPTCHA challenges (requires manual intervention)

## Next Steps After Testing

- [ ] Document selector patterns for each platform
- [ ] Create helper scripts for common operations
- [ ] Set up monitoring/alerting for failures
- [ ] Configure automatic session refresh
- [ ] Implement retry logic for transient failures
- [ ] Add CAPTCHA handling (if needed)
