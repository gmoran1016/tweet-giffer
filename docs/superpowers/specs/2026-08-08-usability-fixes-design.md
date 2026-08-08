# Tweet Giffer Usability Fixes Design

**Status:** Approved design; written specification pending user review  
**Date:** 2026-08-08  
**Repository:** Tweet Giffer, commit `38f9f2c`

## Goal

Resolve every actionable usability finding from the Chromium audit while preserving Tweet Giffer’s existing URL validation, conversion pipeline, output formats, security boundaries, and no-dependency-addition constraint.

## Scope

The implementation covers:

1. Long-running conversion feedback and refresh recovery.
2. Safe, actionable error taxonomy and retry behavior.
3. Clear labeling of static no-video results and cache hits.
4. Quote-post context preservation when available from oEmbed data.
5. WCAG-compliant interactive colors, focus positioning, live announcements, descriptive media labels, and favicon polish.
6. Unambiguous GIF/MP4/WebM share metadata.
7. Automated regression coverage plus rendered Chromium verification.

The implementation will not add authentication, a persistent database, a public deployment, a Discord test deployment, a new frontend framework, or new runtime dependencies.

## Constraints

- Keep the Node/Express architecture and the single-file backend organization.
- Keep `ffmpeg-static`; do not introduce `ffprobe`.
- Keep Windows-safe path and file-URL handling.
- Keep output paths restricted to `/outputs/<uuid>.<extension>`.
- Keep the existing rate-limit and concurrency limits.
- Do not expose yt-dlp, FFmpeg, filesystem, or upstream exception details to users.
- Preserve current API clients by adding optional response fields rather than removing fields.
- Use the existing Node test runner and installed Chromium/Puppeteer for verification.

## Design

### 1. Shared result and job model

The server will retain the existing `videoId`, `gif`, `video`, and `webm` fields and add optional metadata:

```js
{
  videoId: "uuid",
  gif: "/outputs/uuid.gif",
  video: "/outputs/uuid.mp4",
  webm: "/outputs/uuid.webm",
  cached: false,
  staticCard: false,
  authorName: "Author",
  quoteContext: {
    authorName: "Quoted author",
    handle: "quotedhandle",
    tweetUrl: "https://x.com/quotedhandle/status/123",
    text: "Quoted text"
  }
}
```

`webm` remains nullable. `cached` is true only for a cache response. `staticCard` is true when the source post contains no downloadable video and the output is the five-second image-card fallback. `authorName` and `quoteContext` are optional and are treated as untrusted text by the client.

The output JSON sidecar will store the same user-safe metadata needed by `/share/:videoId`, including `staticCard` and quote context. Cache responses will read this sidecar when available so cached and freshly completed results render consistently.

Each job will also track:

- `createdAt` and `startedAt` timestamps.
- `stepIndex` and `stepCount` for the six known pipeline stages.
- The latest safe stage message.
- Existing result/error/errorCode state and TTL behavior.

Status and SSE payloads will expose `stepIndex`, `stepCount`, and `elapsedMs` without exposing command output or upstream errors.

### 2. Processing feedback and refresh recovery

The six stages will be represented consistently as:

1. Fetching tweet metadata
2. Downloading video
3. Rendering tweet card
4. Compositing video
5. Creating GIF
6. Creating WebM

The client will display the current stage as “Step N of 6” and an elapsed timer. It will not fabricate a percentage because the stages have materially different durations.

After the process endpoint returns a `jobId`, the client will store `{ jobId, url, startedAt }` under a namespaced local-storage key. On page load it will query the stored job:

- Pending job: restore the loading state and continue polling.
- Completed job: display the result and clear the stored job.
- Failed job: show the safe error and clear the stored job.
- Missing/expired job: clear the stored job and show a one-time message that the previous conversion expired.

Refreshing will no longer discard the only client reference to an active server job. A normal successful completion, explicit replacement by a new submission, or terminal error clears the stored job.

### 3. Error taxonomy and retry UX

The server will use these stable safe error codes:

