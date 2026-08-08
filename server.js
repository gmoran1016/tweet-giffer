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
const { parseTweetUrl, isSafeRemoteUrl, escapeHtml, isUuid } = require('./lib/security');

let ffmpegPath;
try {
  ffmpegPath = require('ffmpeg-static');
} catch (e) {
  ffmpegPath = null;
}

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
app.set('trust proxy', /^(1|true)$/i.test(process.env.TRUST_PROXY || ''));
const allowedOrigin = process.env.ALLOWED_ORIGIN || process.env.CORS_ORIGIN;
if (allowedOrigin) app.use(cors({ origin: allowedOrigin }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '4kb' }));
app.use(express.static('public'));

const outputDir = path.resolve(process.env.OUTPUT_DIR || path.join(__dirname, 'outputs'));
const tempDir = path.resolve(process.env.TEMP_DIR || path.join(__dirname, 'temp'));

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
const RATE_LIMIT = Math.max(1, Number(process.env.RATE_LIMIT) || 3);
const MAX_RATE_LIMIT_ENTRIES = Math.max(100, Number(process.env.MAX_RATE_LIMIT_ENTRIES) || 10_000);

function checkRateLimit(ip) {
  const now = Date.now();
  for (const [key, value] of rateLimitMap) {
    if (value.resetAt < now) rateLimitMap.delete(key);
  }
  if (!rateLimitMap.has(ip) && rateLimitMap.size >= MAX_RATE_LIMIT_ENTRIES) {
    rateLimitMap.delete(rateLimitMap.keys().next().value);
  }
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
const JOB_TTL_MS = Math.max(1000, Number(process.env.JOB_TTL_MS) || 5 * 60_000);
const MAX_CONCURRENT_JOBS = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS) || 2);
const PIPELINE_STAGES = Object.freeze([
  'Fetching tweet metadata...',
  'Downloading video...',
  'Rendering tweet card...',
  'Compositing video...',
  'Creating GIF...',
  'Creating WebM...',
]);
let activeJobs = 0;

function createJob(jobId) {
  const now = Date.now();
  const job = {
    steps: [], result: null, error: null, errorCode: null, clients: [],
    createdAt: now, startedAt: now, completedAt: null,
    stepIndex: 0, stepCount: PIPELINE_STAGES.length,
    expiresAt: now + JOB_TTL_MS,
  };
  jobs.set(jobId, job);
  return job;
}

function emitProgress(jobId, data) {
  const job = jobs.get(jobId);
  if (!job) return null;
  const stageIndex = PIPELINE_STAGES.indexOf(data.message);
  const normalized = {
    ...data,
    ...(stageIndex >= 0 ? { stepIndex: stageIndex + 1 } : {}),
    stepCount: job.stepCount,
    elapsedMs: Math.max(0, Date.now() - job.startedAt),
  };
  if (stageIndex >= 0) job.stepIndex = stageIndex + 1;
  job.steps.push(normalized);
  for (const client of job.clients) {
    try { client.write(`data: ${JSON.stringify(normalized)}\n\n`); } catch {}
  }
  return normalized;
}

function resolveJob(jobId, result) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.result = result;
  job.completedAt = Date.now();
  const msg = `data: ${JSON.stringify({
    type: 'done', result, stepIndex: job.stepIndex, stepCount: job.stepCount,
    elapsedMs: job.completedAt - job.startedAt,
  })}\n\n`;
  for (const client of job.clients) {
    try { client.write(msg); client.end(); } catch {}
  }
  job.clients = [];
  job.expiresAt = Date.now() + JOB_TTL_MS;
}

function rejectJob(jobId, error = 'Tweet conversion failed. Please try again.', errorCode = 'PROCESSING_FAILED') {
  const job = jobs.get(jobId);
  if (!job) return;
  job.error = error;
  job.errorCode = errorCode;
  job.completedAt = Date.now();
  const msg = `data: ${JSON.stringify({
    type: 'error', error, errorCode, stepIndex: job.stepIndex,
    stepCount: job.stepCount, elapsedMs: job.completedAt - job.startedAt,
  })}\n\n`;
  for (const client of job.clients) {
    try { client.write(msg); client.end(); } catch {}
  }
  job.clients = [];
  job.expiresAt = Date.now() + JOB_TTL_MS;
}

