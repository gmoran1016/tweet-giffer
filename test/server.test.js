const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

let root;
let server;
let base;

test.before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'tweet-giffer-'));
  process.env.OUTPUT_DIR = path.join(root, 'outputs');
  process.env.TEMP_DIR = path.join(root, 'temp');
  process.env.MAX_CONCURRENT_JOBS = '1';
  process.env.RATE_LIMIT = '100';
  process.env.ALLOWED_ORIGIN = 'https://app.example.test';
  const api = require('../server');
  server = await api.startServer({ port: 0, prewarm: false });
  base = `http://127.0.0.1:${server.address().port}`;
});

test('classifies upstream access failures without exposing diagnostics', () => {
  const { classifyProcessingError } = require('../server')._internals;
  assert.deepEqual(
    classifyProcessingError({ response: { status: 404 } }, 'oembed'),
    {
      errorCode: 'TWEET_UNAVAILABLE',
      message: 'This post is unavailable, private, or no longer exists. Check the URL and try another public post.',
      status: 502,
    },
  );
  assert.deepEqual(
    classifyProcessingError(new Error('stderr=C:\\secret\\video'), 'video'),
    {
      errorCode: 'MEDIA_ACCESS_FAILED',
      message: 'The post was found, but its media could not be accessed. Check that it is public and try again.',
      status: 502,
    },
  );
  assert.doesNotMatch(JSON.stringify(classifyProcessingError(new Error('private stderr'))), /private|stderr/i);
});

test('builds oEmbed requests against the current X publishing host', () => {
  const { buildOEmbedUrl } = require('../server')._internals;
  const requestUrl = new URL(buildOEmbedUrl('https://x.com/MLB/status/2097762182364581908'));

  assert.equal(requestUrl.origin, 'https://publish.x.com');
  assert.equal(requestUrl.pathname, '/oembed');
  assert.equal(requestUrl.searchParams.get('url'), 'https://x.com/MLB/status/2097762182364581908');
  assert.equal(requestUrl.searchParams.get('omit_script'), 'true');
});

test('extracts nested quote context without inventing flat-post context', () => {
  const { extractQuoteContext } = require('../server')._internals;
  const html = `
    <blockquote class="twitter-tweet">
      <p>Outer text</p>
      <a href="https://x.com/outer/status/1">Outer link</a>
      <blockquote class="twitter-tweet">
        <p>Quoted text</p>
        <a href="https://x.com/quoted/status/2">Quoted Author (@quoted)</a>
      </blockquote>
    </blockquote>`;
  assert.deepEqual(extractQuoteContext(html), {
    authorName: 'Quoted Author',
    handle: 'quoted',
    tweetUrl: 'https://x.com/quoted/status/2',
    text: 'Quoted text',
  });
  assert.equal(
    extractQuoteContext('<blockquote class="twitter-tweet"><p>Only one post</p><a href="https://x.com/outer/status/1">Outer</a></blockquote>'),
    null,
  );
});

test('normalizes job progress to the six conversion stages', () => {
  const { PIPELINE_STAGES, createJob, emitProgress } = require('../server')._internals;
  const jobId = '623e4567-e89b-42d3-a456-426614174000';
  const job = createJob(jobId);
  const step = emitProgress(jobId, { type: 'step', message: 'Creating WebM...' });
  assert.deepEqual(PIPELINE_STAGES, [
    'Fetching tweet metadata...',
    'Downloading video...',
    'Rendering tweet card...',
    'Compositing video...',
    'Creating GIF...',
    'Creating WebM...',
  ]);
  assert.equal(typeof job.createdAt, 'number');
  assert.equal(typeof job.startedAt, 'number');
  assert.equal(step.stepIndex, 6);
  assert.equal(step.stepCount, 6);
  assert.ok(step.elapsedMs >= 0);
});

