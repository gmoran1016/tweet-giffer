const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const styleCss = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
const scriptJs = fs.readFileSync(path.join(root, 'public', 'script.js'), 'utf8');

function parseDeclarations(block) {
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
      .map(([, name, value]) => [name, value.trim()]),
  );
}

function relativeLuminance(value) {
  const match = value.match(/^#([\da-f]{6})$/i);
  assert.ok(match, `Expected a six-digit hex color, got ${value}`);
  const channels = [0, 2, 4].map(index => parseInt(match[1].slice(index, index + 2), 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrastRatio(foreground, background) {
  const luminances = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (luminances[0] + 0.05) / (luminances[1] + 0.05);
}

function ruleBody(selectorPattern) {
  const match = styleCss.match(selectorPattern);
  assert.ok(match, `Expected a CSS rule matching ${selectorPattern}`);
  return match[1];
}

test('frontend declares the usability audit structure and favicon', () => {
  assert.match(indexHtml, /rel="icon"[^>]+href="\/favicon\.svg"/);
  assert.match(indexHtml, /id="resultSummary"/);
  assert.match(indexHtml, /id="retryBtn"/);
  assert.ok(fs.existsSync(path.join(root, 'public', 'favicon.svg')));
});

test('frontend declares the accessible accent and focus scroll margin', () => {
  assert.match(styleCss, /--accent:\s*#126c74/i);
  assert.match(styleCss, /\.skip-link\s*\{[^}]*color:\s*var\(--on-accent\)/s);
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

test('small text meets contrast requirements in light and dark themes', () => {
  const lightBlock = styleCss.match(/:root\s*\{([^}]+)\}/)?.[1];
  const darkBlock = styleCss.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]+)\}/s)?.[1];
  assert.ok(lightBlock, 'Expected a light theme token set');
  assert.ok(darkBlock, 'Expected a dark theme token set');

  for (const [theme, declarations] of [['light', lightBlock], ['dark', darkBlock]]) {
    const tokens = parseDeclarations(declarations);
    const backgrounds = ['--canvas', '--surface', '--surface-raised', '--surface-muted'];
    for (const foreground of ['--ink', '--muted']) {
      for (const background of backgrounds) {
        const ratio = contrastRatio(tokens[foreground], tokens[background]);
        assert.ok(ratio >= 4.5, `${theme} ${foreground} on ${background} is ${ratio.toFixed(2)}:1`);
      }
    }
    const statusPairs = [
      ['--accent', backgrounds],
      ['--accent-strong', ['--surface', '--surface-raised', '--accent-soft']],
      ['--success', ['--surface', '--surface-muted', '--success-soft']],
      ['--danger', ['--surface', '--danger-soft', '--danger-field']],
      ['--placeholder', ['--surface']],
      ['--disabled-ink', ['--disabled-surface']],
      ['--on-accent', ['--accent', '--accent-strong']],
    ];
    for (const [foreground, pairedBackgrounds] of statusPairs) {
      for (const background of pairedBackgrounds) {
        const ratio = contrastRatio(tokens[foreground], tokens[background]);
        assert.ok(ratio >= 4.5, `${theme} ${foreground} on ${background} is ${ratio.toFixed(2)}:1`);
      }
    }
    assert.match(declarations, theme === 'dark' ? /color-scheme:\s*dark/i : /color-scheme:\s*light/i);
  }
});

test('progress updates are announced without making the whole rail live', () => {
  const loadingSection = indexHtml.match(/<section id="loadingSection"[^>]*>([\s\S]*?)<\/section>/)?.[0];
  assert.ok(loadingSection, 'Expected the conversion progress section');
  assert.doesNotMatch(loadingSection.slice(0, loadingSection.indexOf('>')), /role="status"|aria-live=/);
  assert.match(loadingSection, /<p id="loadingStatus"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.match(loadingSection, /<ol id="loadingSteps"[^>]*aria-label="Conversion progress"/);
  assert.match(scriptJs, /setAttribute\('aria-current',\s*'step'\)/);
});

test('theme and state colors are expressed through semantic tokens', () => {
  assert.match(styleCss, /--success-soft:/);
  assert.match(styleCss, /--danger-soft:/);
  assert.match(styleCss, /--disabled-surface:/);
  assert.match(styleCss, /--disabled-ink:/);
  assert.match(styleCss, /@media\s*\(prefers-color-scheme:\s*dark\)/);

  for (const selector of [
    /#tweetUrl::placeholder\s*\{([^}]*)\}/,
    /#tweetUrl\[aria-invalid="true"\]\s*\{([^}]*)\}/,
    /button:disabled,\s*select:disabled\s*\{\s*border-color:\s*var\([^)]*\);([^}]*)\}/,
    /\.cache-notice\s*\{([^}]*)\}/,
    /\.share-section\s*\{([^}]*)\}/,
    /\.error-section\s*\{\s*padding:\s*20px;([^}]*)\}/,
  ]) {
    const body = ruleBody(selector);
    assert.doesNotMatch(body, /#[\da-f]{3,8}\b|rgba?\(/i, `State rule ${selector} should use semantic color tokens`);
    if (/disabled/.test(selector.source)) assert.doesNotMatch(body, /opacity\s*:/i, 'Disabled text must retain its token contrast');
  }
});
