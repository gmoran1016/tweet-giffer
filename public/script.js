const tweetForm = document.getElementById('tweetForm');
const tweetUrlInput = document.getElementById('tweetUrl');
const processBtn = document.getElementById('processBtn');
const loadingSection = document.getElementById('loadingSection');
const loadingStatus = document.getElementById('loadingStatus');
const loadingElapsed = document.getElementById('loadingElapsed');
const resultSection = document.getElementById('resultSection');
const resultHeading = document.getElementById('resultHeading');
const resultSummary = document.getElementById('resultSummary');
const cacheNotice = document.getElementById('cacheNotice');
const errorSection = document.getElementById('errorSection');
const errorMessage = document.getElementById('errorMessage');
const retryBtn = document.getElementById('retryBtn');
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
const ACTIVE_JOB_STORAGE_KEY = 'tweetGiffer.activeJob';
const RETRYABLE_ERROR_CODES = new Set(['CAPACITY_FULL', 'MEDIA_ACCESS_FAILED', 'PROCESSING_FAILED']);
let currentResult = null;
let activeRun = null;
let shareTimer = null;
let elapsedTimer = null;
let lastSubmittedUrl = '';

function createApiError(message, code = null) {
  const error = new Error(message);
  error.code = typeof code === 'string' ? code : null;
  return error;
}

function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

function formatProgress(message, stepIndex, stepCount) {
  if (Number.isInteger(stepIndex) && stepIndex > 0 && Number.isInteger(stepCount) && stepCount > 0) {
    return `Step ${stepIndex} of ${stepCount}: ${message}`;
  }
  return message || 'Starting conversion...';
}

function readStoredJob() {
  try {
    const stored = JSON.parse(localStorage.getItem(ACTIVE_JOB_STORAGE_KEY) || 'null');
    if (!stored || !UUID_V4_PATTERN.test(stored.jobId || '') || typeof stored.url !== 'string' || !stored.url || !Number.isFinite(stored.startedAt)) {
      return null;
    }
    return { jobId: stored.jobId, url: stored.url, startedAt: stored.startedAt };
  } catch {
    return null;
  }
}

function storeJob(jobId, url, startedAt) {
  try {
    localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, JSON.stringify({ jobId, url, startedAt }));
  } catch {}
}

function clearStoredJob() {
  try { localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY); } catch {}
}

function startElapsedTimer(run) {
  clearInterval(elapsedTimer);
  const startedAt = Number.isFinite(run.startedAt) ? run.startedAt : Date.now();
  const update = () => {
    loadingElapsed.textContent = `Elapsed ${formatElapsed(Date.now() - startedAt)}.`;
  };
  update();
  elapsedTimer = setInterval(update, 1000);
}

function stopElapsedTimer() {
  clearInterval(elapsedTimer);
  elapsedTimer = null;
}

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
  if (!response.ok) throw createApiError(typeof data.error === 'string' ? data.error : fallbackMessage, data.errorCode);
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

async function pollForResult(jobId, run, immediate = false) {
  if (!jobId || typeof jobId !== 'string') throw new Error('Server returned an invalid job response.');
  let firstPoll = true;
  while (Date.now() < run.deadline) {
    if (!immediate || !firstPoll) await waitForNextPoll(run);
    firstPoll = false;
    const response = await fetch(`/api/status/${encodeURIComponent(jobId)}`, { signal: run.controller.signal, headers: { Accept: 'application/json' } });
    const status = await readJsonResponse(response, 'Lost connection to server. Please try again.');
    if (typeof status.error === 'string') throw createApiError(status.error, status.errorCode);
    if (status.done) {
      if (!status.result || typeof status.result !== 'object') throw new Error('Server returned an invalid result.');
      return status.result;
    }
    if (activeRun === run) {
      loadingStatus.textContent = formatProgress(status.message, status.stepIndex, status.stepCount);
      if (Number.isFinite(status.elapsedMs) && !elapsedTimer) loadingElapsed.textContent = `Elapsed ${formatElapsed(status.elapsedMs)}.`;
    }
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
  clearStoredJob();
  clearTimeout(shareTimer);
  clearMedia();
  currentResult = null;
  hideAllSections();

  let url;
  try { url = parseTweetUrl(tweetUrlInput.value.trim()); }
  catch (error) { showError(error.message, 'INVALID_URL'); tweetUrlInput.focus(); return; }

  tweetUrlInput.value = url;
  lastSubmittedUrl = url;

  const run = {
    controller: new AbortController(),
    deadline: Date.now() + POLL_DEADLINE_MS,
    deadlineTimer: null,
    pollTimer: null,
    startedAt: Date.now(),
    jobId: null,
  };
  activeRun = run;
  run.deadlineTimer = setTimeout(() => run.controller.abort(new DOMException('Processing timed out after five minutes. Please try again.', 'TimeoutError')), POLL_DEADLINE_MS);
  showLoading('Starting conversion...');
  startElapsedTimer(run);
  processBtn.disabled = true;
  processBtn.textContent = 'Processing...';

  try {
    const response = await fetch('/api/process-tweet', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ url }), signal: run.controller.signal,
    });
    const data = await readJsonResponse(response, 'Failed to process tweet. Please try again.');
    if (data.cached) clearStoredJob();
    else {
      run.jobId = data.jobId;
      storeJob(data.jobId, url, run.startedAt);
    }
    const result = validateResultPayload(data.cached ? data : await pollForResult(data.jobId, run));
    if (activeRun === run) {
      clearStoredJob();
      displayResults(result);
    }
  } catch (error) {
    if (activeRun === run) {
      const message = error.name === 'TimeoutError' ? error.message :
        error.name === 'AbortError' ? 'Processing was cancelled. Please try again.' : error.message;
      showError(message || 'Failed to process tweet. Please try again.', error.code);
      clearStoredJob();
    }
  } finally {
    clearTimeout(run.deadlineTimer); clearTimeout(run.pollTimer);
    stopElapsedTimer();
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
  const authorName = typeof data.authorName === 'string' ? data.authorName.slice(0, 200) : null;
  return {
    ...data,
    videoId,
    gif: validateOutputPath(data.gif, videoId, 'gif'),
    video: validateOutputPath(data.video, videoId, 'mp4'),
    webm: validateOutputPath(data.webm, videoId, 'webm', true),
    authorName,
    cached: data.cached === true,
    staticCard: data.staticCard === true,
    quoteContext: data.quoteContext && typeof data.quoteContext === 'object' ? data.quoteContext : null,
  };
}

