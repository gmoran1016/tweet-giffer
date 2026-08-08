# Tweet Giffer Usability Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the audited Tweet Giffer usability issues across processing feedback, recovery, errors, result clarity, accessibility, quote-post rendering, favicon polish, and share metadata without changing the application’s core conversion pipeline.

**Architecture:** Keep the existing Node/Express backend and vanilla browser frontend. Add safe metadata and explicit stage/error contracts in `server.js`, consume them in `public/script.js`, and keep visual/semantic changes in `public/index.html` and `public/style.css`. Use the existing Node test runner for backend and asset contracts, plus an external Puppeteer harness for rendered frontend behavior and genuine conversion verification.

**Tech Stack:** Node.js 18+, built-in `node:test`, Express, Cheerio, Puppeteer, vanilla HTML/CSS/JavaScript, FFmpeg-static, yt-dlp.

## Global Constraints

- Keep the Node/Express architecture and the single-file backend organization.
- Keep `ffmpeg-static`; do not introduce `ffprobe`.
- Keep Windows-safe path and file-URL handling.
- Keep output paths restricted to `/outputs/<uuid>.<extension>`.
- Keep the existing rate-limit and concurrency limits.
- Do not expose yt-dlp, FFmpeg, filesystem, or upstream exception details to users.
- Preserve current API clients by adding optional response fields rather than removing fields.
- Use the existing Node test runner and installed Chromium/Puppeteer for verification.
- Do not add runtime dependencies.
- Do not write screenshots, traces, downloads, or temporary browser scripts into the repository.

---

## File map

| File | Responsibility in this change |
|---|---|
| `server.js` | Stage/error contracts, job timestamps, safe metadata, quote-context extraction/rendering, result payloads, and share metadata |
| `public/index.html` | Loading progress markup, result summary/cache notice, error heading/retry control, favicon link, and accessible labels |
| `public/script.js` | Status restoration, elapsed/stage display, local-storage lifecycle, error mapping/retry, static-card/cache messaging, and descriptive media labels |
| `public/style.css` | Accessible accent tokens, progress/error/result layout, focus scroll margin, and responsive control styling |
| `public/favicon.svg` | Small static favicon that removes the browser 404 |
| `test/server.test.js` | Backend contract, metadata, error, job, and share regression tests |
| `test/frontend-assets.test.js` | Static markup/style/favicon contract tests |
| `test/frontend-browser.test.js` | Optional local Chromium behavior tests for result messaging and refresh recovery; runs explicitly when Chromium is available |
| `docs/superpowers/specs/2026-08-08-usability-fixes-design.md` | Approved design; no further edits expected |

## Interfaces introduced by this plan

The implementation will use these exact backend helper contracts and optional response fields:

```js
classifyProcessingError(error, phase) => {
  errorCode: 'TWEET_UNAVAILABLE' | 'MEDIA_ACCESS_FAILED' | 'PROCESSING_FAILED',
  message: string,
  status: 502 | 500,
}

extractQuoteContext(oembedHtml) => null | {
  authorName: string,
  handle: string,
  tweetUrl: string,
  text: string,
}

buildResultMetadata({ authorName, staticCard, quoteContext }) => {
  authorName: string | null,
  staticCard: boolean,
  quoteContext: object | null,
}

result = {
  videoId: string,
  gif: string,
  video: string,
  webm: string | null,
  cached?: boolean,
  staticCard?: boolean,
  authorName?: string,
  quoteContext?: object | null,
}
```

Job status and SSE step payloads will include `stepIndex`, `stepCount`, and `elapsedMs`; existing `message`, `done`, `result`, `error`, and `errorCode` fields remain present.

---

### Task 1: Add failing backend contract tests for stages, errors, and quote context

**Files:**
- Modify: `test/server.test.js`
- Modify: `server.js` only after the RED test run

