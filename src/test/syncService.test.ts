import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { SyncConfig, SyncService } from '../core/syncService';
import { FolderTransport, GitTransport } from '../core/transport';
import { bareRepo, read, tmp, touch, userLine, write } from './helpers';

/** One "device": its own ~/.claude project dir and its own clone, sharing the bare remote. */
function device(remote: string, name: string, extra: Partial<SyncConfig> = {}) {
  const root = tmp();
  const repoDir = path.join(root, 'repo');
  const localDir = path.join(root, 'claude-project');
  const service = new SyncService({
    transport: new GitTransport(repoDir, remote),
    localDir,
    projectKey: 'k',
    hostname: name,
    ...extra,
  });
  return { service, localDir };
}

test('a session pushed from one device is pulled on another', async () => {
  const remote = bareRepo();
  const [laptop, desktop] = [device(remote, 'laptop'), device(remote, 'desktop')];
  write(laptop.localDir, 'abc-1.jsonl', userLine('refactor auth'));

  assert.equal((await laptop.service.push()).pushed, true);
  assert.deepEqual((await desktop.service.pull()).copied, ['abc-1.jsonl']);
  assert.equal(read(desktop.localDir, 'abc-1.jsonl'), userLine('refactor auth'));
});

test('pushing twice without changes is a no-op', async () => {
  const remote = bareRepo();
  const d = device(remote, 'laptop');
  write(d.localDir, 's.jsonl', userLine('x'));
  await d.service.push();
  assert.equal((await d.service.push()).pushed, false);
});

test('continuing a session on the other device round-trips', async () => {
  const remote = bareRepo();
  const [laptop, desktop] = [device(remote, 'laptop'), device(remote, 'desktop')];
  write(laptop.localDir, 's.jsonl', userLine('one'));
  await laptop.service.push();
  await desktop.service.pull();
  write(desktop.localDir, 's.jsonl', userLine('one') + userLine('two'));
  await desktop.service.push();
  await laptop.service.pull();
  assert.equal(read(laptop.localDir, 's.jsonl'), userLine('one') + userLine('two'));
});

test('a clone made while the remote was empty still pulls later', async () => {
  const remote = bareRepo();
  const [late, early] = [device(remote, 'late'), device(remote, 'early')];
  assert.deepEqual((await late.service.pull()).copied, []); // clones the empty remote
  write(early.localDir, 's.jsonl', userLine('first'));
  await early.service.push();
  assert.deepEqual((await late.service.pull()).copied, ['s.jsonl']);
});

test('a session continued on both devices is reported as a conflict and not overwritten', async () => {
  const remote = bareRepo();
  const [laptop, desktop] = [device(remote, 'laptop'), device(remote, 'desktop')];
  write(laptop.localDir, 's.jsonl', userLine('base'));
  await laptop.service.push();
  await desktop.service.pull();
  write(laptop.localDir, 's.jsonl', userLine('base') + userLine('laptop work'));
  write(desktop.localDir, 's.jsonl', userLine('base') + userLine('desktop work!'));
  await laptop.service.push();
  const r = await desktop.service.push();
  assert.deepEqual(r.conflicts, ['s.jsonl']);
  assert.equal(read(desktop.localDir, 's.jsonl'), userLine('base') + userLine('desktop work!'));
});

test('concurrent calls on one service are serialised, not interleaved', async () => {
  const remote = bareRepo();
  const d = device(remote, 'laptop');
  write(d.localDir, 's.jsonl', userLine('x'));
  const results = await Promise.all([d.service.push(), d.service.push(), d.service.pull()]);
  assert.equal(results.length, 3);
});

test('a push leaves out sessions over the size limit and reports them, so one huge file cannot fail the push', async () => {
  const remote = bareRepo();
  const [laptop, desktop] = [
    device(remote, 'laptop', { limits: { maxFileBytes: 200, maxAgeDays: 0 } }),
    device(remote, 'desktop'),
  ];
  write(laptop.localDir, 'small.jsonl', userLine('ok'));
  write(laptop.localDir, 'big.jsonl', userLine('x'.repeat(500)));

  const r = await laptop.service.push();
  assert.deepEqual(r.copied, ['small.jsonl']);
  assert.deepEqual(r.tooLarge, ['big.jsonl']);
  assert.deepEqual((await desktop.service.pull()).copied, ['small.jsonl']);
});

