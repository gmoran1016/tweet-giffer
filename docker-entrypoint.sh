#!/bin/sh
set -e

# Keep yt-dlp current so Twitter/X extraction (e.g. videos inside quote tweets)
# keeps working — the bundled version freezes at image-build time and Twitter
# breaks old extractors frequently. Best-effort: never block startup on failure.
# Disable with YTDLP_UPDATE=false (e.g. air-gapped hosts).
if [ "$(id -u)" = "0" ]; then
  case "${YTDLP_UPDATE:-true}" in
    0|false|False|FALSE|no|off)
      echo "yt-dlp auto-update disabled (YTDLP_UPDATE=${YTDLP_UPDATE})"
      ;;
    *)
      echo "Updating yt-dlp..."
      pip3 install -U yt-dlp --break-system-packages \
        || echo "WARNING: yt-dlp update failed; continuing with bundled version"
      ;;
  esac
  # Drop root before running the app.
  exec gosu node "$@"
fi

# Already unprivileged (container started with --user): skip update and run as-is.
exec "$@"
