const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const ffmpeg = require('fluent-ffmpeg');
const { spawn, execSync } = require('child_process');

let ffmpegPath;
try {
  ffmpegPath = require('ffmpeg-static');
} catch (e) {
  ffmpegPath = null;
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const outputDir = path.join(__dirname, 'outputs');
const tempDir = path.join(__dirname, 'temp');

async function ensureDirectories() {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(tempDir, { recursive: true });
}

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
  console.log('Using bundled FFmpeg');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Find the yt-dlp executable (may not be in PATH on Windows)
function findYtDlp() {
  // 1. Try yt-dlp directly (if in PATH)
  try {
    execSync('yt-dlp --version', { stdio: 'pipe', timeout: 5000 });
    return 'yt-dlp';
  } catch {}

  // 2. Search common Python Scripts locations
  const appData = process.env.APPDATA || '';
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [];

  // User Python installs (pip install --user)
  for (const ver of ['314', '313', '312', '311', '310', '39']) {
    candidates.push(path.join(appData, 'Python', `Python${ver}`, 'Scripts', 'yt-dlp.exe'));
  }
  // System Python installs
  for (const ver of ['314', '313', '312', '311', '310', '39']) {
    candidates.push(path.join('C:\\Program Files\\Python' + ver, 'Scripts', 'yt-dlp.exe'));
    candidates.push(path.join(localAppData, 'Programs', 'Python', 'Python' + ver, 'Scripts', 'yt-dlp.exe'));
  }
  // Winget / Scoop / Chocolatey locations
  candidates.push(path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe'));
  candidates.push('C:\\ProgramData\\chocolatey\\bin\\yt-dlp.exe');
  candidates.push(path.join(process.env.USERPROFILE || '', 'scoop', 'shims', 'yt-dlp.exe'));

  for (const c of candidates) {
    if (fsSync.existsSync(c)) {
      console.log(`Found yt-dlp at: ${c}`);
      return c;
    }
  }
  return null;
}

const YT_DLP = findYtDlp();
if (YT_DLP) {
  console.log(`yt-dlp: ${YT_DLP}`);
} else {
  console.warn('WARNING: yt-dlp not found. Video tweets will not have video content.');
  console.warn('Install with: pip install yt-dlp');
}

// Convert local path to file:// URL (handles Windows backslashes)
function toFileUrl(p) {
  return 'file:///' + path.resolve(p).replace(/\\/g, '/');
}

// Extract tweet ID and username from URL
function parseTweetUrl(url) {
  const match = url.match(/(?:twitter\.com|x\.com)\/(\w+)\/status\/(\d+)/i);
  if (!match) return null;
  return { username: match[1], tweetId: match[2] };
}

// Fetch tweet metadata via oEmbed (no auth required)
async function fetchOEmbed(tweetUrl) {
  const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(tweetUrl)}&omit_script=true`;
  const response = await axios.get(oembedUrl, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible)' }
  });
  return response.data;
}

// Extract clean tweet text from oEmbed HTML
function extractTweetText(oembedHtml) {
  const $ = cheerio.load(oembedHtml);
  const p = $('blockquote p').first();
  // Convert <br> to newlines
  p.find('br').replaceWith('\n');
  // Remove trailing media links (t.co URLs shown as plain URLs)
  p.find('a').each((i, el) => {
    const text = $(el).text().trim();
    if (/^https?:\/\//i.test(text) || text.startsWith('pic.twitter') || text.startsWith('t.co')) {
      $(el).remove();
    }
  });
  return p.text().trim();
}

// Download video using yt-dlp
async function downloadVideoYtDlp(tweetUrl, sessionDir) {
  if (!YT_DLP) throw new Error('yt-dlp is not installed. Run: pip install yt-dlp');

  const outputTemplate = path.join(sessionDir, 'video.%(ext)s');

  return new Promise((resolve, reject) => {
    const args = [
      tweetUrl,
      '-o', outputTemplate,
      '--no-playlist',
      '--merge-output-format', 'mp4',
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--no-warnings',
      '--quiet',
    ];

    console.log('Running yt-dlp...');
    const proc = spawn(YT_DLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.stdout.on('data', d => { process.stdout.write(d); });

    proc.on('close', async (code) => {
      // Find the created video file (yt-dlp uses the template ext)
      try {
        const files = await fs.readdir(sessionDir);
        const videoFile = files.find(f => f.startsWith('video.') && /\.(mp4|mkv|webm|mov)$/i.test(f));
        if (videoFile) {
          const fullPath = path.join(sessionDir, videoFile);
          const stats = await fs.stat(fullPath);
          if (stats.size > 10000) {
            return resolve(fullPath);
          }
        }
        reject(new Error(`yt-dlp failed (code ${code}): ${stderr.slice(-300)}`));
      } catch (e) {
        reject(e);
      }
    });

    proc.on('error', err => {
      reject(new Error(`yt-dlp not available: ${err.message}`));
    });

    setTimeout(() => {
      proc.kill();
      reject(new Error('yt-dlp timed out after 120s'));
    }, 120000);
  });
}

// Get video dimensions, duration, and audio presence using ffmpeg -i
// (avoids needing ffprobe, which ffmpeg-static does not bundle)
async function getVideoInfo(videoPath) {
  const { execFile } = require('child_process');
  const ffmpegBin = ffmpegPath || 'ffmpeg';

  return new Promise((resolve) => {
    // ffmpeg -i always exits non-zero but writes full stream info to stderr
    execFile(ffmpegBin, ['-i', videoPath, '-hide_banner'], { timeout: 15000 }, (err, stdout, stderr) => {
      const output = stderr || '';

      const hasAudio = /Stream #\S+: Audio:/i.test(output);

      const videoMatch = output.match(/Stream #\S+: Video:[^,\n]*,\s*(\d{2,5})x(\d{2,5})/);
      let width  = videoMatch ? parseInt(videoMatch[1], 10) : 1280;
      let height = videoMatch ? parseInt(videoMatch[2], 10) : 720;

      // Detect rotation metadata — phones often store portrait video as landscape + rotate tag.
      // Both legacy "rotate: 90" and newer "displaymatrix: rotation of -90.00 degrees" forms.
      const rotateMeta = output.match(/rotate\s*:\s*(-?\d+)/) ||
                         output.match(/rotation of (-?\d+(?:\.\d+)?) degrees/);
      if (rotateMeta) {
        const deg = Math.abs(parseFloat(rotateMeta[1]));
        const normalized = Math.round(deg / 90) * 90 % 180;
        if (normalized === 90) {
          // 90° or 270° rotation: swap stored width/height to get display dimensions
          [width, height] = [height, width];
          console.log(`  Detected rotation ${deg}° — swapped to display dimensions ${width}x${height}`);
        }
      }

      const durMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      const duration = durMatch
        ? parseInt(durMatch[1], 10) * 3600 + parseInt(durMatch[2], 10) * 60 + parseFloat(durMatch[3])
        : 10;

      console.log(`  ffmpeg info → ${width}x${height}, ${duration.toFixed(1)}s, audio=${hasAudio}`);
      if (!hasAudio && output.includes('Audio:')) {
        console.warn('  Audio line found but regex did not match — check raw output:');
        console.warn(output.split('\n').filter(l => l.includes('Audio:')).join('\n'));
      }

      resolve({ width, height, duration, hasAudio });
    });
  });
}

// Download a file (image/avatar)
async function downloadFile(url, filePath) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 10000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' }
  });
  await fs.writeFile(filePath, Buffer.from(response.data));
  return filePath;
}

// Render the tweet as HTML for screenshotting
function renderTweetHtml({ authorName, handle, tweetText, avatarFileUrl, mediaHtml }) {
  const esc = s => String(s || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));

  const avatarContent = avatarFileUrl
    ? `<img src="${esc(avatarFileUrl)}" class="avatar-img" alt="" />`
    : `<div class="avatar-letter">${esc((authorName || 'T')[0].toUpperCase())}</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background: #e6e6e6;
  padding: 24px;
  display: flex;
  justify-content: center;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
.tweet-card {
  width: 598px;
  background: #fff;
  border: 1px solid #cfd9de;
  border-radius: 16px;
  overflow: hidden;
}
.tweet-header {
  display: flex;
  align-items: center;
  padding: 12px 16px 8px;
  gap: 10px;
}
.avatar-img {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}
.avatar-letter {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: linear-gradient(135deg, #1d9bf0, #0a7abf);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  font-weight: 700;
  flex-shrink: 0;
}
.author-info { flex: 1; min-width: 0; }
.author-name {
  font-weight: 700;
  font-size: 15px;
  color: #0f1419;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.author-handle {
  font-size: 15px;
  color: #536471;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.x-logo {
  font-size: 20px;
  color: #0f1419;
  font-weight: 900;
  flex-shrink: 0;
  font-family: sans-serif;
}
.tweet-body { padding: 4px 16px 12px; }
.tweet-text {
  font-size: 15px;
  line-height: 1.5;
  color: #0f1419;
  white-space: pre-wrap;
  word-wrap: break-word;
}
.media-wrap {
  margin-top: 12px;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid #cfd9de;
}
.video-placeholder {
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
}
.play-icon {
  width: 56px;
  height: 56px;
  background: rgba(0,0,0,0.55);
  border: 2px solid rgba(255,255,255,0.8);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 22px;
  padding-left: 4px;
}
.img-single { width: 100%; display: block; max-height: 510px; object-fit: cover; }
.img-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; }
.img-grid img { width: 100%; height: 200px; object-fit: cover; display: block; }
.tweet-footer {
  padding: 10px 16px 12px;
  border-top: 1px solid #eff3f4;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.tweet-time { font-size: 13px; color: #536471; }
.tweet-actions { display: flex; gap: 24px; }
.action-btn {
  font-size: 13px;
  color: #536471;
  display: flex;
  align-items: center;
  gap: 4px;
}
</style>
</head>
<body>
<div class="tweet-card">
  <div class="tweet-header">
    ${avatarContent}
    <div class="author-info">
      <div class="author-name">${esc(authorName || 'Twitter User')}</div>
      <div class="author-handle">@${esc(handle || 'user')}</div>
    </div>
    <div class="x-logo">&#120143;</div>
  </div>
  <div class="tweet-body">
    <div class="tweet-text">${esc(tweetText || '')}</div>
    ${mediaHtml}
  </div>
  <div class="tweet-footer">
    <span class="tweet-time">${new Date().toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric', year: 'numeric' })}</span>
    <div class="tweet-actions">
      <span class="action-btn">💬 <span>Reply</span></span>
      <span class="action-btn">🔁 <span>Repost</span></span>
      <span class="action-btn">❤️ <span>Like</span></span>
    </div>
  </div>
</div>
</body>
</html>`;
}

// Take a screenshot of the tweet card; return path + video placeholder bounds
async function screenshotTweet(htmlPath) {
  const puppeteerOpts = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--allow-file-access-from-files',
    ],
  };
  // Use system Chromium when running in Docker (set via PUPPETEER_EXECUTABLE_PATH env var)
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    puppeteerOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const browser = await puppeteer.launch(puppeteerOpts);

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 700, height: 1400, deviceScaleFactor: 1 });
    await page.goto(toFileUrl(htmlPath), { waitUntil: 'networkidle0', timeout: 30000 });

    // Wait for images to finish loading
    await page.evaluate(() => Promise.all(
      Array.from(document.images).map(img =>
        img.complete ? null : new Promise(r => { img.onload = r; img.onerror = r; setTimeout(r, 4000); })
      ).filter(Boolean)
    ));
    await delay(300);

    // Get tweet card bounds
    const cardEl = await page.$('.tweet-card');
    if (!cardEl) throw new Error('Tweet card element not found in rendered HTML');
    const cardBox = await cardEl.boundingBox();

    // Get video placeholder bounds (relative to card top-left)
    let videoArea = null;
    const vpEl = await page.$('.video-placeholder');
    if (vpEl) {
      const vpBox = await vpEl.boundingBox();
      if (vpBox) {
        videoArea = {
          x: Math.round(vpBox.x - cardBox.x),
          y: Math.round(vpBox.y - cardBox.y),
          width: Math.round(vpBox.width),
          height: Math.round(vpBox.height),
        };
      }
    }

    // Screenshot just the tweet card
    const screenshotPath = htmlPath.replace('.html', '_frame.png');
    await page.screenshot({
      path: screenshotPath,
      clip: {
        x: cardBox.x,
        y: cardBox.y,
        width: cardBox.width,
        height: cardBox.height,
      },
    });

    await browser.close();
    return { screenshotPath, videoArea, cardWidth: Math.round(cardBox.width) };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// Composite tweet screenshot with video overlay using FFmpeg
function compositeVideo(screenshotPath, videoPath, videoArea, outputPath, hasAudio = false) {
  const { x, y } = videoArea;
  // libx264 requires dimensions divisible by 2 — round down
  const width  = videoArea.width  % 2 === 0 ? videoArea.width  : videoArea.width  - 1;
  const height = videoArea.height % 2 === 0 ? videoArea.height : videoArea.height - 1;

  return new Promise((resolve, reject) => {
    // Build output options — audio mapping only added when the video actually has audio
    const outputOpts = [
      '-map', '[out]',
      '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '22',
      '-movflags', '+faststart',
    ];

    if (hasAudio) {
      // Explicit audio stream map — no trailing '?' so FFmpeg errors if audio is missing
      // (helps us catch mis-detection), then fallback handled in catch below
      outputOpts.push('-map', '1:a', '-c:a', 'aac', '-b:a', '192k');
    }

    let stderrLog = '';

    const cmd = ffmpeg()
      .input(screenshotPath)
      .inputOptions(['-loop', '1'])
      .input(videoPath)
      .complexFilter([
        // Scale video to fit within the placeholder box without stretching,
        // then pad any remaining space with black so dimensions are exact.
        `[1:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black[vid]`,
        `[0:v][vid]overlay=${x}:${y}:shortest=1[v1]`,
        // libx264 requires even dimensions — round down via trunc
        `[v1]scale=trunc(iw/2)*2:trunc(ih/2)*2[out]`,
      ])
      .outputOptions(outputOpts)
      .output(outputPath);

    cmd
      .on('start', command => console.log('  FFmpeg cmd:', command))
      .on('stderr', line => { stderrLog += line + '\n'; })
      .on('progress', p => p.percent && console.log(`  Encoding: ${Math.round(p.percent)}%`))
      .on('error', (err) => {
        console.error('  FFmpeg stderr:\n' + stderrLog.slice(-2000));
        // If we tried with audio and it failed for any reason, retry without audio
        if (hasAudio) {
          console.warn('  Retrying without audio...');
          compositeVideo(screenshotPath, videoPath, videoArea, outputPath, false)
            .then(resolve).catch(reject);
        } else {
          reject(new Error(`FFmpeg composite failed: ${err.message}\n${stderrLog.slice(-500)}`));
        }
      })
      .on('end', () => resolve(outputPath))
      .run();
  });
}

// Create a short video from a static screenshot (tweets without video)
function staticImageToVideo(screenshotPath, outputPath, durationSecs = 5) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(screenshotPath)
      .inputOptions(['-loop', '1', '-framerate', '1'])
      .outputOptions([
        `-t`, String(durationSecs),
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-pix_fmt', 'yuv420p',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '22',
        '-movflags', '+faststart',
      ])
      .output(outputPath)
      .on('error', (err) => reject(new Error(`FFmpeg static video failed: ${err.message}`)))
      .on('end', () => resolve(outputPath))
      .run();
  });
}

// Convert video to GIF (palette-optimized for quality)
async function videoToGif(videoPath, gifPath, targetWidth = 598) {
  const palettePath = gifPath.replace('.gif', '_pal.png');

  // Pass 1: generate palette
  await new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .outputOptions([
        '-vf', `fps=12,scale=${targetWidth}:-1:flags=lanczos,palettegen=max_colors=256:reserve_transparent=0`,
        '-y',
      ])
      .output(palettePath)
      .on('error', reject)
      .on('end', resolve)
      .run();
  });

  // Pass 2: render GIF using palette
  await new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .input(palettePath)
      .complexFilter([
        `[0:v]fps=12,scale=${targetWidth}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer`,
      ])
      .output(gifPath)
      .on('error', reject)
      .on('end', resolve)
      .run();
  });

  await fs.unlink(palettePath).catch(() => {});
  return gifPath;
}

// Convert video to WebM (VP9 + Opus — smaller than MP4, plays in all modern browsers)
function videoToWebm(videoPath, webmPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .outputOptions([
        '-c:v', 'libvpx-vp9',
        '-crf', '33',
        '-b:v', '0',          // CRF-only mode (best quality/size ratio)
        '-c:a', 'libopus',
        '-b:a', '128k',
        '-deadline', 'good',
        '-cpu-used', '2',
      ])
      .output(webmPath)
      .on('progress', p => p.percent && console.log(`  WebM: ${Math.round(p.percent)}%`))
      .on('error', reject)
      .on('end', () => resolve(webmPath))
      .run();
  });
}

// ─── Main API endpoint ──────────────────────────────────────────────────────

app.post('/api/process-tweet', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const parsed = parseTweetUrl(url);
  if (!parsed) return res.status(400).json({ error: 'Invalid Twitter/X URL' });

  const { username, tweetId } = parsed;
  const sessionId = uuidv4();
  const sessionDir = path.join(tempDir, sessionId);
  await fs.mkdir(sessionDir, { recursive: true });

  try {
    console.log(`\n── Processing tweet ${tweetId} by @${username} ──`);

    // 1. Fetch tweet metadata via oEmbed
    console.log('Fetching tweet metadata...');
    const oembedData = await fetchOEmbed(url);
    const tweetText = extractTweetText(oembedData.html);
    const authorName = oembedData.author_name || username;
    console.log(`  Author: ${authorName}`);
    console.log(`  Text: ${tweetText.substring(0, 80)}${tweetText.length > 80 ? '…' : ''}`);

    // 2. Try to download video with yt-dlp
    let videoPath = null;
    let videoInfo = null;

    try {
      console.log('Downloading video with yt-dlp...');
      videoPath = await downloadVideoYtDlp(url, sessionDir);
      videoInfo = await getVideoInfo(videoPath);
      console.log(`  Video: ${videoInfo.width}x${videoInfo.height}, ${videoInfo.duration.toFixed(1)}s, audio=${videoInfo.hasAudio}`);
    } catch (err) {
      console.warn(`  Video download failed: ${err.message}`);
      console.warn('  Continuing as image/text-only tweet');
    }

    // 3. Fetch author avatar
    let avatarFileUrl = null;
    try {
      const avatarPath = path.join(sessionDir, 'avatar.jpg');
      await downloadFile(`https://unavatar.io/twitter/${username}`, avatarPath);
      avatarFileUrl = toFileUrl(avatarPath);
      console.log('  Avatar downloaded');
    } catch (e) {
      console.warn(`  Avatar fetch failed: ${e.message}`);
    }

    // 4. Build media HTML section
    let mediaHtml = '';
    if (videoPath && videoInfo) {
      // Video tweet: show a placeholder sized to the video's aspect ratio
      const aspectRatio = videoInfo.height / videoInfo.width;
      const placeholderHeight = Math.round(566 * aspectRatio); // 566 = card width minus padding
      mediaHtml = `
    <div class="media-wrap">
      <div class="video-placeholder" style="height:${placeholderHeight}px;">
        <div class="play-icon">&#9654;</div>
      </div>
    </div>`;
    } else if (oembedData.thumbnail_url) {
      // Image/GIF tweet: download and embed thumbnail
      try {
        const imgPath = path.join(sessionDir, 'media.jpg');
        await downloadFile(oembedData.thumbnail_url, imgPath);
        const imgUrl = toFileUrl(imgPath);
        mediaHtml = `
    <div class="media-wrap">
      <img class="img-single" src="${imgUrl.replace(/['"]/g, '')}" alt="" />
    </div>`;
        console.log('  Thumbnail downloaded');
      } catch (e) {
        console.warn(`  Thumbnail fetch failed: ${e.message}`);
      }
    }

    // 5. Render tweet HTML and screenshot it
    const htmlContent = renderTweetHtml({ authorName, handle: username, tweetText, avatarFileUrl, mediaHtml });
    const htmlPath = path.join(sessionDir, 'tweet.html');
    await fs.writeFile(htmlPath, htmlContent, 'utf8');

    console.log('Taking tweet screenshot...');
    const { screenshotPath, videoArea } = await screenshotTweet(htmlPath);
    console.log(`  Screenshot saved. Video area: ${JSON.stringify(videoArea)}`);

    // 6. Build output video
    const videoId = uuidv4();
    const outputVideoPath = path.join(outputDir, `${videoId}.mp4`);

    if (videoPath && videoArea) {
      console.log(`Compositing tweet frame with video (audio=${videoInfo.hasAudio})...`);
      await compositeVideo(screenshotPath, videoPath, videoArea, outputVideoPath, videoInfo.hasAudio);
    } else {
      console.log('Creating static image video (no video in tweet)...');
      await staticImageToVideo(screenshotPath, outputVideoPath, 5);
    }
    console.log('  MP4 created');

    // 7. Convert to GIF
    const gifPath = path.join(outputDir, `${videoId}.gif`);
    console.log('Converting to GIF...');
    try {
      await videoToGif(outputVideoPath, gifPath);
      console.log('  GIF created');
    } catch (gifErr) {
      console.warn(`  GIF palette conversion failed (${gifErr.message}), trying simple conversion...`);
      await new Promise((resolve, reject) => {
        ffmpeg(outputVideoPath)
          .outputOptions(['-vf', 'fps=12,scale=598:-1:flags=lanczos'])
          .output(gifPath)
          .on('error', reject)
          .on('end', resolve)
          .run();
      });
      console.log('  GIF created (simple)');
    }

    // 8. Convert to WebM
    const webmPath = path.join(outputDir, `${videoId}.webm`);
    console.log('Converting to WebM...');
    try {
      await videoToWebm(outputVideoPath, webmPath);
      console.log('  WebM created');
    } catch (webmErr) {
      console.warn(`  WebM conversion failed: ${webmErr.message}`);
    }

    // 9. Cleanup session temp files
    await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});

    console.log(`\nDone! Output: ${videoId}`);
    res.json({
      success: true,
      video: `/outputs/${videoId}.mp4`,
      gif: `/outputs/${videoId}.gif`,
      webm: fsSync.existsSync(webmPath) ? `/outputs/${videoId}.webm` : null,
      videoId,
    });

  } catch (error) {
    console.error('Error processing tweet:', error);
    await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
    res.status(500).json({ error: error.message || 'Failed to process tweet' });
  }
});

