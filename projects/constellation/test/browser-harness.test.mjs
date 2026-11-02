import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { waitForDevToolsPort } from '../scripts/browser-harness.mjs';

test('browser startup tolerates temporary port-file locks but preserves other errors', async () => {
  const errors = ['ENOENT', 'EACCES', 'EPERM', 'EBUSY'];
  const port = await waitForDevToolsPort('fixture', {
    timeoutMs: 1000, pollIntervalMs: 1,
    readPortFile: async () => {
      if (errors.length) throw Object.assign(new Error('Port file unavailable'), { code: errors.shift() });
      return '12345\n/devtools/browser/test\n';
    },
  });
  assert.equal(port, '12345');
  assert.equal(await waitForDevToolsPort('fixture', {
    timeoutMs: 30, pollIntervalMs: 5,
    readPortFile: async () => { throw Object.assign(new Error('Locked'), { code: 'EPERM' }); },
  }), undefined);
  await assert.rejects(waitForDevToolsPort('fixture', {
    readPortFile: async () => { throw Object.assign(new Error('I/O failure'), { code: 'EIO' }); },
  }), { code: 'EIO' });
});

test('browser startup waits through missing, empty and partial port files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'constellation-port-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'DevToolsActivePort');
  const port = waitForDevToolsPort(path, { timeoutMs: 5000, pollIntervalMs: 5 });
  await delay(20);
  await writeFile(path, '');
  await delay(20);
  await writeFile(path, '123');
  await delay(20);
  await writeFile(path, '12345\n/devtools/browser/test\n');
  assert.equal(await port, '12345');
});

test('browser startup rejects invalid ports and stops when the browser exits', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'constellation-port-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'DevToolsActivePort');
  for (const contents of ['', '123', '0\n', '65536\n', 'invalid\n']) {
    await writeFile(path, contents);
    assert.equal(await waitForDevToolsPort(path, { timeoutMs: 30, pollIntervalMs: 5 }), undefined);
  }
  await writeFile(path, '12345\r\n/devtools/browser/test\r\n');
  assert.equal(await waitForDevToolsPort(path), '12345');
  assert.equal(await waitForDevToolsPort(path, { isRunning: () => false }), undefined);
});
