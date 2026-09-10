# Tweet Giffer interface polish and share-surface redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing Tweet Giffer utility into a distinctive, accessible conversion workspace without changing its conversion, security, caching, output, or deployment contracts.

**Architecture:** Keep the vanilla HTML/CSS/JavaScript frontend and Node/Express backend. Introduce a shared visual token layer in `public/style.css`, add semantic state hooks in `public/index.html`/`public/script.js`, and give the server-rendered share route a small branded document while leaving the generated X-like tweet card intentionally separate. Every behavior change gets a failing source or browser test before production code is changed.

**Tech Stack:** Node.js 22.12+, Express 5, vanilla HTML/CSS/JavaScript, Node’s built-in test runner, Puppeteer, FFmpeg, yt-dlp.

**Spec:** `docs/superpowers/specs/2026-09-10-interface-redesign-design.md`

## Global Constraints

- Keep the Node/Express backend and vanilla HTML/CSS/JavaScript frontend; do not migrate frameworks.
- Do not add runtime dependencies or external font/image services.
- Preserve `/api/process-tweet`, `/api/status/:jobId`, `/api/progress/:jobId`, UUID-named files under `/outputs/`, and existing result fields.
- Preserve URL validation, origin allowlisting, CSP, output limits, cache behavior, job recovery, FFmpeg/yt-dlp behavior, and Windows-safe path handling.
- Keep `ffmpeg-static`; do not introduce `ffprobe`.
- Keep the exported tweet card’s X-like typography and layout intentionally separate from the app shell.
- Do not invent legal policy language or publish a public deployment. Add only an accurate processing/retention note to the local UI.
- Do not commit screenshots, traces, downloads, or temporary browser artifacts.
- Use `apply_patch` for source edits and stage only intended files if the work is later committed.

### Task 1: Add regression tests for the approved interface contract

**Files:**
- Modify: `test/frontend-assets.test.js`
- Modify: `test/frontend-browser.test.js`
- Modify: `test/server.test.js`

**Interfaces:**
- Consumes: Existing `public/index.html`, `public/style.css`, `public/script.js`, and the exported `app`/`startServer` API.
- Produces: Failing tests that define the new brand metadata, state hooks, copy-failure behavior, mobile layout, and branded route fallbacks.

- [x] **Step 1: Add source assertions for the new homepage hooks**

Add a test named `frontend exposes the redesign state hooks and sharing metadata` in `test/frontend-assets.test.js`. Read `public/index.html` and `public/style.css` using the existing `fs` setup and assert the following concrete contract:

```js
assert.match(indexHtml, /<meta name="description" content="[^"]+">/);
assert.match(indexHtml, /property="og:image" content="\/social-card\.svg"/);
assert.match(indexHtml, /class="brand-mark"[^>]+src="\/favicon\.svg"/);
assert.match(indexHtml, /id="urlError"/);
assert.match(indexHtml, /id="loadingSteps"/);
assert.match(indexHtml, /data-progress-step="6"/);
assert.match(indexHtml, /id="shareUrlInput"/);
assert.match(indexHtml, /id="downloadVideoBtn" class="btn-primary/);
assert.match(styleCss, /font-variant-numeric:\s*tabular-nums/);
assert.doesNotMatch(styleCss, /transition\s*:\s*all/i);
```

- [x] **Step 2: Add a browser test for field-error association**

Append a test named `invalid URLs expose an associated inline field error` to `test/frontend-browser.test.js`. Navigate to the local page, fill `#tweetUrl` with `https://example.com/status/123`, click `#processBtn`, and assert that `#tweetUrl` has `aria-invalid="true"`, its `aria-describedby` contains `urlError`, `#urlError` is visible with the rejected-host message, and focus remains on `#tweetUrl`.

- [x] **Step 3: Add a browser test for the progress rail**

Append a test named `loading progress marks completed and active stages` that navigates to the page and evaluates the existing global `showLoading` function with `{ stepIndex: 6, stepCount: 6, elapsedMs: 12500 }`. Assert that the sixth progress item has `aria-current="step"`, five earlier items have the completed state, the loading status contains `Step 6 of 6`, and the elapsed text contains `12s`.

