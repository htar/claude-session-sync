import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { ensureSyncFolder, STORAGES, storageRoots } from '../core/storages';
import { tmp } from './helpers';

const find = (id: string) => {
  const s = STORAGES.find((x) => x.id === id);
  assert.ok(s, id);
  return s;
};
const mk = (home: string, ...rel: string[]) => fs.mkdirSync(path.join(home, ...rel), { recursive: true });
const roots = (id: string, home: string, platform: NodeJS.Platform = 'darwin', env: NodeJS.ProcessEnv = {}) =>
  storageRoots(find(id), { home, platform, env }).map((r) => path.relative(home, r));

test('a storage that is not installed has no roots', () => {
  assert.deepEqual(roots('dropbox', tmp()), []);
});

test('iCloud Drive and a classic Dropbox folder are found in their standard places', () => {
  const home = tmp();
  mk(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  mk(home, 'Dropbox');
  assert.deepEqual(roots('icloud', home), [path.join('Library', 'Mobile Documents', 'com~apple~CloudDocs')]);
  assert.deepEqual(roots('dropbox', home), ['Dropbox']);
});

test('macOS File Provider: Google Drive root is «My Drive», every OneDrive account is its own root', () => {
  const home = tmp();
  mk(home, 'Library', 'CloudStorage', 'GoogleDrive-me@example.com', 'My Drive');
  mk(home, 'Library', 'CloudStorage', 'OneDrive-Personal');
  mk(home, 'Library', 'CloudStorage', 'OneDrive-Acme');
  assert.deepEqual(roots('gdrive', home), [
    path.join('Library', 'CloudStorage', 'GoogleDrive-me@example.com', 'My Drive'),
  ]);
  assert.equal(roots('onedrive', home).length, 2);
});

test('Windows: OneDrive is named by an environment variable', () => {
  const home = tmp();
  const od = path.join(home, 'OneDriveCorp');
  fs.mkdirSync(od);
  assert.deepEqual(roots('onedrive', home, 'win32', { OneDrive: od }), ['OneDriveCorp']);
});

test('a plain file with the storage name is not a root', () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, 'Dropbox'), 'x');
  assert.deepEqual(roots('dropbox', home), []);
});

test('«Claude Sessions» is created at the root, and again without error', () => {
  const root = tmp();
  const dir = ensureSyncFolder(root);
  assert.equal(dir, path.join(root, 'Claude Sessions'));
  assert.equal(ensureSyncFolder(root), dir);
});