test('a push leaves out sessions older than the age limit and counts them', async () => {
  const remote = bareRepo();
  const now = Date.parse('2026-11-10T12:00:00Z');
  const laptop = device(remote, 'laptop', { limits: { maxFileBytes: 1e9, maxAgeDays: 30 }, now: () => now });
  write(laptop.localDir, 'new.jsonl', userLine('recent'));
  write(laptop.localDir, 'old.jsonl', userLine('ancient'));
  touch(laptop.localDir, 'new.jsonl', new Date('2026-11-09'));
  touch(laptop.localDir, 'old.jsonl', new Date('2026-09-01'));

  const r = await laptop.service.push();
  assert.deepEqual(r.copied, ['new.jsonl']);
  assert.equal(r.tooOld, 1);
});

test('the push limits do not apply to a pull', async () => {
  const remote = bareRepo();
  const [laptop, desktop] = [
    device(remote, 'laptop'),
    device(remote, 'desktop', { limits: { maxFileBytes: 10, maxAgeDays: 1 } }),
  ];
  write(laptop.localDir, 'big.jsonl', userLine('x'.repeat(500)));
  await laptop.service.push();
  const r = await desktop.service.pull();
  assert.deepEqual(r.copied, ['big.jsonl']);
  assert.equal(r.tooOld, 0);
});

/** Two devices that share one folder, as iCloud Drive or Dropbox would present it. */
function folderDevice(shared: string, name: string) {
  const localDir = path.join(tmp(), 'claude-project');
  return {
    service: new SyncService({ transport: new FolderTransport(shared), localDir, projectKey: 'k', hostname: name }),
    localDir,
  };
}

test('folder mode: a session pushed to a shared folder is pulled on another device', async () => {
  const shared = tmp();
  const [laptop, desktop] = [folderDevice(shared, 'laptop'), folderDevice(shared, 'desktop')];
  write(laptop.localDir, 's.jsonl', userLine('via cloud'));
  assert.equal((await laptop.service.push()).pushed, true);
  assert.equal((await laptop.service.push()).pushed, false);
  assert.deepEqual((await desktop.service.pull()).copied, ['s.jsonl']);
  assert.equal(read(desktop.localDir, 's.jsonl'), userLine('via cloud'));
});

test('folder mode: a diverged session is a conflict and is not overwritten', async () => {
  const shared = tmp();
  const [laptop, desktop] = [folderDevice(shared, 'laptop'), folderDevice(shared, 'desktop')];
  write(laptop.localDir, 's.jsonl', userLine('base'));
  await laptop.service.push();
  await desktop.service.pull();
  write(laptop.localDir, 's.jsonl', userLine('base') + userLine('laptop'));
  write(desktop.localDir, 's.jsonl', userLine('base') + userLine('desktop!'));
  await laptop.service.push();
  assert.deepEqual((await desktop.service.push()).conflicts, ['s.jsonl']);
});

test('folder mode: a missing folder is an error, not a silently created one', async () => {
  const d = folderDevice(path.join(tmp(), 'gone'), 'laptop');
  await assert.rejects(d.service.pull(), /Sync folder not found/);
});

test('folder mode: sessions iCloud has not downloaded yet are counted, not silently missed', async () => {
  const shared = tmp();
  write(path.join(shared, 'projects', 'k'), '.evicted-1.jsonl.icloud', 'stub');
  write(path.join(shared, 'projects', 'k'), 'here.jsonl', userLine('present'));
  const d = folderDevice(shared, 'desktop');
  const r = await d.service.pull();
  assert.deepEqual(r.copied, ['here.jsonl']);
  assert.equal(r.notDownloaded, 1);
});

test('available() lists what the store holds with what a pull would do; pull(ids) takes only the chosen ones', async () => {
  const shared = tmp();
  const [laptop, desktop] = [folderDevice(shared, 'laptop'), folderDevice(shared, 'desktop')];
  write(laptop.localDir, 'a.jsonl', userLine('alpha'));
  write(laptop.localDir, 'b.jsonl', userLine('beta'));
  write(laptop.localDir, 'c.jsonl', userLine('gamma'));
  await laptop.service.push();
  await desktop.service.pull(['c']);
  write(laptop.localDir, 'c.jsonl', userLine('gamma') + userLine('more'));
  await laptop.service.push();

  const list = await desktop.service.available();
  assert.deepEqual(list.map((s) => [s.id, s.status]).sort(), [
    ['a', 'new'],
    ['b', 'new'],
    ['c', 'updated'],
  ]);
  const r = await desktop.service.pull(['b']);
  assert.deepEqual(r.copied, ['b.jsonl']);
  assert.equal(fs.existsSync(path.join(desktop.localDir, 'a.jsonl')), false);
  assert.equal((await desktop.service.available()).find((s) => s.id === 'b')?.status, 'same');
});