**Interfaces:**
- Consumes: existing `server._internals` export and existing `/api/process-tweet`, `/api/status/:jobId`, and `/share/:videoId` routes.
- Produces: failing tests that define the exact safe classifier, quote extractor, and stage metadata behavior used by later tasks.

- [ ] **Step 1: Write the failing classifier tests**

Add tests for the exported `_internals.classifyProcessingError`:

```js
test('classifies upstream access failures without exposing diagnostics', () => {
  const { classifyProcessingError } = require('../server')._internals;
  assert.deepEqual(
    classifyProcessingError({ response: { status: 404 } }, 'oembed'),
    {
      errorCode: 'TWEET_UNAVAILABLE',
      message: 'This post is unavailable, private, or no longer exists. Check the URL and try another public post.',
      status: 502,
    },
  );
  assert.deepEqual(
    classifyProcessingError(new Error('stderr=C:\\secret\\video'), 'video'),
    {
      errorCode: 'MEDIA_ACCESS_FAILED',
      message: 'The post was found, but its media could not be accessed. Check that it is public and try again.',
      status: 502,
    },
  );
  assert.doesNotMatch(JSON.stringify(classifyProcessingError(new Error('private stderr'))), /private|stderr/i);
});
```

- [ ] **Step 2: Write the failing quote-context test**

Add an oEmbed fixture containing an outer and nested blockquote and assert that `_internals.extractQuoteContext` returns the nested author, handle, URL, and text. Add a second assertion that malformed/flat markup returns `null` rather than inventing context.

- [ ] **Step 3: Write the failing job-stage test**

Call the exported `_internals.createJob(jobId)` and `_internals.emitProgress(jobId, { type: 'step', message: 'Creating WebM...' })`. Assert that the returned job has timestamps and that the returned normalized step carries `stepIndex: 6`, `stepCount: 6`, and a non-negative `elapsedMs`. Assert `_internals.PIPELINE_STAGES` contains the six labels in metadata-fetch, download, render, composite, GIF, WebM order.

- [ ] **Step 4: Run the focused test file and verify RED**

Run:

```powershell
node --test test/server.test.js
```

Expected: FAIL because the new helpers and stage fields do not exist yet; no failure should be caused by a syntax error or missing fixture.

- [ ] **Step 5: Commit the test-only RED state**

```powershell
git add test/server.test.js
git commit -m "test: specify usability backend contracts"
```

### Task 2: Implement safe error classification and job progress contracts

**Files:**
- Modify: `server.js` around job tracking, status/SSE routes, and asynchronous processing
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: Task 1 classifier and stage tests.
- Produces: `classifyProcessingError`, six-stage progress payloads, timestamped job records, and safe error codes for client consumption.

- [ ] **Step 1: Implement the six-stage constant and job timestamps**

Add one ordered `PIPELINE_STAGES` array. Update `createJob` to store `createdAt`, `startedAt`, `stepIndex: 0`, `stepCount: PIPELINE_STAGES.length`, and the existing state. Make it return the created job for focused testing without changing route behavior.

- [ ] **Step 2: Implement stage-aware `emitProgress`**

When a step message matches a pipeline stage, attach its one-based `stepIndex`, total count, and `elapsedMs`. Keep replay and live SSE behavior unchanged. Update `/api/status/:jobId` to expose the latest safe stage fields and elapsed time.

- [ ] **Step 3: Implement `classifyProcessingError` and stable route codes**

Map oEmbed HTTP 401/403/404 errors to `TWEET_UNAVAILABLE`; map video-download failures after a successful metadata phase to `MEDIA_ACCESS_FAILED`; map all remaining processing failures to `PROCESSING_FAILED`. Add `INVALID_URL`, `RATE_LIMITED`, and `CAPACITY_FULL` codes at their existing HTTP responses. Keep messages exactly as defined in the approved specification and never serialize raw errors.

- [ ] **Step 4: Use the classifier in the async pipeline**

