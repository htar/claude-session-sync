import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { DeviceNameTakenError, SyncConfig, SyncService } from '../core/syncService';
import { LEGACY_SOURCE, listDevices, safeDeviceName } from '../core/devices';
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
    deviceName: name,
    ...extra,
  });
  return { service, localDir };
}

test('a session pushed from one device is pulled on another', async () => {
  const remote = bareRepo();
  const [laptop, desktop] = [device(remote, 'laptop'), device(remote, 'desktop')];
  write(laptop.localDir, 'abc-1.jsonl', userLine('refactor auth'));

  assert.equal((await laptop.service.push()).pushed, true);
  assert.deepEqual((await desktop.service.pull('laptop')).copied, ['abc-1.jsonl']);
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
  await desktop.service.pull('laptop');
  write(desktop.localDir, 's.jsonl', userLine('one') + userLine('two'));
  await desktop.service.push();
  await laptop.service.pull('desktop');
  assert.equal(read(laptop.localDir, 's.jsonl'), userLine('one') + userLine('two'));
});

test('a clone made while the remote was empty still pulls later', async () => {
  const remote = bareRepo();
  const [late, early] = [device(remote, 'late'), device(remote, 'early')];
  assert.deepEqual((await late.service.pull('early')).copied, []); // clones the empty remote
  write(early.localDir, 's.jsonl', userLine('first'));
  await early.service.push();
  assert.deepEqual((await late.service.pull('early')).copied, ['s.jsonl']);
});

test('a session continued on both devices is reported as a conflict and not overwritten', async () => {
  const remote = bareRepo();
  const [laptop, desktop] = [device(remote, 'laptop'), device(remote, 'desktop')];
  write(laptop.localDir, 's.jsonl', userLine('base'));
  await laptop.service.push();
  await desktop.service.pull('laptop');
  write(laptop.localDir, 's.jsonl', userLine('base') + userLine('laptop work'));
  write(desktop.localDir, 's.jsonl', userLine('base') + userLine('desktop work!'));
  await laptop.service.push();
  const r = await desktop.service.pull('laptop');
  assert.deepEqual(r.conflicts, ['s.jsonl']);
  assert.equal(read(desktop.localDir, 's.jsonl'), userLine('base') + userLine('desktop work!'));
});

test('concurrent calls on one service are serialised, not interleaved', async () => {
  const remote = bareRepo();
  const d = device(remote, 'laptop');
  write(d.localDir, 's.jsonl', userLine('x'));
  const results = await Promise.all([d.service.push(), d.service.push(), d.service.pull('laptop')]);
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
  assert.deepEqual((await desktop.service.pull('laptop')).copied, ['small.jsonl']);
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
  const r = await desktop.service.pull('laptop');
  assert.deepEqual(r.copied, ['big.jsonl']);
  assert.equal(r.tooOld, 0);
});

/** Two devices that share one folder, as iCloud Drive or Dropbox would present it. */
function folderDevice(shared: string, name: string) {
  const localDir = path.join(tmp(), 'claude-project');
  return {
    service: new SyncService({ transport: new FolderTransport(shared), localDir, projectKey: 'k', deviceName: name }),
    localDir,
  };
}

test('folder mode: a session pushed to a shared folder is pulled on another device', async () => {
  const shared = tmp();
  const [laptop, desktop] = [folderDevice(shared, 'laptop'), folderDevice(shared, 'desktop')];
  write(laptop.localDir, 's.jsonl', userLine('via cloud'));
  assert.equal((await laptop.service.push()).pushed, true);
  assert.equal((await laptop.service.push()).pushed, false);
  assert.deepEqual((await desktop.service.pull('laptop')).copied, ['s.jsonl']);
  assert.equal(read(desktop.localDir, 's.jsonl'), userLine('via cloud'));
});

