const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const { spawn, execFile, execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const dns = require('dns').promises;
const net = require('net');
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
const trustedProxyIps = new Set(
  (process.env.TRUST_PROXY_IPS || '127.0.0.1,::1')
    .split(',').map(value => value.trim()).filter(Boolean)
);
const trustProxyEnabled = /^(1|true)$/i.test(process.env.TRUST_PROXY || '');
app.set('trust proxy', trustProxyEnabled ? ip => trustedProxyIps.has(String(ip).replace(/^::ffff:/i, '')) : false);
const allowedOrigin = process.env.ALLOWED_ORIGIN || process.env.CORS_ORIGIN;
if (allowedOrigin && allowedOrigin !== '*') {
  app.use(cors({ origin: (origin, callback) => callback(null, !origin || origin === allowedOrigin) }));
}
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '4kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const outputDir = path.resolve(process.env.OUTPUT_DIR || path.join(__dirname, 'outputs'));
const tempDir = path.resolve(process.env.TEMP_DIR || path.join(__dirname, 'temp'));

function positiveEnvNumber(name, fallback, minimum = 1) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

const MAX_DOWNLOAD_BYTES = positiveEnvNumber('MAX_DOWNLOAD_BYTES', 200 * 1024 * 1024);
const MAX_VIDEO_DURATION_SEC = positiveEnvNumber('MAX_VIDEO_DURATION_SEC', 10 * 60);
const MAX_VIDEO_DIMENSION = positiveEnvNumber('MAX_VIDEO_DIMENSION', 4096);
const MAX_OUTPUT_BYTES = positiveEnvNumber('MAX_OUTPUT_BYTES', 5 * 1024 * 1024 * 1024);
const MAX_REMOTE_MEDIA_BYTES = positiveEnvNumber('MAX_REMOTE_MEDIA_BYTES', 10 * 1024 * 1024);

async function ensureDirectories() {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(tempDir, { recursive: true });
}

if (ffmpegPath) console.log('Using bundled FFmpeg');

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
const JOB_TIMEOUT_MS = Math.max(30_000, Number(process.env.JOB_TIMEOUT_MS) || 15 * 60_000);
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
const inFlightTweets = new Map(); // tweetId -> jobId
const activeProcesses = new Set();
const activeSessionDirs = new Set();
let serverStopping = false;
let serverGeneration = 0;

function createJob(jobId) {
  const now = Date.now();
  const job = {
    steps: [], result: null, error: null, errorCode: null, clients: [],
    createdAt: now, startedAt: now, completedAt: null,
    stepIndex: 0, stepCount: PIPELINE_STAGES.length,
    expiresAt: null,
    deadlineAt: now + JOB_TIMEOUT_MS,
    generation: serverGeneration,
    active: true,
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
  if (job.tweetId && inFlightTweets.get(job.tweetId) === jobId) inFlightTweets.delete(job.tweetId);
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
  if (job.tweetId && inFlightTweets.get(job.tweetId) === jobId) inFlightTweets.delete(job.tweetId);
}

function pruneExpiredJobs(now = Date.now()) {
  for (const [id, job] of jobs) {
    if (job.completedAt && job.expiresAt && job.expiresAt <= now && job.clients.length === 0) jobs.delete(id);
  }
}

function assertJobWithinDeadline(jobId) {
  const job = jobs.get(jobId);
  if (serverStopping || !job || job.generation !== serverGeneration || (job.deadlineAt && Date.now() > job.deadlineAt)) {
    throw new Error('Tweet conversion exceeded the processing time limit');
  }
}

function boundedTimeout(deadlineAt, fallback) {
  if (!deadlineAt) return fallback;
  return Math.max(1, Math.min(fallback, deadlineAt - Date.now()));
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
  if (phase === 'timeout') {
    return {
      errorCode: 'PROCESSING_TIMEOUT',
      message: 'This conversion took too long and was stopped. Please try again.',
      status: 504,
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
    await pruneTweetCache();
  } catch (e) {
    console.warn('Cleanup error:', e.message);
  }
}

// ─── Puppeteer browser pool (singleton — warm browser reused across requests) ─
let _browser = null;
let browserLaunch = null;
let browserLastError = null;

async function getPuppeteerOpts() {
  const opts = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
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
  if (browserLaunch) return browserLaunch;
  browserLaunch = (async () => {
    try {
      const browser = await puppeteer.launch(await getPuppeteerOpts());
      _browser = browser;
      browserLastError = null;
      console.log('Puppeteer browser started');
      return browser;
    } catch (error) {
      browserLastError = error;
      throw error;
    } finally {
      browserLaunch = null;
    }
  })();
  return browserLaunch;
}

async function cleanOldTempDirs(maxAgeHours = 24) {
  const cutoff = Date.now() - maxAgeHours * 3_600_000;
  try {
    const entries = await fs.readdir(tempDir, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !isUuid(entry.name)) continue;
      const dir = path.join(tempDir, entry.name);
      if (activeSessionDirs.has(dir)) continue;
      const stat = await fs.stat(dir).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        removed++;
      }
    }
    if (removed) console.log(`Cleanup: removed ${removed} temporary session(s) older than ${maxAgeHours}h`);
  } catch (error) {
    console.warn('Temporary cleanup error:', error.message);
  }
}

async function pruneTweetCache() {
  for (const [tweetId, videoId] of tweetCache) {
    const mp4Exists = await fs.access(path.join(outputDir, `${videoId}.mp4`)).then(() => true).catch(() => false);
    const gifExists = await fs.access(path.join(outputDir, `${videoId}.gif`)).then(() => true).catch(() => false);
    if (!mp4Exists || !gifExists) tweetCache.delete(tweetId);
  }
}

async function hydrateTweetCache() {
  const files = await fs.readdir(outputDir).catch(() => []);
  for (const file of files) {
    if (!/^[0-9a-f-]{36}\.json$/i.test(file)) continue;
    const videoId = file.slice(0, -5);
    const metadata = await fs.readFile(path.join(outputDir, file), 'utf8').then(JSON.parse).catch(() => null);
    const parsed = typeof metadata?.tweetId === 'string' && /^\d+$/.test(metadata.tweetId)
      ? { tweetId: metadata.tweetId }
      : (metadata?.tweetUrl ? parseTweetUrl(metadata.tweetUrl) : null);
    if (!parsed) continue;
    const mp4Exists = await fs.access(path.join(outputDir, `${videoId}.mp4`)).then(() => true).catch(() => false);
    const gifExists = await fs.access(path.join(outputDir, `${videoId}.gif`)).then(() => true).catch(() => false);
    if (mp4Exists && gifExists) tweetCache.set(parsed.tweetId, videoId);
  }
}

async function getOutputUsageBytes() {
  let total = 0;
  const files = await fs.readdir(outputDir).catch(() => []);
  for (const file of files) {
    if (!/\.(mp4|gif|webm|json)$/i.test(file)) continue;
    const stat = await fs.stat(path.join(outputDir, file)).catch(() => null);
    if (stat?.isFile()) total += stat.size;
  }
  return total;
}

async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${uuidv4()}.tmp`;
  try {
    await fs.writeFile(tempPath, JSON.stringify(value), 'utf8');
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function assertOutputUsageWithinLimit() {
  const usage = await getOutputUsageBytes();
  if (usage > MAX_OUTPUT_BYTES) throw new Error('Generated outputs exceed the storage limit');
}

// ─── yt-dlp discovery ────────────────────────────────────────────────────────
function findYtDlp() {
  // 1. Try yt-dlp directly (if in PATH)
  try {
    execFileSync('yt-dlp', ['--version'], { stdio: 'pipe', timeout: 5000 });
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
    try {
      if (fsSync.statSync(c).isFile()) {
        console.log(`Found yt-dlp at: ${c}`);
        return c;
      }
    } catch {}
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

function formatYtDlpSize(bytes) {
  // yt-dlp accepts a bare byte count; using it avoids rounding a small
  // deployment-specific limit up to a whole megabyte.
  return String(Math.max(1, Math.floor(bytes)));
}

function buildYtDlpArgs(tweetUrl, sessionDir) {
  const outputTemplate = path.join(sessionDir, 'video.%(ext)s');
  return [
    tweetUrl,
    '-o', outputTemplate,
    '--no-playlist',
    '--ignore-config',
    '--use-extractors', 'twitter',
    '--max-downloads', '1',
    '--max-filesize', formatYtDlpSize(MAX_DOWNLOAD_BYTES),
    '--match-filter', `duration <= ${MAX_VIDEO_DURATION_SEC} & width <= ${MAX_VIDEO_DIMENSION} & height <= ${MAX_VIDEO_DIMENSION}`,
    '--socket-timeout', '30',
    '--merge-output-format', 'mp4',
    // Use combined (muxed) formats first — these are always natively oriented.
    // Avoid bestvideo+bestaudio which on Docker picks HLS video-only streams that
    // Twitter encodes as landscape with black bars baked in.
    '-f', 'best[ext=mp4]/best',
    '--no-warnings',
    '--quiet',
  ];
}

// Convert local path to file:// URL with correct escaping on every platform.
function toFileUrl(p) {
  return pathToFileURL(path.resolve(p)).href;
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
function buildOEmbedUrl(tweetUrl) {
  return `https://publish.x.com/oembed?url=${encodeURIComponent(tweetUrl)}&omit_script=true`;
}