Pass the current phase into the catch path, call `rejectJob` with the safe message/code, and keep cleanup/active-job release behavior intact. Ensure the current forced setup-failure tests still see `PROCESSING_FAILED` and no secret fragments.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
node --test test/server.test.js
```

Expected: the new classifier/stage tests and all existing server tests pass with zero failures.

- [ ] **Step 6: Commit the backend contract implementation**

```powershell
git add server.js test/server.test.js
git commit -m "feat: add safe job progress and error contracts"
```

### Task 3: Add failing metadata, static-card, quote-rendering, and cache tests

**Files:**
- Modify: `test/server.test.js`
- Modify: `server.js` only after the RED test run

**Interfaces:**
- Consumes: Task 2 result and job contracts.
- Produces: tests for `staticCard`, author/quote metadata, cached sidecar reads, and quote-card markup.

- [ ] **Step 1: Add failing result metadata tests**

Call `_internals.buildResultMetadata({ authorName: 'Alice', staticCard: true, quoteContext: null })` and assert it returns the safe optional metadata shape. Repeat with `staticCard: false` and a quote context, asserting the supplied values are retained and no output-path fields are changed by the helper.

- [ ] **Step 2: Add failing quote-rendering tests**

Call the exported renderer with a quote context containing HTML-significant characters and assert the generated card contains an escaped bordered quote block, author/handle text, source link, and no raw markup. Assert the unavailable-context label is used when quote-like markup is detected without nested details.

- [ ] **Step 3: Add failing cached-sidecar test**

Create a temporary output sidecar with author/static-card metadata and exercise the cache response path. Assert the JSON response includes `cached: true`, `staticCard`, and the sidecar author rather than returning only file paths.

- [ ] **Step 4: Run the focused tests and verify RED**

Run:

```powershell
node --test test/server.test.js
```

Expected: only the new metadata/quote/cache assertions fail; existing security and lifecycle tests remain green.

- [ ] **Step 5: Commit the test-only RED state**

```powershell
git add test/server.test.js
git commit -m "test: specify result metadata and quote context"
```

### Task 4: Implement result metadata, no-video clarity, quote context, and cache consistency

**Files:**
- Modify: `server.js` around oEmbed extraction, card rendering, pipeline result construction, cache lookup, and sidecar writing
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `extractQuoteContext`, `PIPELINE_STAGES`, and Task 3 tests.
- Produces: consistent fresh/cache result metadata and safe quote-card rendering.

- [ ] **Step 1: Add quote extraction and rendering inputs**

Parse nested blockquotes/links from already-fetched oEmbed HTML. Pass `quoteContext` into `renderTweetHtml`; render a bordered quoted-post block only from extracted values, escaping all text and URLs. If quote-like markup exists without enough data, render the explicit unavailable-context label and the outer post unchanged.

- [ ] **Step 2: Mark static-card outputs**

Set `staticCard` from the existing `videoPath && videoInfo` decision. Store it in the sidecar and result payload. Do not alter the five-second FFmpeg fallback, output dimensions, or audio behavior.

- [ ] **Step 3: Store and return author/quote metadata**

Write `authorName`, `quoteContext`, `staticCard`, `tweetUrl`, and output dimensions to the JSON sidecar. Add a safe sidecar reader for cache responses, with conservative defaults when older sidecars lack the new fields.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```powershell
node --test test/server.test.js
```

Expected: all result metadata, quote-rendering, cache, security, and lifecycle tests pass.

- [ ] **Step 5: Commit the result-model implementation**

```powershell
git add server.js test/server.test.js
git commit -m "feat: preserve result and quote metadata"
```

### Task 5: Add failing share and frontend asset/accessibility tests

**Files:**
- Modify: `test/server.test.js`
- Create: `test/frontend-assets.test.js`
- Modify: `public/index.html`, `public/style.css`, `public/favicon.svg` only after the RED test run

**Interfaces:**
- Consumes: Task 4 metadata and share sidecar behavior.
- Produces: failing assertions for one canonical video metadata set, static-card descriptions, favicon linkage, accessible hooks, accent contrast, and result scroll margin.

- [ ] **Step 1: Tighten share metadata tests**

Update the existing Discord-friendly share test to assert exactly one `og:video` tag set for MP4. Add a WebM case asserting one `og:video` set and no duplicate MP4 fallback tags. Add a static-card case asserting `Shareable tweet card`, `og:type=website`, and no video metadata.

- [ ] **Step 2: Add the frontend asset contract tests**

Create `test/frontend-assets.test.js` with Node `fs` assertions that:

```js
assert.match(indexHtml, /rel="icon"[^>]+href="\/favicon\.svg"/);
assert.match(indexHtml, /id="resultSummary"/);
assert.match(indexHtml, /id="retryBtn"/);
assert.match(styleCss, /--accent:\s*#0b6ca8/i);
assert.match(styleCss, /scroll-margin-top/);
assert.ok(fs.existsSync(path.join(root, 'public', 'favicon.svg')));
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```powershell
node --test test/server.test.js test/frontend-assets.test.js
```

Expected: the new share/asset assertions fail because duplicate metadata, static-card copy, favicon, new hooks, and accessible color tokens are not implemented.

- [ ] **Step 4: Commit the test-only RED state**

```powershell
git add test/server.test.js test/frontend-assets.test.js
git commit -m "test: specify share and accessibility contracts"
```

### Task 6: Implement share metadata and static frontend structure/styles

**Files:**
- Modify: `server.js` share route
- Modify: `public/index.html`
- Modify: `public/style.css`
- Create: `public/favicon.svg`
- Test: `test/server.test.js`, `test/frontend-assets.test.js`

**Interfaces:**
- Consumes: Task 5 tests and sidecar `staticCard` metadata.
- Produces: one canonical share video declaration, static-card share descriptions, accessible result/error/progress markup, and a favicon.

- [ ] **Step 1: Remove duplicate Open Graph fallback tags**

Keep the requested existing format selection and emit one `og:video`, `og:video:url`, `og:video:secure_url`, type, width, and height set for video output. Keep the selected WebM as the canonical WebM share file instead of appending a second MP4 set.

- [ ] **Step 2: Add static-card share metadata**

Read `staticCard` from the sidecar and set the description, `og:type`, and Twitter card mode accordingly. Keep escaping, canonical URL, CSP, frame-ancestor policy, and original-tweet link behavior unchanged.

- [ ] **Step 3: Add semantic UI hooks**

Add the loading step/elapsed elements, result summary, cache notice, error heading, retry button, and favicon link. Keep the existing labels, tab roles, media controls, skip link, and form structure.

- [ ] **Step 4: Apply accessible color and focus-scroll styles**

Define `--accent: #0b6ca8` and a darker hover token, replace main UI uses of `#1da1f2`, add `scroll-margin-top: 1rem` to focusable result/error sections, and preserve the reduced-motion media query.

- [ ] **Step 5: Add a simple SVG favicon**

Create a small self-contained SVG using the Tweet Giffer bird/card motif. It must not load external resources and must be referenced only through `/favicon.svg`.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```powershell
node --test test/server.test.js test/frontend-assets.test.js
npm run check
```

Expected: share metadata, asset contracts, and syntax checks pass.

- [ ] **Step 7: Commit the share and markup/style implementation**

```powershell
git add server.js public/index.html public/style.css public/favicon.svg test/server.test.js test/frontend-assets.test.js
git commit -m "feat: improve share metadata and accessible UI structure"
```

### Task 7: Add failing rendered-browser tests for progress, recovery, errors, and result messaging

**Files:**
- Create: `test/frontend-browser.test.js`
- Modify: `public/script.js` only after the RED test run

**Interfaces:**
- Consumes: Task 6 DOM IDs and the existing local Express server.
- Produces: browser-level assertions for real frontend state transitions; no production test hooks.

- [ ] **Step 1: Create the browser harness outside the default test command**

Create `test/frontend-browser.test.js` using the installed `puppeteer` package, `server.startServer({ port: 0, prewarm: false })`, temporary output/temp directories, and a clean browser page. Guard every browser test with `{ skip: process.env.TWEET_GIFFER_BROWSER_TEST !== '1' }` so the normal `npm test` run remains dependency-light. The test file must close the browser/server and delete its temporary directories in `test.after`.

- [ ] **Step 2: Write the failing result-state test**

Navigate to `/`, call the existing top-level `displayResults` function with a validated fake result containing `staticCard: true`, `cached: true`, and `authorName: 'Alice'`, then assert:

```js
assert.equal(await page.$eval('#resultHeading', node => node.textContent), 'Static tweet card ready');
assert.match(await page.$eval('#resultSummary', node => node.textContent), /no video/i);
assert.match(await page.$eval('#cacheNotice', node => node.textContent), /cache/i);
assert.match(await page.$eval('#gifImg', node => node.alt), /Alice/);
```

- [ ] **Step 3: Write the failing refresh-recovery test**

Before navigation, install a page-level fetch response for one known job ID that returns a pending status with `stepIndex: 6`, `stepCount: 6`, `elapsedMs`, and `message: 'Creating WebM...'`. Seed the namespaced local-storage record and reload. Assert loading is visible, the stage text includes `Step 6 of 6`, and the elapsed label is present.

- [ ] **Step 4: Write the failing retry/error test**

Return a safe `MEDIA_ACCESS_FAILED` response from the process endpoint, submit a valid public-shaped URL, and assert the alert contains the approved message, the retry button is visible, and the input still contains the normalized URL.

- [ ] **Step 5: Run the browser test and verify RED**

Run:

```powershell
$env:TWEET_GIFFER_BROWSER_TEST = '1'; node --test test/frontend-browser.test.js
```

Expected: the harness loads the Tweet Giffer page but fails only on the new heading/summary/cache/recovery/retry assertions, not because Chromium or the server failed to start.

- [ ] **Step 6: Commit the browser test-only RED state**

```powershell
git add test/frontend-browser.test.js
git commit -m "test: specify frontend recovery and result states"
```

### Task 8: Implement frontend progress, recovery, errors, and result behavior

**Files:**
- Modify: `public/script.js`
- Test: `test/frontend-browser.test.js`

**Interfaces:**
- Consumes: Task 2 status/error fields and Task 6 DOM IDs.
- Produces: persistent active-job restoration, stage/elapsed announcements, safe error mapping/retry, static-card/cache messaging, and author-aware media labels.

- [ ] **Step 1: Add namespaced job-storage helpers**

Implement private client helpers for reading, writing, and clearing one JSON record under `tweetGiffer.activeJob`. Validate the stored job ID with the existing UUID pattern and discard malformed records.

- [ ] **Step 2: Add stage and elapsed rendering**

Render server-provided `stepIndex`/`stepCount` and run a one-second elapsed timer from `startedAt` or the server-provided elapsed baseline. Keep the live region concise by updating one atomic status string such as `Step 6 of 6: Creating WebM... Elapsed 2m 14s.`

- [ ] **Step 3: Persist and restore jobs**

Store the job after `/api/process-tweet` returns. On `DOMContentLoaded`, restore pending/completed/failed jobs through the existing polling/result validation path. Do not clear the persisted job in `beforeunload`; clear it only on terminal completion, terminal error, explicit replacement, or confirmed expiration.

- [ ] **Step 4: Add safe client error objects and retry behavior**

Make JSON response failures retain `errorCode` alongside the message. Keep the normalized URL in the input, populate the alert, show the retry button only for `CAPACITY_FULL`, `MEDIA_ACCESS_FAILED`, and `PROCESSING_FAILED`, and resubmit the same URL through the normal form handler when activated.

- [ ] **Step 5: Add result summaries and labels**

Set the heading/summary/cache notice according to `staticCard` and `cached`. Set GIF/video/WebM accessible labels using `authorName` with a safe generic fallback. Keep optional WebM hiding and format fallback behavior unchanged.

- [ ] **Step 6: Run the browser test and verify GREEN**

Run:

```powershell
$env:TWEET_GIFFER_BROWSER_TEST = '1'; node --test test/frontend-browser.test.js
```

Expected: all progress, refresh-recovery, error/retry, static-card, cache, and descriptive-label assertions pass.

- [ ] **Step 7: Commit the frontend behavior implementation**

```powershell
git add public/script.js test/frontend-browser.test.js
git commit -m "feat: restore jobs and clarify conversion states"
```

### Task 9: Run complete automated verification and rendered Chromium QA

**Files:**
- No planned source changes; only external temporary audit artifacts under the system temp directory

**Interfaces:**
- Consumes: all implementation tasks.
- Produces: fresh evidence that fixes work together and do not regress conversion, downloads, sharing, or accessibility behavior.

- [ ] **Step 1: Run the complete automated suite**

Run:

```powershell
npm test
npm run check
docker compose config
```

Expected: zero Node test failures, syntax checks pass, and Compose config validates. If Docker runtime is unavailable, record that runtime limitation without changing Docker files.

- [ ] **Step 2: Start an isolated local audit instance**

Use external `OUTPUT_DIR` and `TEMP_DIR`, the existing bundled Chromium path, and a temporary audit directory outside the repository. Confirm `/api/health` returns HTTP 200 and capture clean server stdout/stderr separately.

- [ ] **Step 3: Validate the fixed primary journey in the in-app Browser**

Use the Browser plugin first at the actual local URL printed by `startServer`, for example `http://localhost:3000/`. Confirm page identity, meaningful DOM, no framework overlay, no relevant console errors, and a screenshot. Convert the public landscape post, observe all six stage labels plus elapsed feedback, inspect GIF/MP4/WebM playback, and download all formats.

- [ ] **Step 4: Validate fixed edge journeys**

Exercise invalid URL, unavailable post, no-video post, rate limit, capacity full, repeated cached URL, and refresh during processing. Confirm safe copy, focus target, retry visibility, static-card labeling, cache notice, and restored job state.

- [ ] **Step 5: Validate responsive and accessibility states**

Check 1366×768, 390×844, 720px CSS-equivalent zoom, keyboard tab/Enter/arrow/Home/End/Space behavior, reduced motion, contrast token values, result focus scroll position, and favicon response status.

- [ ] **Step 6: Validate share metadata locally**

Open GIF, MP4, WebM, and static-card share URLs. Assert HTTP 200, canonical/original links, one video metadata set for video formats, no video tags for static cards, escaping, CSP, and no relevant console/network failures. Do not claim Discord verification without public HTTPS.

- [ ] **Step 7: Stop the audit server and verify repository hygiene**

Stop the temporary server, remove only the explicitly created external temp directory, confirm no generated artifacts are under the repository, and run:

```powershell
git status --short --branch
git diff --check
```

Expected: only intentional source/test changes are present and there are no whitespace errors or untracked audit artifacts.

### Task 10: Final verification review

**Files:**
- Review only: all changed source/test files and the approved design/plan documents

- [ ] **Step 1: Review the diff against the approved specification**

Check each approved finding: contrast, long-wait feedback, refresh recovery, unavailable errors, no-video labeling, quote context, mobile focus, favicon, cache visibility, and duplicate share metadata.

- [ ] **Step 2: Re-run the original regression scenarios**

Run the same genuine landscape, portrait, quote-post, no-video, unavailable, cache, download, share, keyboard, mobile, zoom, and reduced-motion scenarios used in the audit. Record any remaining external limitation instead of claiming it passed.

- [ ] **Step 3: Run final completion verification**

Run `npm test`, `npm run check`, and `git diff --check` after the final review. Report exact pass/fail counts and any untested browser/deployment scope.
