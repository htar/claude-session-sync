import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeProjectDir, projectKey } from '../core/paths';

test('encodeProjectDir matches Claude Code naming', () => {
  assert.equal(encodeProjectDir('/Users/khmelovski/Desktop/pwaStart'), '-Users-khmelovski-Desktop-pwaStart');
});

test('projectKey is identical on any machine for the same remote', () => {
  assert.equal(projectKey('git@github.com:htar/pwaStart.git', '/a/b'), 'htar_pwaStart');
  assert.equal(projectKey('https://github.com/htar/pwaStart', '/c/d'), 'htar_pwaStart');
  assert.equal(projectKey('https://github.com/htar/pwaStart.git/', '/c/d'), 'htar_pwaStart');
});

test('projectKey falls back to the folder name and is filesystem-safe', () => {
  assert.equal(projectKey(undefined, '/x/my proj'), 'my_proj');
});
