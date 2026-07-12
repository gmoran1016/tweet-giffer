# Tweet Giffer Project Hardening Design

## Objective

Improve Tweet Giffer comprehensively while preserving its core workflow: submit a Twitter/X status URL, process its media, preview the generated formats, and download or share the results. The review prioritizes correctness, public-deployment security, reliability, maintainability, accessibility, and clear user feedback.

## Scope

The work covers the Express server, media-processing pipeline, browser UI, dependencies, Docker configuration, documentation, and automated verification. Visible UI changes are allowed when they improve usability or accessibility. The existing Express, Puppeteer, yt-dlp, and FFmpeg architecture remains in place unless a confirmed defect requires a focused substitution.

The work does not add accounts, persistence, billing, analytics, or unrelated product features. It also avoids a wholesale framework rewrite.

## Architecture and Boundaries

The application remains a single Node.js service serving a static frontend and JSON processing API. Focused helpers may be extracted from `server.js` when doing so creates a clear security boundary or makes important behavior independently testable.

The following inputs are untrusted and require explicit validation:

- Submitted tweet URLs and their hostnames, protocols, paths, and identifiers.
- Job and output identifiers supplied through routes.
- Metadata and media URLs returned by third-party services.
- Process output and files produced by yt-dlp, Puppeteer, and FFmpeg.
- Values used in generated HTML, Open Graph metadata, filenames, or response headers.

External downloads must use bounded timeouts, size limits where practical, safe protocols, and controlled redirects. Child processes must receive fixed executable paths and argument arrays, enforce time limits, and be terminated and cleaned up on failure. Generated and temporary files must remain inside their designated directories and be removed predictably.

## Server Behavior

The server will reject malformed or unsupported tweet URLs before creating work. Rate limiting and job concurrency controls will bound resource consumption for public deployment. Request bodies, job lookups, and output access will use strict limits and identifier validation.

Errors will be logged with useful server-side context while API responses expose stable, non-sensitive messages. Job state transitions will remain compatible with the current polling client and will reach a terminal state on every handled failure. Shutdown will close browser/process resources cleanly.

Share pages will escape all externally derived metadata and construct canonical media URLs safely. Static output serving will expose only generated deliverables and will use appropriate content and caching headers.

## Frontend Experience

The primary paste-to-result flow remains recognizable. Improvements may clarify validation, progress, failure recovery, format availability, downloads, and copy-link feedback. Controls will have accessible names and states, keyboard-visible focus, usable contrast, and responsive layouts for narrow screens. Client rendering will avoid unsafe HTML insertion for external values.

## Testing and Verification

Automated tests will cover the highest-risk logic and routes, including URL validation, identifier handling, rate or concurrency behavior where feasible, HTML escaping, error responses, and representative successful job-state behavior with external tools mocked or isolated. Tests must not require live Twitter/X access.

Verification will include:

- The complete automated test suite.
- Syntax or lint-style checks available to the project.
- `npm audit` with findings assessed rather than blindly upgraded.
- Review of production dependency and Docker behavior.
- A local server smoke test and browser-level inspection of the main UI when the environment supports it.
- Confirmation that temporary artifacts and unrelated user files are not modified.

## Delivery Standard

Changes should be focused, understandable, and proportionate to confirmed risks. Existing output formats and documented URLs remain compatible unless retaining them would preserve a security defect. The final handoff will distinguish fixed issues, structural improvements, verification evidence, and any residual limitations that depend on external services or platform tools.