function classifyProcessingError(error, phase) {
  const status = Number(error && error.response && error.response.status);
  if (phase === 'oembed' && [401, 403, 404].includes(status)) {
    return {
      errorCode: 'TWEET_UNAVAILABLE',
      message: 'This post is unavailable, private, or no longer exists. Check the URL and try another public post.',
      status: 502,
    };
  }
  if (phase === 'video') {
    return {
      errorCode: 'MEDIA_ACCESS_FAILED',
      message: 'The post was found, but its media could not be accessed. Check that it is public and try again.',
      status: 502,
    };
  }
  return {
    errorCode: 'PROCESSING_FAILED',
    message: "We couldn't finish this conversion. Please try again.",
    status: 500,
  };
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

function extractQuoteContext(oembedHtml) {
  if (typeof oembedHtml !== 'string' || !oembedHtml.trim()) return null;
  const $ = cheerio.load(oembedHtml);
  const blocks = $('blockquote.twitter-tweet');
  if (blocks.length < 2) return null;

  const block = blocks.eq(1);
  const link = block.find('a[href*="/status/"]').last();
  const rawUrl = link.attr('href');
  const parsed = rawUrl ? parseTweetUrl(rawUrl) : null;
  if (!parsed) return null;

  const paragraph = block.find('p').first().clone();
  paragraph.find('br').replaceWith('\n');
  const text = paragraph.text().trim();
  const linkText = link.text().trim();
  const handleMatch = linkText.match(/@([A-Za-z0-9_]{1,15})/);
  const handle = handleMatch ? handleMatch[1] : parsed.username;
  const authorName = (linkText.replace(/\s*\(@[A-Za-z0-9_]{1,15}\)/, '').trim() || handle);
  if (!text && !authorName) return null;

  return {
    authorName,
    handle,
    tweetUrl: parsed.canonicalUrl,
    text,
  };
}

function hasQuoteMarkup(oembedHtml) {
  if (typeof oembedHtml !== 'string' || !oembedHtml.trim()) return false;
  const $ = cheerio.load(oembedHtml);
  return $('blockquote.twitter-tweet').length > 1;
}

function buildResultMetadata({ authorName, staticCard, quoteContext }) {
  return {
    authorName: typeof authorName === 'string' && authorName.trim() ? authorName.trim() : null,
    staticCard: staticCard === true,
    quoteContext: quoteContext && typeof quoteContext === 'object' ? quoteContext : null,
  };
}

async function readOutputMetadata(videoId) {
  try {
    const raw = await fs.readFile(path.join(outputDir, `${videoId}.json`), 'utf8');
    const metadata = JSON.parse(raw);
    return buildResultMetadata(metadata);
  } catch {
    return buildResultMetadata({});
  }
}

function isNoVideoDownloadError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /\bno (?:video|media) formats? found\b|\bno video found\b/i.test(message);
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
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    proc.stderr.on('data', d => { stderr = (stderr + d.toString()).slice(-8192); });
    proc.stdout.on('data', d => { process.stdout.write(d); });

    proc.on('close', async (code) => {
      try {
        const files = await fs.readdir(sessionDir);
        const videoFile = files.find(f => f.startsWith('video.') && /\.(mp4|mkv|webm|mov)$/i.test(f));
        if (videoFile) {
          const fullPath = path.join(sessionDir, videoFile);
          const stats = await fs.stat(fullPath);
          if (stats.size > 10000) {
            return finish(resolve, fullPath);
          }
        }
        finish(reject, new Error(`yt-dlp failed (code ${code}): ${stderr.slice(-300)}`));
      } catch (e) {
        finish(reject, e);
      }
    });

    proc.on('error', err => {
      finish(reject, new Error(`yt-dlp not available: ${err.message}`));
    });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish(reject, new Error('yt-dlp timed out after 120s'));
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
  const allowedHosts = new Set(['unavatar.io', 'pbs.twimg.com', 'video.twimg.com', 'abs.twimg.com']);
  let currentUrl = url;
  let response;
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!isSafeRemoteUrl(currentUrl, allowedHosts)) throw new Error('Unsafe remote media URL');
    response = await axios.get(currentUrl, {
      responseType: 'arraybuffer', timeout: 10000,
      maxContentLength: 10 * 1024 * 1024, maxBodyLength: 10 * 1024 * 1024,
      maxRedirects: 0, validateStatus: status => status >= 200 && status < 400,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
    });
    if (response.status < 300) break;
    const location = response.headers.location;
    if (!location || redirects === 3) throw new Error('Too many remote media redirects');
    currentUrl = new URL(location, currentUrl).href;
  }
  await fs.writeFile(filePath, Buffer.from(response.data));
  return filePath;
}

