import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { copyTranscripts, isPrefix, listSessions } from '../core/transcripts';
import { read, tmp, userLine, write } from './helpers';

test('copies missing files and ignores everything that is not a session transcript', () => {
  const [a, b] = [path.join(tmp(), 'a'), path.join(tmp(), 'b')];
  write(a, 's1.jsonl', userLine('hello'));
  write(a, 'notes.txt', 'x');
  write(a, '..evil.jsonl', 'x');
  const r = copyTranscripts(a, b);
  assert.deepEqual(r.copied, ['s1.jsonl']);
  assert.deepEqual(fs.readdirSync(b), ['s1.jsonl']);
});

test('a longer file extending the shorter one overwrites it', () => {
  const [a, b] = [path.join(tmp(), 'a'), path.join(tmp(), 'b')];
  write(b, 's.jsonl', 'one\n');
  write(a, 's.jsonl', 'one\ntwo\n');
  assert.deepEqual(copyTranscripts(a, b).copied, ['s.jsonl']);
  assert.equal(read(b, 's.jsonl'), 'one\ntwo\n');
});

test('a destination that is further along is kept', () => {
  const [a, b] = [path.join(tmp(), 'a'), path.join(tmp(), 'b')];
  write(a, 's.jsonl', 'one\n');
  write(b, 's.jsonl', 'one\ntwo\n');
  const r = copyTranscripts(a, b);
  assert.deepEqual(r.skipped, ['s.jsonl']);
  assert.equal(read(b, 's.jsonl'), 'one\ntwo\n');
});

test('diverged transcripts are reported and nothing is overwritten', () => {
  const [a, b] = [path.join(tmp(), 'a'), path.join(tmp(), 'b')];
  write(a, 's.jsonl', 'one\nLAPTOP\n');
  write(b, 's.jsonl', 'one\nDESKTOP-longer\n');
  const r = copyTranscripts(a, b);
  assert.deepEqual(r.conflicts, ['s.jsonl']);
  assert.equal(read(b, 's.jsonl'), 'one\nDESKTOP-longer\n');
});

test('isPrefix works across chunk boundaries', () => {
  const dir = tmp();
  const big = 'x'.repeat(200_000);
  write(dir, 'short', big);
  write(dir, 'long', `${big}tail`);
  write(dir, 'other', `${big.slice(0, 150_000)}y${big.slice(150_001)}tail`);
  assert.equal(isPrefix(path.join(dir, 'short'), path.join(dir, 'long')), true);
  assert.equal(isPrefix(path.join(dir, 'short'), path.join(dir, 'other')), false);
});

test('listSessions titles by first real user prompt, newest first, tolerating a torn line', () => {
  const dir = tmp();
  write(dir, 'old.jsonl', userLine('<command-name>x</command-name>') + userLine('real prompt'));
  write(dir, 'torn.jsonl', `${userLine('second')}{"type":"us`);
  fs.utimesSync(path.join(dir, 'old.jsonl'), 1, 1);
  const list = listSessions(dir);
  assert.deepEqual(
    list.map((s) => [s.id, s.title]),
    [
      ['torn', 'second'],
      ['old', 'real prompt'],
    ],
  );
});
