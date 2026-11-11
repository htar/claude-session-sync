import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensurePrivateRepo, githubAuthEnv, PublicRepoError } from '../core/github';

type Route = { status: number; body?: unknown };

function fakeFetch(routes: Record<string, Route>, seen: string[] = []): typeof fetch {
  return ((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url.replace('https://api.github.com', '')}`;
    seen.push(key);
    const r = routes[key] ?? { status: 500 };
    return Promise.resolve(new Response(JSON.stringify(r.body ?? {}), { status: r.status }));
  }) as typeof fetch;
}

const user = { 'GET /user': { status: 200, body: { login: 'me' } } };

test('an existing private repo is reused and nothing is created', async () => {
  const seen: string[] = [];
  const f = fakeFetch(
    {
      ...user,
      'GET /repos/me/claude-sessions': {
        status: 200,
        body: { private: true, clone_url: 'https://github.com/me/claude-sessions.git' },
      },
    },
    seen,
  );
  assert.equal((await ensurePrivateRepo('t', f)).cloneUrl, 'https://github.com/me/claude-sessions.git');
  assert.equal(
    seen.some((s) => s.startsWith('POST')),
    false,
  );
});

test('a missing repo is created as private', async () => {
  const f = fakeFetch({
    ...user,
    'GET /repos/me/claude-sessions': { status: 404 },
    'POST /user/repos': {
      status: 201,
      body: { private: true, clone_url: 'https://github.com/me/claude-sessions.git' },
    },
  });
  assert.equal((await ensurePrivateRepo('t', f)).cloneUrl, 'https://github.com/me/claude-sessions.git');
});

test('a PUBLIC repo with that name is refused', async () => {
  const f = fakeFetch({
    ...user,
    'GET /repos/me/claude-sessions': { status: 200, body: { private: false, clone_url: 'x' } },
  });
  await assert.rejects(ensurePrivateRepo('t', f), PublicRepoError);
});

test('API failures surface as errors', async () => {
  await assert.rejects(ensurePrivateRepo('t', fakeFetch({ 'GET /user': { status: 401 } })), /HTTP 401/);
  await assert.rejects(
    ensurePrivateRepo(
      't',
      fakeFetch({ ...user, 'GET /repos/me/claude-sessions': { status: 404 }, 'POST /user/repos': { status: 403 } }),
    ),
    /HTTP 403/,
  );
});

test('the token goes into the git environment, never onto a command line', () => {
  const env = githubAuthEnv('secret');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.extraheader');
  assert.match(env.GIT_CONFIG_VALUE_0 ?? '', /^Authorization: Basic /);
  assert.equal(JSON.stringify(Object.keys(env)).includes('secret'), false);
});