// Render the tweet as HTML for screenshotting
function renderTweetHtml({
  authorName, handle, tweetText, avatarFileUrl, mediaHtml, cardWidth = 598,
  tweetDate = null, quoteContext = null, quoteContextUnavailable = false,
}) {
  const esc = s => String(s || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));

  const avatarContent = avatarFileUrl
    ? `<img src="${esc(avatarFileUrl)}" class="avatar-img" alt="" />`
    : `<div class="avatar-letter">${esc((authorName || 'T')[0].toUpperCase())}</div>`;

  const dateStr = tweetDate instanceof Date && !isNaN(tweetDate)
    ? tweetDate.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric', year: 'numeric' })
    : new Date().toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric', year: 'numeric' });

  const safeQuoteUrl = quoteContext && parseTweetUrl(quoteContext.tweetUrl)
    ? parseTweetUrl(quoteContext.tweetUrl).canonicalUrl
    : null;
  const quoteHtml = quoteContext
    ? `<div class="quoted-post">
        <div class="quoted-label">Quoted post</div>
        <div class="quoted-author">${esc(quoteContext.authorName)} <span>@${esc(quoteContext.handle)}</span></div>
        <div class="quoted-text">${esc(quoteContext.text)}</div>
        ${safeQuoteUrl ? `<a class="quoted-link" href="${esc(safeQuoteUrl)}">View quoted post</a>` : ''}
      </div>`
    : (quoteContextUnavailable ? '<div class="quoted-post quote-unavailable"><div class="quoted-label">Quoted post content unavailable</div></div>' : '');

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
.quoted-post {
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid #cfd9de;
  border-radius: 12px;
  color: #0f1419;
}
.quoted-label { font-size: 12px; font-weight: 700; color: #536471; margin-bottom: 4px; }
.quoted-author { font-weight: 700; font-size: 14px; }
.quoted-author span { color: #536471; font-weight: 400; }
.quoted-text { margin-top: 4px; font-size: 14px; line-height: 1.4; white-space: pre-wrap; word-wrap: break-word; }
.quoted-link { display: inline-block; margin-top: 6px; color: #0b6ca8; font-size: 13px; }
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
    ${quoteHtml}
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
    return { screenshotPath, videoArea, cardWidth: Math.round(cardBox.width), cardHeight: Math.round(cardBox.height) };
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}

// Composite tweet screenshot with video overlay using FFmpeg.
// rotation is handled inline via transpose filter — no pre-encode step needed.
const FFMPEG_TIMEOUT_MS = Math.max(5_000, Number(process.env.FFMPEG_TIMEOUT_MS) || 5 * 60_000);

function runFfmpegCommand(command, options = {}) {
  const { label = 'FFmpeg conversion', timeoutMs = FFMPEG_TIMEOUT_MS, onStart, onStderr, onProgress } = options;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try { command.kill('SIGKILL'); } catch {}
      finish(reject, new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    command
      .on('start', value => onStart && onStart(value))
      .on('stderr', value => onStderr && onStderr(value))
      .on('progress', value => onProgress && onProgress(value))
      .on('error', error => finish(reject, error))
      .on('end', () => finish(resolve));
    try { command.run(); } catch (error) { finish(reject, error); }
  });
}

async function compositeVideo(screenshotPath, videoPath, videoArea, outputPath, hasAudio = false, rotation = 0) {
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
  try {
    await runFfmpegCommand(cmd, {
      label: 'FFmpeg composite',
      onStart: command => console.log('  FFmpeg cmd:', command),
      onStderr: line => { stderrLog = (stderrLog + line + '\n').slice(-8192); },
      onProgress: p => p.percent && console.log(`  Encoding: ${Math.round(p.percent)}%`),
    });
    return outputPath;
  } catch (error) {
    console.error('  FFmpeg stderr:\n' + stderrLog.slice(-2000));
    if (hasAudio) {
      console.warn('  Retrying without audio...');
      return compositeVideo(screenshotPath, videoPath, videoArea, outputPath, false, rotation);
    }
    throw new Error(`FFmpeg composite failed: ${error.message}\n${stderrLog.slice(-500)}`);
  }
}

// Create a short video from a static screenshot (tweets without video)
async function staticImageToVideo(screenshotPath, outputPath, durationSecs = 5) {
  const command = ffmpeg()
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
      .output(outputPath);
  try {
    await runFfmpegCommand(command, { label: 'FFmpeg static video' });
    return outputPath;
  } catch (error) {
    throw new Error(`FFmpeg static video failed: ${error.message}`);
  }
}

// Convert video to GIF (palette-optimized for quality)
async function videoToGif(videoPath, gifPath, targetWidth = 598) {
  const palettePath = gifPath.replace('.gif', '_pal.png');

  // Pass 1: generate palette
  try {
    const paletteCommand = ffmpeg(videoPath)
      .outputOptions([
        '-vf', `fps=15,scale=${targetWidth}:-1:flags=lanczos,palettegen=max_colors=256:reserve_transparent=0`,
        '-y',
      ])
      .output(palettePath);
    await runFfmpegCommand(paletteCommand, { label: 'FFmpeg GIF palette' });

    // Pass 2: render GIF using palette
    const gifCommand = ffmpeg(videoPath)
      .input(palettePath)
      .complexFilter([
        `[0:v]fps=15,scale=${targetWidth}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer`,
      ])
      .output(gifPath);
    await runFfmpegCommand(gifCommand, { label: 'FFmpeg GIF render' });
  } finally {
    await fs.unlink(palettePath).catch(() => {});
  }
  return gifPath;
}

// Convert video to WebM (VP9 + Opus — smaller than MP4, plays in all modern browsers)
async function videoToWebm(videoPath, webmPath) {
  const command = ffmpeg(videoPath)
      .outputOptions([
        '-c:v', 'libvpx-vp9',
        '-crf', '28',
        '-b:v', '0',          // CRF-only mode (best quality/size ratio)
        '-c:a', 'libopus',
        '-b:a', '128k',
        '-deadline', 'good',
        '-cpu-used', '2',
      ])
      .output(webmPath);
  await runFfmpegCommand(command, {
    label: 'FFmpeg WebM',
    onProgress: p => p.percent && console.log(`  WebM: ${Math.round(p.percent)}%`),
  });
  return webmPath;
}

// ─── SSE progress endpoint (with proxy-busting headers + keepalive heartbeat) ─
app.get('/api/progress/:jobId', (req, res) => {
  if (!isUuid(req.params.jobId)) return res.status(400).json({ error: 'Invalid job ID' });
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
    res.write(`data: ${JSON.stringify({
      type: 'done', result: job.result, stepIndex: job.stepIndex,
      stepCount: job.stepCount, elapsedMs: job.completedAt - job.startedAt,
    })}\n\n`);
    return res.end();
  }
  if (job.error) {
    res.write(`data: ${JSON.stringify({
      type: 'error', error: job.error, errorCode: job.errorCode,
      stepIndex: job.stepIndex, stepCount: job.stepCount,
      elapsedMs: job.completedAt - job.startedAt,
    })}\n\n`);
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
  if (!isUuid(req.params.jobId)) return res.status(400).json({ error: 'Invalid job ID' });
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const completedAt = job.completedAt || Date.now();
  const lastStep = job.steps[job.steps.length - 1] || null;
  res.json({
    jobId: req.params.jobId,
    done: !!job.result,
    error: job.error || null,
    errorCode: job.errorCode || null,
    message: lastStep ? lastStep.message : 'Starting...',
    stepIndex: lastStep && lastStep.stepIndex ? lastStep.stepIndex : job.stepIndex,
    stepCount: job.stepCount,
    elapsedMs: Math.max(0, completedAt - job.startedAt),
    result: job.result || null,
  });
});

// ─── Main API endpoint ───────────────────────────────────────────────────────
app.post('/api/process-tweet', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({
    error: 'Enter a valid public Twitter/X post URL.', errorCode: 'INVALID_URL',
  });

  const parsed = parseTweetUrl(url);
  if (!parsed) return res.status(400).json({
    error: 'Enter a valid public Twitter/X post URL.', errorCode: 'INVALID_URL',
  });

  // Rate limiting
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({
      error: 'Too many requests. Please wait a minute and try again.', errorCode: 'RATE_LIMITED',
    });
  }

  const { username, tweetId, canonicalUrl } = parsed;

  // Cache check — return existing output if files are still on disk
  const cachedVideoId = tweetCache.get(tweetId);
  if (cachedVideoId) {
    const mp4 = path.join(outputDir, `${cachedVideoId}.mp4`);
    const gif = path.join(outputDir, `${cachedVideoId}.gif`);
    if (fsSync.existsSync(mp4) && fsSync.existsSync(gif)) {
      console.log(`Cache hit for tweet ${tweetId} → ${cachedVideoId}`);
      const webmPath = path.join(outputDir, `${cachedVideoId}.webm`);
      const cachedMetadata = await readOutputMetadata(cachedVideoId);
      return res.json({
        success: true,
        cached: true,
        video: `/outputs/${cachedVideoId}.mp4`,
        gif: `/outputs/${cachedVideoId}.gif`,
        webm: fsSync.existsSync(webmPath) ? `/outputs/${cachedVideoId}.webm` : null,
        videoId: cachedVideoId,
        ...cachedMetadata,
      });
    }
    tweetCache.delete(tweetId); // stale entry
  }

  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    return res.status(503).json({
      error: 'Conversion capacity is full. Please try again later.', errorCode: 'CAPACITY_FULL',
    });
  }

  // Return jobId immediately; process async so the client can stream progress
  const jobId = uuidv4();
  createJob(jobId);
  activeJobs++;
  res.json({ success: true, jobId });

  // ── Async processing ──────────────────────────────────────────────────────
  (async () => {
    const sessionId = uuidv4();
    const sessionDir = path.join(tempDir, sessionId);
    const partialOutputs = [];
    let processingPhase = 'setup';

    try {
      await fs.mkdir(sessionDir, { recursive: true });
      console.log(`\n── Processing tweet ${tweetId} by @${username} (job ${jobId}) ──`);

      // 1. Fetch tweet metadata
      processingPhase = 'oembed';
      emitProgress(jobId, { type: 'step', message: 'Fetching tweet metadata...' });
      const oembedData = await fetchOEmbed(canonicalUrl);
      const tweetText = extractTweetText(oembedData.html);
      const authorName = oembedData.author_name || username;
      const quoteContext = extractQuoteContext(oembedData.html);
      const quoteContextUnavailable = hasQuoteMarkup(oembedData.html) && !quoteContext;
      const tweetDate = tweetDateFromId(tweetId);
      console.log(`  Author: ${authorName}`);
      console.log(`  Tweet date: ${tweetDate ? tweetDate.toISOString() : 'unknown'}`);

      // 2. Download video
      processingPhase = 'video';
      emitProgress(jobId, { type: 'step', message: 'Downloading video...' });
      let videoPath = null;
      let videoInfo = null;
      try {
        videoPath = await downloadVideoYtDlp(canonicalUrl, sessionDir);
        videoInfo = await getVideoInfo(videoPath);
        console.log(`  Video: ${videoInfo.width}x${videoInfo.height}, ${videoInfo.duration.toFixed(1)}s, audio=${videoInfo.hasAudio}`);
      } catch (err) {
        console.warn(`  Video download failed: ${err.message}`);
        if (!isNoVideoDownloadError(err)) throw err;
        emitProgress(jobId, { type: 'step', message: 'No video found, rendering image card...' });
      }

      // 3. Fetch avatar
      processingPhase = 'avatar';
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
      processingPhase = 'render';
      emitProgress(jobId, { type: 'step', message: 'Rendering tweet card...' });
      const htmlContent = renderTweetHtml({
        authorName, handle: username, tweetText, avatarFileUrl, mediaHtml,
        cardWidth, tweetDate, quoteContext, quoteContextUnavailable,
      });
      const htmlPath = path.join(sessionDir, 'tweet.html');
      await fs.writeFile(htmlPath, htmlContent, 'utf8');

      const { screenshotPath, videoArea, cardHeight: outputHeight } = await screenshotTweet(htmlPath);
      console.log(`  Screenshot saved. Video area: ${JSON.stringify(videoArea)}`);

      // 7. Composite video (rotation applied inline — no pre-encode pass)
      processingPhase = 'composite';
      emitProgress(jobId, { type: 'step', message: 'Compositing video...' });
      const videoId = uuidv4();
      const outputVideoPath = path.join(outputDir, `${videoId}.mp4`);
      partialOutputs.push(outputVideoPath);

      if (videoPath && videoArea) {
        console.log(`Compositing tweet frame with video (audio=${videoInfo.hasAudio}, rotation=${videoInfo.rotation})...`);
        await compositeVideo(screenshotPath, videoPath, videoArea, outputVideoPath, videoInfo.hasAudio, videoInfo.rotation);
      } else {
        console.log('Creating static image video (no video in tweet)...');
        await staticImageToVideo(screenshotPath, outputVideoPath, 5);
      }
      console.log('  MP4 created');

      // 8. Convert to GIF
      processingPhase = 'gif';
      emitProgress(jobId, { type: 'step', message: 'Creating GIF...' });
      const gifPath = path.join(outputDir, `${videoId}.gif`);
      partialOutputs.push(gifPath);
      try {
        await videoToGif(outputVideoPath, gifPath, cardWidth);
        console.log('  GIF created');
      } catch (gifErr) {
        console.warn(`  GIF palette conversion failed (${gifErr.message}), trying simple conversion...`);
        const fallbackCommand = ffmpeg(outputVideoPath)
          .outputOptions([`-vf`, `fps=12,scale=${cardWidth}:-1:flags=lanczos`])
          .output(gifPath);
        await runFfmpegCommand(fallbackCommand, { label: 'FFmpeg GIF fallback' });
        console.log('  GIF created (simple)');
      }

      // 9. Convert to WebM
      processingPhase = 'webm';
      emitProgress(jobId, { type: 'step', message: 'Creating WebM...' });
      const webmPath = path.join(outputDir, `${videoId}.webm`);
      partialOutputs.push(webmPath);
      try {
        await videoToWebm(outputVideoPath, webmPath);
        console.log('  WebM created');
      } catch (webmErr) {
        await fs.rm(webmPath, { force: true }).catch(() => {});
        console.warn(`  WebM conversion failed: ${webmErr.message}`);
      }

      // Cleanup session temp files
      await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});

      // Save metadata so the share page can link back to the original tweet
      const metaPath = path.join(outputDir, `${videoId}.json`);
      const staticCard = !(videoPath && videoInfo);
      const resultMetadata = buildResultMetadata({ authorName, staticCard, quoteContext });
      await fs.writeFile(metaPath, JSON.stringify({
        tweetUrl: canonicalUrl, width: cardWidth, height: outputHeight, ...resultMetadata,
      }), 'utf8').catch(() => {});

      // Store in cache
      tweetCache.set(tweetId, videoId);

      console.log(`\nDone! Output: ${videoId}`);
      resolveJob(jobId, {
        video: `/outputs/${videoId}.mp4`,
        gif: `/outputs/${videoId}.gif`,
        webm: fsSync.existsSync(webmPath) ? `/outputs/${videoId}.webm` : null,
        videoId,
        ...resultMetadata,
      });

    } catch (error) {
      console.error('Error processing tweet:', error);
      await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
      await Promise.all(partialOutputs.map(file => fs.rm(file, { force: true }).catch(() => {})));
      const safeError = classifyProcessingError(error, processingPhase);
      rejectJob(jobId, safeError.message, safeError.errorCode);
    } finally {
      activeJobs = Math.max(0, activeJobs - 1);
    }
  })();
});

