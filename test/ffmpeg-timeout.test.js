const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { _internals } = require('../server');

class StalledCommand extends EventEmitter {
  run() {}
  kill(signal) { this.killedWith = signal; }
}

test('bounded FFmpeg runner kills and rejects a stalled command', async () => {
  const command = new StalledCommand();
  await assert.rejects(
    _internals.runFfmpegCommand(command, { label: 'test conversion', timeoutMs: 20 }),
    /timed out/,
  );
  assert.equal(command.killedWith, 'SIGKILL');
});

test('bounded FFmpeg runner settles once and clears its timeout', async () => {
  const command = new StalledCommand();
  const result = _internals.runFfmpegCommand(command, { timeoutMs: 20 });
  command.emit('end');
  await result;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(command.killedWith, undefined);
});
