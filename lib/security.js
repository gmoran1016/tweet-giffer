const TWEET_HOSTS = new Set([
  'x.com',
  'www.x.com',
  'twitter.com',
  'www.twitter.com',
]);

const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
const TWEET_ID_PATTERN = /^\d+$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseTweetUrl(value) {
  if (typeof value !== 'string') return null;

  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || !TWEET_HOSTS.has(url.hostname)
      || url.username
      || url.password
      || url.port
    ) return null;

    const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)\/?$/);
    if (!match) return null;

    const [, username, tweetId] = match;
    if (!USERNAME_PATTERN.test(username) || !TWEET_ID_PATTERN.test(tweetId)) return null;

    return {
      username,
      tweetId,
      canonicalUrl: `https://x.com/${username}/status/${tweetId}`,
    };
  } catch {
    return null;
  }
}

function isSafeRemoteUrl(value, allowedHosts) {
  if (typeof value !== 'string' || !allowedHosts || typeof allowedHosts[Symbol.iterator] !== 'function') {
    return false;
  }

  const hosts = new Set(Array.from(allowedHosts, (host) => String(host).toLowerCase()));
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.port
      && hosts.has(url.hostname);
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function isUuid(value) {
  return typeof value === 'string' && UUID_V4_PATTERN.test(value);
}

module.exports = {
  parseTweetUrl,
  isSafeRemoteUrl,
  escapeHtml,
  isUuid,
};