test('builds safe result metadata for video and static-card outputs', () => {
  const { buildResultMetadata } = require('../server')._internals;
  assert.deepEqual(buildResultMetadata({ authorName: 'Alice', staticCard: true, quoteContext: null }), {
    authorName: 'Alice',
    staticCard: true,
    quoteContext: null,
  });
  assert.deepEqual(buildResultMetadata({
    authorName: 'Outer',
    staticCard: false,
    quoteContext: {
      authorName: 'Quoted',
      handle: 'quoted',
      tweetUrl: 'https://x.com/quoted/status/2',
      text: 'Quoted text',
    },
  }), {
    authorName: 'Outer',
    staticCard: false,
    quoteContext: {
      authorName: 'Quoted',
      handle: 'quoted',
      tweetUrl: 'https://x.com/quoted/status/2',
      text: 'Quoted text',
    },
  });
});

test('renders escaped quote context in a visually distinct card block', () => {
  const { renderTweetHtml } = require('../server')._internals;
  const html = renderTweetHtml({
    authorName: 'Outer',
    handle: 'outer',
    tweetText: 'Outer text',
    mediaHtml: '',
    quoteContext: {
      authorName: '<Quoted>',
      handle: 'quoted',
      tweetUrl: 'https://x.com/quoted/status/2',
      text: '<Quoted text>',
    },
  });
  assert.match(html, /class="quoted-post"/);
  assert.match(html, /&lt;Quoted&gt;/);
  assert.match(html, /&lt;Quoted text&gt;/);
  assert.doesNotMatch(html, /<Quoted>/);
});

test('cache responses include sidecar metadata and cached state', async () => {
  const { tweetCache } = require('../server')._internals;
  const tweetId = '987654321';
  const videoId = '723e4567-e89b-42d3-a456-426614174000';
  await fs.writeFile(path.join(process.env.OUTPUT_DIR, `${videoId}.mp4`), 'media');
  await fs.writeFile(path.join(process.env.OUTPUT_DIR, `${videoId}.gif`), 'image');
  await fs.writeFile(path.join(process.env.OUTPUT_DIR, `${videoId}.json`), JSON.stringify({
    authorName: 'Alice', staticCard: true, quoteContext: null,
  }));
  tweetCache.set(tweetId, videoId);
  try {
    const response = await fetch(`${base}/api/process-tweet`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `https://x.com/alice/status/${tweetId}` }),
    });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.cached, true);
    assert.equal(data.staticCard, true);
    assert.equal(data.authorName, 'Alice');
    assert.equal(data.quoteContext, null);
  } finally {
    tweetCache.delete(tweetId);
  }
});

