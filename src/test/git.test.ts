import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidRepoUrl } from '../core/git';

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
