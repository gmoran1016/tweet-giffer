# Tweet Giffer interface polish and share-surface redesign

**Status:** Direction approved; written specification pending user review
**Date:** 2026-09-10
**Repository:** Tweet Giffer

## Goal

Turn the existing Tweet Giffer utility into a more distinctive, calm, and confidence-building conversion workspace while preserving the current conversion pipeline, output contracts, security boundaries, and X-like exported tweet-card fidelity.

## Scope

The implementation covers:

1. A coherent visual system for the home screen: brand mark, typography, color, surfaces, spacing, shadows, and responsive layout.
2. Clearer product communication before submission, including supported formats, audio behavior, processing expectations, and automatic output cleanup.
3. A visual six-stage progress state that uses the existing job progress data.
4. Stronger result action hierarchy: MP4 as the primary download, GIF/WebM as alternatives, and sharing as a tertiary action.
5. Accessible field-error association, retry messaging, copy-link feedback, focus management, minimum hit areas, tabular elapsed time, reduced motion, and tactile press states.
6. A branded human-facing share page, homepage sharing metadata, and helpful branded 404/unsupported-route responses.
7. Regression tests and real Chromium verification at desktop and mobile sizes.

The exported tweet card remains visually faithful to the source platform. Its internal card styling may be cleaned up only where that does not change the intended tweet-card appearance.

## Constraints and non-goals

- Keep the Node/Express backend and vanilla HTML/CSS/JavaScript frontend; do not migrate frameworks.
- Do not add runtime dependencies or external font/image services.
- Preserve `/api/process-tweet`, `/api/status/:jobId`, `/api/progress/:jobId`, `/outputs/<uuid>.<extension>`, and existing result fields.
- Preserve URL validation, origin allowlisting, CSP, output limits, cache behavior, job recovery, FFmpeg/yt-dlp behavior, and Windows-safe path handling.
- Keep `ffmpeg-static`; do not introduce `ffprobe`.
- Keep the exported tweet card’s X-like typography and layout intentionally separate from the app shell rather than forcing app branding into the generated media.
- Do not invent legal policy language or publish a public deployment. Add only an accurate processing/retention note to the local UI.
- Do not commit screenshots, traces, downloads, or temporary browser artifacts.

## Design

### 1. Home workspace

Replace the single centered white form card and saturated purple/blue linear gradient with a warm neutral application shell and one muted teal accent. Use subtle radial ambient lighting rather than a loud gradient, a tinted multi-layer shadow, and a constrained workspace that feels like a small media tool rather than a marketing template.

The header will use the existing `public/favicon.svg` as the visible brand mark so the wordmark and favicon share one identity. Use a characterful local font stack without downloading fonts: a readable sans-serif body stack and a restrained serif display face for the main title and short section headings. Apply balanced heading wrapping, pretty short-copy wrapping, font smoothing, and tabular numerals for the elapsed timer.

The main content will use a responsive two-column workspace on wide screens:

- An intro panel explains the value in concrete language: one public post becomes a tweet-styled GIF, MP4, or WebM card; video formats retain audio; generated files are removed after 24 hours.
- A tool panel contains the URL form, a visible heading, the accepted host hint, and the primary submission action.

Below the workspace, loading, result, and error sections remain in the same document flow so focus moves to the state that needs attention. On narrow screens the columns collapse into a single readable stack without horizontal overflow.

### 2. Conversion feedback

Add a six-item progress rail with these labels:

1. Fetch post
2. Download media
3. Render card
4. Composite video
5. Create GIF
6. Create WebM

The active step will be marked with `aria-current="step"`; completed steps will receive a completed visual state; future steps will remain quiet. The existing safe stage message remains the live status text, and the existing elapsed timer remains visible with `font-variant-numeric: tabular-nums`. The interface will not fabricate percentage completion because the stages have different durations.

The loading state will use a composed status surface with a progress rail and concise “keep this tab open; refresh is safe” guidance. The spinner may remain as a small status indicator but will not be the only feedback. Loading and result entrance transitions will use opacity/transform/filter only, respect `prefers-reduced-motion`, and avoid `transition: all`.

### 3. Result and share actions

The result heading will use sentence case without exclamation marks. The MP4 download will be the filled primary action and will mention audio when appropriate; GIF and WebM remain secondary controls. The share control will be a tertiary grouped action with a clear “Share format” label and “Copy share link” wording.

When automatic copying fails, the share status will expose a readonly, selectable URL field instead of embedding a long URL only in paragraph text. Successful feedback will use direct copy such as “MP4 share link copied.” and will not use a transient exclamation-mark message.

The existing GIF/MP4/WebM tabs and pause-on-switch behavior remain. Tab controls will keep roving keyboard focus, visible focus rings, active state, and hidden unavailable WebM controls.

### 4. Form errors and accessibility

The URL input will have a dedicated inline field-error element. Client-side invalid URLs will set `aria-invalid="true"`, expose the error through `aria-describedby`, and retain focus on the input. Valid server-side failures will continue to focus the global alert without falsely marking the URL invalid. Starting a new submission clears the previous field-error state.

Buttons, selects, and form inputs will have at least a 44px effective hit area. Buttons will have explicit hover/focus/pressed/disabled transitions; pressed states will use `scale(0.96)` and exact transition properties. Nested surfaces will use concentric radii where padding makes them adjacent layers. Images will receive a subtle neutral inset outline.

### 5. Share page and route fallback

Keep the existing canonical Open Graph and Twitter player metadata behavior, including the WebM-to-MP4 crawler fallback and origin restrictions. Give the human-facing share page a small branded shell with the media preview, a clear open-media action, a return-to-tool action, and the original-tweet link when available. Keep its CSP and media behavior unchanged.

Add a branded HTML response for missing human-facing routes and a safe JSON 404 response for unknown API routes. Homepage metadata will include a description, theme color, canonical home URL where configuration permits, and share-card metadata using a local branded asset. No external resource is required.

### 6. Testing and acceptance

Tests will be written before production changes for each behavior change. Coverage will include:

- Source-level checks for the shared brand asset, metadata, semantic form-error hooks, progress rail, and action hierarchy.
- Browser checks for initial layout, invalid URL association, loading step updates, retryable errors, cached/static results, tab switching, share copy success/failure, and mobile no-overflow behavior.
- Server checks for branded share output, correct metadata preservation, human 404 rendering, and JSON API 404 responses.

Acceptance requires:

- `npm test` passes with all browser tests enabled and zero failures.
- `npm run check` passes.
- `npm audit --omit=dev --audit-level=high` reports no high-severity vulnerabilities.
- `docker compose config` and `git diff --check` pass.
- Desktop and 390px-wide Chromium screenshots show a distinct non-purple shell, aligned controls, no clipping, and a clear visual hierarchy.
- The loading rail tracks the real six-stage status, result actions remain usable, invalid URLs are associated with their field error, and copy failures expose a selectable URL.
- Share links preserve existing Discord-oriented metadata behavior while looking intentional to human visitors.
- No conversion, caching, output-path, security, or deployment behavior regresses.

## Remaining external verification

No public HTTPS deployment or Discord refresh will be performed in this implementation pass. External crawler rendering, Firefox/WebKit, and screen-reader verification remain follow-up checks after the local implementation is validated.