async function fetchOEmbed(tweetUrl) {
  const oembedUrl = buildOEmbedUrl(tweetUrl);
  const response = await axios.get(oembedUrl, {
    timeout: 15000,
    maxContentLength: MAX_REMOTE_MEDIA_BYTES,
    maxBodyLength: MAX_REMOTE_MEDIA_BYTES,
    maxRedirects: 0,
    validateStatus: status => status >= 200 && status < 300,
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

function profileHandleFromUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value);
    if (!['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'].includes(parsed.hostname.toLowerCase())) return null;
    if (parsed.username || parsed.password || parsed.port) return null;
    const match = parsed.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function resolveOEmbedIdentity(oembedData, fallback) {
  const safeFallback = fallback || {};
  const fallbackParsed = parseTweetUrl(safeFallback.canonicalUrl || '');
  const upstreamTweet = parseTweetUrl(typeof oembedData?.url === 'string' ? oembedData.url : '');
  const handle = profileHandleFromUrl(oembedData?.author_url) || upstreamTweet?.username || safeFallback.username || 'user';
  const authorName = typeof oembedData?.author_name === 'string' && oembedData.author_name.trim()
    ? oembedData.author_name.trim()
    : handle;
  const sameTweet = upstreamTweet && (!safeFallback.tweetId || upstreamTweet.tweetId === safeFallback.tweetId);
  return {
    authorName,
    handle,
    tweetUrl: sameTweet ? upstreamTweet.canonicalUrl : (fallbackParsed?.canonicalUrl || safeFallback.canonicalUrl || null),
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
  return /\bno (?:video|media) formats? found\b|\bno video (?:could be )?found\b/i.test(message);
}

// Download video using yt-dlp
async function downloadVideoYtDlp(tweetUrl, sessionDir, timeoutMs = 120000) {
  if (!YT_DLP) throw new Error('yt-dlp is not installed. Run: pip install yt-dlp');

  return new Promise((resolve, reject) => {
    const args = buildYtDlpArgs(tweetUrl, sessionDir);

    console.log('Running yt-dlp...');
    const proc = spawn(YT_DLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    activeProcesses.add(proc);

    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeProcesses.delete(proc);
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
          if (stats.isFile() && stats.size > 10000 && stats.size <= MAX_DOWNLOAD_BYTES) {
            return finish(resolve, fullPath);
          }
          if (stats.size > MAX_DOWNLOAD_BYTES) throw new Error(`Downloaded video exceeds the ${formatYtDlpSize(MAX_DOWNLOAD_BYTES)} limit`);
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
      finish(reject, new Error(`yt-dlp timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });
}

// Get video dimensions, duration, and audio presence using ffmpeg -i
// (avoids needing ffprobe, which ffmpeg-static does not bundle)
function parseVideoInfoOutput(output) {
  const text = String(output || '');
  const videoMatch = text.match(/Stream #\S+: Video:[^\n]*?[ ,](\d{2,5})x(\d{2,5})(?:[ ,\[]|$)/im);
  if (!videoMatch) return null;
  let width = parseInt(videoMatch[1], 10);
  let height = parseInt(videoMatch[2], 10);
  const hasAudio = /Stream #\S+: Audio:/i.test(text);
  let rotation = 0;
  const rotateMeta = text.match(/rotate\s*:\s*(-?\d+)/i) || text.match(/rotation of (-?\d+(?:\.\d+)?) degrees/i);
  if (rotateMeta) {
    const rawDeg = Math.round(parseFloat(rotateMeta[1]));
    rotation = ((rawDeg % 360) + 360) % 360;
    if (![0, 90, 180, 270].includes(rotation)) rotation = 0;
    if (rotation === 90 || rotation === 270) [width, height] = [height, width];
  }
  const durMatch = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  const duration = durMatch
    ? parseInt(durMatch[1], 10) * 3600 + parseInt(durMatch[2], 10) * 60 + parseFloat(durMatch[3])
    : null;
  return { width, height, duration, hasAudio, rotation };
}

async function getVideoInfo(videoPath, timeoutMs = 15000) {
  const ffmpegBin = ffmpegPath && fsSync.existsSync(ffmpegPath) ? ffmpegPath : 'ffmpeg';
  return new Promise((resolve, reject) => {
    // ffmpeg -i always exits non-zero but writes full stream info to stderr
    execFile(ffmpegBin, ['-i', videoPath, '-hide_banner'], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err && (err.killed || err.code === 'ETIMEDOUT')) return reject(new Error('Unable to read video metadata'));
      const info = parseVideoInfoOutput(stderr || '');
      if (!info || !Number.isFinite(info.duration) || info.duration <= 0) {
        return reject(new Error('Unable to read video metadata'));
      }
      if (info.width > MAX_VIDEO_DIMENSION || info.height > MAX_VIDEO_DIMENSION) {
        return reject(new Error(`Video dimensions exceed the ${MAX_VIDEO_DIMENSION}px limit`));
      }
      if (info.duration > MAX_VIDEO_DURATION_SEC) {
        return reject(new Error(`Video duration exceeds the ${MAX_VIDEO_DURATION_SEC}s limit`));
      }
      console.log(`  ffmpeg info → ${info.width}x${info.height}, ${info.duration.toFixed(1)}s, audio=${info.hasAudio}, rotation=${info.rotation}`);
      resolve(info);
    });
  });
}

function isPrivateIp(address) {
  const value = String(address || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (value === '::' || value === '::1') return true;
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice(7);
    if (net.isIP(mapped) === 4) return isPrivateIp(mapped);
    const mappedParts = mapped.split(':');
    if (mappedParts.length === 2 && mappedParts.every(part => /^[0-9a-f]{1,4}$/.test(part))) {
      const first = parseInt(mappedParts[0], 16);
      const second = parseInt(mappedParts[1], 16);
      return isPrivateIp(`${first >>> 8}.${first & 255}.${second >>> 8}.${second & 255}`);
    }
  }
  if (net.isIP(value) === 6 && (value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value))) return true;
  const octets = value.split('.').map(Number);
  if (octets.length !== 4 || octets.some(o => !Number.isInteger(o) || o < 0 || o > 255)) return false;
  const [first, second] = octets;
  return first === 0 || first === 10 || first === 127 || first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 0 || second === 168)) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 203 && second === 0);
}

async function assertSafeRemoteDestination(value, allowedHosts) {
  if (!isSafeRemoteUrl(value, allowedHosts)) throw new Error('Unsafe remote media URL');
  const hostname = new URL(value).hostname;
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (records.some(record => isPrivateIp(record.address))) throw new Error('Unsafe remote media destination');
}

// Download a file (image/avatar)
async function downloadFile(url, filePath, timeoutMs = 10000) {
  const allowedHosts = new Set(['unavatar.io', 'pbs.twimg.com', 'video.twimg.com', 'abs.twimg.com']);
  let currentUrl = url;
  let response;
  for (let redirects = 0; redirects <= 3; redirects++) {
    await assertSafeRemoteDestination(currentUrl, allowedHosts);
    response = await axios.get(currentUrl, {
      responseType: 'arraybuffer', timeout: timeoutMs,
      maxContentLength: MAX_REMOTE_MEDIA_BYTES, maxBodyLength: MAX_REMOTE_MEDIA_BYTES,
      maxRedirects: 0, validateStatus: status => status >= 200 && status < 400,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
    });
    if (response.status < 300) break;
    const location = response.headers.location;
    if (!location || redirects === 3) throw new Error('Too many remote media redirects');
    currentUrl = new URL(location, currentUrl).href;
  }
  if (!response || !Buffer.isBuffer(response.data) || response.data.length > MAX_REMOTE_MEDIA_BYTES) {
    throw new Error('Remote media exceeds the size limit');
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
async function screenshotTweet(htmlPath, timeoutMs = 30000) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 700, height: 1400, deviceScaleFactor: 1 });
    await page.goto(toFileUrl(htmlPath), { waitUntil: 'networkidle0', timeout: timeoutMs });

    const imageWaitMs = Math.min(4000, Math.max(100, timeoutMs));
    await page.evaluate((waitMs) => Promise.all(
      Array.from(document.images).map(img =>
        img.complete ? null : new Promise(r => { img.onload = r; img.onerror = r; setTimeout(r, waitMs); })
      ).filter(Boolean)
    ), imageWaitMs);
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

function rotationFilterFor(rotation) {
  if (rotation === 90) return 'transpose=2,';
  if (rotation === 270) return 'transpose=1,';
  if (rotation === 180) return 'vflip,hflip,';
  return '';
}

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

async function compositeVideo(screenshotPath, videoPath, videoArea, outputPath, hasAudio = false, rotation = 0, deadlineAt = null) {
  const { x, y } = videoArea;
  // libx264 requires dimensions divisible by 2 — round down
  const width  = videoArea.width  % 2 === 0 ? videoArea.width  : videoArea.width  - 1;
  const height = videoArea.height % 2 === 0 ? videoArea.height : videoArea.height - 1;

  // Apply rotation in the filter chain (avoids a separate pre-encode pass)
  // These transpose values match FFmpeg's transpose filter: 1=CW90, 2=CCW90
  const rotateFilter = rotationFilterFor(rotation);

  const outputOpts = [
    '-y',
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

  const filter = [
    // Rotate (if needed), then scale to fit placeholder, pad any remaining space with black
    `[1:v]${rotateFilter}scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black[vid]`,
    `[0:v][vid]overlay=${x}:${y}:shortest=1[v1]`,
    // libx264 requires even dimensions — round down via trunc
    `[v1]scale=trunc(iw/2)*2:trunc(ih/2)*2[out]`,
  ].join(';');
  const args = ['-loop', '1', '-i', screenshotPath, '-noautorotate', '-i', videoPath, '-filter_complex', filter, ...outputOpts, outputPath];
  try {
    await runFfmpegArgs(args, {
      label: 'FFmpeg composite',
      timeoutMs: boundedTimeout(deadlineAt, FFMPEG_TIMEOUT_MS),
      onStart: command => console.log('  FFmpeg cmd:', command),
      onStderr: line => { stderrLog = (stderrLog + line + '\n').slice(-8192); },
      onProgress: p => p.percent && console.log(`  Encoding: ${Math.round(p.percent)}%`),
    });
    return outputPath;
  } catch (error) {
    console.error('  FFmpeg stderr:\n' + stderrLog.slice(-2000));
    if (/timed out|time limit/i.test(error.message || '')) throw error;
    if (hasAudio) {
      console.warn('  Retrying without audio...');
      return compositeVideo(screenshotPath, videoPath, videoArea, outputPath, false, rotation, deadlineAt);
    }
    throw new Error(`FFmpeg composite failed: ${error.message}\n${stderrLog.slice(-500)}`);
  }
}

// Create a short video from a static screenshot (tweets without video)
async function staticImageToVideo(screenshotPath, outputPath, durationSecs = 5, deadlineAt = null) {
  const args = [
    '-y', '-loop', '1', '-framerate', '1', '-i', screenshotPath,
    '-t', String(durationSecs), '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
    '-movflags', '+faststart', outputPath,
  ];
  try {
    await runFfmpegArgs(args, { label: 'FFmpeg static video', timeoutMs: boundedTimeout(deadlineAt, FFMPEG_TIMEOUT_MS) });
    return outputPath;
  } catch (error) {
    throw new Error(`FFmpeg static video failed: ${error.message}`);
  }
}

// Convert video to GIF (palette-optimized for quality)
async function videoToGif(videoPath, gifPath, targetWidth = 598, deadlineAt = null) {
  const palettePath = gifPath.replace('.gif', '_pal.png');

  // Pass 1: generate palette
  try {
    const paletteArgs = ['-y', '-i', videoPath, '-vf', `fps=15,scale=${targetWidth}:-1:flags=lanczos,palettegen=max_colors=256:reserve_transparent=0`, palettePath];
    await runFfmpegArgs(paletteArgs, { label: 'FFmpeg GIF palette', timeoutMs: boundedTimeout(deadlineAt, FFMPEG_TIMEOUT_MS) });

    // Pass 2: render GIF using palette
    const gifArgs = ['-y', '-i', videoPath, '-i', palettePath, '-filter_complex',
      `[0:v]fps=15,scale=${targetWidth}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer`, gifPath];
    await runFfmpegArgs(gifArgs, { label: 'FFmpeg GIF render', timeoutMs: boundedTimeout(deadlineAt, FFMPEG_TIMEOUT_MS) });
  } finally {
    await fs.unlink(palettePath).catch(() => {});
  }
  return gifPath;
}

// Convert video to WebM (VP9 + Opus — smaller than MP4, plays in all modern browsers)
async function videoToWebm(videoPath, webmPath, deadlineAt = null) {
  const args = ['-y', '-i', videoPath, '-c:v', 'libvpx-vp9', '-crf', '28', '-b:v', '0',
    '-c:a', 'libopus', '-b:a', '128k', '-deadline', 'good', '-cpu-used', '2', webmPath];
  await runFfmpegArgs(args, {
    label: 'FFmpeg WebM',
    timeoutMs: boundedTimeout(deadlineAt, FFMPEG_TIMEOUT_MS),
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
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({
      error: 'Too many requests. Please wait a minute and try again.', errorCode: 'RATE_LIMITED',
    });
  }

  const { username, tweetId, canonicalUrl } = parsed;

  const inFlightJobId = inFlightTweets.get(tweetId);
  if (inFlightJobId && jobs.has(inFlightJobId)) {
    return res.json({ success: true, jobId: inFlightJobId, queued: true });
  }
  if (inFlightJobId) inFlightTweets.delete(tweetId);

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

  try {
    const usage = await getOutputUsageBytes();
    if (usage >= MAX_OUTPUT_BYTES) {
      return res.status(507).json({
        error: 'Output storage is full. Please try again later.', errorCode: 'OUTPUT_STORAGE_FULL',
      });
    }
  } catch (error) {
    console.warn(`Output usage check failed: ${error.message}`);
  }

  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    return res.status(503).json({
      error: 'Conversion capacity is full. Please try again later.', errorCode: 'CAPACITY_FULL',
    });
  }

  // Return jobId immediately; process async so the client can stream progress
  const jobId = uuidv4();
  const job = createJob(jobId);
  job.tweetId = tweetId;
  inFlightTweets.set(tweetId, jobId);
  activeJobs++;
  res.json({ success: true, jobId });

  // ── Async processing ──────────────────────────────────────────────────────
  (async () => {
    const sessionId = uuidv4();
    const sessionDir = path.join(tempDir, sessionId);
    const partialOutputs = [];
    let processingPhase = 'setup';

    try {
      assertJobWithinDeadline(jobId);
      await fs.mkdir(sessionDir, { recursive: true });
      activeSessionDirs.add(sessionDir);
      console.log(`\n── Processing tweet ${tweetId} by @${username} (job ${jobId}) ──`);

      // 1. Fetch tweet metadata
      processingPhase = 'oembed';
      emitProgress(jobId, { type: 'step', message: 'Fetching tweet metadata...' });
      const oembedData = await fetchOEmbed(canonicalUrl);
      assertJobWithinDeadline(jobId);
      const tweetText = extractTweetText(oembedData.html);
      const identity = resolveOEmbedIdentity(oembedData, { username, tweetId, canonicalUrl });
      const authorName = identity.authorName;
      const quoteContext = extractQuoteContext(oembedData.html);
      const quoteContextUnavailable = hasQuoteMarkup(oembedData.html) && !quoteContext;
      const tweetDate = tweetDateFromId(tweetId);
      console.log(`  Author: ${authorName}`);
      console.log(`  Tweet date: ${tweetDate ? tweetDate.toISOString() : 'unknown'}`);

      // 2. Download video
      processingPhase = 'video';
      emitProgress(jobId, { type: 'step', message: 'Downloading video...' });
      assertJobWithinDeadline(jobId);
      let videoPath = null;
      let videoInfo = null;
      try {
        videoPath = await downloadVideoYtDlp(canonicalUrl, sessionDir, boundedTimeout(job.deadlineAt, 120000));
        videoInfo = await getVideoInfo(videoPath, boundedTimeout(job.deadlineAt, 15000));
        assertJobWithinDeadline(jobId);
        console.log(`  Video: ${videoInfo.width}x${videoInfo.height}, ${videoInfo.duration.toFixed(1)}s, audio=${videoInfo.hasAudio}`);
      } catch (err) {
        console.warn(`  Video download failed: ${err.message}`);
        if (!isNoVideoDownloadError(err)) throw err;
        emitProgress(jobId, { type: 'step', message: 'No video found, rendering image card...' });
      }

      // 3. Fetch avatar
      processingPhase = 'avatar';
      assertJobWithinDeadline(jobId);
      let avatarFileUrl = null;
      try {
        const avatarPath = path.join(sessionDir, 'avatar.jpg');
        await downloadFile(`https://unavatar.io/twitter/${identity.handle}`, avatarPath, boundedTimeout(job.deadlineAt, 10000));
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
          await downloadFile(oembedData.thumbnail_url, imgPath, boundedTimeout(job.deadlineAt, 10000));
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
      assertJobWithinDeadline(jobId);
      const htmlContent = renderTweetHtml({
        authorName, handle: identity.handle, tweetText, avatarFileUrl, mediaHtml,
        cardWidth, tweetDate, quoteContext, quoteContextUnavailable,
      });
      const htmlPath = path.join(sessionDir, 'tweet.html');
      await fs.writeFile(htmlPath, htmlContent, 'utf8');

      const { screenshotPath, videoArea, cardHeight: outputHeight } = await screenshotTweet(htmlPath, boundedTimeout(job.deadlineAt, 30000));
      console.log(`  Screenshot saved. Video area: ${JSON.stringify(videoArea)}`);

      // 7. Composite video (rotation applied inline — no pre-encode pass)
      processingPhase = 'composite';
      emitProgress(jobId, { type: 'step', message: 'Compositing video...' });
      assertJobWithinDeadline(jobId);
      const videoId = uuidv4();
      const outputVideoPath = path.join(outputDir, `${videoId}.mp4`);
      partialOutputs.push(outputVideoPath);

      if (videoPath && videoArea) {
        console.log(`Compositing tweet frame with video (audio=${videoInfo.hasAudio}, rotation=${videoInfo.rotation})...`);
        await compositeVideo(screenshotPath, videoPath, videoArea, outputVideoPath, videoInfo.hasAudio, videoInfo.rotation, job.deadlineAt);
      } else {
        console.log('Creating static image video (no video in tweet)...');
        await staticImageToVideo(screenshotPath, outputVideoPath, 5, job.deadlineAt);
      }
      console.log('  MP4 created');
      await assertOutputUsageWithinLimit();

      // 8. Convert to GIF
      processingPhase = 'gif';
      emitProgress(jobId, { type: 'step', message: 'Creating GIF...' });
      assertJobWithinDeadline(jobId);
      const gifPath = path.join(outputDir, `${videoId}.gif`);
      partialOutputs.push(gifPath);
      try {
        await videoToGif(outputVideoPath, gifPath, cardWidth, job.deadlineAt);
        console.log('  GIF created');
      } catch (gifErr) {
        if (/timed out|time limit/i.test(gifErr.message || '')) throw gifErr;
        console.warn(`  GIF palette conversion failed (${gifErr.message}), trying simple conversion...`);
        await runFfmpegArgs(['-y', '-i', outputVideoPath, '-vf', `fps=12,scale=${cardWidth}:-1:flags=lanczos`, gifPath], { label: 'FFmpeg GIF fallback', timeoutMs: boundedTimeout(job.deadlineAt, FFMPEG_TIMEOUT_MS) });
        console.log('  GIF created (simple)');
      }
      await assertOutputUsageWithinLimit();

      // 9. Convert to WebM
      processingPhase = 'webm';
      emitProgress(jobId, { type: 'step', message: 'Creating WebM...' });
      assertJobWithinDeadline(jobId);
      const webmPath = path.join(outputDir, `${videoId}.webm`);
      partialOutputs.push(webmPath);
      try {
        await videoToWebm(outputVideoPath, webmPath, job.deadlineAt);
        console.log('  WebM created');
      } catch (webmErr) {
        if (/timed out|time limit/i.test(webmErr.message || '')) throw webmErr;
        await fs.rm(webmPath, { force: true }).catch(() => {});
        console.warn(`  WebM conversion failed: ${webmErr.message}`);
      }
      await assertOutputUsageWithinLimit();

      // Cleanup session temp files
      await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});

      // Save metadata so the share page can link back to the original tweet
      const metaPath = path.join(outputDir, `${videoId}.json`);
      const staticCard = !(videoPath && videoInfo);
      const resultMetadata = buildResultMetadata({ authorName, staticCard, quoteContext });
      await writeJsonAtomic(metaPath, {
        tweetId,
        tweetUrl: identity.tweetUrl || canonicalUrl,
        handle: identity.handle,
        width: cardWidth, height: outputHeight, ...resultMetadata,
      }).catch(() => {});

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
      const timedOut = !!(job && job.deadlineAt && Date.now() >= job.deadlineAt) || !!(error && /processing time limit/i.test(error.message));
      const safeError = classifyProcessingError(error, timedOut ? 'timeout' : processingPhase);
      rejectJob(jobId, safeError.message, safeError.errorCode);
    } finally {
      if (inFlightTweets.get(tweetId) === jobId) inFlightTweets.delete(tweetId);
      activeSessionDirs.delete(sessionDir);
      if (job.active) {
        job.active = false;
        if (job.generation === serverGeneration) activeJobs = Math.max(0, activeJobs - 1);
      }
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

const PUBLIC_PAGE_STYLES = `<style>
:root { color-scheme: light; font-family: "Segoe UI", Arial, sans-serif; color: #1f292d; background: #f2eee6; }
* { box-sizing: border-box; }
body { min-height: 100dvh; margin: 0; padding: 24px; display: grid; place-items: center; background: #f2eee6; }
.public-shell { width: min(760px, 100%); padding: clamp(24px, 5vw, 56px); border-radius: 28px; background: #fffdf8; box-shadow: 0 24px 70px rgba(40, 51, 49, .16), 0 2px 10px rgba(40, 51, 49, .08); text-align: center; }
.brand-mark { width: 48px; height: 48px; margin-bottom: 18px; border-radius: 16px; outline: 1px solid rgba(18, 108, 116, .2); outline-offset: 4px; }
.eyebrow { margin: 0 0 10px; color: #126c74; font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
h1 { margin: 0; font-family: Georgia, "Times New Roman", serif; font-size: clamp(32px, 6vw, 56px); line-height: 1; letter-spacing: -.04em; text-wrap: balance; }
.message { max-width: 48ch; margin: 18px auto 28px; color: #627076; line-height: 1.6; text-wrap: pretty; }
.media { max-width: 100%; margin: 24px auto; overflow: hidden; border-radius: 20px; box-shadow: 0 1px 2px rgba(31, 41, 45, .08), 0 8px 18px rgba(31, 41, 45, .08); }
.media img, .media video { display: block; width: 100%; max-width: 100%; height: auto; outline: 1px solid rgba(0, 0, 0, .1); outline-offset: -1px; }
.actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; }
.actions a { min-height: 44px; display: inline-flex; align-items: center; justify-content: center; padding: 11px 18px; border-radius: 12px; background: #126c74; color: #fffdf8; font-weight: 700; text-decoration: none; transition: background-color 150ms ease-out, box-shadow 150ms ease-out, transform 150ms ease-out, scale 150ms ease-out; }
.actions a:hover { background: #0e5057; transform: translateY(-1px); box-shadow: 0 8px 18px rgba(18, 108, 116, .18); }
.actions a:active { scale: .96; }
.actions a.secondary { border: 1px solid rgba(18, 108, 116, .28); color: #0e5057; background: #fffdf8; }
.actions a.secondary:hover { color: #0e5057; background: #e4f1ee; }
@media (max-width: 560px) { body { padding: 10px; } .public-shell { border-radius: 20px; padding: 24px 18px; } .actions { flex-direction: column; } .actions a { width: 100%; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: .01ms !important; animation-duration: .01ms !important; } .actions a:hover { transform: none; } }
</style>`;

function renderPublicPage({ title, eyebrow, message, actionHref = '/', actionLabel = 'Back to the tool', mediaHtml = '', secondaryHtml = '' }) {
  const safeActionHref = escapeHtml(actionHref);
  return `<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f2eee6">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  ${PUBLIC_PAGE_STYLES}
</head><body>
  <main class="public-shell">
    <img class="brand-mark" src="/favicon.svg" alt="" width="48" height="48">
    <p class="eyebrow">${escapeHtml(eyebrow)}</p>
    <h1>${escapeHtml(title)}</h1>
    <p class="message">${escapeHtml(message)}</p>
    ${mediaHtml ? `<div class="media">${mediaHtml}</div>` : ''}
    <div class="actions"><a href="${safeActionHref}">${escapeHtml(actionLabel)}</a>${secondaryHtml}</div>
  </main>
</body></html>`;
}

// Share embed page — returns OG-tagged HTML so Discord/Slack/etc embed properly with audio
// Usage: /share/:videoId?f=video  (f = gif | video | webm, defaults to video)
app.get('/share/:videoId', async (req, res) => {
  const { videoId } = req.params;
  if (!isUuid(videoId)) {
    return res.status(400).type('html').send(renderPublicPage({
      title: 'Invalid share link · Tweet Giffer',
      eyebrow: 'Share link',
      message: 'This share link is not valid. The conversion tool is ready when you are.',
    }));
  }
  const requestedFormat = typeof req.query.f === 'string' ? req.query.f : 'video';
  const format = new Set(['video', 'gif', 'webm']).has(requestedFormat) ? requestedFormat : 'video';

  const mp4Exists  = fsSync.existsSync(path.join(outputDir, `${videoId}.mp4`));
  const gifExists  = fsSync.existsSync(path.join(outputDir, `${videoId}.gif`));
  const webmExists = fsSync.existsSync(path.join(outputDir, `${videoId}.webm`));

  if (!mp4Exists && !gifExists && !webmExists) {
    return res.status(404).type('html').send(renderPublicPage({
      title: 'Media not found · Tweet Giffer',
      eyebrow: 'Share link',
      message: 'This generated file is no longer available. Create a new card to share it again.',
    }));
  }

  // Load stored metadata (tweet URL + author) if available
  let tweetUrl = null;
  let authorName = null;
  let staticCard = false;
  let outputWidth = 598;
  let outputHeight = 336;
  try {
    const raw = await fs.readFile(path.join(outputDir, `${videoId}.json`), 'utf8');
    const meta = JSON.parse(raw);
    ({ tweetUrl, authorName } = meta);
    staticCard = meta.staticCard === true;
    if (Number.isInteger(meta.width) && meta.width > 0) outputWidth = meta.width;
    if (Number.isInteger(meta.height) && meta.height > 0) outputHeight = meta.height;
  } catch {}

  let base;
  try {
    base = resolvePublicBase(req);
  } catch {
    return res.status(500).type('html').send(renderPublicPage({
      title: 'Share unavailable · Tweet Giffer',
      eyebrow: 'Configuration error',
      message: 'The share origin configuration is invalid.',
    }));
  }
  if (!base) {
    return res.status(503).type('html').send(renderPublicPage({
      title: 'Share unavailable · Tweet Giffer',
      eyebrow: 'Share setup',
      message: 'Share origin is not configured.',
    }));
  }
  const mp4Url  = `${base}/outputs/${videoId}.mp4`;
  const gifUrl  = `${base}/outputs/${videoId}.gif`;
  const webmUrl = `${base}/outputs/${videoId}.webm`;

  let fileUrl, mimeType;
  if (staticCard && gifExists) {
    fileUrl = gifUrl; mimeType = 'image/gif';
  } else if (format === 'webm' && webmExists) {
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

  const isVideo = !staticCard && mimeType.startsWith('video/');
  const actualFormat = mimeType === 'video/webm' ? 'webm' : (mimeType === 'image/gif' ? 'gif' : 'video');
  const shareUrl = `${base}/share/${videoId}?f=${actualFormat}`;
  const thumbUrl = gifExists ? gifUrl : (isVideo && mp4Exists ? mp4Url : null);
  const ogTitle = escapeHtml(authorName ? `Tweet by ${authorName}` : 'Tweet Video');
  const ogDescription = staticCard ? 'Shareable tweet card' : 'Shareable tweet video with audio';
  const safeShareUrl = escapeHtml(shareUrl);
  const safeFileUrl = escapeHtml(fileUrl);
  const embedFileUrl = isVideo && mp4Exists ? mp4Url : fileUrl;
  const embedMimeType = isVideo && mp4Exists ? 'video/mp4' : mimeType;
  const safeEmbedFileUrl = escapeHtml(embedFileUrl);
  const safeEmbedMimeType = escapeHtml(embedMimeType);
  const safeThumbUrl = thumbUrl ? escapeHtml(thumbUrl) : null;
  const safeTweetUrl = tweetUrl && parseTweetUrl(tweetUrl) ? escapeHtml(parseTweetUrl(tweetUrl).canonicalUrl) : null;
  const safeDescription = escapeHtml(ogDescription);
  const safeWidth = escapeHtml(outputWidth);
  const safeHeight = escapeHtml(outputHeight);
  const twitterCard = isVideo ? 'player' : 'summary_large_image';
  const pageTitle = authorName ? `Tweet by ${authorName}` : 'Tweet Giffer';
  const mediaHtml = isVideo
    ? `<video src="${safeFileUrl}" ${safeThumbUrl ? `poster="${safeThumbUrl}" ` : ''}controls playsinline></video>`
    : `<img src="${safeFileUrl}" alt="${ogTitle}" />`;
  const secondaryHtml = `<a class="secondary" href="/">Back to the tool</a>${safeTweetUrl ? `<a class="secondary" href="${safeTweetUrl}">View original post</a>` : ''}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${ogTitle}</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  ${PUBLIC_PAGE_STYLES}
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
  <meta property="og:video" content="${safeEmbedFileUrl}" />
  <meta property="og:video:url" content="${safeEmbedFileUrl}" />
  <meta property="og:video:secure_url" content="${safeEmbedFileUrl}" />
  <meta property="og:video:type" content="${safeEmbedMimeType}" />
  <meta property="og:video:width" content="${safeWidth}" />
  <meta property="og:video:height" content="${safeHeight}" />
  <meta name="twitter:player" content="${safeShareUrl}" />
  <meta name="twitter:player:width" content="${safeWidth}" />
  <meta name="twitter:player:height" content="${safeHeight}" />
  <meta name="twitter:player:stream" content="${safeEmbedFileUrl}" />
  <meta name="twitter:player:stream:content_type" content="${safeEmbedMimeType}" />
  ` : ''}
</head>
<body>
  <main class="public-shell">
    <img class="brand-mark" src="/favicon.svg" alt="" width="48" height="48">
    <p class="eyebrow">${staticCard ? 'Tweet card' : 'Motion card'}</p>
    <h1>${escapeHtml(pageTitle)}</h1>
    <p class="message">${escapeHtml(staticCard ? 'A shareable tweet card.' : 'A shareable tweet video with audio.')}</p>
    <div class="media">${mediaHtml}</div>
    <div class="actions"><a href="${safeFileUrl}">Open media file</a>${secondaryHtml}</div>
  </main>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', `default-src 'none'; media-src ${base}; img-src ${base}; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors https://discord.com https://*.discord.com`);
  res.send(html);
});

async function getReadiness() {
  const issues = [];
  const warnings = [];
  const configuredBrowser = process.env.PUPPETEER_EXECUTABLE_PATH;
  let browserPath = configuredBrowser;
  if (!browserPath) {
    try { browserPath = await puppeteer.executablePath(); } catch { browserPath = null; }
  }
  if (!browserPath || !fsSync.existsSync(browserPath)) issues.push('browser-unavailable');
  const ffmpegAvailable = (ffmpegPath && fsSync.existsSync(ffmpegPath)) || (() => {
    try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 2000 }); return true; } catch { return false; }
  })();
  if (!ffmpegAvailable) issues.push('ffmpeg-unavailable');
  if (!YT_DLP) warnings.push('yt-dlp-unavailable');
  if (browserLastError && !_browser) issues.push('browser-start-failed');
  return { ready: issues.length === 0, issues, warnings };
}

async function sendReadiness(res) {
  const readiness = await getReadiness();
  return res.status(readiness.ready ? 200 : 503).json({
    status: readiness.ready ? 'ok' : 'degraded',
    ready: readiness.ready,
    issues: readiness.issues,
    warnings: readiness.warnings,
  });
}

// Run FFmpeg directly. fluent-ffmpeg is deprecated, so keeping the small
// argument builder here avoids an unmaintained command wrapper in production.
function runFfmpegArgs(args, options = {}) {
  const { label = 'FFmpeg conversion', timeoutMs = FFMPEG_TIMEOUT_MS, onStart, onStderr } = options;
  const ffmpegBin = ffmpegPath && fsSync.existsSync(ffmpegPath) ? ffmpegPath : 'ffmpeg';
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = '';
    let timer = null;
    let proc = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (proc) activeProcesses.delete(proc);
      fn(value);
    };
    try {
      proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      activeProcesses.add(proc);
      onStart?.([ffmpegBin, ...args].join(' '));
      proc.stderr.on('data', chunk => {
        const text = chunk.toString();
        stderr = (stderr + text).slice(-8192);
        for (const line of text.split(/\r?\n/)) if (line) onStderr?.(line);
      });
      proc.once('error', error => finish(reject, error));
      proc.once('close', code => {
        if (code === 0) return finish(resolve);
        finish(reject, new Error(`${label} failed with exit code ${code}: ${stderr.slice(-500)}`));
      });
      timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        finish(reject, new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    } catch (error) {
      finish(reject, error);
    }
  });
}

app.get('/api/health', (req, res, next) => sendReadiness(res).catch(next));
app.get('/api/ready', (req, res, next) => sendReadiness(res).catch(next));

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found', errorCode: 'NOT_FOUND' });
  }
  return res.status(404).type('html').send(renderPublicPage({
    title: 'Page not found · Tweet Giffer',
    eyebrow: '404',
    message: 'That page is not available. The conversion tool is ready when you are.',
  }));
});

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
  serverGeneration++;
  serverStopping = false;
  browserLastError = null;
  await ensureDirectories();
  await hydrateTweetCache();

  // Pre-warm browser so first request doesn't pay the launch cost
  if (options.prewarm !== false) getBrowser().catch(e => console.warn('Browser pre-warm failed:', e.message));

  // Auto-cleanup: remove output files older than 24 hours before accepting work.
  await cleanOldOutputs();
  await cleanOldTempDirs();
  cleanupTimer = setInterval(() => { cleanOldOutputs(); cleanOldTempDirs(); }, 3_600_000);
  jobTimer = setInterval(() => {
    pruneExpiredJobs();
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
  serverStopping = true;
  serverGeneration++;
  inFlightTweets.clear();
  clearLifecycleTimers();
  activeJobs = 0;
  for (const job of jobs.values()) {
    job.active = false;
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
  for (const process of activeProcesses) {
    try { process.kill('SIGKILL'); } catch {}
  }
  activeProcesses.clear();
  if (browserLaunch) await browserLaunch.catch(() => {});
  if (_browser) await _browser.close().catch(() => {});
  _browser = null;
  browserLaunch = null;
  browserLastError = null;
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
    runFfmpegArgs,
    compositeVideo,
    staticImageToVideo,
    videoToGif,
    videoToWebm,
    isNoVideoDownloadError,
    buildYtDlpArgs,
    parseVideoInfoOutput,
    rotationFilterFor,
    toFileUrl,
    resolveOEmbedIdentity,
    buildOEmbedUrl,
    PIPELINE_STAGES,
    createJob,
    jobs,
    pruneExpiredJobs,
    emitProgress,
    classifyProcessingError,
    extractQuoteContext,
    buildResultMetadata,
    renderTweetHtml,
    tweetCache,
  },
};
