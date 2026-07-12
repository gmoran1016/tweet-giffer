const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let root;
let server;
let base;

test.before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'tweet-giffer-'));
  process.env.OUTPUT_DIR = path.join(root, 'outputs');
  process.env.TEMP_DIR = path.join(root, 'temp');
  const api = require('../server');
  server = await api.startServer({ port: 0, prewarm: false });
  base = `http://127.0.0.1:${server.address().port}`;
});

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
  assert.match(html, /<noscript>/);
});

test('health responses use defensive and non-cache headers', async () => {
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
