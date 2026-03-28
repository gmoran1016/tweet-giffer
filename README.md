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
  --shm-size=256m \
  ghcr.io/gmoran1016/tweet-giffer:latest
```

Or with Docker Compose:

```yaml
services:
  tweet-giffer:
    image: ghcr.io/gmoran1016/tweet-giffer:latest
    ports:
      - "3000:3000"
    volumes:
      - ./outputs:/app/outputs
    shm_size: 256mb
    restart: unless-stopped
```

The image includes Chromium, FFmpeg, and yt-dlp — no separate installs needed.

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
