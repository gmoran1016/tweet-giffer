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
const { spawn, execSync, execFile } = require('child_process');

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

// ─── Rate limiting (3 requests/IP/minute) ───────────────────────────────────
const rateLimitMap = new Map(); // ip -> { count, resetAt }
const RATE_LIMIT = 3;

function checkRateLimit(ip) {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 60_000 };
  }
  entry.count++;
  rateLimitMap.set(ip, entry);
  return entry.count <= RATE_LIMIT;
}

// ─── Tweet ID → videoId cache ────────────────────────────────────────────────
const tweetCache = new Map(); // tweetId -> videoId

// ─── Job progress tracking (SSE) ────────────────────────────────────────────
const jobs = new Map(); // jobId -> { steps, result, error, clients }

function createJob(jobId) {
  jobs.set(jobId, { steps: [], result: null, error: null, clients: [] });
}

function emitProgress(jobId, data) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.steps.push(data);
  for (const client of job.clients) {
    try { client.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
  }
}

function resolveJob(jobId, result) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.result = result;
  const msg = `data: ${JSON.stringify({ type: 'done', result })}\n\n`;
  for (const client of job.clients) {
    try { client.write(msg); client.end(); } catch {}
  }
  job.clients = [];
  setTimeout(() => jobs.delete(jobId), 5 * 60_000);
}

function rejectJob(jobId, error) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.error = error;
  const msg = `data: ${JSON.stringify({ type: 'error', error })}\n\n`;
  for (const client of job.clients) {
    try { client.write(msg); client.end(); } catch {}
  }
  job.clients = [];
  setTimeout(() => jobs.delete(jobId), 5 * 60_000);
}

// ─── Auto-cleanup of old output files (24h) ─────────────────────────────────
async function cleanOldOutputs(maxAgeHours = 24) {
  const cutoff = Date.now() - maxAgeHours * 3_600_000;
  try {
    const files = await fs.readdir(outputDir);
    let removed = 0;
    for (const file of files) {
      if (!/\.(mp4|gif|webm|json)$/i.test(file)) continue;
      const filePath = path.join(outputDir, file);
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) {
        await fs.unlink(filePath).catch(() => {});
        removed++;
      }
    }
    if (removed) console.log(`Cleanup: removed ${removed} output file(s) older than ${maxAgeHours}h`);
  } catch (e) {
    console.warn('Cleanup error:', e.message);
  }
}

// ─── Puppeteer browser pool (singleton — warm browser reused across requests) ─
let _browser = null;

async function getPuppeteerOpts() {
  const opts = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--allow-file-access-from-files',
    ],
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    opts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  return opts;
}

async function getBrowser() {
  if (_browser) {
    try {
      await _browser.version(); // throws if browser crashed
      return _browser;
    } catch {
      _browser = null;
    }
  }
  _browser = await puppeteer.launch(await getPuppeteerOpts());
  console.log('Puppeteer browser started');
  return _browser;
}

