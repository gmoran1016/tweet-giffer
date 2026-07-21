const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('Docker health check uses runtime PORT with a 3000 default', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /127\.0\.0\.1:\$\{PORT:-3000\}\/api\/health/);
});

test('Compose health check preserves container-shell PORT expansion', () => {
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  assert.match(compose, /127\.0\.0\.1:\$\$\{PORT:-3000\}\/api\/health/);
  assert.match(compose, /PORT: \$\{PORT:-3000\}/);
});

test('Docker image advertises the stable Unraid icon URL', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  assert.match(
    dockerfile,
    /LABEL net\.unraid\.docker\.icon="https:\/\/raw\.githubusercontent\.com\/gmoran1016\/tweet-giffer\/master\/public\/docker-icon\.png"/
  );
});