test('folder mode: a diverged session is a conflict and is not overwritten', async () => {
  const shared = tmp();
  const [laptop, desktop] = [folderDevice(shared, 'laptop'), folderDevice(shared, 'desktop')];
  write(laptop.localDir, 's.jsonl', userLine('base'));
  await laptop.service.push();
  await desktop.service.pull('laptop');
  write(laptop.localDir, 's.jsonl', userLine('base') + userLine('laptop'));
  write(desktop.localDir, 's.jsonl', userLine('base') + userLine('desktop!'));
  await laptop.service.push();
  assert.deepEqual((await desktop.service.pull('laptop')).conflicts, ['s.jsonl']);
});

test('folder mode: a missing folder is an error, not a silently created one', async () => {
  const d = folderDevice(path.join(tmp(), 'gone'), 'laptop');
  await assert.rejects(d.service.pull('laptop'), /Sync folder not found/);
});

test('folder mode: sessions iCloud has not downloaded yet are counted, not silently missed', async () => {
  const shared = tmp();
  write(path.join(shared, 'devices', 'other', 'projects', 'k'), '.evicted-1.jsonl.icloud', 'stub');
  write(path.join(shared, 'devices', 'other', 'projects', 'k'), 'here.jsonl', userLine('present'));
  const d = folderDevice(shared, 'desktop');
  const r = await d.service.pull('other');
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
  await desktop.service.pull('laptop', ['c']);
  write(laptop.localDir, 'c.jsonl', userLine('gamma') + userLine('more'));
  await laptop.service.push();

  const list = await desktop.service.available('laptop');
  assert.deepEqual(list.map((s) => [s.id, s.status]).sort(), [
    ['a', 'new'],
    ['b', 'new'],
    ['c', 'updated'],
  ]);
  const r = await desktop.service.pull('laptop', ['b']);
  assert.deepEqual(r.copied, ['b.jsonl']);
  assert.equal(fs.existsSync(path.join(desktop.localDir, 'a.jsonl')), false);
  assert.equal((await desktop.service.available('laptop')).find((s) => s.id === 'b')?.status, 'same');
});

test('each device exports to its own folder: two devices push the same session without touching each other', async () => {
  const shared = tmp();
  const [laptop, desktop] = [folderDevice(shared, 'laptop'), folderDevice(shared, 'desktop')];
  write(laptop.localDir, 's.jsonl', userLine('base') + userLine('laptop'));
  write(desktop.localDir, 's.jsonl', userLine('base') + userLine('desktop'));
  assert.deepEqual((await laptop.service.push()).conflicts, []);
  assert.deepEqual((await desktop.service.push()).conflicts, []);
  assert.deepEqual((await laptop.service.devices()).map((d) => [d.name, d.sessions]).sort(), [
    ['desktop', 1],
    ['laptop', 1],
  ]);
  // Importing chooses the source: each device's own version is still there, unmixed.
  const third = folderDevice(shared, 'third');
  await third.service.pull('desktop');
  assert.equal(read(third.localDir, 's.jsonl'), userLine('base') + userLine('desktop'));
});

test('sessions pushed by an older version (one shared folder) are offered as a legacy source', async () => {
  const shared = tmp();
  write(path.join(shared, 'projects', 'k'), 'old.jsonl', userLine('from 0.4'));
  const d = folderDevice(shared, 'desktop');
  assert.deepEqual(
    (await d.service.devices()).map((x) => [x.name, x.legacy]),
    [[LEGACY_SOURCE, true]],
  );
  assert.deepEqual((await d.service.pull(LEGACY_SOURCE)).copied, ['old.jsonl']);
});

test('device names are made safe, and unsafe folder names in the store are ignored and refused', async () => {
  assert.equal(safeDeviceName("Taras's MacBook Pro.local"), 'Taras-s-MacBook-Pro.local');
  assert.equal(safeDeviceName('../../etc'), 'etc');
  assert.equal(safeDeviceName('   '), 'device');
  const shared = tmp();
  write(path.join(shared, 'devices', '..evil', 'projects', 'k'), 'x.jsonl', 'x');
  write(path.join(shared, 'devices', 'ok', 'projects', 'k'), 'x.jsonl', 'x');
  assert.deepEqual(
    listDevices(shared, 'k').map((d) => d.name),
    ['ok'],
  );
  const d = folderDevice(shared, 'me');
  await assert.rejects(d.service.pull('../..'), /Unsafe device name/);
  await assert.rejects(d.service.removeDevice('../..'), /Unsafe device name/);
});