- [x] **Step 4: Add a browser test for copy failure fallback**

Append a test named `copy failure exposes a selectable share URL` that calls the existing global `displayResults` with `videoId: 'c23e4567-e89b-42d3-a456-426614174000'` and matching local output paths, replaces `navigator.clipboard.writeText` with a rejected function, clicks `#copyLinkBtn`, and asserts that the manual share field is visible, readonly, and contains `/share/c23e4567-e89b-42d3-a456-426614174000?f=gif`. Keep the test local; it must not submit a real tweet URL or call an external service.

- [x] **Step 5: Add a browser test for the mobile first viewport**

Append a test named `mobile homepage has no horizontal overflow` that sets the Puppeteer page viewport to `{ width: 390, height: 844 }`, reloads the page, and asserts `document.documentElement.scrollWidth === 390` and that the primary form button is visible with a client height of at least 44 pixels.

- [x] **Step 6: Add server tests for branded human and API 404s**

Add tests in `test/server.test.js` that start the app on an ephemeral port with `prewarm: false`:

```js
const human404 = await fetch(`${base}/route-that-does-not-exist`);
assert.equal(human404.status, 404);
assert.match(await human404.text(), /Tweet Giffer/);
assert.match(await human404.text(), /Back to the tool/);

const api404 = await fetch(`${base}/api/route-that-does-not-exist`, {
  headers: { Accept: 'application/json' },
});
assert.equal(api404.status, 404);
assert.equal(api404.headers.get('content-type').includes('application/json'), true);
assert.deepEqual(await api404.json(), { error: 'Not found', errorCode: 'NOT_FOUND' });
```

Use the existing test lifecycle helpers and do not hardcode port 3000.

- [x] **Step 7: Run the focused tests and verify they fail for the intended reasons**

Run:

```powershell
npm test -- test/frontend-assets.test.js test/frontend-browser.test.js test/server.test.js
```

Expected: the pre-existing tests continue to run, while the new assertions fail because the new IDs, metadata, progress state, manual share field, and route renderers do not exist yet. If a test errors because of a test typo or setup issue instead of a missing behavior, correct the test before proceeding.

### Task 2: Add the shared brand asset and semantic homepage structure

**Files:**
- Create: `public/social-card.svg`
- Modify: `public/index.html`

**Interfaces:**
- Consumes: Existing `/favicon.svg` and the DOM IDs referenced by `public/script.js`.
- Produces: A semantic initial page with shared branding, product explanation, progress-stage hooks, result action hierarchy, and accessible error/share fields.

- [x] **Step 1: Add the local social-card SVG**

Create `public/social-card.svg` as a 1200×630 local Open Graph asset. Use the same warm-neutral canvas, muted teal accent, and favicon play/chat mark as the app shell. Include the text `Tweet Giffer` and `Turn public posts into shareable motion cards` as SVG text. Do not reference external fonts, images, or gradients that recreate the old purple/blue treatment.

Use this complete asset structure:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-labelledby="title description">
  <title id="title">Tweet Giffer</title>
  <desc id="description">Turn public posts into shareable motion cards</desc>
  <rect width="1200" height="630" fill="#f2eee6"/>
  <circle cx="1030" cy="-20" r="260" fill="#e4f1ee"/>
  <circle cx="1050" cy="650" r="180" fill="#ebe6dc"/>
  <rect x="96" y="96" width="86" height="86" rx="24" fill="#126c74"/>
  <path fill="#fffdf8" d="M118 120h42a9 9 0 0 1 9 9v24a9 9 0 0 1-9 9h-16l-11 8v-8h-15a9 9 0 0 1-9-9v-24a9 9 0 0 1 9-9Zm9 12v14l14-7-14-7Z"/>
  <text x="214" y="160" fill="#1f292d" font-family="Georgia, Times New Roman, serif" font-size="72" font-weight="700">Tweet Giffer</text>
  <text x="100" y="330" fill="#1f292d" font-family="Segoe UI, Arial, sans-serif" font-size="44" font-weight="600">Turn public posts into</text>
  <text x="100" y="390" fill="#126c74" font-family="Segoe UI, Arial, sans-serif" font-size="44" font-weight="600">shareable motion cards.</text>
  <text x="100" y="510" fill="#627076" font-family="Segoe UI, Arial, sans-serif" font-size="25">GIF · MP4 · WebM · audio preserved in video formats</text>