function displayResults(data) {
  currentResult = data;
  const authorLabel = data.authorName ? ` for ${data.authorName}` : '';
  const staticCard = data.staticCard === true;
  resultHeading.textContent = staticCard ? 'Static tweet card ready' : 'Your tweet is ready!';
  resultSummary.textContent = staticCard
    ? 'This post has no video. Downloads contain a five-second animated card with no audio.'
    : `Video conversion complete${authorLabel}.`;
  cacheNotice.textContent = data.cached === true ? 'Loaded from cache.' : '';
  cacheNotice.classList.toggle('hidden', data.cached !== true);
  gifImg.src = data.gif; videoPlayer.src = data.video;
  gifImg.alt = `${staticCard ? 'Animated static tweet card' : 'Animated preview of converted tweet'}${authorLabel}`;
  videoPlayer.setAttribute('aria-label', `${staticCard ? 'MP4 static tweet card' : 'MP4 preview of converted tweet'}${authorLabel}`);
  webmPlayer.setAttribute('aria-label', `${staticCard ? 'WebM static tweet card' : 'WebM preview of converted tweet'}${authorLabel}`);
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

function showLoading(message, progress = {}) {
  loadingStatus.textContent = formatProgress(message, progress.stepIndex, progress.stepCount);
  if (Number.isFinite(progress.elapsedMs) && !elapsedTimer) loadingElapsed.textContent = `Elapsed ${formatElapsed(progress.elapsedMs)}.`;
  loadingSection.classList.remove('hidden');
}

function hideLoading() {
  loadingSection.classList.add('hidden');
  loadingElapsed.textContent = '';
}

function showError(message, code = null) {
  errorMessage.textContent = message;
  retryBtn.classList.toggle('hidden', !RETRYABLE_ERROR_CODES.has(code));
  errorSection.classList.remove('hidden');
  errorSection.focus();
}

retryBtn.addEventListener('click', () => {
  if (!lastSubmittedUrl) {
    tweetUrlInput.focus();
    return;
  }
  tweetUrlInput.value = lastSubmittedUrl;
  tweetForm.requestSubmit();
});

function hideAllSections() {
  loadingSection.classList.add('hidden'); resultSection.classList.add('hidden');
  errorSection.classList.add('hidden'); shareSection.classList.add('hidden');
  cacheNotice.classList.add('hidden'); retryBtn.classList.add('hidden');
}

async function restoreActiveJob() {
  const stored = readStoredJob();
  if (!stored) return;

  tweetUrlInput.value = stored.url;
  lastSubmittedUrl = stored.url;
  const run = {
    controller: new AbortController(),
    deadline: Date.now() + POLL_DEADLINE_MS,
    deadlineTimer: null,
    pollTimer: null,
    startedAt: stored.startedAt,
    jobId: stored.jobId,
  };
  activeRun = run;
  run.deadlineTimer = setTimeout(() => run.controller.abort(new DOMException('Processing timed out after five minutes. Please try again.', 'TimeoutError')), POLL_DEADLINE_MS);
  processBtn.disabled = true;
  processBtn.textContent = 'Processing...';
  showLoading('Resuming conversion...', { elapsedMs: Math.max(0, Date.now() - stored.startedAt) });
  startElapsedTimer(run);

  try {
    const result = validateResultPayload(await pollForResult(stored.jobId, run, true));
    if (activeRun === run) {
      clearStoredJob();
      displayResults(result);
    }
  } catch (error) {
    if (activeRun === run) {
      const message = error.message === 'Job not found'
        ? 'The previous conversion expired. Paste the URL again to start a new one.'
        : error.name === 'TimeoutError'
          ? error.message
          : error.message || 'Failed to restore the previous conversion. Please try again.';
      showError(message, error.code);
      clearStoredJob();
    }
  } finally {
    clearTimeout(run.deadlineTimer); clearTimeout(run.pollTimer);
    stopElapsedTimer();
    if (activeRun === run) {
      activeRun = null;
      processBtn.disabled = false;
      processBtn.textContent = 'Create GIF/Video';
      hideLoading();
    }
  }
}

window.addEventListener('beforeunload', () => {
  cleanupRun(activeRun);
  stopElapsedTimer();
});

void restoreActiveJob();