// Serve output files
app.use('/outputs', express.static(outputDir));

function resolvePublicBase(req) {
  if (process.env.PUBLIC_BASE_URL) {
    const configured = new URL(process.env.PUBLIC_BASE_URL);
    if (!['http:', 'https:'].includes(configured.protocol) || configured.username || configured.password) {
      throw new Error('Invalid PUBLIC_BASE_URL');
    }
    return configured.origin;
  }

  const rawHost = req.get('host');
  const parsedHost = new URL(`http://${rawHost}`);
  const hostname = parsedHost.hostname.toLowerCase();
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  const allowed = new Set((process.env.PUBLIC_HOSTS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
  if (!loopback && !allowed.has(hostname) && !allowed.has(parsedHost.host.toLowerCase())) return null;

  return `${req.protocol === 'https' ? 'https' : 'http'}://${parsedHost.host}`;
}

// Share embed page — returns OG-tagged HTML so Discord/Slack/etc embed properly with audio
// Usage: /share/:videoId?f=video  (f = gif | video | webm, defaults to video)
app.get('/share/:videoId', async (req, res) => {
  const { videoId } = req.params;
  if (!isUuid(videoId)) return res.status(400).send('Invalid output ID');
  const requestedFormat = typeof req.query.f === 'string' ? req.query.f : 'video';
  const format = new Set(['video', 'gif', 'webm']).has(requestedFormat) ? requestedFormat : 'video';

  const mp4Exists  = fsSync.existsSync(path.join(outputDir, `${videoId}.mp4`));
  const gifExists  = fsSync.existsSync(path.join(outputDir, `${videoId}.gif`));
  const webmExists = fsSync.existsSync(path.join(outputDir, `${videoId}.webm`));

  if (!mp4Exists && !gifExists && !webmExists) {
    return res.status(404).send('Not found');
  }

  // Load stored metadata (tweet URL + author) if available
  let tweetUrl = null;
  let authorName = null;
  let outputWidth = 598;
  let outputHeight = 336;
  try {
    const raw = await fs.readFile(path.join(outputDir, `${videoId}.json`), 'utf8');
    const meta = JSON.parse(raw);
    ({ tweetUrl, authorName } = meta);
    if (Number.isInteger(meta.width) && meta.width > 0) outputWidth = meta.width;
    if (Number.isInteger(meta.height) && meta.height > 0) outputHeight = meta.height;
  } catch {}

  let base;
  try {
    base = resolvePublicBase(req);
  } catch {
    return res.status(500).send('Share origin configuration is invalid');
  }
  if (!base) return res.status(503).send('Share origin is not configured');
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
  } else if (gifExists) {
    fileUrl = gifUrl; mimeType = 'image/gif';
  } else {
    fileUrl = webmUrl; mimeType = 'video/webm';
  }

  const isVideo = mimeType.startsWith('video/');
  const actualFormat = mimeType === 'video/webm' ? 'webm' : (mimeType === 'image/gif' ? 'gif' : 'video');
  const shareUrl = `${base}/share/${videoId}?f=${actualFormat}`;
  const thumbUrl = gifExists ? gifUrl : (mp4Exists ? mp4Url : null);
  const ogTitle = escapeHtml(authorName ? `Tweet by ${authorName}` : 'Tweet Video');
  const ogDescription = 'Shareable tweet video with audio';
  const safeShareUrl = escapeHtml(shareUrl);
  const safeFileUrl = escapeHtml(fileUrl);
  const safeThumbUrl = thumbUrl ? escapeHtml(thumbUrl) : null;
  const safeTweetUrl = tweetUrl && parseTweetUrl(tweetUrl) ? escapeHtml(parseTweetUrl(tweetUrl).canonicalUrl) : null;
  const safeMimeType = escapeHtml(mimeType);
  const safeDescription = escapeHtml(ogDescription);
  const safeWidth = escapeHtml(outputWidth);
  const safeHeight = escapeHtml(outputHeight);
  const twitterCard = isVideo ? 'player' : 'summary_large_image';

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${ogTitle}</title>
  <link rel="canonical" href="${safeShareUrl}" />
  <meta property="og:type" content="${isVideo ? 'video.other' : 'website'}" />
  <meta property="og:title" content="${ogTitle}" />
  <meta property="og:description" content="${safeDescription}" />
  <meta property="og:url" content="${safeShareUrl}" />
  ${safeThumbUrl ? `<meta property="og:image" content="${safeThumbUrl}" />` : ''}
  ${safeThumbUrl ? `<meta property="og:image:width" content="${safeWidth}" />` : ''}
  ${safeThumbUrl ? `<meta property="og:image:height" content="${safeHeight}" />` : ''}
  <meta name="twitter:card" content="${twitterCard}" />
  <meta name="twitter:title" content="${ogTitle}" />
  <meta name="twitter:description" content="${safeDescription}" />
  ${safeThumbUrl ? `<meta name="twitter:image" content="${safeThumbUrl}" />` : ''}
  ${isVideo ? `
  <meta property="og:video" content="${safeFileUrl}" />
  <meta property="og:video:url" content="${safeFileUrl}" />
  <meta property="og:video:secure_url" content="${safeFileUrl}" />
  <meta property="og:video:type" content="${safeMimeType}" />
  <meta property="og:video:width" content="${safeWidth}" />
  <meta property="og:video:height" content="${safeHeight}" />
  <meta name="twitter:player" content="${safeShareUrl}" />
  <meta name="twitter:player:width" content="${safeWidth}" />
  <meta name="twitter:player:height" content="${safeHeight}" />
  <meta name="twitter:player:stream" content="${safeFileUrl}" />
  <meta name="twitter:player:stream:content_type" content="${safeMimeType}" />
  ${mp4Exists && mimeType !== 'video/mp4' ? `
  <meta property="og:video" content="${mp4Url}" />
  <meta property="og:video:url" content="${mp4Url}" />
  <meta property="og:video:secure_url" content="${mp4Url}" />
  <meta property="og:video:type" content="video/mp4" />
  <meta property="og:video:width" content="${safeWidth}" />
  <meta property="og:video:height" content="${safeHeight}" />` : ''}
  ` : ''}
</head>
<body>
  ${isVideo
    ? `<video src="${safeFileUrl}" ${safeThumbUrl ? `poster="${safeThumbUrl}" ` : ''}controls playsinline style="max-width:100%;height:auto"></video>`
    : `<img src="${safeFileUrl}" alt="${ogTitle}" style="max-width:100%;height:auto" />`}
  <p><a href="${safeFileUrl}">Open media file</a></p>
  ${safeTweetUrl ? `<p><a href="${safeTweetUrl}">View original tweet</a></p>` : ''}
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', `default-src 'none'; media-src ${base}; img-src ${base}; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors https://discord.com https://*.discord.com`);
  res.send(html);
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  if (err instanceof SyntaxError && err.status === 400) return res.status(400).json({ error: 'Malformed JSON' });
  return next(err);
});

let httpServer = null;
let cleanupTimer = null;
let jobTimer = null;

function clearLifecycleTimers() {
  if (cleanupTimer) clearInterval(cleanupTimer);
  if (jobTimer) clearInterval(jobTimer);
  cleanupTimer = null;
  jobTimer = null;
}

async function startServer(options = {}) {
  if (httpServer) return httpServer;
  await ensureDirectories();

  // Pre-warm browser so first request doesn't pay the launch cost
  if (options.prewarm !== false) getBrowser().catch(e => console.warn('Browser pre-warm failed:', e.message));

  // Auto-cleanup: remove output files older than 24 hours
  cleanOldOutputs();
  cleanupTimer = setInterval(() => cleanOldOutputs(), 3_600_000);
  jobTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobs) if (job.expiresAt <= now && job.clients.length === 0) jobs.delete(id);
  }, Math.min(JOB_TTL_MS, 60_000));

  const port = options.port ?? PORT;
  const candidateServer = app.listen(port);
  try {
    await new Promise((resolve, reject) => {
      candidateServer.once('listening', resolve);
      candidateServer.once('error', reject);
    });
    httpServer = candidateServer;
  } catch (error) {
    clearLifecycleTimers();
    if (candidateServer.listening) await new Promise(resolve => candidateServer.close(resolve));
    httpServer = null;
    throw error;
  }
  {
    const { version } = require('./package.json');
    console.log(`\nTweet Giffer v${version} running at http://localhost:${httpServer.address().port}`);
    console.log('Requires: yt-dlp installed and in PATH (https://github.com/yt-dlp/yt-dlp)\n');
  }
  return httpServer;
}

async function stopServer() {
  clearLifecycleTimers();
  for (const job of jobs.values()) {
    for (const client of job.clients) {
      try { client.end(); } catch {}
    }
    job.clients = [];
  }
  const server = httpServer;
  httpServer = null;
  if (server) {
    const closed = new Promise(resolve => server.close(resolve));
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await closed;
  }
  if (_browser) await _browser.close().catch(() => {});
  _browser = null;
}

if (require.main === module) {
  startServer().catch(error => { console.error(error); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => stopServer().finally(() => process.exit(0)));
  }
}

module.exports = {
  app,
  startServer,
  stopServer,
  _internals: {
    runFfmpegCommand,
    isNoVideoDownloadError,
    PIPELINE_STAGES,
    createJob,
    emitProgress,
    classifyProcessingError,
    extractQuoteContext,
    buildResultMetadata,
    renderTweetHtml,
    tweetCache,
  },
};
