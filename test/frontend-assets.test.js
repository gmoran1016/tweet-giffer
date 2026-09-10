const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const styleCss = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');

test('frontend declares the usability audit structure and favicon', () => {
  assert.match(indexHtml, /rel="icon"[^>]+href="\/favicon\.svg"/);
  assert.match(indexHtml, /id="resultSummary"/);
  assert.match(indexHtml, /id="retryBtn"/);
  assert.ok(fs.existsSync(path.join(root, 'public', 'favicon.svg')));
});

test('frontend declares the accessible accent and focus scroll margin', () => {
  assert.match(styleCss, /--accent:\s*#126c74/i);
  assert.match(styleCss, /scroll-margin-top/);
  assert.match(styleCss, /\.share-select:focus-visible/);
  assert.doesNotMatch(styleCss, /\.share-select\s*\{[^}]*outline:\s*none/i);
  assert.match(styleCss, /\.tab-btn\.active\s*\{[^}]*color:\s*var\(--accent\)/s);
});

test('frontend exposes the redesign state hooks and sharing metadata', () => {
  assert.match(indexHtml, /<meta name="description" content="[^"]+">/);
  assert.match(indexHtml, /property="og:image" content="\/social-card\.svg"/);
  assert.match(indexHtml, /class="brand-mark"[^>]+src="\/favicon\.svg"/);
  assert.match(indexHtml, /id="urlError"/);
  assert.match(indexHtml, /id="loadingSteps"/);
  assert.match(indexHtml, /data-progress-step="6"/);
  assert.match(indexHtml, /id="shareUrlInput"/);
  assert.match(indexHtml, /id="downloadVideoBtn" class="btn-primary/);
  assert.ok(fs.existsSync(path.join(root, 'public', 'social-card.svg')));
  assert.match(styleCss, /font-variant-numeric:\s*tabular-nums/);
  assert.doesNotMatch(styleCss, /transition\s*:\s*all/i);
});

test('frontend controls and motion rules stay explicit and touch friendly', () => {
  assert.match(styleCss, /button,\s*input,\s*select\s*\{[^}]*font:\s*inherit/s);
  assert.match(styleCss, /min-height:\s*44px/);
  assert.match(styleCss, /scale:\s*0\.96/);
  assert.match(styleCss, /transition:\s*[^;]*(background-color|transform)/i);
  assert.match(styleCss, /text-wrap:\s*balance/);
  assert.match(styleCss, /text-wrap:\s*pretty/);
  assert.match(styleCss, /min-height:\s*100dvh/);
});
