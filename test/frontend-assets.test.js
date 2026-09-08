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
  assert.match(styleCss, /--accent:\s*#0b6ca8/i);
  assert.match(styleCss, /scroll-margin-top/);
  assert.match(styleCss, /\.share-select:focus-visible/);
  assert.doesNotMatch(styleCss, /\.share-select\s*\{[^}]*outline:\s*none/i);
  assert.match(styleCss, /\.tab-btn\.active\s*\{[^}]*color:\s*var\(--accent\)/s);
});
