import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { copyTranscripts, isPrefix, listSessions, readTitle } from '../core/transcripts';
import { read, tmp, touch, userLine, userLineAt, write } from './helpers';

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

test('files over the size limit are reported and not copied', () => {
  const [a, b] = [path.join(tmp(), 'a'), path.join(tmp(), 'b')];
  write(a, 'small.jsonl', 'tiny\n');
  write(a, 'big.jsonl', 'x'.repeat(100));
  const r = copyTranscripts(a, b, { maxBytes: 50 });
  assert.deepEqual(r.copied, ['small.jsonl']);
  assert.deepEqual(r.tooLarge, ['big.jsonl']);
  assert.deepEqual(fs.readdirSync(b), ['small.jsonl']);
});

test('files older than the age limit are only counted, not copied', () => {
  const [a, b] = [path.join(tmp(), 'a'), path.join(tmp(), 'b')];
  write(a, 'recent.jsonl', 'r\n');
  write(a, 'old.jsonl', 'o\n');
  touch(a, 'recent.jsonl', new Date('2026-09-01'));
  touch(a, 'old.jsonl', new Date('2026-01-01'));
  const r = copyTranscripts(a, b, { modifiedAfterMs: Date.parse('2026-06-01') });
  assert.deepEqual(r.copied, ['recent.jsonl']);
  assert.equal(r.tooOld, 1);
  assert.deepEqual(fs.readdirSync(b), ['recent.jsonl']);
});

test('a file that is both old and large counts as old only', () => {
  const [a, b] = [path.join(tmp(), 'a'), path.join(tmp(), 'b')];
  write(a, 'old-big.jsonl', 'x'.repeat(100));
  touch(a, 'old-big.jsonl', new Date('2026-01-01'));
  const r = copyTranscripts(a, b, { maxBytes: 50, modifiedAfterMs: Date.parse('2026-06-01') });
  assert.equal(r.tooOld, 1);
  assert.deepEqual(r.tooLarge, []);
});

test('empty transcripts are neither copied nor listed', () => {
  const [a, b] = [path.join(tmp(), 'a'), path.join(tmp(), 'b')];
  write(a, 'empty.jsonl', '');
  write(a, 'real.jsonl', userLine('work'));
  const r = copyTranscripts(a, b);
  assert.deepEqual(r.copied, ['real.jsonl']);
  assert.deepEqual(fs.readdirSync(b), ['real.jsonl']);
  assert.deepEqual(
    listSessions(a).map((s) => s.id),
    ['real'],
  );
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

test('readTitle skips IDE context blocks and finds the real prompt in the same message', () => {
  const dir = tmp();
  const blocks = [
    { type: 'text', text: '<ide_opened_file>a.ts</ide_opened_file>' },
    { type: 'text', text: 'fix   the\nbug' },
  ];
  write(dir, 's.jsonl', `${JSON.stringify({ type: 'user', message: { content: blocks } })}\n`);
  assert.equal(readTitle(path.join(dir, 's.jsonl')), 'fix the bug');
});

test('readTitle looks only at the head of a file, so a huge transcript is not read whole', () => {
  const dir = tmp();
  const filler = `${JSON.stringify({ type: 'summary', pad: 'x'.repeat(5 * 1024 * 1024) })}\n`;
  write(dir, 'late.jsonl', filler + userLine('too late'));
  write(dir, 'early.jsonl', userLine('on time') + filler);
  assert.equal(readTitle(path.join(dir, 'late.jsonl')), '(no prompt)');
  assert.equal(readTitle(path.join(dir, 'early.jsonl')), 'on time');
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

test('listSessions orders by the last timestamped entry, not by file mtime (a pulled file has the pull time)', () => {
  const dir = tmp();
  // Real transcripts end with a statistics record that has no timestamp.
  const stats = `${JSON.stringify({ type: 'stats', totalCostUSD: 1 })}\n`;
  write(dir, 'march.jsonl', userLineAt('older work', '2026-03-01T10:00:00.000Z') + stats);
  write(dir, 'june.jsonl', userLineAt('newer work', '2026-06-01T10:00:00.000Z') + stats);
  touch(dir, 'march.jsonl', new Date()); // pulled just now
  touch(dir, 'june.jsonl', new Date('2026-01-01'));
  assert.deepEqual(
    listSessions(dir).map((s) => s.id),
    ['june', 'march'],
  );
});

test('the last activity is found even when the tail window starts in the middle of a huge line', () => {
  const dir = tmp();
  const huge = `${JSON.stringify({ type: 'assistant', pad: 'x'.repeat(300 * 1024) })}\n`;
  write(dir, 's.jsonl', huge + userLineAt('last', '2026-05-05T00:00:00.000Z'));
  touch(dir, 's.jsonl', new Date('2026-01-01'));
  assert.equal(listSessions(dir)[0]?.lastActivity, Date.parse('2026-05-05T00:00:00.000Z'));
});
