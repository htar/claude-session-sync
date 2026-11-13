import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyError, redactSecrets } from '../core/errors';
import { retryingFetch } from '../core/http';
import { FetchFn } from '../core/oauth';

const scripted = (steps: (Response | Error)[]): { fetch: FetchFn; calls: () => number } => {
  let i = 0;
  return {
    calls: () => i,
    fetch: () => {
      const step = steps[Math.min(i++, steps.length - 1)];
      return step instanceof Error ? Promise.reject(step) : Promise.resolve(step ?? new Response('', { status: 500 }));
    },
  };
};

const noSleep = () => {
  const waits: number[] = [];
  return {
    waits,
    sleep: (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
};

test('a 429 is retried after the time the service asks for', async () => {
  const s = scripted([new Response('', { status: 429, headers: { 'retry-after': '3' } }), new Response('ok')]);
  const t = noSleep();
  const res = await retryingFetch(s.fetch, { sleep: t.sleep })('https://x');
  assert.equal(await res.text(), 'ok');
  assert.deepEqual(t.waits, [3000]);
});

test('a dropped connection is retried with a growing pause, then the error surfaces', async () => {
  const s = scripted([new TypeError('fetch failed')]);
  const t = noSleep();
  await assert.rejects(retryingFetch(s.fetch, { sleep: t.sleep, retries: 2 })('https://x'), /fetch failed/);
  assert.equal(s.calls(), 3);
  assert.deepEqual(t.waits, [1000, 2000]);
});

test('4xx answers other than 429 are returned at once, never retried', async () => {
  const s = scripted([new Response('', { status: 409 })]);
  const res = await retryingFetch(s.fetch, { sleep: noSleep().sleep })('https://x');
  assert.equal(res.status, 409);
  assert.equal(s.calls(), 1);
});

test('a 503 that keeps failing is returned after the last retry', async () => {
  const s = scripted([new Response('', { status: 503 })]);
  const res = await retryingFetch(s.fetch, { sleep: noSleep().sleep, retries: 2 })('https://x');
  assert.equal(res.status, 503);
  assert.equal(s.calls(), 3);
});

test('errors are told apart: no connection, storage full, anything else', () => {
  assert.equal(classifyError('fetch failed'), 'network');
  assert.equal(classifyError("fatal: unable to access 'https://x/': Could not resolve host: x"), 'network');
  assert.equal(classifyError('getaddrinfo ENOTFOUND api.dropboxapi.com'), 'network');
  assert.equal(
    classifyError('Dropbox upload of a failed (409): {"error_summary": "path/insufficient_space/"}'),
    'full',
  );
  assert.equal(classifyError('OneDrive upload of a failed (507): insufficientStorage'), 'full');
  assert.equal(classifyError('Something else broke'), 'other');
});

test('access errors are told apart from network errors and from a local EACCES', () => {
  assert.equal(classifyError("fatal: unable to access 'https://x/': The requested URL returned error: 403"), 'access');
  assert.equal(classifyError('git@github.com: Permission denied (publickey).'), 'access');
  assert.equal(classifyError('Sync folder not found: /x'), 'access');
  assert.equal(classifyError("EACCES: permission denied, open '/x'"), 'other');
});

test('credentials never reach the log or a notification', () => {
  assert.equal(
    redactSecrets("fatal: unable to access 'https://user:s3cret@host/o/r.git/'"),
    "fatal: unable to access 'https://***@host/o/r.git/'",
  );
  assert.equal(redactSecrets('Authorization: Bearer abc.def-123'), 'Authorization: Bearer ***');
  assert.equal(redactSecrets(`token ghp_${'a'.repeat(36)} used`), 'token *** used');
  assert.equal(redactSecrets('nothing to hide'), 'nothing to hide');
});
