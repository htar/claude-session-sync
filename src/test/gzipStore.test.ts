import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GzipStore } from '../core/gzipStore';
import { RemoteFile, RemoteStore } from '../core/remote';

class Mem implements RemoteStore {
  files = new Map<string, Buffer>();
  list(): Promise<RemoteFile[]> {
    return Promise.resolve([...this.files].map(([rel, d]) => ({ rel, size: d.length })));
  }
  download(rel: string): Promise<Buffer> {
    const d = this.files.get(rel);
    return d ? Promise.resolve(d) : Promise.reject(new Error('missing'));
  }
  upload(rel: string, data: Buffer): Promise<void> {
    this.files.set(rel, data);
    return Promise.resolve();
  }
  remove(rel: string): Promise<void> {
    this.files.delete(rel);
    return Promise.resolve();
  }
}

test('GzipStore: transcripts are stored compressed, shown plain with their plain size, and round-trip', async () => {
  const mem = new Mem();
  const s = new GzipStore(mem);
  const data = Buffer.from('{"a":1}\n'.repeat(1000));
  await s.upload('d/p/s.jsonl', data);
  assert.deepEqual([...mem.files.keys()], [`d/p/s.jsonl.${data.length}.gz`]);
  assert.ok((mem.files.values().next().value as Buffer).length < data.length / 5);
  assert.deepEqual(await s.list(), [{ rel: 'd/p/s.jsonl', size: data.length }]);
  assert.deepEqual(await s.download('d/p/s.jsonl'), data);
});

test('GzipStore: a changed file replaces the old copy, a plain legacy copy is read and then replaced', async () => {
  const mem = new Mem();
  mem.files.set('s.jsonl', Buffer.from('old\n'));
  mem.files.set('other.json', Buffer.from('{}'));
  const s = new GzipStore(mem);
  assert.deepEqual(
    (await s.list()).map((f) => [f.rel, f.size]),
    [
      ['s.jsonl', 4],
      ['other.json', 2],
    ],
  );
  assert.equal((await s.download('s.jsonl')).toString(), 'old\n');
  await s.upload('s.jsonl', Buffer.from('old\nnew\n'));
  await s.upload('other.json', Buffer.from('{"x":1}'));
  assert.deepEqual([...mem.files.keys()].sort(), ['other.json', 's.jsonl.8.gz']);
  await s.upload('s.jsonl', Buffer.from('old\nnewer\n'));
  assert.deepEqual([...mem.files.keys()].sort(), ['other.json', 's.jsonl.10.gz']);
  await s.remove('s.jsonl');
  assert.deepEqual([...mem.files.keys()], ['other.json']);
});