| Code | HTTP | User message | Retry control |
|---|---:|---|---|
| `INVALID_URL` | 400 | `Enter a valid public Twitter/X post URL.` | No |
| `RATE_LIMITED` | 429 | `Too many requests. Please wait a minute and try again.` | No |
| `CAPACITY_FULL` | 503 | `Conversion capacity is full. Please try again later.` | Yes |
| `TWEET_UNAVAILABLE` | 502 | `This post is unavailable, private, or no longer exists. Check the URL and try another public post.` | No |
| `MEDIA_ACCESS_FAILED` | 502 | `The post was found, but its media could not be accessed. Check that it is public and try again.` | Yes |
| `PROCESSING_FAILED` | 500 | `We couldn't finish this conversion. Please try again.` | Yes |

The server will classify oEmbed 401/403/404 responses as `TWEET_UNAVAILABLE`, non-video yt-dlp messages will continue through the static-card path, and other media/upstream failures will use `MEDIA_ACCESS_FAILED` or `PROCESSING_FAILED` without leaking diagnostics.

The error section will include an accessible heading, the safe message, and a retry button only for retryable errors. The submitted normalized URL remains in the input. Invalid client-side URL errors continue to focus the input; server errors focus the alert and expose the retry action when appropriate.

### 4. Result clarity and quote context

The result heading and summary will vary by result type:

- Normal video: `Your tweet is ready!` and `Video conversion complete.`
- Static fallback: `Static tweet card ready` and `This post has no video. Downloads contain a five-second animated card with no audio.`
- Cache hit: add a non-blocking `Loaded from cache.` status.

Preview image and video labels will include the author when available, while retaining safe fallbacks.

The backend will parse additional blockquote/link context from the oEmbed HTML without making an unauthenticated second content lookup. When nested quote data is present, the rendered card will show it in a bordered quoted-post block with author, handle, text, and source link. When quote-like markup is detected but details are unavailable, the card will show a clear `Quoted post content unavailable` label and preserve the outer post identity rather than silently flattening the context.

### 5. Accessibility and visual polish

- Replace the main UI’s failing `#1da1f2` accent with `#0b6ca8` and a darker hover color, preserving the existing 3px focus ring.
- Route primary buttons, secondary controls, active tabs, borders, and share controls through the new color tokens.
- Add `scroll-margin-top` to the focusable result and error sections so automatic focus does not hide their headings on mobile.
- Keep the current skip link, semantic landmarks, tab roles, keyboard tab movement, and reduced-motion behavior.
- Add `aria-atomic`/stage text updates that announce the current step and elapsed time without flooding the live region.
- Add a small `public/favicon.svg` and reference it from `public/index.html`.

### 6. Share metadata

The share page will continue to select the requested existing format, but will emit exactly one canonical `og:video` declaration set when the selected output is video. The duplicate MP4 fallback declaration will be removed. GIF shares remain image shares.

Static-card sidecars will use `Shareable tweet card` rather than `Shareable tweet video with audio`. Video shares retain the audio description only when the result is a real video. Existing origin allowlisting, canonical URL handling, CSP, escaping, and Discord frame-ancestor policy remain unchanged.

### 7. Testing strategy and acceptance criteria

Tests will be written before production changes and must fail for the audited behavior. Coverage will include:

- Safe error-code classification and non-leakage of upstream details.
- Job status stage indices, elapsed fields, and terminal state payloads.
- Result metadata for normal, cached, static-card, and quote-context results.
- Share metadata containing exactly one video declaration set and correct static-card descriptions.
- Frontend validation of optional metadata and static-card result messaging.
- Favicon presence and source-level accessibility hooks.

Acceptance requires:

- `npm test` passes with zero failures.
- `npm run check` passes.
- A genuine landscape conversion reaches all six stages and displays elapsed/stage feedback.
- A refresh during an active conversion restores the job or clearly handles expiration.
- A genuine no-video post is clearly identified as a static card.
- Unavailable and retryable errors show the correct safe copy and controls.
- GIF, MP4, and WebM previews/downloads remain functional.
- Desktop, mobile-size, 200%-equivalent, keyboard, and reduced-motion Chromium checks pass.
- A clean browser run has no application console errors or favicon 404.
- The worktree contains no generated screenshots, traces, downloads, or temporary files.

## Non-goals and remaining external verification

No public HTTPS deployment will be created as part of this change. Discord embedding will remain an explicitly unverified external integration until a public deployment is available. Firefox/WebKit and screen-reader testing remain separate follow-up validation work.
