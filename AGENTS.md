# AGENTS.md

Node/Express service that turns a tweet URL into a tweet-card GIF/MP4/WebM. See `README.md` for user-facing docs and full env-var table.

## Commands

- `npm run dev` — start with auto-reload (nodemon)
- `npm start` — start server (`node server.js`)
- `npm test` — run the test suite (`node --test`, Node 22.12+, no extra deps)
- `npm run check` — syntax-only check of `server.js` and `public/script.js`
- Run one test file: `node --test test/security.test.js`
- Health check: `curl --fail http://localhost:3000/api/health`

There is no linter, formatter, or typecheck. `npm run check` is the only static gate.

## Architecture

- `server.js` — the entire backend as one file: HTTP routes, job/SSE tracking, yt-dlp download, Puppeteer screenshot, and all FFmpeg pipelines. Almost all changes go here.
- `lib/security.js` — pure URL/HTML validators (`parseTweetUrl`, `isSafeRemoteUrl`, `escapeHtml`, `isUuid`). Security-critical; changes here are covered by `test/security.test.js`.
- `public/` — static frontend (`index.html`, `script.js`, `style.css`), served directly by Express.
- `server.js` exports `{ app, startServer, stopServer, _internals }`. Tests call `startServer({ port: 0, prewarm: false })`; never hardcode a port in test/lib code.

Pipeline: yt-dlp downloads video → Twitter oEmbed for author/text → Puppeteer screenshots a rendered HTML tweet card → FFmpeg composites video into the card → emits MP4, then 2-pass palette GIF and VP9/Opus WebM. Progress streams over SSE (`/api/progress/:jobId`) with a polling fallback (`/api/status/:jobId`).

## Gotchas

- **No ffprobe.** `ffmpeg-static` bundles only `ffmpeg`, so `getVideoInfo` parses `ffmpeg -i` stderr with regex. Don't introduce `ffprobe` calls.
- **yt-dlp is an external dependency**, not in package.json. Locally it must be installed (`pip install yt-dlp`); `findYtDlp()` also probes common Windows install paths. The Docker image bundles a build-time-pinned copy and keeps startup offline; update the image build argument when Twitter/X extraction needs a newer extractor.
- **Puppeteer/Chrome**: locally run `npx puppeteer browsers install chrome` once. In Docker, system Chromium is used via `PUPPETEER_EXECUTABLE_PATH`. A single warm browser is reused across requests.
- **Video format flag is deliberate**: `-f best[ext=mp4]/best` avoids `bestvideo+bestaudio`, which on Docker picks HLS streams Twitter bakes as landscape with black bars. Rotation is applied inline via FFmpeg `transpose`, not a pre-encode pass.
- **Concurrency is a hard cap, not a queue**: over `MAX_CONCURRENT_JOBS` returns HTTP 503. Tweet results are cached by tweet ID; outputs older than 24h are auto-deleted.
- **Share origin is locked down**: `/share/:id` only serves an origin from `PUBLIC_BASE_URL` / `PUBLIC_HOSTS` (or loopback). Missing config returns 503 by design — don't "fix" it by trusting the Host header.
- Dev/host platform is Windows (pwsh). File-URL and path helpers must stay backslash-safe.

## CI / release

`.github/workflows/docker.yml` runs on push to `master` and manual dispatch: it runs `npm ci`, `npm test`, `npm run check`, and a production dependency audit before building and pushing `ghcr.io/gmoran1016/tweet-giffer:latest`.
