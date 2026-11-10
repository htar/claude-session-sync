import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { SyncService } from '../core/syncService';
import { bareRepo, read, tmp, userLine, write } from './helpers';

/** One "device": its own ~/.claude project dir and its own clone, sharing the bare remote. */
function device(remote: string, name: string) {
  const root = tmp();
  const repoDir = path.join(root, 'repo');
  const localDir = path.join(root, 'claude-project');
  const service = new SyncService({
    repoUrl: remote,
    repoDir,
    localDir,
    remoteDir: path.join(repoDir, 'projects', 'k'),
    hostname: name,
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