</svg>
```

- [x] **Step 2: Replace the homepage header and form wrapper**

In `public/index.html`, preserve the existing `<main id="mainContent">` and form IDs, but replace the centered header copy with:

```html
<header class="brand-header">
  <div class="brand-lockup">
    <img class="brand-mark" src="/favicon.svg" alt="" width="48" height="48">
    <div>
      <p class="eyebrow">Media utility</p>
      <h1>Tweet Giffer</h1>
    </div>
  </div>
  <p class="subtitle">Turn a public X post into a shareable motion card.</p>
</header>
```

Keep the page title, favicon, skip link, and `mainContent` target intact.

- [x] **Step 3: Add the intro and tool panels**

Wrap the input section and a new visible intro section in `.workspace-grid`. The intro section must contain a visible heading and three concrete points: `GIF, MP4, or WebM`, `Audio stays with video formats`, and `Files are removed after 24 hours`. The tool section must retain `id="tweetForm"`, `id="tweetUrl"`, `id="processBtn"`, and `id="urlHint"`, while changing the visible heading to `Create a motion card` and the button label to `Create card`.

- [x] **Step 4: Add semantic loading-stage markup**

Inside `#loadingSection`, retain `#loadingStatus` and `#loadingElapsed`, then add a `#loadingSteps` list with exactly six `role="listitem"` elements, each carrying `data-progress-step="1"` through `data-progress-step="6"` and the labels `Fetch post`, `Download media`, `Render card`, `Composite video`, `Create GIF`, and `Create WebM`. Add `#loadingNote` with the copy `Keep this tab open. Refreshing is safe while the conversion runs.`

- [x] **Step 5: Add result action hierarchy and manual share fallback markup**

Keep the existing output button IDs, but assign `btn-primary` to `#downloadVideoBtn`, `btn-secondary` to GIF/WebM, and `btn-tertiary` to the share action. Add `#downloadVideoNote` for the dynamic `with audio`/`no audio` note. Change the copy action label to `Copy share link`.

Inside `#shareSection`, retain the live status wrapper and add:

```html
<p id="shareMessage"></p>
<div id="manualShareField" class="manual-share hidden">
  <label for="shareUrlInput">Share URL</label>
  <input id="shareUrlInput" type="text" readonly spellcheck="false">
</div>
```

- [x] **Step 6: Add the inline field-error hook and accurate footer note**

Change the URL input’s `aria-describedby` to include `urlError`, add a hidden `<p id="urlError" class="field-error"></p>` directly after the URL hint, and keep the global error section for server failures. Replace the exclamation-mark success heading with sentence case and change the footer to state that processing usually takes 30–60 seconds and generated files are removed after 24 hours.

- [x] **Step 7: Run the source tests and inspect only expected behavior failures**

Run:

```powershell
npm test -- test/frontend-assets.test.js
```

Expected: the new source assertions for metadata, progress markup, manual share markup, and primary result action pass; browser and server behavior tests remain red until their implementation tasks are complete.

### Task 3: Implement frontend state semantics and micro-interactions

**Files:**
- Modify: `public/script.js`
- Test: `test/frontend-browser.test.js`

**Interfaces:**
- Consumes: `#loadingSteps`, `#urlError`, `#manualShareField`, `#shareUrlInput`, `#downloadVideoNote`, and the existing progress/result functions.
- Produces: `updateProgressRail(stepIndex, stepCount)`, field-error lifecycle behavior, accessible result metadata, and copy success/failure behavior without changing the API payload contract.

- [x] **Step 1: Add progress-rail state updates**

