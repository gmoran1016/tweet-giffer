const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const serverScript = `
  const { startServer, stopServer } = require('./server');
  startServer({ port: 0, prewarm: false })
    .then(server => process.send({ port: server.address().port }))
    .catch(error => { console.error(error); process.exit(1); });
  process.on('message', message => {
    if (message === 'stop') stopServer().then(() => process.exit(0));
  });
`;

async function corsHeaderFor(env, origin) {
  const child = spawn(process.execPath, ['-e', serverScript], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      ALLOWED_ORIGIN: '',
      CORS_ORIGIN: '',
      ...env,
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });

  try {
    const port = await new Promise((resolve, reject) => {
      child.once('message', message => resolve(message.port));
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`CORS test server exited ${code}: ${stderr}`)));
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { origin },
    });
    return response.headers.get('access-control-allow-origin');
  } finally {
    if (child.connected) child.send('stop');
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(() => { child.kill(); resolve(); }, 5_000).unref();
    });
  }
}

test('CORS_ORIGIN is used when ALLOWED_ORIGIN is absent', async () => {
  const origin = 'https://legacy.example.test';
  assert.equal(await corsHeaderFor({ CORS_ORIGIN: origin }, origin), origin);
});

test('ALLOWED_ORIGIN takes precedence when both origin variables are set', async () => {
  assert.equal(await corsHeaderFor({
    ALLOWED_ORIGIN: 'https://canonical.example.test',
    CORS_ORIGIN: 'https://legacy.example.test',
  }, 'https://canonical.example.test'), 'https://canonical.example.test');
});
