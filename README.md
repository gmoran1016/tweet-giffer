# Tweet Giffer

Convert Twitter/X tweet videos into shareable GIFs, MP4s, and WebMs — styled to look exactly like a tweet card, with audio.

Paste a tweet URL and get back a rendered tweet card with the video composited in, ready to download or share. Share links include Open Graph metadata so they embed properly in Discord with audio.

---

## Features

- **Three output formats** — GIF, MP4 (with audio), and WebM (VP9/Opus)
- **Tweet card rendering** — screenshot of the tweet including avatar, author, and text
- **Portrait & landscape video** — auto-detects orientation; portrait videos get a phone-style narrow card
- **Audio preserved** — downloaded via yt-dlp, composited with FFmpeg
- **Discord embeds** — share links serve OG meta tags so Discord previews play the video with sound
- **Self-hostable** — Docker image published to GitHub Container Registry on every push

---

## Docker (recommended)

```bash
docker run -d \
  --name tweet-giffer \
  -p 3000:3000 \
  -v ./outputs:/app/outputs \
  --tmpfs /app/temp:rw,noexec,nosuid,size=1g,uid=1000,gid=1000 \
  --shm-size=256m \
  -e PUBLIC_BASE_URL=https://giffer.example.com \
  -e TRUST_PROXY=true \
  -e ALLOWED_ORIGIN=https://giffer.example.com \
  ghcr.io/gmoran1016/tweet-giffer:latest
```

Or with Docker Compose:

```yaml
services:
  tweet-giffer:
    image: ghcr.io/gmoran1016/tweet-giffer:latest
    init: true
    ports:
      - "3000:3000"
    volumes:
      - ./outputs:/app/outputs
    tmpfs:
      - /app/temp:mode=1770,uid=1000,gid=1000
    shm_size: 256mb
    restart: unless-stopped
```

The image includes Chromium, FFmpeg, and yt-dlp — no separate installs needed. It runs as an unprivileged user (UID/GID 1000); only `/app/outputs` and `/app/temp` should be writable. Ensure a bind-mounted `./outputs` directory is writable by that user. `/app/temp` is ephemeral, while output files persist in the mounted output directory and are automatically deleted after 24 hours.

For a public deployment, terminate TLS at a reverse proxy and forward traffic to port 3000. Set `PUBLIC_BASE_URL` to the externally visible HTTPS origin so share metadata contains correct URLs. Set `TRUST_PROXY=true` only when the app is behind a trusted proxy that overwrites forwarded headers. Restrict browser API access with `ALLOWED_ORIGIN`; do not use a wildcard for a public instance.

---

## Local Development

**Prerequisites:** Node.js 18+, [yt-dlp](https://github.com/yt-dlp/yt-dlp)

```bash
# Install yt-dlp
pip install yt-dlp

# Install dependencies
npm install

# Install Puppeteer's Chrome
npx puppeteer browsers install chrome

# Start (with auto-reload)
npm run dev
```

Open `http://localhost:3000`.

---

## Usage

1. Paste a `twitter.com` or `x.com` tweet URL
2. Click **Create GIF/Video** and wait ~30–60 seconds
3. Switch between GIF / MP4 / WebM tabs to preview
4. Download the format you want, or use **Copy Link** to get a shareable URL

Share links (`/share/:id?f=video`) serve an HTML page with Open Graph video tags, so Discord and other platforms embed the video with sound.

---

## How It Works

```
Tweet URL
  → yt-dlp downloads the video
  → Twitter oEmbed API fetches author + tweet text
  → Puppeteer renders a tweet card HTML → screenshot
  → FFmpeg composites the screenshot + video
  → 2-pass palette GIF + MP4 + WebM outputs
```

Key dependencies: [yt-dlp](https://github.com/yt-dlp/yt-dlp), [Puppeteer](https://pptr.dev/), [fluent-ffmpeg](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg), [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static)

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `PUPPETEER_EXECUTABLE_PATH` | *(bundled)* | Path to Chromium binary (set automatically in Docker) |
| `PUBLIC_BASE_URL` | `http://localhost:$PORT` | Public HTTP(S) origin used in share metadata. Use an HTTPS URL in production. |
| `TRUST_PROXY` | `false` | Trust Express proxy headers when `true`. Enable only behind a trusted reverse proxy. |
| `ALLOWED_ORIGIN` | *(unset)* | Exact browser origin allowed by CORS. `CORS_ORIGIN` remains a backward-compatible alias. |
| `MAX_CONCURRENT_JOBS` | `2` | Maximum simultaneous conversion jobs. Additional requests receive HTTP 503. |
| `RATE_LIMIT` | `3` | Conversion requests allowed per client IP per minute. |
| `MAX_RATE_LIMIT_ENTRIES` | `10000` | Maximum tracked client-IP rate-limit entries (minimum 100). |
| `JOB_TTL_MS` | `300000` | Completed job status retention in milliseconds (minimum 1000). |
| `OUTPUT_DIR` | `./outputs` | Generated output directory; must be writable. |
| `TEMP_DIR` | `./temp` | Temporary work directory; must be writable and may be ephemeral. |

`MAX_CONCURRENT_JOBS` is a per-process limit, not a queue: excess work is rejected with HTTP 503 and may be retried later. Conversion is CPU-, memory-, and temporary-disk-intensive; start with the default concurrency and size `/dev/shm` and `/app/temp` for the largest expected videos.

## Testing

```bash
npm test
npm run check
npm audit --audit-level=moderate
docker compose config
```

After starting the service, verify readiness with `curl --fail http://localhost:3000/api/health`.