Cache the six `[data-progress-step]` elements and implement `updateProgressRail(stepIndex, stepCount)` so it clamps the active step to the known range, sets `data-state="complete"` on earlier stages, `data-state="active"` and `aria-current="step"` on the active stage, and `data-state="upcoming"` on later stages. Remove `aria-current` from non-active stages. Call it from `showLoading`, `pollForResult`, and the refresh restore path.

- [x] **Step 2: Add field-error lifecycle helpers**

Implement `clearFieldError()` and `setFieldError(message)` in `public/script.js`. `setFieldError` writes text to `#urlError`, removes its `hidden` class, sets `#tweetUrl` to `aria-invalid="true"`, and ensures `aria-describedby` contains `urlHint urlError`. `clearFieldError` hides the message, sets `aria-invalid="false"`, and restores `aria-describedby="urlHint"`. Call `clearFieldError()` when a new submission starts and when a retry begins. For `INVALID_URL`, call `setFieldError` and return focus to the input; for server-side error codes, clear the field error and focus the global alert.

- [x] **Step 3: Update progress and elapsed announcements**

Change `formatProgress`/`showLoading` usage so the existing visible/live status includes `Step N of 6` followed by the safe stage message when stage data exists. Keep `loadingElapsed` visible but `aria-hidden` to avoid duplicate announcements, and add `font-variant-numeric: tabular-nums` in CSS rather than changing the text format.

- [x] **Step 4: Update result labels and action hierarchy state**

In `displayResults`, remove the result-heading exclamation mark, set `#downloadVideoNote` to `with audio` for real video results and `no audio` for static cards, and keep WebM hiding/selection behavior unchanged. Ensure `selectTab` still pauses inactive players and keeps roving `tabindex`.

- [x] **Step 5: Implement the selectable copy-failure fallback**

In the copy handler, populate `#shareUrlInput` with the generated share URL every time. On success, hide `.manual-share` and set `#shareMessage` to `<FORMAT> share link copied.`. On failure, show `.manual-share` and set `#shareMessage` to `Copy this link manually.`. Keep the current clipboard-first strategy and fallback `document.execCommand('copy')`; do not expose a URL through `innerHTML`.

- [x] **Step 6: Run the browser tests and verify the new behavior passes**

Run:

```powershell
$env:TWEET_GIFFER_BROWSER_TEST='1'; node --test test/frontend-browser.test.js
```

Expected: all existing and newly added frontend browser tests pass. If a test fails, inspect the actual DOM state and correct production code rather than weakening the assertion.

### Task 4: Replace the generic shell with the approved visual system

**Files:**
- Modify: `public/style.css`

**Interfaces:**
- Consumes: Semantic classes and IDs from `public/index.html` plus existing hidden/result/loading/error states.
- Produces: Warm neutral shell, coherent typography, responsive workspace, precise transitions, accessible focus/disabled states, and visual progress/result hierarchy.

- [x] **Step 1: Add shared tokens and root rendering rules**

Replace the existing purple/blue body gradient and scattered colors with one token set:

```css
:root {
  --canvas: #f2eee6;
  --surface: #fffdf8;
  --surface-raised: #ffffff;
  --surface-muted: #ebe6dc;
  --ink: #1f292d;
  --muted: #627076;
  --accent: #126c74;
  --accent-strong: #0e5057;
  --accent-soft: #e4f1ee;
  --success: #286a4d;
  --danger: #9a3d37;
  --shadow-shell: 0 24px 70px rgba(40, 51, 49, 0.16), 0 2px 10px rgba(40, 51, 49, 0.08);
  --shadow-control: 0 1px 2px rgba(31, 41, 45, 0.08), 0 8px 18px rgba(31, 41, 45, 0.08);
}

html {
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  scroll-behavior: smooth;
}
```

Use a local readable sans stack for body text and `Georgia, "Times New Roman", serif` for display headings. Set `font: inherit` on `button`, `input`, and `select`. Apply `text-wrap: balance` to headings, `text-wrap: pretty` to short copy, and `font-variant-numeric: tabular-nums` to `.loading-elapsed`.

