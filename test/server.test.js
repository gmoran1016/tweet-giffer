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
    assert.doesNotMatch(html, /<meta property="og:url" content="https:\/\/x\.com/);
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
    assert.equal(status.error, 'Tweet conversion failed. Please try again.');
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
    assert.equal(thirdStatus.error, 'Tweet conversion failed. Please try again.');
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
  assert.equal(isNoVideoDownloadError(new Error('yt-dlp is not installed. Run: pip install yt-dlp')), false);
  assert.equal(isNoVideoDownloadError(new Error('yt-dlp failed (code 1): HTTP Error 403: Forbidden')), false);
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
