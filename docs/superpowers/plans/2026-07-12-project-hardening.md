# Tweet Giffer Project Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden Tweet Giffer for untrusted public traffic, add regression coverage, and improve the existing browser experience without changing its core workflow.

**Architecture:** Keep the single Express service and media pipeline, while extracting pure validation and escaping helpers into `lib/security.js`. Export the Express app and lifecycle functions from `server.js` so Node's built-in test runner can exercise routes without launching Chromium or external media tools.

**Tech Stack:** Node.js 22, Express 4, Node test runner, Puppeteer, yt-dlp, FFmpeg, plain HTML/CSS/JavaScript, Docker.

## Global Constraints

- Preserve GIF, MP4, WebM, polling, download, and share-link behavior.
- Do not require live Twitter/X, Chromium, yt-dlp, or FFmpeg in automated tests.
- Treat submitted URLs, route identifiers, third-party metadata, and forwarded host/protocol values as untrusted.
- Avoid a framework rewrite and unrelated product features.

---

### Task 1: Security boundary helpers and tests

**Files:**
- Create: `lib/security.js`
- Create: `test/security.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `parseTweetUrl(value)`, `isSafeRemoteUrl(value, allowedHosts)`, `escapeHtml(value)`, `isUuid(value)`.
- `parseTweetUrl` returns `{ username, tweetId, canonicalUrl }` or `null`.

- [ ] **Step 1: Add failing tests** for exact `https:` URLs on `x.com`, `www.x.com`, `twitter.com`, and `www.twitter.com`; reject credentials, alternate ports, deceptive subdomains, query-only status fragments, non-status paths, and non-string input. Cover UUID validation, HTML escaping, and HTTPS allowlisted remote URLs.
- [ ] **Step 2: Run `npm test`** and confirm failure because `lib/security.js` does not exist.
- [ ] **Step 3: Implement the helpers** with the WHATWG `URL` parser, exact hostname allowlists, numeric tweet IDs, username validation, canonical URL construction, full HTML attribute escaping, and UUID v4 validation.
- [ ] **Step 4: Add `"test": "node --test"` and `"check": "node --check server.js && node --check public/script.js"`** to `package.json`.
- [ ] **Step 5: Run `npm test`** and confirm all helper tests pass.

### Task 2: Express and processing hardening

**Files:**
- Modify: `server.js`
- Create: `test/server.test.js`

**Interfaces:**
- Consumes: all helpers from `lib/security.js`.
- Produces: exported `app`, `startServer()`, and `stopServer()` for isolated tests.

- [ ] **Step 1: Add failing route tests** using a temporary output directory and a locally listening app. Verify oversized JSON returns 413, malformed tweet URLs return 400, invalid job/output UUIDs return 400 or 404 without filesystem lookup, share metadata is escaped, unsupported share formats fall back safely, and health responses set defensive headers.
- [ ] **Step 2: Run `npm test`** and confirm the route tests fail against current behavior.
- [ ] **Step 3: Harden middleware** with a 4 KiB JSON limit, disabled `x-powered-by`, explicit same-origin CORS policy only when configured, security headers, `trust proxy` controlled by `TRUST_PROXY`, and non-cache API responses.
- [ ] **Step 4: Harden request and job control** by validating IDs, capping in-memory rate-limit entries, expiring jobs deterministically, limiting active conversions through `MAX_CONCURRENT_JOBS` (default 2), and returning 503 when capacity is full.
- [ ] **Step 5: Harden external work** by passing canonical tweet URLs to yt-dlp/oEmbed, adding bounded image response size and safe redirect/protocol checks, clearing child-process timers after settlement, killing timed-out processes, limiting captured stderr, and ensuring partial outputs and session directories are removed on failure.
- [ ] **Step 6: Harden share output** by validating UUIDs/formats, escaping every metadata value, using `PUBLIC_BASE_URL` when configured and otherwise a safely parsed request origin, adding a no-script redirect fallback, and setting `Content-Type: text/html; charset=utf-8` plus `Content-Security-Policy`.
- [ ] **Step 7: Make lifecycle testable** by starting only under `require.main === module`, retaining the server/timer handles, and closing the HTTP server and Puppeteer browser in `stopServer()` and signal handlers.
- [ ] **Step 8: Run `npm test` and `npm run check`** and confirm all tests and syntax checks pass.

### Task 3: Accessible frontend and resilient polling

**Files:**
- Modify: `public/index.html`
- Modify: `public/script.js`
- Modify: `public/style.css`

**Interfaces:**
- Consumes: unchanged `/api/process-tweet`, `/api/status/:jobId`, `/outputs/:id.ext`, and `/share/:id?f=` contracts.

- [ ] **Step 1: Improve semantics** with a labeled form, submit button, live status/error regions, tablist/tab/tabpanel roles, `aria-selected`, `aria-controls`, explicit button types, video labels, and a skip-friendly focus structure.
- [ ] **Step 2: Strengthen client validation and polling** using `URL`, exact allowed hostnames, form submission, an `AbortController`, a five-minute deadline, response content checks, and cleanup of timers and media sources between runs.
- [ ] **Step 3: Make tabs keyboard-accessible** with arrow/Home/End navigation and keep `aria-selected`, `tabIndex`, and hidden panels synchronized; hide the unavailable WebM tab as well as its controls.
- [ ] **Step 4: Refine styling** with visible `:focus-visible`, disabled states, reduced-motion support, improved mobile preview sizing, live-region spacing, and sufficiently contrasted status colors.
- [ ] **Step 5: Run `npm run check`** and perform a local browser smoke check at desktop and mobile widths.

### Task 4: Deployment configuration and documentation

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `.dockerignore`
- Modify: `README.md`

**Interfaces:**
- Documents: `PUBLIC_BASE_URL`, `TRUST_PROXY`, `ALLOWED_ORIGIN`, `MAX_CONCURRENT_JOBS`, and operational limits.

- [ ] **Step 1: Harden the image** by creating an unprivileged runtime user, owning only writable output/temp directories, adding a health check, and removing the startup-time network mutation that upgrades yt-dlp on every container boot.
- [ ] **Step 2: Harden Compose defaults** with `init: true`, a health check, a temporary filesystem for `/app/temp`, and documented environment placeholders while retaining the persistent output volume.
- [ ] **Step 3: Expand `.dockerignore`** to exclude Git metadata, docs, tests, local artifacts, and environment files from the production build context.
- [ ] **Step 4: Update README** with security-related environment variables, public reverse-proxy guidance, testing commands, resource-limit behavior, output retention, and the container's non-root/write-path expectations.
- [ ] **Step 5: Run final verification:** `npm test`, `npm run check`, `npm audit --audit-level=moderate`, `docker compose config` when Docker is available, a local health/request smoke test, and `git diff --check`.

