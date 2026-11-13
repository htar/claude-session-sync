import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { commitAndPush, ensureClone, git, isValidRepoUrl } from '../core/git';

test('accepts https, ssh, scp-style and absolute paths', () => {
  for (const u of [
    'https://github.com/o/r.git',
    'ssh://git@host/o/r.git',
    'git@github.com:o/r.git',
    '/tmp/remote.git',
  ]) {
    assert.equal(isValidRepoUrl(u), true, u);
  }
});

test('rejects option injection, dangerous transports and junk', () => {
  for (const u of [
    '--upload-pack=touch /tmp/x',
    '-oProxyCommand=x',
    'ext::sh -c id',
    'file:///etc',
    'http://insecure/x',
    '',
    'a b',
  ]) {
    assert.equal(isValidRepoUrl(u), false, u);
  }
});

test('commitAndPush pushes commits left behind by a failed push, then reports nothing new', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'css-git-'));
  const remote = path.join(base, 'remote.git');
  const clone = path.join(base, 'clone');
  await git(base, ['init', '-q', '--bare', remote]);
  await ensureClone(clone, remote);
  fs.writeFileSync(path.join(clone, 'a.jsonl'), 'x');
  await git(clone, ['remote', 'set-url', 'origin', path.join(base, 'missing.git')]);
  await assert.rejects(commitAndPush(clone, 'first'));
  await git(clone, ['remote', 'set-url', 'origin', remote]);
  assert.equal(await commitAndPush(clone, 'retry'), true);
  assert.equal(await git(remote, ['log', '--format=%s', '-1']), 'first');
  assert.equal(await commitAndPush(clone, 'again'), false);
});
