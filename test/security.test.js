const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseTweetUrl,
  isSafeRemoteUrl,
  escapeHtml,
  isUuid,
} = require('../lib/security');

test('parseTweetUrl accepts exact HTTPS Twitter and X hosts', () => {
  for (const host of ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']) {
    assert.deepEqual(parseTweetUrl(`https://${host}/OpenAI/status/1234567890`), {
      username: 'OpenAI',
      tweetId: '1234567890',
      canonicalUrl: 'https://x.com/OpenAI/status/1234567890',
    });
  }
});

test('parseTweetUrl rejects unsafe or malformed tweet URLs', () => {
  const invalid = [
    'http://x.com/OpenAI/status/123',
    'https://user:pass@x.com/OpenAI/status/123',
    'https://x.com:444/OpenAI/status/123',
    'https://x.com.evil.test/OpenAI/status/123',
    'https://evilx.com/OpenAI/status/123',
    'https://x.com/?status/123',
    'https://x.com/OpenAI/likes/123',
    'https://x.com/OpenAI/status/not-a-number',
    'https://x.com/OpenAI/status/123/extra',
    'https://x.com/bad.user/status/123',
    '',
    null,
    undefined,
    123,
    {},
  ];

  for (const value of invalid) assert.equal(parseTweetUrl(value), null);
});

test('isSafeRemoteUrl accepts only credential-free HTTPS URLs on exact allowlisted hosts', () => {
  const allowedHosts = ['media.example.com', 'cdn.example.com'];
  assert.equal(isSafeRemoteUrl('https://media.example.com/image.png?size=large', allowedHosts), true);
  assert.equal(isSafeRemoteUrl('https://cdn.example.com/', allowedHosts), true);

  for (const value of [
    'http://media.example.com/image.png',
    'https://user:pass@media.example.com/image.png',
    'https://media.example.com:444/image.png',
    'https://media.example.com.evil.test/image.png',
    'https://sub.media.example.com/image.png',
    'https://other.example.com/image.png',
    'not a url',
    null,
  ]) assert.equal(isSafeRemoteUrl(value, allowedHosts), false);
});

test('escapeHtml escapes all HTML attribute-sensitive characters', () => {
  assert.equal(
    escapeHtml(`Tom & <tag title="quoted" data-note='single'>`),
    'Tom &amp; &lt;tag title=&quot;quoted&quot; data-note=&#39;single&#39;&gt;',
  );
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(42), '42');
});

test('isUuid accepts UUID v4 values and rejects other inputs', () => {
  assert.equal(isUuid('550e8400-e29b-41d4-a716-446655440000'), true);
  assert.equal(isUuid('550E8400-E29B-41D4-A716-446655440000'), true);
  assert.equal(isUuid('550e8400-e29b-11d4-a716-446655440000'), false);
  assert.equal(isUuid('550e8400-e29b-41d4-c716-446655440000'), false);
  assert.equal(isUuid('not-a-uuid'), false);
  assert.equal(isUuid(null), false);
});
