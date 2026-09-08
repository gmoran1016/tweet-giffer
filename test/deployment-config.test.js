const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('Docker health check uses runtime PORT with a 3000 default', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /127\.0\.0\.1:\$\{PORT:-3000\}\/api\/ready/);
});

test('Compose health check preserves container-shell PORT expansion', () => {
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  assert.match(compose, /127\.0\.0\.1:\$\$\{PORT:-3000\}\/api\/ready/);
  assert.match(compose, /PORT: \$\{PORT:-3000\}/);
});

test('Docker image advertises the stable Unraid icon URL', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  assert.match(
    dockerfile,
    /LABEL net\.unraid\.docker\.icon="https:\/\/raw\.githubusercontent\.com\/gmoran1016\/tweet-giffer\/master\/public\/docker-icon\.png"/
  );
});

test('deployment exposes readiness and bounded processing settings', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  assert.match(dockerfile, /\/api\/ready/);
  assert.match(compose, /\/api\/ready/);
  assert.match(compose, /MAX_DOWNLOAD_BYTES/);
  assert.match(compose, /MAX_VIDEO_DURATION_SEC/);
  assert.match(compose, /MAX_VIDEO_DIMENSION/);
  assert.match(compose, /MAX_OUTPUT_BYTES/);
  assert.match(compose, /size=1g/);
});

test('CI verifies the application before publishing the image', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'docker.yml'), 'utf8');
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /TWEET_GIFFER_BROWSER_TEST:\s*['"]?1/);
  assert.match(workflow, /npm run check/);
  assert.match(workflow, /needs:\s*test/);
});

test('runtime declaration matches the dependency floor', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.engines.node, '>=22.12.0');
});
