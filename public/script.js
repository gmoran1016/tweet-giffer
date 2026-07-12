const tweetForm = document.getElementById('tweetForm');
const tweetUrlInput = document.getElementById('tweetUrl');
const processBtn = document.getElementById('processBtn');
const loadingSection = document.getElementById('loadingSection');
const loadingStatus = document.getElementById('loadingStatus');
const resultSection = document.getElementById('resultSection');
const errorSection = document.getElementById('errorSection');
const errorMessage = document.getElementById('errorMessage');
const gifImg = document.getElementById('gifImg');
const videoPlayer = document.getElementById('videoPlayer');
const webmPlayer = document.getElementById('webmPlayer');
const downloadGifBtn = document.getElementById('downloadGifBtn');
const downloadVideoBtn = document.getElementById('downloadVideoBtn');
const downloadWebmBtn = document.getElementById('downloadWebmBtn');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const shareFormat = document.getElementById('shareFormat');
const shareSection = document.getElementById('shareSection');
const tabButtons = [...document.querySelectorAll('[role="tab"]')];
const webmTab = document.getElementById('webmTab');
const webmOption = shareFormat.querySelector('option[value="webm"]');

const ALLOWED_HOSTNAMES = new Set(['twitter.com', 'www.twitter.com', 'x.com', 'www.x.com']);
const POLL_INTERVAL_MS = 2000;
const POLL_DEADLINE_MS = 5 * 60 * 1000;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let currentResult = null;
let activeRun = null;
let shareTimer = null;

function selectTab(tab, focus = false) {
  if (!tab || tab.hidden) return;
  tabButtons.forEach((button) => {
    const selected = button === tab;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    const panel = document.getElementById(button.getAttribute('aria-controls'));
    panel.hidden = !selected;
    panel.classList.toggle('active', selected);
  });
  if (focus) tab.focus();
}

tabButtons.forEach((button) => {
  button.addEventListener('click', () => selectTab(button));
  button.addEventListener('keydown', (event) => {
    const available = tabButtons.filter((tab) => !tab.hidden);
    const currentIndex = available.indexOf(button);
    let nextIndex;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % available.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + available.length) % available.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = available.length - 1;
    else return;
    event.preventDefault();
    selectTab(available[nextIndex], true);
  });
});

function parseTweetUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('Enter a valid Twitter/X URL.'); }
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
    throw new Error('Enter an HTTPS URL from twitter.com or x.com.');
  }
  return parsed.href;
}

async function readJsonResponse(response, fallbackMessage) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) throw new Error(fallbackMessage);
  let data;
  try { data = await response.json(); } catch { throw new Error(fallbackMessage); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(fallbackMessage);
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : fallbackMessage);
  return data;
}

function waitForNextPoll(run) {
  return new Promise((resolve, reject) => {
    const { signal } = run.controller;
    const onAbort = () => { clearTimeout(run.pollTimer); reject(signal.reason || new DOMException('Aborted', 'AbortError')); };
    signal.addEventListener('abort', onAbort, { once: true });
    run.pollTimer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, POLL_INTERVAL_MS);
  });
}

async function pollForResult(jobId, run) {
  if (!jobId || typeof jobId !== 'string') throw new Error('Server returned an invalid job response.');
  while (Date.now() < run.deadline) {
    await waitForNextPoll(run);
    const response = await fetch(`/api/status/${encodeURIComponent(jobId)}`, { signal: run.controller.signal, headers: { Accept: 'application/json' } });
    const status = await readJsonResponse(response, 'Lost connection to server. Please try again.');
    if (typeof status.error === 'string') throw new Error(status.error);
    if (status.done) {
      if (!status.result || typeof status.result !== 'object') throw new Error('Server returned an invalid result.');
      return status.result;
    }
    if (typeof status.message === 'string' && activeRun === run) loadingStatus.textContent = status.message;
  }
  throw new Error('Processing timed out after five minutes. Please try again.');
}

function clearMedia() {
  gifImg.removeAttribute('src');
  [videoPlayer, webmPlayer].forEach((player) => { player.pause(); player.removeAttribute('src'); player.load(); });
}

function cleanupRun(run, abort = true) {
  if (!run) return;
  clearTimeout(run.pollTimer);
  clearTimeout(run.deadlineTimer);
  run.pollTimer = null;
  if (abort && !run.controller.signal.aborted) run.controller.abort();
  if (activeRun === run) activeRun = null;
}

tweetForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  cleanupRun(activeRun);
  clearTimeout(shareTimer);
  clearMedia();
  currentResult = null;
  hideAllSections();

  let url;
  try { url = parseTweetUrl(tweetUrlInput.value.trim()); }
  catch (error) { showError(error.message); tweetUrlInput.focus(); return; }

  const run = { controller: new AbortController(), deadline: Date.now() + POLL_DEADLINE_MS, deadlineTimer: null, pollTimer: null };
  activeRun = run;
  run.deadlineTimer = setTimeout(() => run.controller.abort(new DOMException('Processing timed out after five minutes. Please try again.', 'TimeoutError')), POLL_DEADLINE_MS);
  showLoading('Starting...');
  processBtn.disabled = true;
  processBtn.textContent = 'Processing...';

  try {
    const response = await fetch('/api/process-tweet', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ url }), signal: run.controller.signal,
    });
    const data = await readJsonResponse(response, 'Failed to process tweet. Please try again.');
    const result = validateResultPayload(data.cached ? data : await pollForResult(data.jobId, run));
    if (activeRun === run) displayResults(result);
  } catch (error) {
    if (activeRun === run) {
      const message = error.name === 'TimeoutError' ? error.message :
        error.name === 'AbortError' ? 'Processing was cancelled. Please try again.' : error.message;
      showError(message || 'Failed to process tweet. Please try again.');
    }
  } finally {
    clearTimeout(run.deadlineTimer); clearTimeout(run.pollTimer);
    if (activeRun === run) {
      activeRun = null;
      processBtn.disabled = false; processBtn.textContent = 'Create GIF/Video'; hideLoading();
    }
  }
});

function validateOutputPath(value, videoId, extension, optional = false) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string') throw new Error('Server returned an invalid result.');
  let candidate;
  try { candidate = new URL(value, window.location.origin); } catch { throw new Error('Server returned an invalid result.'); }
  const expectedPath = `/outputs/${videoId}.${extension}`;
  if (candidate.origin !== window.location.origin || candidate.pathname !== expectedPath || candidate.search || candidate.hash) {
    throw new Error('Server returned an invalid result.');
  }
  return expectedPath;
}

function validateResultPayload(data) {
  if (!data || typeof data !== 'object' || !UUID_V4_PATTERN.test(data.videoId || '')) throw new Error('Server returned an invalid result.');
  const videoId = data.videoId;
  return {
    ...data,
    videoId,
    gif: validateOutputPath(data.gif, videoId, 'gif'),
    video: validateOutputPath(data.video, videoId, 'mp4'),
    webm: validateOutputPath(data.webm, videoId, 'webm', true),
  };
}

function displayResults(data) {
  currentResult = data;
  gifImg.src = data.gif; videoPlayer.src = data.video;
  const hasWebm = typeof data.webm === 'string' && data.webm.length > 0;
  webmTab.hidden = !hasWebm; downloadWebmBtn.hidden = !hasWebm; webmOption.hidden = !hasWebm; webmOption.disabled = !hasWebm;
  if (hasWebm) webmPlayer.src = data.webm;
  else { webmPlayer.removeAttribute('src'); if (shareFormat.value === 'webm') shareFormat.value = 'gif'; }
  selectTab(document.getElementById('gifTab'));
  resultSection.classList.remove('hidden'); resultSection.focus();
}

function download(path, extension) {
  if (!currentResult || !path) return;
  const link = document.createElement('a'); link.href = path; link.download = `tweet_${currentResult.videoId}.${extension}`;
  document.body.appendChild(link); link.click(); link.remove();
}
downloadGifBtn.addEventListener('click', () => download(currentResult?.gif, 'gif'));
downloadVideoBtn.addEventListener('click', () => download(currentResult?.video, 'mp4'));
downloadWebmBtn.addEventListener('click', () => download(currentResult?.webm, 'webm'));

copyLinkBtn.addEventListener('click', async () => {
  if (!currentResult) return;
  const format = shareFormat.value;
  if (!currentResult[format === 'video' ? 'video' : format]) return;
  const shareUrl = `${window.location.origin}/share/${encodeURIComponent(currentResult.videoId)}?f=${encodeURIComponent(format)}`;
  let copied = false;
  try { await navigator.clipboard.writeText(shareUrl); copied = true; }
  catch {
    const textArea = document.createElement('textarea');
    try {
      textArea.value = shareUrl; document.body.appendChild(textArea); textArea.select();
      copied = document.execCommand('copy');
    } catch { copied = false; }
    finally { textArea.remove(); }
  }
  shareSection.querySelector('p').textContent = copied
    ? `${format.toUpperCase()} link copied to clipboard!`
    : `Unable to copy automatically. Copy this link manually: ${shareUrl}`;
  shareSection.classList.remove('hidden'); clearTimeout(shareTimer);
  shareTimer = copied ? setTimeout(() => shareSection.classList.add('hidden'), 3000) : null;
});

function showLoading(message) { loadingStatus.textContent = message; loadingSection.classList.remove('hidden'); }
function hideLoading() { loadingSection.classList.add('hidden'); }
function showError(message) { errorMessage.textContent = message; errorSection.classList.remove('hidden'); errorSection.focus(); }
function hideAllSections() {
  loadingSection.classList.add('hidden'); resultSection.classList.add('hidden');
  errorSection.classList.add('hidden'); shareSection.classList.add('hidden');
}

window.addEventListener('beforeunload', () => cleanupRun(activeRun));