// ─── yt-dlp discovery ────────────────────────────────────────────────────────
function findYtDlp() {
  // 1. Try yt-dlp directly (if in PATH)
  try {
    execSync('yt-dlp --version', { stdio: 'pipe', timeout: 5000 });
    return 'yt-dlp';
  } catch {}

  // 2. Search common Python Scripts locations (Windows)
  const appData = process.env.APPDATA || '';
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [];

  for (const ver of ['314', '313', '312', '311', '310', '39']) {
    candidates.push(path.join(appData, 'Python', `Python${ver}`, 'Scripts', 'yt-dlp.exe'));
  }
  for (const ver of ['314', '313', '312', '311', '310', '39']) {
    candidates.push(path.join('C:\\Program Files\\Python' + ver, 'Scripts', 'yt-dlp.exe'));
    candidates.push(path.join(localAppData, 'Programs', 'Python', 'Python' + ver, 'Scripts', 'yt-dlp.exe'));
  }
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

// Derive tweet date from Twitter snowflake ID
// Formula: (id >> 22) + Twitter epoch (Nov 4 2010 01:42:54.657 UTC)
function tweetDateFromId(tweetId) {
  try {
    const ms = Number(BigInt(tweetId) >> 22n) + 1288834974657;
    return new Date(ms);
  } catch { return null; }
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
  p.find('br').replaceWith('\n');
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
      // Use combined (muxed) formats first — these are always natively oriented.
      // Avoid bestvideo+bestaudio which on Docker picks HLS video-only streams that
      // Twitter encodes as landscape with black bars baked in.
      '-f', 'best[ext=mp4]/best',
      '--no-warnings',
      '--quiet',
    ];

    console.log('Running yt-dlp...');
    const proc = spawn(YT_DLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.stdout.on('data', d => { process.stdout.write(d); });

    proc.on('close', async (code) => {
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
  const ffmpegBin = ffmpegPath || 'ffmpeg';

  return new Promise((resolve) => {
    // ffmpeg -i always exits non-zero but writes full stream info to stderr
    execFile(ffmpegBin, ['-i', videoPath, '-hide_banner'], { timeout: 15000 }, (err, stdout, stderr) => {
      const output = stderr || '';

      const hasAudio = /Stream #\S+: Audio:/i.test(output);

      // Match WxH in the Video stream line. Dimensions are 3-5 digits each, preceded by
      // space/comma and followed by space/comma/bracket (or end of line).
      const videoMatch =
        output.match(/Stream #\S+: Video:[^\n]*?[ ,](\d{3,5})x(\d{3,5})[ ,\[]/) ||
        output.match(/Stream #\S+: Video:[^\n]*?[ ,](\d{3,5})x(\d{3,5})$/m);
      let width  = videoMatch ? parseInt(videoMatch[1], 10) : 1280;
      let height = videoMatch ? parseInt(videoMatch[2], 10) : 720;
      if (!videoMatch) console.warn('  WARNING: could not detect video dimensions — using 1280x720 fallback');

      // Detect rotation metadata — phones often store portrait video as landscape + rotate tag.
      let rotation = 0;
      const rotateMeta = output.match(/rotate\s*:\s*(-?\d+)/i) ||
                         output.match(/rotation of (-?\d+(?:\.\d+)?) degrees/i);
      if (rotateMeta) {
        const rawDeg = Math.round(parseFloat(rotateMeta[1]));
        rotation = ((rawDeg % 360) + 360) % 360;
        if (rotation === 90 || rotation === 270) {
          [width, height] = [height, width];
          console.log(`  Detected rotation ${rotation}° — swapped to display dimensions ${width}x${height}`);
        } else if (rotation === 180) {
          console.log(`  Detected rotation 180°`);
        } else {
          rotation = 0;
        }
      }

      const durMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      const duration = durMatch
        ? parseInt(durMatch[1], 10) * 3600 + parseInt(durMatch[2], 10) * 60 + parseFloat(durMatch[3])
        : 10;

      console.log(`  ffmpeg info → ${width}x${height}, ${duration.toFixed(1)}s, audio=${hasAudio}, rotation=${rotation}`);

      resolve({ width, height, duration, hasAudio, rotation });
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
function renderTweetHtml({ authorName, handle, tweetText, avatarFileUrl, mediaHtml, cardWidth = 598, tweetDate = null }) {
  const esc = s => String(s || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));

  const avatarContent = avatarFileUrl
    ? `<img src="${esc(avatarFileUrl)}" class="avatar-img" alt="" />`
    : `<div class="avatar-letter">${esc((authorName || 'T')[0].toUpperCase())}</div>`;

  const dateStr = tweetDate instanceof Date && !isNaN(tweetDate)
    ? tweetDate.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric', year: 'numeric' })
    : new Date().toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric', year: 'numeric' });

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
  width: ${cardWidth}px;
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
.x-logo { flex-shrink: 0; color: #0f1419; }
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
    <div class="x-logo"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.748l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></div>
  </div>
  <div class="tweet-body">
    <div class="tweet-text">${esc(tweetText || '')}</div>
    ${mediaHtml}
  </div>
  <div class="tweet-footer">
    <span class="tweet-time">${dateStr}</span>
    <div class="tweet-actions">
      <span class="action-btn"><svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 7.498 3.159 7.498 6.99 0 3.832-3.008 6.99-7.498 6.99H3.626l-1.875 1.908V10z"/></svg> <span>Reply</span></span>
      <span class="action-btn"><svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM16.5 6H11V4h5.5c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2z"/></svg> <span>Repost</span></span>
      <span class="action-btn"><svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91zm4.187 7.69c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z"/></svg> <span>Like</span></span>
    </div>
  </div>
</div>
</body>
</html>`;
}

// Take a screenshot of the tweet card using the shared browser pool
async function screenshotTweet(htmlPath) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 700, height: 1400, deviceScaleFactor: 1 });
    await page.goto(toFileUrl(htmlPath), { waitUntil: 'networkidle0', timeout: 30000 });

    await page.evaluate(() => Promise.all(
      Array.from(document.images).map(img =>
        img.complete ? null : new Promise(r => { img.onload = r; img.onerror = r; setTimeout(r, 4000); })
      ).filter(Boolean)
    ));
    await delay(300);

    const cardEl = await page.$('.tweet-card');
    if (!cardEl) throw new Error('Tweet card element not found in rendered HTML');
    const cardBox = await cardEl.boundingBox();

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

    const screenshotPath = htmlPath.replace('.html', '_frame.png');
    await page.screenshot({
      path: screenshotPath,
      clip: { x: cardBox.x, y: cardBox.y, width: cardBox.width, height: cardBox.height },
    });

    await page.close();
    return { screenshotPath, videoArea, cardWidth: Math.round(cardBox.width) };
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}

// Composite tweet screenshot with video overlay using FFmpeg.
// rotation is handled inline via transpose filter — no pre-encode step needed.
function compositeVideo(screenshotPath, videoPath, videoArea, outputPath, hasAudio = false, rotation = 0) {
  const { x, y } = videoArea;
  // libx264 requires dimensions divisible by 2 — round down
  const width  = videoArea.width  % 2 === 0 ? videoArea.width  : videoArea.width  - 1;
  const height = videoArea.height % 2 === 0 ? videoArea.height : videoArea.height - 1;

  // Apply rotation in the filter chain (avoids a separate pre-encode pass)
  // These transpose values match FFmpeg's transpose filter: 1=CW90, 2=CCW90
  let rotateFilter = '';
  if      (rotation === 90)  rotateFilter = 'transpose=1,';
  else if (rotation === 270) rotateFilter = 'transpose=2,';
  else if (rotation === 180) rotateFilter = 'vflip,hflip,';

  const outputOpts = [
    '-map', '[out]',
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '18',
    '-movflags', '+faststart',
  ];

  if (hasAudio) {
    outputOpts.push('-map', '1:a', '-c:a', 'aac', '-b:a', '192k');
  }

  let stderrLog = '';

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(screenshotPath)
      .inputOptions(['-loop', '1'])
      .input(videoPath)
      .inputOptions(['-noautorotate'])  // we apply rotation ourselves via rotateFilter
      .complexFilter([
        // Rotate (if needed), then scale to fit placeholder, pad any remaining space with black
        `[1:v]${rotateFilter}scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
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
        if (hasAudio) {
          console.warn('  Retrying without audio...');
          compositeVideo(screenshotPath, videoPath, videoArea, outputPath, false, rotation)
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
        '-crf', '18',
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
        '-vf', `fps=15,scale=${targetWidth}:-1:flags=lanczos,palettegen=max_colors=256:reserve_transparent=0`,
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
        `[0:v]fps=15,scale=${targetWidth}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer`,
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
        '-crf', '28',
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

// ─── SSE progress endpoint (with proxy-busting headers + keepalive heartbeat) ─
app.get('/api/progress/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');  // disable Nginx proxy buffering
  res.flushHeaders();

  // Replay already-emitted steps
  for (const step of job.steps) {
    res.write(`data: ${JSON.stringify(step)}\n\n`);
  }

  if (job.result) {
    res.write(`data: ${JSON.stringify({ type: 'done', result: job.result })}\n\n`);
    return res.end();
  }
  if (job.error) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: job.error })}\n\n`);
    return res.end();
  }

  // Heartbeat every 15s to keep the connection alive through proxies
  const heartbeat = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { clearInterval(heartbeat); }
  }, 15_000);

  job.clients.push(res);
  req.on('close', () => {
    clearInterval(heartbeat);
    if (job) job.clients = job.clients.filter(c => c !== res);
  });
});

// ─── Polling status endpoint (proxy-safe alternative to SSE) ─────────────────
// Client polls this every 2s instead of using EventSource when behind a proxy.
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({
    done: !!job.result,
    error: job.error || null,
    message: job.steps.length > 0 ? job.steps[job.steps.length - 1].message : 'Starting...',
    result: job.result || null,
  });
});

// ─── Main API endpoint ───────────────────────────────────────────────────────
app.post('/api/process-tweet', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const parsed = parseTweetUrl(url);
  if (!parsed) return res.status(400).json({ error: 'Invalid Twitter/X URL' });

  // Rate limiting
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
  }

  const { username, tweetId } = parsed;

  // Cache check — return existing output if files are still on disk
  const cachedVideoId = tweetCache.get(tweetId);
  if (cachedVideoId) {
    const mp4 = path.join(outputDir, `${cachedVideoId}.mp4`);
    const gif = path.join(outputDir, `${cachedVideoId}.gif`);
    if (fsSync.existsSync(mp4) && fsSync.existsSync(gif)) {
      console.log(`Cache hit for tweet ${tweetId} → ${cachedVideoId}`);
      const webmPath = path.join(outputDir, `${cachedVideoId}.webm`);
      return res.json({
        success: true,
        cached: true,
        video: `/outputs/${cachedVideoId}.mp4`,
        gif: `/outputs/${cachedVideoId}.gif`,
        webm: fsSync.existsSync(webmPath) ? `/outputs/${cachedVideoId}.webm` : null,
        videoId: cachedVideoId,
      });
    }
    tweetCache.delete(tweetId); // stale entry
  }

  // Return jobId immediately; process async so the client can stream progress
  const jobId = uuidv4();
  createJob(jobId);
  res.json({ success: true, jobId });

  // ── Async processing ──────────────────────────────────────────────────────
  (async () => {
    const sessionId = uuidv4();
    const sessionDir = path.join(tempDir, sessionId);
    await fs.mkdir(sessionDir, { recursive: true });

    try {
      console.log(`\n── Processing tweet ${tweetId} by @${username} (job ${jobId}) ──`);

      // 1. Fetch tweet metadata
      emitProgress(jobId, { type: 'step', message: 'Fetching tweet metadata...' });
      const oembedData = await fetchOEmbed(url);
      const tweetText = extractTweetText(oembedData.html);
      const authorName = oembedData.author_name || username;
      const tweetDate = tweetDateFromId(tweetId);
      console.log(`  Author: ${authorName}`);
      console.log(`  Tweet date: ${tweetDate ? tweetDate.toISOString() : 'unknown'}`);

      // 2. Download video
      emitProgress(jobId, { type: 'step', message: 'Downloading video...' });
      let videoPath = null;
      let videoInfo = null;
      try {
        videoPath = await downloadVideoYtDlp(url, sessionDir);
        videoInfo = await getVideoInfo(videoPath);
        console.log(`  Video: ${videoInfo.width}x${videoInfo.height}, ${videoInfo.duration.toFixed(1)}s, audio=${videoInfo.hasAudio}`);
      } catch (err) {
        console.warn(`  Video download failed: ${err.message}`);
        emitProgress(jobId, { type: 'step', message: 'No video found, rendering image card...' });
      }

      // 3. Fetch avatar
      let avatarFileUrl = null;
      try {
        const avatarPath = path.join(sessionDir, 'avatar.jpg');
        await downloadFile(`https://unavatar.io/twitter/${username}`, avatarPath);
        avatarFileUrl = toFileUrl(avatarPath);
        console.log('  Avatar downloaded');
      } catch (e) {
        console.warn(`  Avatar fetch failed: ${e.message}`);
      }

      // 4. Determine card layout
      // Portrait: use video width + 32px padding, capped at 520px (improvement #9)
      const isPortrait = !!(videoInfo && videoInfo.height > videoInfo.width);
      const cardWidth = isPortrait
        ? Math.min(videoInfo.width + 32, 520)
        : 598;

      // 5. Build media HTML section
      let mediaHtml = '';
      if (videoPath && videoInfo) {
        const interiorWidth = cardWidth - 32;
        const aspectRatio = videoInfo.height / videoInfo.width;
        const placeholderHeight = Math.round(interiorWidth * aspectRatio);
        mediaHtml = `
    <div class="media-wrap">
      <div class="video-placeholder" style="height:${placeholderHeight}px;">
        <div class="play-icon">&#9654;</div>
      </div>
    </div>`;
      } else if (oembedData.thumbnail_url) {
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

      // 6. Render tweet HTML and screenshot (uses warm browser pool)
      emitProgress(jobId, { type: 'step', message: 'Rendering tweet card...' });
      const htmlContent = renderTweetHtml({ authorName, handle: username, tweetText, avatarFileUrl, mediaHtml, cardWidth, tweetDate });
      const htmlPath = path.join(sessionDir, 'tweet.html');
      await fs.writeFile(htmlPath, htmlContent, 'utf8');

      const { screenshotPath, videoArea } = await screenshotTweet(htmlPath);
      console.log(`  Screenshot saved. Video area: ${JSON.stringify(videoArea)}`);

      // 7. Composite video (rotation applied inline — no pre-encode pass)
      emitProgress(jobId, { type: 'step', message: 'Compositing video...' });
      const videoId = uuidv4();
      const outputVideoPath = path.join(outputDir, `${videoId}.mp4`);

      if (videoPath && videoArea) {
        console.log(`Compositing tweet frame with video (audio=${videoInfo.hasAudio}, rotation=${videoInfo.rotation})...`);
        await compositeVideo(screenshotPath, videoPath, videoArea, outputVideoPath, videoInfo.hasAudio, videoInfo.rotation);
      } else {
        console.log('Creating static image video (no video in tweet)...');
        await staticImageToVideo(screenshotPath, outputVideoPath, 5);
      }
      console.log('  MP4 created');

      // 8. Convert to GIF
      emitProgress(jobId, { type: 'step', message: 'Creating GIF...' });
      const gifPath = path.join(outputDir, `${videoId}.gif`);
      try {
        await videoToGif(outputVideoPath, gifPath, cardWidth);
        console.log('  GIF created');
      } catch (gifErr) {
        console.warn(`  GIF palette conversion failed (${gifErr.message}), trying simple conversion...`);
        await new Promise((resolve, reject) => {
          ffmpeg(outputVideoPath)
            .outputOptions([`-vf`, `fps=12,scale=${cardWidth}:-1:flags=lanczos`])
            .output(gifPath)
            .on('error', reject)
            .on('end', resolve)
            .run();
        });
        console.log('  GIF created (simple)');
      }

      // 9. Convert to WebM
      emitProgress(jobId, { type: 'step', message: 'Creating WebM...' });
      const webmPath = path.join(outputDir, `${videoId}.webm`);
      try {
        await videoToWebm(outputVideoPath, webmPath);
        console.log('  WebM created');
      } catch (webmErr) {
        console.warn(`  WebM conversion failed: ${webmErr.message}`);
      }

      // Cleanup session temp files
      await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});

      // Save metadata so the share page can link back to the original tweet
      const metaPath = path.join(outputDir, `${videoId}.json`);
      await fs.writeFile(metaPath, JSON.stringify({ tweetUrl: url, authorName }), 'utf8').catch(() => {});

      // Store in cache
      tweetCache.set(tweetId, videoId);

      console.log(`\nDone! Output: ${videoId}`);
      resolveJob(jobId, {
        video: `/outputs/${videoId}.mp4`,
        gif: `/outputs/${videoId}.gif`,
        webm: fsSync.existsSync(webmPath) ? `/outputs/${videoId}.webm` : null,
        videoId,
      });

    } catch (error) {
      console.error('Error processing tweet:', error);
      await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
      rejectJob(jobId, error.message || 'Failed to process tweet');
    }
  })();
});

// Serve output files
app.use('/outputs', express.static(outputDir));

// Share embed page — returns OG-tagged HTML so Discord/Slack/etc embed properly with audio
// Usage: /share/:videoId?f=video  (f = gif | video | webm, defaults to video)
app.get('/share/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const format = req.query.f || 'video';

  const mp4Exists  = fsSync.existsSync(path.join(outputDir, `${videoId}.mp4`));
  const gifExists  = fsSync.existsSync(path.join(outputDir, `${videoId}.gif`));
  const webmExists = fsSync.existsSync(path.join(outputDir, `${videoId}.webm`));

  if (!mp4Exists && !gifExists && !webmExists) {
    return res.status(404).send('Not found');
  }

  // Load stored metadata (tweet URL + author) if available
  let tweetUrl = null;
  let authorName = null;
  try {
    const raw = await fs.readFile(path.join(outputDir, `${videoId}.json`), 'utf8');
    ({ tweetUrl, authorName } = JSON.parse(raw));
  } catch {}

  const base = `${req.protocol}://${req.get('host')}`;
  const mp4Url  = `${base}/outputs/${videoId}.mp4`;
  const gifUrl  = `${base}/outputs/${videoId}.gif`;
  const webmUrl = `${base}/outputs/${videoId}.webm`;

  let fileUrl, mimeType;
  if (format === 'webm' && webmExists) {
    fileUrl = webmUrl; mimeType = 'video/webm';
  } else if (format === 'gif' && gifExists) {
    fileUrl = gifUrl; mimeType = 'image/gif';
  } else if (mp4Exists) {
    fileUrl = mp4Url; mimeType = 'video/mp4';
  } else {
    fileUrl = gifUrl; mimeType = 'image/gif';
  }

  const isVideo = mimeType.startsWith('video/');
  const thumbUrl = gifExists ? gifUrl : mp4Url;
  const ogTitle = authorName ? `Tweet by ${authorName}` : 'Tweet Video';

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${ogTitle}</title>
  <meta property="og:type" content="${isVideo ? 'video.other' : 'website'}" />
  <meta property="og:title" content="${ogTitle}" />
  <meta property="og:image" content="${thumbUrl}" />
  ${tweetUrl ? `<meta property="og:url" content="${tweetUrl}" />` : ''}
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
  ${tweetUrl ? `<p><a href="${tweetUrl}">View original tweet</a></p>` : ''}
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

async function startServer() {
  await ensureDirectories();

  // Pre-warm browser so first request doesn't pay the launch cost
  getBrowser().catch(e => console.warn('Browser pre-warm failed:', e.message));

  // Auto-cleanup: remove output files older than 24 hours
  cleanOldOutputs();
  setInterval(() => cleanOldOutputs(), 3_600_000);

  app.listen(PORT, () => {
    const { version } = require('./package.json');
    console.log(`\nTweet Giffer v${version} running at http://localhost:${PORT}`);
    console.log('Requires: yt-dlp installed and in PATH (https://github.com/yt-dlp/yt-dlp)\n');
  });
}

startServer();