- [x] **Step 2: Build the desktop workspace layout**

Set `.container` to a constrained `max-width` between 1100px and 1180px with a warm surface, 28px outer radius, responsive padding, and the layered shell shadow. Use `.workspace-grid { display: grid; grid-template-columns: minmax(0, 0.9fr) minmax(360px, 1.1fr); }` with an intentional gap and left-aligned content. Keep the result/loading/error sections full width below the grid.

- [x] **Step 3: Style the brand, intro panel, and form panel**

Use the favicon image at 48px with an inset neutral outline, a small sentence-case `.eyebrow`, a display heading with negative tracking, and a readable subtitle width. Style the intro panel with a muted surface and a three-item feature list. Style the tool panel as the raised surface; use inner radius 20px inside the outer shell rather than repeating the outer 28px radius.

- [x] **Step 4: Style controls with explicit interaction properties**

Give the URL field and all buttons/selects a minimum height of 44px. Use explicit transitions such as `background-color, color, border-color, box-shadow, transform, scale`; never `transition: all`. Add hover lift only through `transform`, visible `:focus-visible` rings, `:active:not(:disabled) { scale: 0.96; }`, and disabled styling. Use a filled primary action, quiet secondary actions, and a text/tertiary share action.

- [x] **Step 5: Style loading, progress, result, share, and error states**

Create a composed loading surface with a six-stage horizontal rail on desktop and stacked rail on narrow screens. Use small completed markers, one active marker, and a quiet upcoming state. Give result media a raised frame and a neutral inset image outline. Use a two-column action grid with MP4 spanning the primary position, and collapse to one column below 560px. Style manual share fallback as a readonly field, not a paragraph URL. Keep error colors accessible and use a restrained surface treatment rather than a generic large red box.

- [x] **Step 6: Add responsive and reduced-motion rules**

At `max-width: 820px`, collapse the workspace to one column. At `max-width: 560px`, use `padding: 10px`, a 20px shell radius, full-width buttons, a single-column action layout, and a compact progress rail. Use `min-height: 100dvh` instead of `100vh`. Preserve the existing reduced-motion media query and disable transforms/animations there.

- [x] **Step 7: Run static checks and inspect the stylesheet for regressions**

Run:

```powershell
npm run check
rg -n -i 'linear-gradient|transition\s*:\s*all|font-family:\s*Arial|height:\s*100vh' public/style.css
```

Expected: syntax passes; the old purple linear gradient, `transition: all`, Arial control declarations, and `height: 100vh` are absent from the app shell. The generated tweet card’s separate server template is intentionally not part of this stylesheet check.

### Task 5: Brand the human-facing share page and route fallbacks

**Files:**
- Modify: `server.js`
- Modify: `public/index.html`
- Modify: `test/server.test.js`

**Interfaces:**
- Consumes: Existing share metadata selection, `resolvePublicBase`, output existence checks, CSP, and `escapeHtml`.
- Produces: Branded share HTML, safe human 404s, JSON API 404s, and unchanged crawler metadata/output selection.

- [x] **Step 1: Add a server-side public-page renderer**

Add a helper near the share route:

