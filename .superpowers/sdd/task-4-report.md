# Task 4 Report: Deployment configuration and documentation

## Changes

- Hardened the production image to run as the unprivileged `node` user, with only `/app/outputs` and `/app/temp` owned for runtime writes.
- Added an image health check and removed the startup-time `yt-dlp` upgrade/network mutation.
- Hardened Compose with `init: true`, environment placeholders, a `/app/temp` tmpfs, and a service health check while retaining persistent outputs.
- Expanded `.dockerignore` for Git metadata, documentation, tests, local artifacts, environment files, and non-runtime Docker files.
- Documented reverse-proxy setup, security environment variables, operational limits, output retention, non-root filesystem expectations, and verification commands.
- Made `ALLOWED_ORIGIN` the canonical CORS environment variable while retaining `CORS_ORIGIN` as a backward-compatible alias.
- Added requested username boundary coverage for valid 1- and 15-character usernames and rejection at 16 characters.
- Added process-isolated integration tests proving `CORS_ORIGIN` fallback and `ALLOWED_ORIGIN` precedence without environment or module-cache leakage between scenarios.

## Commands and results

- `node --test test/server.test.js test/security.test.js` (red): 17 passed, 1 failed as expected because `ALLOWED_ORIGIN` was not yet read.
- `node --test test/server.test.js test/security.test.js` (green): 18 passed, 0 failed.
- `node --test test/cors-env.test.js`: 2 passed, 0 failed.
- `npm test`: 20 passed, 0 failed.
- `npm run check`: passed.
- `npm audit --audit-level=moderate`: passed; 0 vulnerabilities.
- Local health smoke test against a separately started server: passed with `{"status":"ok"}`.
- `git diff --check`: passed.
- `docker compose config`: not run because the Docker CLI is unavailable (`Get-Command docker` returned no executable; verification emitted `DOCKER_CLI_UNAVAILABLE`).

## Self-review

- Confirmed the runtime user switch happens after dependency installation and source copying.
- Confirmed no startup command performs package installation or network mutation.
- Confirmed persistent and temporary write paths match server defaults.
- Confirmed `ALLOWED_ORIGIN` takes precedence over the legacy alias and has integration coverage.
- Confirmed fallback and precedence tests each start a fresh child process with explicit environment values, exercise the HTTP response, and shut the child server down.
- Confirmed documentation states concurrency rejection behavior and the 24-hour cleanup policy implemented by the server.
- Preserved unrelated untracked planning files under `docs/superpowers/plans/`.

## Concerns

- Docker image construction, Compose interpolation, container UID/write permissions, and container health could not be exercised locally because Docker is unavailable. These should be run in CI or on a Docker-enabled host before release.
- Bind-mounted output directories on Linux must be writable by UID/GID 1000, as documented.
