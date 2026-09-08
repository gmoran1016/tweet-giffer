const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');

const browserEnabled = process.env.TWEET_GIFFER_BROWSER_TEST === '1';
let root;
let api;
let server;
let browser;
let base;

test.before(async () => {
  if (!browserEnabled) return;
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'tweet-giffer-browser-'));
  process.env.OUTPUT_DIR = path.join(root, 'outputs');
  process.env.TEMP_DIR = path.join(root, 'temp');
  process.env.MAX_CONCURRENT_JOBS = '2';
  process.env.RATE_LIMIT = '100';
  api = require('../server');
  server = await api.startServer({ port: 0, prewarm: false });
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
});

test.after(async () => {
  if (!browserEnabled) return;
  await browser?.close();
  await api?.stopServer();
  await fs.rm(root, { recursive: true, force: true });
});

test('static-card and cached result states are announced in the real page', { skip: !browserEnabled }, async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${base}/`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => displayResults({
      videoId: '823e4567-e89b-42d3-a456-426614174000',
      gif: '/outputs/823e4567-e89b-42d3-a456-426614174000.gif',
      video: '/outputs/823e4567-e89b-42d3-a456-426614174000.mp4',
      webm: '/outputs/823e4567-e89b-42d3-a456-426614174000.webm',
      staticCard: true,
      cached: true,
      authorName: 'Alice',
    }));
    const state = await page.evaluate(() => ({
      heading: document.getElementById('resultHeading').textContent,
      summary: document.getElementById('resultSummary').textContent,
      cache: document.getElementById('cacheNotice').textContent,
      alt: document.getElementById('gifImg').alt,
    }));
    assert.equal(state.heading, 'Static tweet card ready');
    assert.match(state.summary, /no video/i);
    assert.match(state.cache, /cache/i);
    assert.match(state.alt, /Alice/);
  } finally {
    await page.close();
  }
});

test('refresh restores a pending job and its stage in the real page', { skip: !browserEnabled }, async () => {
  const page = await browser.newPage();
  const jobId = '923e4567-e89b-42d3-a456-426614174000';
  try {
    await page.evaluateOnNewDocument((pendingJobId) => {
      const realFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        if (String(input).includes(`/api/status/${pendingJobId}`)) {
          return new Response(JSON.stringify({
            jobId: pendingJobId,
            done: false,
            error: null,
            errorCode: null,
            message: 'Creating WebM...',
            stepIndex: 6,
            stepCount: 6,
            elapsedMs: 12500,
            result: null,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return realFetch(input, init);
      };
    }, jobId);
    await page.goto(`${base}/`, { waitUntil: 'networkidle0' });
    await page.evaluate((pendingJobId) => {
      localStorage.setItem('tweetGiffer.activeJob', JSON.stringify({
        jobId: pendingJobId,
        url: 'https://x.com/alice/status/1',
        startedAt: Date.now() - 12500,
      }));
    }, jobId);
    await page.reload({ waitUntil: 'networkidle0' });
    await new Promise(resolve => setTimeout(resolve, 150));
    const state = await page.evaluate(() => ({
      loading: !document.getElementById('loadingSection').classList.contains('hidden'),
      status: document.getElementById('loadingStatus').textContent,
      elapsed: document.getElementById('loadingElapsed').textContent,
    }));
    assert.equal(state.loading, true);
    assert.match(state.status, /Step 6 of 6/);
    assert.match(state.elapsed, /Elapsed/);
  } finally {
    await page.close();
  }
});

test('retryable conversion errors preserve the URL and expose retry', { skip: !browserEnabled }, async () => {
  const page = await browser.newPage();
  try {
    await page.evaluateOnNewDocument(() => {
      localStorage.clear();
      const realFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        if (String(input).endsWith('/api/process-tweet')) {
          return new Response(JSON.stringify({
            error: 'The post was found, but its media could not be accessed. Check that it is public and try again.',
            errorCode: 'MEDIA_ACCESS_FAILED',
          }), { status: 502, headers: { 'content-type': 'application/json' } });
        }
        return realFetch(input, init);
      };
    });
    await page.goto(`${base}/`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => localStorage.clear());
    const url = 'https://x.com/alice/status/123456789';
    await page.type('#tweetUrl', url);
    await page.click('#processBtn');
    await page.waitForFunction(() => !document.getElementById('errorSection').classList.contains('hidden'), { timeout: 1000 });
    const state = await page.evaluate(() => ({
      message: document.getElementById('errorMessage').textContent,
      retryHidden: document.getElementById('retryBtn').classList.contains('hidden'),
      input: document.getElementById('tweetUrl').value,
    }));
    assert.match(state.message, /media could not be accessed/i);
    assert.equal(state.retryHidden, false);
    assert.equal(state.input, url);
  } finally {
    await page.close();
  }
});

test('switching preview tabs pauses inactive media', { skip: !browserEnabled }, async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${base}/`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => displayResults({
      videoId: 'a23e4567-e89b-42d3-a456-426614174000',
      gif: '/outputs/a23e4567-e89b-42d3-a456-426614174000.gif',
      video: '/outputs/a23e4567-e89b-42d3-a456-426614174000.mp4',
      webm: '/outputs/a23e4567-e89b-42d3-a456-426614174000.webm',
    }));
    const calls = await page.evaluate(() => {
      let count = 0;
      document.getElementById('videoPlayer').pause = () => { count += 1; };
      document.getElementById('webmPlayer').pause = () => { count += 1; };
      selectTab(document.getElementById('videoTab'));
      selectTab(document.getElementById('gifTab'));
      return count;
    });
    assert.equal(calls, 4);
  } finally {
    await page.close();
  }
});

test('a transient status request is retried without losing the active job', { skip: !browserEnabled }, async () => {
  const page = await browser.newPage();
  const jobId = 'b23e4567-e89b-42d3-a456-426614174000';
  try {
    let statusCalls = 0;
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (request.url().endsWith('/api/process-tweet')) {
        return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, jobId }) });
      }
      if (request.url().includes(`/api/status/${jobId}`)) {
        statusCalls += 1;
        if (statusCalls === 1) return request.abort('connectionfailed');
        return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({
          jobId, done: true, error: null, errorCode: null,
          result: { videoId: 'c23e4567-e89b-42d3-a456-426614174000', gif: '/outputs/c23e4567-e89b-42d3-a456-426614174000.gif', video: '/outputs/c23e4567-e89b-42d3-a456-426614174000.mp4', webm: null },
        }) });
      }
      return request.continue();
    });
    await page.goto(`${base}/`, { waitUntil: 'networkidle0' });
    await page.type('#tweetUrl', 'https://x.com/alice/status/123456789');
    await page.click('#processBtn');
    await page.waitForFunction(() => !document.getElementById('resultSection').classList.contains('hidden'), { timeout: 5000 });
    assert.equal(statusCalls, 2);
    assert.equal(await page.evaluate(() => localStorage.getItem('tweetGiffer.activeJob')), null);
  } finally {
    await page.close();
  }
});
