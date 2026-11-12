import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeProjectsDir, encodeProjectDir, projectKey, sanitizeProjectKey } from '../core/paths';

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

test('Claude Code folder: the setting wins, then CLAUDE_CONFIG_DIR, then ~/.claude', () => {
  assert.equal(claudeProjectsDir('/a', { CLAUDE_CONFIG_DIR: '/b' }), '/a/projects');
  assert.equal(claudeProjectsDir('', { CLAUDE_CONFIG_DIR: '/b' }), '/b/projects');
  assert.match(claudeProjectsDir('', {}), /\.claude[\\/]projects$/);
});

test('a project key typed by the user is made safe for a folder name', () => {
  assert.equal(sanitizeProjectKey('  my app / v2 '), 'my_app_v2');
  assert.equal(sanitizeProjectKey('../../etc'), 'etc');
  assert.equal(sanitizeProjectKey('   '), '');
});
