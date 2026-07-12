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
let currentResult = null;
let activeController = null;
let pollTimer = null;
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

function waitForNextPoll(signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(pollTimer); reject(signal.reason || new DOMException('Aborted', 'AbortError')); };
    signal.addEventListener('abort', onAbort, { once: true });
    pollTimer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, POLL_INTERVAL_MS);
  });
}

async function pollForResult(jobId, signal, deadline) {
  if (!jobId || typeof jobId !== 'string') throw new Error('Server returned an invalid job response.');
  while (Date.now() < deadline) {
    await waitForNextPoll(signal);
    const response = await fetch(`/api/status/${encodeURIComponent(jobId)}`, { signal, headers: { Accept: 'application/json' } });
    const status = await readJsonResponse(response, 'Lost connection to server. Please try again.');
    if (typeof status.error === 'string') throw new Error(status.error);
    if (status.done) {
      if (!status.result || typeof status.result !== 'object') throw new Error('Server returned an invalid result.');
      return status.result;
    }
    if (typeof status.message === 'string') loadingStatus.textContent = status.message;
  }
  throw new Error('Processing timed out after five minutes. Please try again.');
}

function clearMedia() {
  gifImg.removeAttribute('src');
  [videoPlayer, webmPlayer].forEach((player) => { player.pause(); player.removeAttribute('src'); player.load(); });
}

function cleanupRun() {
  clearTimeout(pollTimer); pollTimer = null;
  if (activeController) activeController.abort();
  activeController = null;
}

tweetForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  cleanupRun();
  clearTimeout(shareTimer);
  clearMedia();
  currentResult = null;
  hideAllSections();

  let url;
  try { url = parseTweetUrl(tweetUrlInput.value.trim()); }
  catch (error) { showError(error.message); tweetUrlInput.focus(); return; }

  activeController = new AbortController();
  const controller = activeController;
  const deadline = Date.now() + POLL_DEADLINE_MS;
  const deadlineTimer = setTimeout(() => controller.abort(new DOMException('Processing timed out after five minutes. Please try again.', 'TimeoutError')), POLL_DEADLINE_MS);
  showLoading('Starting...');
  processBtn.disabled = true;
  processBtn.textContent = 'Processing...';

  try {
    const response = await fetch('/api/process-tweet', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ url }), signal: controller.signal,
    });
    const data = await readJsonResponse(response, 'Failed to process tweet. Please try again.');
    const result = data.cached ? data : await pollForResult(data.jobId, controller.signal, deadline);
    displayResults(result);
  } catch (error) {
    const message = error.name === 'TimeoutError' ? error.message :
      error.name === 'AbortError' ? 'Processing was cancelled. Please try again.' : error.message;
    showError(message || 'Failed to process tweet. Please try again.');
  } finally {
    clearTimeout(deadlineTimer); clearTimeout(pollTimer);
    if (activeController === controller) activeController = null;
    processBtn.disabled = false; processBtn.textContent = 'Create GIF/Video'; hideLoading();
  }
});

function displayResults(data) {
  if (!data || typeof data.gif !== 'string' || typeof data.video !== 'string' || typeof data.videoId !== 'string') {
    throw new Error('Server returned an invalid result.');
  }
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
  try { await navigator.clipboard.writeText(shareUrl); }
  catch {
    const textArea = document.createElement('textarea'); textArea.value = shareUrl; document.body.appendChild(textArea);
    textArea.select(); document.execCommand('copy'); textArea.remove();
  }
  shareSection.querySelector('p').textContent = `${format.toUpperCase()} link copied to clipboard!`;
  shareSection.classList.remove('hidden'); clearTimeout(shareTimer);
  shareTimer = setTimeout(() => shareSection.classList.add('hidden'), 3000);
});

function showLoading(message) { loadingStatus.textContent = message; loadingSection.classList.remove('hidden'); }
function hideLoading() { loadingSection.classList.add('hidden'); }
function showError(message) { errorMessage.textContent = message; errorSection.classList.remove('hidden'); errorSection.focus(); }
function hideAllSections() {
  loadingSection.classList.add('hidden'); resultSection.classList.add('hidden');
  errorSection.classList.add('hidden'); shareSection.classList.add('hidden');
}

window.addEventListener('beforeunload', cleanupRun);