test("removeDevice deletes only that device's folder of this project and tidies up what it left empty", async () => {
  const shared = tmp();
  const [laptop, desktop] = [folderDevice(shared, 'laptop'), folderDevice(shared, 'desktop')];
  write(laptop.localDir, 'a.jsonl', userLine('a'));
  write(laptop.localDir, 'b.jsonl', userLine('b'));
  write(desktop.localDir, 'c.jsonl', userLine('c'));
  await laptop.service.push();
  await desktop.service.push();
  write(path.join(shared, 'devices', 'laptop', 'projects', 'other-project'), 'z.jsonl', 'keep');

  assert.deepEqual(await desktop.service.removeDevice('laptop'), { removed: 2, published: true });
  assert.equal(fs.existsSync(path.join(shared, 'devices', 'laptop', 'projects', 'k')), false);
  assert.equal(fs.existsSync(path.join(shared, 'devices', 'laptop', 'projects', 'other-project', 'z.jsonl')), true);
  assert.equal(fs.existsSync(path.join(shared, 'devices', 'desktop', 'projects', 'k', 'c.jsonl')), true);
  assert.equal(read(laptop.localDir, 'a.jsonl'), userLine('a')); // local sessions are never touched

  assert.deepEqual(await desktop.service.removeDevice('desktop'), { removed: 1, published: true });
  assert.equal(fs.existsSync(path.join(shared, 'devices', 'desktop')), false);
  assert.equal(fs.existsSync(path.join(shared, 'devices')), true);
  assert.deepEqual(await desktop.service.removeDevice('desktop'), { removed: 0, published: false });
});

const withId = (store: string, local: string, deviceName: string, installId: string): SyncService =>
  new SyncService({ transport: new FolderTransport(store), localDir: local, projectKey: 'p', deviceName, installId });

test('two computers with the same device name are told apart: the second one is refused', async () => {
  const store = tmp();
  const a = tmp();
  const b = tmp();
  write(a, 's1.jsonl', userLine('a'));
  write(b, 's2.jsonl', userLine('b'));
  await withId(store, a, 'MacBook-Pro', 'id-A').push();
  await withId(store, a, 'MacBook-Pro', 'id-A').push(); // the same computer again: fine
  await assert.rejects(withId(store, b, 'MacBook-Pro', 'id-B').push(), DeviceNameTakenError);
  assert.equal(fs.existsSync(path.join(store, 'devices', 'MacBook-Pro', 'projects', 'p', 's2.jsonl')), false);
});

test('a reinstalled editor can take its own device name over after confirming', async () => {
  const store = tmp();
  const a = tmp();
  write(a, 's1.jsonl', userLine('a'));
  await withId(store, a, 'laptop', 'old-id').push();
  await assert.rejects(withId(store, a, 'laptop', 'new-id').push(), DeviceNameTakenError);
  await withId(store, a, 'laptop', 'new-id').push({ takeOver: true });
  await withId(store, a, 'laptop', 'new-id').push(); // now it owns the name
});

test('a folder without a marker (pushed by an older version) is claimed, not refused', async () => {
  const store = tmp();
  const a = tmp();
  write(a, 's1.jsonl', userLine('a'));
  write(path.join(store, 'devices', 'laptop', 'projects', 'p'), 's0.jsonl', userLine('old'));
  await withId(store, a, 'laptop', 'id-A').push();
  assert.ok(fs.existsSync(path.join(store, 'devices', 'laptop', 'device.json')));
});

test('removing the last export of a device removes its marker too, and the device disappears', async () => {
  const store = tmp();
  const a = tmp();
  write(a, 's1.jsonl', userLine('a'));
  const svc = withId(store, a, 'laptop', 'id-A');
  await svc.push();
  await svc.removeDevice('laptop');
  assert.equal(fs.existsSync(path.join(store, 'devices', 'laptop')), false);
  assert.deepEqual(await svc.devices(), []);
});