// Serve output files
app.use('/outputs', express.static(outputDir));

// Share embed page — returns OG-tagged HTML so Discord/Slack/etc embed properly with audio
// Usage: /share/:videoId?f=video  (f = gif | video | webm, defaults to video)
app.get('/share/:videoId', (req, res) => {
  const { videoId } = req.params;
  const format = req.query.f || 'video';

  const mp4Exists  = fsSync.existsSync(path.join(outputDir, `${videoId}.mp4`));
  const gifExists  = fsSync.existsSync(path.join(outputDir, `${videoId}.gif`));
  const webmExists = fsSync.existsSync(path.join(outputDir, `${videoId}.webm`));

  if (!mp4Exists && !gifExists && !webmExists) {
    return res.status(404).send('Not found');
  }

  const base = `${req.protocol}://${req.get('host')}`;
  const mp4Url  = `${base}/outputs/${videoId}.mp4`;
  const gifUrl  = `${base}/outputs/${videoId}.gif`;
  const webmUrl = `${base}/outputs/${videoId}.webm`;

  // Determine the featured file for this share link
  let fileUrl, mimeType;
  if (format === 'webm' && webmExists) {
    fileUrl  = webmUrl;
    mimeType = 'video/webm';
  } else if (format === 'gif' && gifExists) {
    fileUrl  = gifUrl;
    mimeType = 'image/gif';
  } else if (mp4Exists) {
    fileUrl  = mp4Url;
    mimeType = 'video/mp4';
  } else {
    fileUrl  = gifUrl;
    mimeType = 'image/gif';
  }

  // Discord requires og:video to be MP4 for audio to work — always include MP4 tag
  // even when a different format is featured
  const isVideo = mimeType.startsWith('video/');
  const thumbUrl = gifExists ? gifUrl : mp4Url;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Tweet Video</title>
  <meta property="og:type" content="${isVideo ? 'video.other' : 'website'}" />
  <meta property="og:title" content="Tweet Video" />
  <meta property="og:image" content="${thumbUrl}" />
  ${isVideo ? `
  <meta property="og:video" content="${fileUrl}" />
  <meta property="og:video:url" content="${fileUrl}" />
  <meta property="og:video:secure_url" content="${fileUrl}" />
  <meta property="og:video:type" content="${mimeType}" />
  <meta property="og:video:width" content="598" />
  ${mp4Exists && mimeType !== 'video/mp4' ? `
  <meta property="og:video" content="${mp4Url}" />
  <meta property="og:video:url" content="${mp4Url}" />
  <meta property="og:video:secure_url" content="${mp4Url}" />
  <meta property="og:video:type" content="video/mp4" />
  <meta property="og:video:width" content="598" />` : ''}
  ` : ''}
</head>
<body>
  <script>window.location.replace('${fileUrl}');</script>
  <p>Redirecting… <a href="${fileUrl}">Click here if not redirected</a></p>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

async function startServer() {
  await ensureDirectories();
  app.listen(PORT, () => {
    const { version } = require('./package.json');
    console.log(`\nTweet Giffer v${version} running at http://localhost:${PORT}`);
    console.log('Requires: yt-dlp installed and in PATH (https://github.com/yt-dlp/yt-dlp)\n');
  });
}

startServer();
