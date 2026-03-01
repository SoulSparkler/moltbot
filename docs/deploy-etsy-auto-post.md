# Etsy Auto Post Deployment

## Source of Truth

- Etsy autoposter code lives in `apps/etsy-auto-post` in this repo; no code under ad-hoc workspace folders is used for deploys.
- The package is part of the pnpm workspace; commits on the main branch are the deployable state.

## Railway Build and Start

- `railway.json` uses the Nixpacks builder with:
  - build: `pnpm install --filter etsy-auto-post... --frozen-lockfile && pnpm --filter etsy-auto-post build`
  - start: `pnpm --filter etsy-auto-post start`
- pnpm runs scripts from the package root, so `node dist/index.js` executes inside `apps/etsy-auto-post`.
- The `/data` volume remains mounted; the watcher state file defaults to `RSS_STATE_PATH=/data/.openclaw/state/etsy_rss.json` (override with a relative or absolute path if needed).

## Build Proof and Verification

- On boot the watcher logs a build line: `[build] sha=<sha> source=<env|git> version=<semver> build_time=<iso> build_time_source=<env|startup> start_time=<iso> service=etsy-auto-post`.
- A self-check log follows and the HTTP server exposes:
  - `GET /health` ? `{ ok: true }`
  - `GET /self-check` ? build + config snapshot (cwd, statePath, facebook/instagram toggles, limits, image overrides, telegram polling flag) plus Meta status: token presence, `FACEBOOK_ENABLED` reason/missing env, `META_PAGE_ID`, required vs missing permissions, page access/IG link flags.
- To verify production is on the expected commit, check Railway logs for the `[build]` line or curl the `/self-check` endpoint.

## Runtime Env and Toggles

- Required feed: `ETSY_SHOP_RSS_URL`
- Meta auth: `META_ACCESS_TOKEN` (or `META_PAGE_ACCESS_TOKEN` + `META_PAGE_ID`); optional `RSS_FACEBOOK_VERIFY_ATTACHMENT`, `RSS_FACEBOOK_VERIFY_DELAY_MS`.
- Channel switches: `FACEBOOK_ENABLED`, `INSTAGRAM_ENABLED` (legacy `RSS_FACEBOOK_ENABLED`, `RSS_INSTAGRAM_ENABLED` still read).
- Rate limits: `MAX_POSTS_PER_DAY` (default 1), `MIN_POST_INTERVAL_HOURS` (default 24), `DEDUPE_DAYS` (default 30), `RSS_CHECK_INTERVAL_MS` (default 6h).
- Instagram media overrides: `RSS_INSTAGRAM_IMAGE_URL_OVERRIDE`, `RSS_INSTAGRAM_TEST_IMAGE_URL`.
- Telegram ops: `RUN_TELEGRAM_POLLING=true`, plus `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
- Misc: `RSS_STATE_PATH` (optional override), `PORT` set by Railway for the health server.

## Pinterest Smoke Test (one-off)

- Enable `PINTEREST_TEST_MODE=true` along with `PINTEREST_ACCESS_TOKEN` and `PINTEREST_BOARD_ID`.
- With the service running and the health server enabled, trigger exactly once via `curl -XPOST http://localhost:${PORT:-8080}/pinterest_test`.
- The smoke test posts `title="TEST PIN - Jannetje"`, `description="Smoke test"`, `link=https://tresortendance.etsy.com`, and `image_url=https://via.placeholder.com/1000x1500.png` to the configured board; the handler logs the returned pin id and URL.
- The route returns `429` after the first request in a process to avoid spamming; redeploy/restart to rerun if needed.
- After verification, remove/unset `PINTEREST_TEST_MODE` (and any temporary creds) so the route is disabled.

## Notes

- The gateway Docker entrypoint no longer launches the RSS watcher sidecar; use the `railway.json` commands above as the single deployment path for Etsy autoposting.
