FROM node:22-bookworm-slim

# Install system dependencies for Puppeteer (Chromium), FFmpeg, and yt-dlp
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    chromium \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Install a build-time-pinned yt-dlp. Runtime startup must remain offline and immutable.
ARG YTDLP_VERSION=2026.03.17
RUN pip3 install --no-cache-dir "yt-dlp==${YTDLP_VERSION}" --break-system-packages

# Tell Puppeteer to use the system Chromium instead of downloading its own
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

LABEL net.unraid.docker.icon="https://raw.githubusercontent.com/gmoran1016/tweet-giffer/master/public/docker-icon.png"

# Install Node dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Only generated output and temporary work files are writable at runtime.
RUN mkdir -p outputs temp \
    && chown node:node outputs temp \
    && chmod +x docker-entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:${PORT:-3000}/api/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# Keep the service unprivileged. The image already contains the pinned runtime tools.
USER node
ENTRYPOINT ["./docker-entrypoint.sh"]

CMD ["node", "server.js"]
