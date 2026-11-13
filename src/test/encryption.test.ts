import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  decrypt,
  encrypt,
  EncryptingTransport,
  ENCRYPTION_FILE,
  newMeta,
  openMeta,
  PassphraseSource,
  readMeta,
  WrongPassphraseError,
} from '../core/encryption';
import { SyncService } from '../core/syncService';
import { FolderTransport, GitTransport } from '../core/transport';
import { bareRepo, read, tmp, userLine, write } from './helpers';

const walk = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .flatMap((e) => (e.isFile() && !e.parentPath.includes(`${path.sep}.git`) ? [path.join(e.parentPath, e.name)] : []));

const source =
  (passphrase: string, calls: { n: number } = { n: 0 }): PassphraseSource =>
  (meta) => {
    calls.n++;
    return Promise.resolve(openMeta(meta, passphrase));
  };

test('encrypt/decrypt round-trip; a wrong key or a changed byte is refused', () => {
  const { meta, key } = newMeta('correct horse');
  const data = Buffer.from('{"type":"user"} Привіт');
  const sealed = encrypt(key, data);
  assert.ok(!sealed.includes(data));
  assert.deepEqual(decrypt(key, sealed), data);
  assert.throws(() => decrypt(openMeta(newMeta('other').meta, 'other'), sealed));
  const tampered = Buffer.from(sealed);
  tampered.writeUInt8(tampered.readUInt8(tampered.length - 1) ^ 1, tampered.length - 1);
  assert.throws(() => decrypt(key, tampered));
  assert.throws(() => decrypt(key, Buffer.from('plain text, not ours')));
  assert.throws(() => openMeta(meta, 'wrong'), WrongPassphraseError);
  assert.deepEqual(openMeta(meta, 'correct horse'), key);
});

test('two devices sync through an encrypted folder; the storage holds only ciphertext', async () => {
  const store = tmp();
  const make = (name: string) => {
    const localDir = tmp();
    const transport = new EncryptingTransport(new FolderTransport(store), tmp(), source('pass phrase'));
    return {
      localDir,
      transport,
      service: new SyncService({ transport, localDir, projectKey: 'k', deviceName: name }),
    };
  };
  const laptop = make('laptop');
  const desktop = make('desktop');
  assert.ok(await laptop.transport.enable('pass phrase'));
  assert.equal(await laptop.transport.enable('pass phrase'), undefined); // already on
  assert.ok(readMeta(store));

  write(laptop.localDir, 's.jsonl', userLine('secret plan'));
  assert.equal((await laptop.service.push()).pushed, true);
  for (const f of walk(store)) {
    assert.ok(f.endsWith('.enc') || f.endsWith(ENCRYPTION_FILE), f);
    assert.ok(!fs.readFileSync(f).includes('secret plan'), f);
  }
  assert.deepEqual((await desktop.service.pull('laptop')).copied, ['s.jsonl']);
  assert.equal(read(desktop.localDir, 's.jsonl'), userLine('secret plan'));

  // The other way, and an unchanged push publishes nothing.
  write(desktop.localDir, 's.jsonl', userLine('secret plan') + userLine('more'));
  await desktop.service.push();
  await laptop.service.pull('desktop');
  assert.equal(read(laptop.localDir, 's.jsonl'), userLine('secret plan') + userLine('more'));
  assert.equal((await laptop.service.push()).pushed, true); // its own export catches up with the pulled session
  assert.equal((await laptop.service.push()).pushed, false);

  // Deleting a device's export removes its encrypted files from the store.
  await laptop.service.removeDevice('desktop');
  assert.ok(!walk(store).some((f) => f.includes(`${path.sep}desktop${path.sep}`)));
});

test('the passphrase is asked once per transport, and a wrong one stops the operation', async () => {
  const store = tmp();
  const owner = new EncryptingTransport(new FolderTransport(store), tmp(), source('right'));
  await owner.enable('right');
  const calls = { n: 0 };
  const ok = new EncryptingTransport(new FolderTransport(store), tmp(), source('right', calls));
  await ok.refresh();
  await ok.refresh();
  assert.equal(calls.n, 1);
  assert.equal(ok.encrypted, true);

  const wrong = new EncryptingTransport(new FolderTransport(store), tmp(), source('wrong'));
  await assert.rejects(wrong.refresh(), WrongPassphraseError);
  const gaveUp = new EncryptingTransport(new FolderTransport(store), tmp(), () => Promise.resolve(undefined));
  await assert.rejects(gaveUp.refresh(), /no passphrase/);
});

test('without encryption.json the wrapper is a pass-through', async () => {
  const store = tmp();
  const t = new EncryptingTransport(new FolderTransport(store), tmp(), () => {
    throw new Error('must not ask');
  });
  const localDir = tmp();
  const service = new SyncService({ transport: t, localDir, projectKey: 'k', deviceName: 'laptop' });
  write(localDir, 's.jsonl', userLine('plain'));
  await service.push();
  assert.equal(t.encrypted, false);
  assert.equal(t.root, store);
  assert.ok(walk(store).some((f) => f.endsWith('s.jsonl')));
});

test('encryption over git: other devices see .enc files only, and older versions ignore them', async () => {
  const remote = bareRepo();
  const make = (name: string) => {
    const root = tmp();
    const localDir = path.join(root, 'claude');
    const transport = new EncryptingTransport(
      new GitTransport(path.join(root, 'repo'), remote),
      path.join(root, 'plain'),
      source('pw'),
    );
    return {
      root,
      localDir,
      transport,
      service: new SyncService({ transport, localDir, projectKey: 'k', deviceName: name }),
    };
  };
  const a = make('a');
  const b = make('b');
  await a.transport.enable('pw');
  write(a.localDir, 's.jsonl', userLine('over git'));
  await a.service.push();
  assert.deepEqual((await b.service.pull('a')).copied, ['s.jsonl']);
  // An old client (plain GitTransport) sees no session to pull.
  const old = new SyncService({
    transport: new GitTransport(path.join(tmp(), 'repo'), remote),
    localDir: tmp(),
    projectKey: 'k',
    deviceName: 'old',
  });
  assert.deepEqual((await old.pull('a')).copied, []);
});

test('turning encryption on can remove the unencrypted copies already in the storage', async () => {
  const store = tmp();
  const localDir = tmp();
  const plain = new SyncService({
    transport: new FolderTransport(store),
    localDir,
    projectKey: 'k',
    deviceName: 'old',
  });
  write(localDir, 's.jsonl', userLine('was plain'));
  await plain.push();
  const keep = tmp();
  fs.cpSync(store, keep, { recursive: true });

  const t = new EncryptingTransport(new FolderTransport(keep), tmp(), source('pw'));
  await t.enable('pw');
  assert.ok(
    walk(keep).some((f) => f.endsWith('s.jsonl')),
    'kept by default',
  );

  const t2 = new EncryptingTransport(new FolderTransport(store), tmp(), source('pw'));
  await t2.enable('pw', { removePlain: true });
  assert.deepEqual(
    walk(store).map((f) => path.basename(f)),
    [ENCRYPTION_FILE],
  );
});