```js
const PUBLIC_PAGE_STYLES = `<style>
:root { color-scheme: light; font-family: "Segoe UI", Arial, sans-serif; color: #1f292d; background: #f2eee6; }
* { box-sizing: border-box; }
body { min-height: 100dvh; margin: 0; padding: 24px; display: grid; place-items: center; background: #f2eee6; }
.public-shell { width: min(760px, 100%); padding: clamp(24px, 5vw, 56px); border-radius: 28px; background: #fffdf8; box-shadow: 0 24px 70px rgba(40, 51, 49, .16), 0 2px 10px rgba(40, 51, 49, .08); text-align: center; }
.eyebrow { margin: 0 0 10px; color: #126c74; font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
h1 { margin: 0; font-family: Georgia, "Times New Roman", serif; font-size: clamp(32px, 6vw, 56px); line-height: 1; letter-spacing: -.04em; text-wrap: balance; }
.message { max-width: 48ch; margin: 18px auto 28px; color: #627076; line-height: 1.6; text-wrap: pretty; }
.media { max-width: 100%; margin: 24px auto; overflow: hidden; border-radius: 20px; box-shadow: 0 1px 2px rgba(31, 41, 45, .08), 0 8px 18px rgba(31, 41, 45, .08); }
.media img, .media video { display: block; width: 100%; max-width: 100%; height: auto; outline: 1px solid rgba(0, 0, 0, .1); outline-offset: -1px; }
.actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; }
.actions a { min-height: 44px; display: inline-flex; align-items: center; justify-content: center; padding: 11px 18px; border-radius: 12px; background: #126c74; color: #fffdf8; font-weight: 700; text-decoration: none; transition: background-color 150ms ease-out, box-shadow 150ms ease-out, transform 150ms ease-out, scale 150ms ease-out; }
.actions a:hover { background: #0e5057; transform: translateY(-1px); box-shadow: 0 8px 18px rgba(18, 108, 116, .18); }
.actions a:active { scale: .96; }
.secondary { display: inline-block; margin-top: 18px; color: #126c74; font-weight: 600; }
@media (max-width: 560px) { body { padding: 10px; } .public-shell { border-radius: 20px; padding: 24px 18px; } .actions { flex-direction: column; } .actions a { width: 100%; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: .01ms !important; animation-duration: .01ms !important; } }
</style>`;

function renderPublicPage({ title, eyebrow, message, actionHref = '/', actionLabel = 'Back to the tool', mediaHtml = '', secondaryHtml = '' }) {
  const safeActionHref = escapeHtml(actionHref);
  return `<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f2eee6">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  ${PUBLIC_PAGE_STYLES}
</head><body>
  <main class="public-shell">
    <p class="eyebrow">${escapeHtml(eyebrow)}</p>
    <h1>${escapeHtml(title)}</h1>
    <p class="message">${escapeHtml(message)}</p>
    ${mediaHtml ? `<div class="media">${mediaHtml}</div>` : ''}
    <div class="actions"><a href="${safeActionHref}">${escapeHtml(actionLabel)}</a>${secondaryHtml}</div>
  </main>
</body></html>`;
}
```

The complete inline CSS must use the same token values as the homepage, keep media constrained to `max-width: 100%`, use a 44px action, and use `textContent`-equivalent escaped values through `escapeHtml`. Do not include external resources.

- [x] **Step 2: Wrap the existing share media in the branded page**

Keep the existing `og:*`, `twitter:*`, canonical, media URL, MIME fallback, CSP, `frame-ancestors`, and original-tweet link logic. Replace only the unstyled `<body>` output with the renderer’s branded shell. The shell must contain the media element, an `Open media file` action, a `Back to the tool` action, and the original tweet link when available. Preserve `res.removeHeader('X-Frame-Options')` for share pages.

- [x] **Step 3: Add safe route fallbacks after all known routes**

Change invalid/missing share responses to use the branded renderer with the existing status codes. Add a final middleware before the error handler:

```js
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found', errorCode: 'NOT_FOUND' });
  }
  return res.status(404).type('html').send(renderPublicPage({
    title: 'Page not found · Tweet Giffer',
    eyebrow: '404',
    message: 'That page is not available. The conversion tool is ready when you are.',
  }));
});
```

Do not turn unknown API requests into HTML and do not add a broad Host-header trust path.

- [x] **Step 4: Add homepage metadata without hardcoding a deployment hostname**

Add static description, theme-color, `og:title`, `og:description`, `og:image` pointing to `/social-card.svg`, and `twitter:card` metadata to `public/index.html`. Keep the canonical link relative or omit it when no configured public origin exists; do not hardcode a production hostname into the source.

- [x] **Step 5: Run the server tests and verify metadata behavior is unchanged**

Run:

```powershell
node --test test/server.test.js
```

Expected: all existing share metadata, origin restriction, WebM fallback, static-card, escaping, lifecycle, and new route fallback tests pass. Inspect the generated share HTML for exactly the existing video declaration set and the new branded body.

### Task 6: Expand regression coverage for final UI details

**Files:**
- Modify: `test/frontend-assets.test.js`
- Modify: `test/frontend-browser.test.js`
- Modify: `test/server.test.js`

**Interfaces:**
- Consumes: Completed frontend and server behavior from Tasks 2–5.
- Produces: Durable checks for the specific audit findings that are easy to regress during future styling edits.

- [x] **Step 1: Add source assertions for control typography and motion rules**

Assert that `public/style.css` contains `font: inherit` for form controls, a 44px minimum control height, `scale: 0.96` or an equivalent `scale(0.96)` active rule, explicit transition properties, `text-wrap: balance`, `text-wrap: pretty`, and `min-height: 100dvh`.

- [x] **Step 2: Add browser assertions for action hierarchy and mobile geometry**

Use `displayResults` with valid GIF/MP4/WebM paths and assert that the MP4 button has the primary class, the GIF/WebM buttons remain visible, the share group remains usable, and the 390px viewport has no horizontal overflow. Restore the default page viewport when the test finishes.

- [x] **Step 3: Add browser assertions for reduced motion and console health**

Use Puppeteer’s `page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])`, reload the page, and assert that the page has no runtime errors while the reduced-motion stylesheet is active. Keep console collection limited to `error` and `warn` messages from the application page.

- [x] **Step 4: Run the full test suite with browser checks enabled**

Run:

```powershell
$env:TWEET_GIFFER_BROWSER_TEST='1'; npm test
```

Expected: zero failures, zero skipped tests, and all server/frontend/browser checks pass.

### Task 7: Execute rendered QA and completion verification

**Files:**
- No committed file changes.

**Interfaces:**
- Consumes: The completed implementation and test suite.
- Produces: Fresh browser evidence for the initial screen, invalid URL state, loading progress, result actions, share fallback, and mobile geometry.

- [x] **Step 1: Start the local app on the documented host**

Run `npm start` from the repository root and verify `http://localhost:3000/` responds. Keep the process isolated and stop it after browser QA.

- [x] **Step 2: Verify the desktop target flow**

The flow under test is: app loads → first meaningful screen renders → a malformed URL is submitted → the inline field error is shown and associated with the input. Capture a desktop screenshot and inspect the page title, DOM snapshot, and console warnings/errors.

- [x] **Step 3: Verify the loading and result states**

Use the existing local browser-test stubs or page-level test hooks to show step 6 progress and a valid result. Confirm the progress rail, elapsed timer, MP4 primary action, alternate downloads, tab switching, focus movement, and copy-success message.

- [x] **Step 4: Verify the copy-failure and share-page states**

Force the local clipboard failure path and confirm the readonly URL field is visible and selectable. Open a fixture-backed or test-backed share response and confirm the branded shell, media action, original tweet link, canonical metadata, and preserved CSP behavior.

- [x] **Step 5: Verify the 390×844 mobile target**

Use a temporary 390×844 viewport. Confirm no horizontal overflow, readable wrapping, 44px controls, stacked workspace panels, compact progress rail, and no clipped share/result actions. Reset the browser viewport before finishing.

- [x] **Step 6: Run the final command set**

Run all of the following after the code and browser checks are complete:

```powershell
$env:TWEET_GIFFER_BROWSER_TEST='1'; npm test
npm run check
npm audit --omit=dev --audit-level=high
docker compose config
git diff --check
git status --short --branch
```

Expected: all commands exit successfully, `npm test` reports zero failures and zero skipped tests, the audit reports no high-severity vulnerabilities, Compose renders successfully, the diff has no whitespace errors, and only intended source/spec/plan files are present.

- [x] **Step 7: Review the final diff before claiming completion**

Run `git diff --stat` and `git diff -- public/index.html public/style.css public/script.js server.js public/social-card.svg test/frontend-assets.test.js test/frontend-browser.test.js test/server.test.js`. Confirm no API fields were removed, no security/origin/CSP protections were weakened, no generated artifacts are included, and every user-visible audit finding has an implementation or an explicit spec non-goal.
