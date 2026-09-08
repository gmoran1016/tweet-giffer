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
  -e TRUST_PROXY_IPS=172.18.0.2 \
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
      - /app/temp:mode=1770,uid=1000,gid=1000,size=1g,noexec,nosuid
    shm_size: 256mb
    restart: unless-stopped
```

The image includes Chromium, FFmpeg, and yt-dlp — no separate installs needed. It runs as an unprivileged user (UID/GID 1000); only `/app/outputs` and `/app/temp` should be writable. Ensure a bind-mounted `./outputs` directory is writable by that user. `/app/temp` is ephemeral, while output files persist in the mounted output directory and are automatically deleted after 24 hours.

For a public deployment, terminate TLS at a reverse proxy and forward traffic to the configured `PORT`. Set `PUBLIC_BASE_URL` to the externally visible HTTPS origin so share metadata contains correct URLs. Alternatively, set `PUBLIC_HOSTS` to an explicit comma-separated host allowlist; requests with other Host values receive a configuration error. Without either setting, only loopback Host values are accepted for local development. Set `TRUST_PROXY=true` only when the app is behind a trusted proxy that overwrites forwarded headers, and set `TRUST_PROXY_IPS` to the proxy's source addresses. Restrict browser API access with `ALLOWED_ORIGIN`; wildcard CORS is ignored.

---

## Local Development

**Prerequisites:** Node.js 22.12.0+, [yt-dlp](https://github.com/yt-dlp/yt-dlp)

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

Key dependencies: [yt-dlp](https://github.com/yt-dlp/yt-dlp), [Puppeteer](https://pptr.dev/), [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static)

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `PUPPETEER_EXECUTABLE_PATH` | *(bundled)* | Path to Chromium binary (set automatically in Docker) |
| `PUBLIC_BASE_URL` | *(unset)* | Canonical public HTTP(S) origin used in share metadata. Takes precedence over `PUBLIC_HOSTS`. |
| `PUBLIC_HOSTS` | *(loopback only)* | Comma-separated trusted Host names (optionally including ports) from which a share origin may be derived. |
| `TRUST_PROXY` | `false` | Trust Express proxy headers when `true`. Enable only behind a trusted reverse proxy. |
| `TRUST_PROXY_IPS` | `127.0.0.1,::1` | Comma-separated proxy source addresses trusted when `TRUST_PROXY=true`. |
| `ALLOWED_ORIGIN` | *(unset)* | Exact browser origin allowed by CORS. `CORS_ORIGIN` remains a backward-compatible alias. |
| `MAX_CONCURRENT_JOBS` | `2` | Maximum simultaneous conversion jobs. Additional requests receive HTTP 503. |
| `RATE_LIMIT` | `3` | Conversion requests allowed per client IP per minute. |
| `MAX_RATE_LIMIT_ENTRIES` | `10000` | Maximum tracked client-IP rate-limit entries (minimum 100). |
| `JOB_TTL_MS` | `300000` | Completed job status retention in milliseconds (minimum 1000). |
| `JOB_TIMEOUT_MS` | `900000` | Maximum total conversion time before the job fails safely (minimum 30000). |
| `MAX_DOWNLOAD_BYTES` | `209715200` | Maximum downloaded video size. yt-dlp is restricted to the Twitter extractor and one file. |
| `MAX_VIDEO_DURATION_SEC` | `600` | Maximum input video duration. |
| `MAX_VIDEO_DIMENSION` | `4096` | Maximum input width or height in pixels. |
| `MAX_OUTPUT_BYTES` | `5368709120` | Maximum combined generated output size before new work is rejected. |
| `MAX_REMOTE_MEDIA_BYTES` | `10485760` | Maximum avatar or thumbnail response size. |
| `OUTPUT_DIR` | `./outputs` | Generated output directory; must be writable. |
| `TEMP_DIR` | `./temp` | Temporary work directory; must be writable and may be ephemeral. |
| `FFMPEG_TIMEOUT_MS` | `300000` | Maximum time for each FFmpeg pass before it is killed (minimum 5000 ms). |

`MAX_CONCURRENT_JOBS` is a per-process limit, not a queue: excess work is rejected with HTTP 503 and may be retried later. Conversion is CPU-, memory-, and temporary-disk-intensive; start with the default concurrency and size `/dev/shm` and `/app/temp` for the largest expected videos.

## Testing

```bash
npm test
npm run check
npm audit --omit=dev --audit-level=high
docker compose config
```

After starting the service, verify readiness with `curl --fail http://localhost:3000/api/ready` (the health endpoint reports the same readiness state).