function requestWithHeaders(pathname, headers) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${base}${pathname}`, { headers }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on('error', reject);
  });
}

test.after(async () => {
  await require('../server').stopServer();
  await fs.rm(root, { recursive: true, force: true });
});

test('rejects JSON bodies over 4 KiB', async () => {
  const response = await fetch(`${base}/api/process-tweet`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'x'.repeat(5000) }),
  });
  assert.equal(response.status, 413);
});

test('rejects malformed tweet URLs', async () => {
  const response = await fetch(`${base}/api/process-tweet`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://evil.example/alice/status/123' }),
  });
  assert.equal(response.status, 400);
});

test('allows the configured canonical CORS origin', async () => {
  const response = await fetch(`${base}/api/health`, {
    headers: { origin: 'https://app.example.test' },
  });
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://app.example.test');
});

test('rejects invalid job and output IDs before lookup', async () => {
  assert.equal((await fetch(`${base}/api/status/../../package.json`)).status, 404);
  assert.equal((await fetch(`${base}/api/status/not-a-uuid`)).status, 400);
  assert.equal((await fetch(`${base}/share/not-a-uuid`)).status, 400);
});

test('renders branded human and JSON API 404 fallbacks', async () => {
  const human404 = await fetch(`${base}/route-that-does-not-exist`);
  const humanBody = await human404.text();
  assert.equal(human404.status, 404);
  assert.match(humanBody, /Tweet Giffer/);
  assert.match(humanBody, /Back to the tool/);

  const api404 = await fetch(`${base}/api/route-that-does-not-exist`, {
    headers: { Accept: 'application/json' },
  });
  assert.equal(api404.status, 404);
  assert.equal(api404.headers.get('content-type').includes('application/json'), true);
  assert.deepEqual(await api404.json(), { error: 'Not found', errorCode: 'NOT_FOUND' });
});

test('escapes share metadata and safely falls back from unsupported formats', async () => {
  const id = '123e4567-e89b-42d3-a456-426614174000';
  await fs.mkdir(process.env.OUTPUT_DIR, { recursive: true });
  await fs.writeFile(path.join(process.env.OUTPUT_DIR, `${id}.mp4`), 'media');
  await fs.writeFile(path.join(process.env.OUTPUT_DIR, `${id}.json`), JSON.stringify({
    authorName: '<script>alert(1)</script>',
    tweetUrl: 'https://x.com/a/status/1?x=" onload="alert(1)',
  }));
  const response = await fetch(`${base}/share/${id}?f=exe`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html; charset=utf-8/);
  assert.ok(response.headers.get('content-security-policy'));
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /123e4567-e89b-42d3-a456-426614174000\.mp4/);
  assert.match(html, /<video /);
});

test('share rejects hostile host and forwarded headers without trusted origin config', async () => {
  const id = '223e4567-e89b-42d3-a456-426614174000';
  await fs.writeFile(path.join(process.env.OUTPUT_DIR, `${id}.mp4`), 'media');
  const response = await requestWithHeaders(`/share/${id}`, {
    host: 'evil.example',
    'x-forwarded-host': 'forwarded.evil.example',
    'x-forwarded-proto': 'https',
  });
  assert.equal(response.status, 503);
  assert.doesNotMatch(response.body, /evil\.example/);
  assert.match(response.body, /Share origin is not configured/);
});

test('share accepts explicitly trusted hosts and configured canonical origins', async () => {
  const id = '423e4567-e89b-42d3-a456-426614174000';
  await fs.writeFile(path.join(process.env.OUTPUT_DIR, `${id}.mp4`), 'media');
  process.env.PUBLIC_HOSTS = 'trusted.example';
  try {
    let response = await requestWithHeaders(`/share/${id}`, { host: 'trusted.example' });
    assert.equal(response.status, 200);
    assert.match(response.body, /http:\/\/trusted\.example\/outputs/);

    process.env.PUBLIC_BASE_URL = 'https://cdn.example.test/base-ignored';
    response = await requestWithHeaders(`/share/${id}`, { host: 'evil.example' });
    assert.equal(response.status, 200);
    assert.match(response.body, /https:\/\/cdn\.example\.test\/outputs/);
    assert.doesNotMatch(response.body, /evil\.example/);
  } finally {
    delete process.env.PUBLIC_HOSTS;
    delete process.env.PUBLIC_BASE_URL;
  }
});

test('share emits Discord-friendly canonical video metadata', async () => {
  const id = '523e4567-e89b-42d3-a456-426614174000';
  await fs.writeFile(path.join(process.env.OUTPUT_DIR, `${id}.mp4`), 'media');
  await fs.writeFile(path.join(process.env.OUTPUT_DIR, `${id}.gif`), 'image');
  await fs.writeFile(path.join(process.env.OUTPUT_DIR, `${id}.json`), JSON.stringify({
    authorName: 'Alice',
    tweetUrl: 'https://x.com/alice/status/12345',
    width: 598,
    height: 736,
  }));
  process.env.PUBLIC_BASE_URL = 'https://giffer.example.test';
  try {
    const response = await fetch(`${base}/share/${id}?f=video`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-frame-options'), null);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors https:\/\/discord\.com https:\/\/\*\.discord\.com/);
    assert.match(html, new RegExp(`<meta property="og:url" content="https://giffer\\.example\\.test/share/${id}\\?f=video" />`));
    assert.match(html, /<meta property="og:description" content="Shareable tweet video with audio" \/>/);
    assert.match(html, /<meta property="og:video:height" content="736" \/>/);
    assert.match(html, /<meta name="twitter:card" content="player" \/>/);
    assert.match(html, new RegExp(`<meta name="twitter:player" content="https://giffer\\.example\\.test/share/${id}\\?f=video" />`));
    assert.match(html, new RegExp(`<meta name="twitter:player:stream" content="https://giffer\\.example\\.test/outputs/${id}\\.mp4" />`));
    assert.match(html, new RegExp(`<link rel="canonical" href="https://giffer\\.example\\.test/share/${id}\\?f=video" />`));
    assert.match(html, /<main class="public-shell">/);
    assert.match(html, /Open media file/);
    assert.match(html, /Back to the tool/);
    assert.match(html, /View original post/);
    assert.doesNotMatch(html, /<meta property="og:url" content="https:\/\/x\.com/);
  } finally {
    delete process.env.PUBLIC_BASE_URL;
  }
});

test('WebM share uses MP4 metadata fallback for Discord when MP4 exists', async () => {
  const id = '623e4567-e89b-42d3-a456-426614174000';
  await fs.writeFile(path.join(process.env.OUTPUT_DIR, `${id}.mp4`), 'media');
  await fs.writeFile(path.join(process.env.OUTPUT_DIR, `${id}.gif`), 'image');
  await fs.writeFile(path.join(process.env.OUTPUT_DIR, `${id}.webm`), 'webm');
  await fs.writeFile(path.join(process.env.OUTPUT_DIR, `${id}.json`), JSON.stringify({
    authorName: 'Alice', tweetUrl: 'https://x.com/alice/status/12345', width: 598, height: 736,
  }));
  process.env.PUBLIC_BASE_URL = 'https://giffer.example.test';
  try {
    const response = await fetch(`${base}/share/${id}?f=webm`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.equal((html.match(/<meta property="og:video"/g) || []).length, 1);
    assert.match(html, /<meta property="og:video:type" content="video\/mp4" \/>/);
    assert.match(html, new RegExp(`<meta property="og:video" content="https://giffer\\.example\\.test/outputs/${id}\\.mp4" />`));
    assert.match(html, new RegExp(`<meta name="twitter:player:stream" content="https://giffer\\.example\\.test/outputs/${id}\\.mp4" />`));
    assert.match(html, new RegExp(`<video src="https://giffer\\.example\\.test/outputs/${id}\\.webm"`));
  } finally {
    delete process.env.PUBLIC_BASE_URL;
  }
});

test('static-card share metadata is not advertised as a video', async () => {
  const id = '723e4567-e89b-42d3-a456-426614174000';
  await fs.writeFile(path.join(process.env.OUTPUT_DIR, `${id}.mp4`), 'media');
  await fs.writeFile(path.join(process.env.OUTPUT_DIR, `${id}.gif`), 'image');
  await fs.writeFile(path.join(process.env.OUTPUT_DIR, `${id}.json`), JSON.stringify({
    authorName: 'Alice', staticCard: true, tweetUrl: 'https://x.com/alice/status/12345', width: 598, height: 170,
  }));
  process.env.PUBLIC_BASE_URL = 'https://giffer.example.test';
  try {
    const response = await fetch(`${base}/share/${id}?f=video`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /<meta property="og:type" content="website" \/>/);
    assert.match(html, /<meta property="og:description" content="Shareable tweet card" \/>/);
    assert.doesNotMatch(html, /<meta property="og:video"/);
    assert.match(html, /<img /);
  } finally {
    delete process.env.PUBLIC_BASE_URL;
  }
});

test('share fallback selects an existing WebM-only output', async () => {
  const id = '323e4567-e89b-42d3-a456-426614174000';
  await fs.writeFile(path.join(process.env.OUTPUT_DIR, `${id}.webm`), 'media');
  const response = await fetch(`${base}/share/${id}?f=unsupported`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, new RegExp(`${id}\\.webm`));
  assert.doesNotMatch(html, new RegExp(`${id}\\.gif`));
  assert.doesNotMatch(html, new RegExp(`${id}\\.mp4`));
});

test('capacity rejects concurrent work and setup failure releases the slot', async () => {
  const originalMkdir = fs.mkdir;
  const originalConsoleError = console.error;
  console.error = () => {};
  let rejectSetup;
  let setupStartedResolve;
  const setupStarted = new Promise(resolve => { setupStartedResolve = resolve; });
  fs.mkdir = async (target, options) => {
    if (path.dirname(target) === process.env.TEMP_DIR) {
      setupStartedResolve();
      return new Promise((resolve, reject) => { rejectSetup = reject; });
    }
    return originalMkdir(target, options);
  };

  try {
    const submit = url => fetch(`${base}/api/process-tweet`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }),
    });
    const first = await submit('https://x.com/alice/status/1001');
    const { jobId } = await first.json();
    await setupStarted;
    assert.equal((await submit('https://x.com/alice/status/1002')).status, 503);
    rejectSetup(new Error('forced setup failure C:\\secret\\temp\\session stderr=private'));

    let status;
    for (let attempt = 0; attempt < 20; attempt++) {
      status = await (await fetch(`${base}/api/status/${jobId}`)).json();
      if (status.error) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(status.error, "We couldn't finish this conversion. Please try again.");
    assert.equal(status.errorCode, 'PROCESSING_FAILED');
    assert.doesNotMatch(JSON.stringify(status), /secret|stderr|session/i);

    fs.mkdir = async target => {
      if (path.dirname(target) === process.env.TEMP_DIR) throw new Error('second setup failure');
      return originalMkdir(target, { recursive: true });
    };
    const third = await submit('https://x.com/alice/status/1003');
    assert.equal(third.status, 200);
    const thirdJobId = (await third.json()).jobId;
    let thirdStatus;
    for (let attempt = 0; attempt < 20; attempt++) {
      thirdStatus = await (await fetch(`${base}/api/status/${thirdJobId}`)).json();
      if (thirdStatus.error) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(thirdStatus.error, "We couldn't finish this conversion. Please try again.");
    assert.equal(thirdStatus.errorCode, 'PROCESSING_FAILED');
  } finally {
    fs.mkdir = originalMkdir;
    console.error = originalConsoleError;
  }
});

test('health responses use defensive and non-cache headers', async () => {
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('distinguishes tweets without video from yt-dlp failures', () => {
  const { isNoVideoDownloadError } = require('../server')._internals;

  assert.equal(isNoVideoDownloadError(new Error('ERROR: [Twitter] 123: No video formats found!')), true);
  assert.equal(isNoVideoDownloadError(new Error('ERROR: [twitter] 123: No video could be found in this tweet')), true);
  assert.equal(isNoVideoDownloadError(new Error('yt-dlp is not installed. Run: pip install yt-dlp')), false);
  assert.equal(isNoVideoDownloadError(new Error('yt-dlp failed (code 1): HTTP Error 403: Forbidden')), false);
});

test('yt-dlp arguments stay on Twitter extractors and enforce bounded downloads', () => {
  const { buildYtDlpArgs } = require('../server')._internals;
  const args = buildYtDlpArgs('https://x.com/alice/status/123', 'C:\\temp\\session');
  assert.deepEqual(args.slice(0, 3), [
    'https://x.com/alice/status/123', '-o', path.join('C:\\temp\\session', 'video.%(ext)s'),
  ]);
  assert.ok(args.includes('--ignore-config'));
  assert.deepEqual(args.slice(args.indexOf('--use-extractors'), args.indexOf('--use-extractors') + 2), ['--use-extractors', 'twitter']);
  assert.ok(args.includes('--max-filesize'));
  assert.ok(args.includes('--match-filter'));
  assert.deepEqual(args.slice(args.indexOf('--max-downloads'), args.indexOf('--max-downloads') + 2), ['--max-downloads', '1']);
});

test('video metadata parsing accepts small dimensions and maps display rotation correctly', () => {
  const { parseVideoInfoOutput, rotationFilterFor } = require('../server')._internals;
  const parsed = parseVideoInfoOutput([
    'Duration: 00:00:02.50, start: 0.000000, bitrate: 100 kb/s',
    'Stream #0:0: Video: h264, 96x160 [SAR 1:1 DAR 3:5]',
    'Stream #0:1: Audio: aac, 44100 Hz',
    'rotate          : 90',
  ].join('\n'));
  assert.deepEqual(parsed, { width: 160, height: 96, duration: 2.5, hasAudio: true, rotation: 90 });
  assert.equal(rotationFilterFor(90), 'transpose=2,');
  assert.equal(rotationFilterFor(270), 'transpose=1,');
  assert.equal(rotationFilterFor(180), 'vflip,hflip,');
});

test('file URLs encode path characters and upstream identity overrides submitted usernames', () => {
  const { toFileUrl, resolveOEmbedIdentity } = require('../server')._internals;
  const fileUrl = toFileUrl(path.join('audit #fixture', 'tweet.html'));
  assert.match(fileUrl, /\/audit%20%23fixture\/tweet\.html$/);
  assert.deepEqual(resolveOEmbedIdentity({
    author_name: 'Captain America',
    author_url: 'https://x.com/CaptainAmerica',
    url: 'https://x.com/CaptainAmerica/status/123',
  }, {
    username: 'audit_wrong', tweetId: '123', canonicalUrl: 'https://x.com/audit_wrong/status/123',
  }), {
    authorName: 'Captain America',
    handle: 'CaptainAmerica',
    tweetUrl: 'https://x.com/CaptainAmerica/status/123',
  });
});

test('pending jobs are retained while completed jobs expire', () => {
  const { createJob, jobs, pruneExpiredJobs } = require('../server')._internals;
  const id = '733e4567-e89b-42d3-a456-426614174000';
  const job = createJob(id);
  job.expiresAt = Date.now() - 1;
  pruneExpiredJobs(Date.now());
  assert.equal(jobs.has(id), true);
  job.completedAt = Date.now() - 10;
  job.expiresAt = Date.now() - 1;
  pruneExpiredJobs(Date.now());
  assert.equal(jobs.has(id), false);
});

test('stopServer closes active SSE clients and settles promptly', async () => {
  const api = require('../server');
  const originalMkdir = fs.mkdir;
  const originalConsoleError = console.error;
  console.error = () => {};
  let rejectSetup;
  fs.mkdir = async (target, options) => {
    if (path.dirname(target) === process.env.TEMP_DIR) {
      return new Promise((resolve, reject) => { rejectSetup = reject; });
    }
    return originalMkdir(target, options);
  };

  try {
    const submitted = await fetch(`${base}/api/process-tweet`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://x.com/alice/status/2001' }),
    });
    const { jobId } = await submitted.json();
    const sseResponse = await new Promise((resolve, reject) => {
      const request = http.get(`${base}/api/progress/${jobId}`, resolve);
      request.on('error', reject);
    });
    sseResponse.resume();
    const streamEnded = new Promise(resolve => {
      sseResponse.once('end', resolve);
      sseResponse.once('close', resolve);
    });
    await Promise.race([
      api.stopServer(),
      new Promise((resolve, reject) => setTimeout(() => reject(new Error('shutdown timed out')), 500)),
    ]);
    await streamEnded;
    rejectSetup(new Error('forced setup stop'));
    await new Promise(resolve => setImmediate(resolve));
    server = await api.startServer({ port: 0, prewarm: false });
    base = `http://127.0.0.1:${server.address().port}`;
  } finally {
    fs.mkdir = originalMkdir;
    console.error = originalConsoleError;
  }
});

test('failed listen rolls back lifecycle state and allows a later start', async () => {
  const api = require('../server');
  await api.stopServer();
  const blocker = http.createServer();
  await new Promise(resolve => blocker.listen(0, resolve));
  const occupiedPort = blocker.address().port;
  try {
    await assert.rejects(api.startServer({ port: occupiedPort, prewarm: false }), /EADDRINUSE/);
  } finally {
    await new Promise(resolve => blocker.close(resolve));
  }
  server = await api.startServer({ port: 0, prewarm: false });
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});
