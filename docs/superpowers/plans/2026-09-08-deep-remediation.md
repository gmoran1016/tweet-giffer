# Tweet Giffer Deep Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:test-driven-development to implement this plan.
> **Skill note:** This plan follows the approved request to fix the full security, usability, and stability audit.

**Goal:** Preserve the existing tweet-to-media API while closing the confirmed SSRF, lifecycle, media-orientation, attribution, recovery, accessibility, deployment, and dependency gaps.

**Files:** `server.js` owns network/download policy, job lifecycle, media pipelines, health/readiness, and share rendering. `lib/security.js` owns reusable URL and path validation. `public/script.js`, `public/index.html`, and `public/style.css` own recovery, media playback, responsive share UI, and focus/contrast. Tests receive regression coverage in the existing `test/` files. `package.json`/`package-lock.json`, Docker files, README, and CI receive compatible operational updates.

**Order:**

1. Add failing tests for URL/extractor boundaries, active-job retention, no-video classification, attribution, file URLs, dimensions, browser launch/readiness, and test isolation.
2. Implement security and lifecycle fixes: only allow Twitter extraction, bound downloads and media metadata, reject private remote targets, keep pending jobs alive, deduplicate/cache safely, and expose readiness.
3. Implement media correctness: fix display rotation, robustly parse small dimensions, use `pathToFileURL`, and make fallback/cleanup deterministic.
4. Implement frontend recovery and presentation fixes: retry transient polls, pause inactive media, add share-page viewport metadata, and restore focus/contrast.
5. Update dependencies/runtime declaration and CI gates; document new limits and supported Node versions.
6. Run the full Node suite, browser suite, syntax checks, dependency audit, Docker/Compose static validation, and a fresh live conversion smoke test. No source fix is complete until its regression test passes.
