import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findSecrets, scanSessions } from '../core/secrets';
import { SyncService } from '../core/syncService';
import { FolderTransport } from '../core/transport';
import { tmp, userLine, write } from './helpers';

const fake = {
  aws: 'AKIA' + 'ABCDEFGHIJKLMNOP',
  github: 'ghp_' + 'a'.repeat(36),
  anthropic: 'sk-ant-' + 'b'.repeat(40),
  openai: 'sk-proj-' + 'c'.repeat(40),
  key: '-----BEGIN OPENSSH PRIVATE KEY-----',
};

test('findSecrets recognises common credential formats, also right after an escaped newline in JSONL', () => {
  assert.deepEqual(findSecrets(fake.aws), ['AWS access key']);
  assert.deepEqual(findSecrets(JSON.stringify(`env:\n${fake.github}`)), ['GitHub token']);
  assert.deepEqual(findSecrets(fake.anthropic), ['Anthropic API key']);
  assert.deepEqual(findSecrets(fake.openai), ['OpenAI API key']);
  assert.deepEqual(findSecrets(JSON.stringify(`${fake.key}\nabc`)), ['private key']);
  assert.deepEqual(findSecrets(`${fake.aws} ${fake.github}`), ['AWS access key', 'GitHub token']);
});

test('findSecrets leaves ordinary code and prose alone', () => {
  for (const t of [
    'const key = process.env.API_KEY;',
    'AKIA is the prefix of AWS keys',
    'sk-short',
    'ghp_ tokens start like this',
    'BEGIN PUBLIC KEY',
    '',
  ]) {
    assert.deepEqual(findSecrets(t), [], t);
  }
});

test('scanSessions reports only the listed sessions that hold something, and skips missing files', () => {
  const d = tmp();
  write(d, 'a.jsonl', userLine(`token ${fake.github}`));
  write(d, 'b.jsonl', userLine('clean'));
  write(d, 'c.jsonl', userLine(fake.aws));
  const hits = scanSessions(d, ['a.jsonl', 'b.jsonl', 'gone.jsonl']);
  assert.deepEqual([...hits], [['a.jsonl', ['GitHub token']]]);
});

function folderDevice(name: string, store = tmp()) {
  const localDir = tmp();
  return {
    localDir,
    store,
    service: new SyncService({ transport: new FolderTransport(store), localDir, projectKey: 'k', deviceName: name }),
  };
}

test('push shows only the sessions it would send, and leaves out the ones the review excludes', async () => {
  const d = folderDevice('laptop');
  write(d.localDir, 'clean.jsonl', userLine('clean'));
  write(d.localDir, 'leaky.jsonl', userLine(fake.github));
  let seen: readonly string[] = [];
  const r = await d.service.push({
    review: (pending) => {
      seen = pending;
      return Promise.resolve(new Set(['leaky.jsonl']));
    },
  });
  assert.deepEqual([...seen].sort(), ['clean.jsonl', 'leaky.jsonl']);
  assert.deepEqual(r.copied, ['clean.jsonl']);
  // Already sent sessions are not shown again.
  const again = await d.service.push({
    review: (pending) => {
      seen = pending;
      return Promise.resolve(new Set());
    },
  });
  assert.deepEqual(seen, ['leaky.jsonl']);
  assert.deepEqual(again.copied, ['leaky.jsonl']);
});

test('a cancelled review sends nothing', async () => {
  const d = folderDevice('laptop');
  write(d.localDir, 's.jsonl', userLine(fake.aws));
  const r = await d.service.push({ review: () => Promise.resolve('cancel') });
  assert.equal(r.cancelled, true);
  assert.deepEqual(r.copied, []);
  const other = folderDevice('desktop', d.store);
  assert.deepEqual((await other.service.pull('laptop')).copied, []);
});
