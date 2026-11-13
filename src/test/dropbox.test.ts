import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { test } from 'node:test';
import { DROPBOX_APP_KEY, DropboxClient, dropboxOAuth } from '../core/dropbox';
import { exchangeCode, FetchFn, pkcePair, tokenProvider, waitForAuthCode } from '../core/oauth';
import { CloudAuthError, MirrorTransport } from '../core/remote';
import { SyncService } from '../core/syncService';
import { read, tmp, userLine, write } from './helpers';

/** A tiny in-memory Dropbox: the app folder plus the token endpoint. */
class FakeDropbox {
  files = new Map<string, Buffer>();
  tokens = 0;
  calls: string[] = [];
  expireAccessTokens = false;

  fetch: FetchFn = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body;
    const text = typeof body === 'string' ? body : '';
    this.calls.push(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const json = (v: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(v), { status }));

    if (url.endsWith('/oauth2/token')) {
      const p = new URLSearchParams(text);
      if (p.get('grant_type') === 'refresh_token' && p.get('refresh_token') !== 'good-refresh')
        return json({ error: 'invalid_grant' }, 400);
      this.tokens++;
      return json({ access_token: `access-${this.tokens}`, refresh_token: 'good-refresh', expires_in: 14400 });
    }
    if (this.expireAccessTokens) return json({ error: 'expired_access_token' }, 401);
    if (url.endsWith('/files/list_folder')) {
      const entries = [...this.files].map(([rel, data]) => ({
        '.tag': 'file',
        path_display: `/${rel}`,
        size: data.length,
      }));
      return json({ entries, has_more: false, cursor: 'c' });
    }
    const argHeader = headers['dropbox-api-arg'];
    const arg = argHeader ? (JSON.parse(argHeader) as { path: string }) : { path: '/' };
    if (url.endsWith('/files/download')) {
      const data = this.files.get(arg.path.slice(1));
      return Promise.resolve(data ? new Response(new Uint8Array(data)) : new Response('not found', { status: 409 }));
    }
    if (url.endsWith('/files/upload')) {
      this.files.set(arg.path.slice(1), Buffer.from(body as Uint8Array));
      return json({});
    }
    if (url.endsWith('/files/delete_v2')) {
      const rel = (JSON.parse(text) as { path: string }).path.slice(1);
      return this.files.delete(rel) ? json({}) : json({ error: 'not_found' }, 409);
    }
    return json({ error: 'unexpected' }, 500);
  };
}

const device = (dbx: FakeDropbox, deviceName: string, localDir: string) => {
  const client = new DropboxClient(dbx.fetch, tokenProvider(dbx.fetch, dropboxOAuth, 'good-refresh'));
  const transport = new MirrorTransport(path.join(tmp(), 'cache'), client);
  return new SyncService({ transport, localDir, projectKey: 'proj', deviceName });
};

test('PKCE challenge matches the RFC 7636 example', () => {
  const { challenge } = pkcePair('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('authorize URL asks for a refresh token with PKCE and the loopback redirect', () => {
  const u = new URL(dropboxOAuth.authorizeUrl('ch', 'st'));
  assert.equal(u.searchParams.get('client_id'), DROPBOX_APP_KEY);
  assert.equal(u.searchParams.get('token_access_type'), 'offline');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:53682/callback');
  assert.equal(u.searchParams.get('state'), 'st');
});

test('exchangeCode returns the refresh token', async () => {
  const t = await exchangeCode(new FakeDropbox().fetch, dropboxOAuth, 'code', 'verifier', () => 1000);
  assert.equal(t.refreshToken, 'good-refresh');
  assert.equal(t.expiresAt, 1000 + 14400 * 1000);
});

test('token provider caches the access token and refreshes it near expiry', async () => {
  const dbx = new FakeDropbox();
  let now = 0;
  const get = tokenProvider(dbx.fetch, dropboxOAuth, 'good-refresh', undefined, () => now);
  assert.equal(await get(), 'access-1');
  assert.equal(await get(), 'access-1');
  now = 14400 * 1000;
  assert.equal(await get(), 'access-2');
});

test('a revoked refresh token is reported as an auth error', async () => {
  const dbx = new FakeDropbox();
  await assert.rejects(tokenProvider(dbx.fetch, dropboxOAuth, 'revoked')(), CloudAuthError);
});

test('a rejected access token is an auth error, not a silent failure', async () => {
  const dbx = new FakeDropbox();
  dbx.expireAccessTokens = true;
  const client = new DropboxClient(dbx.fetch, () => Promise.resolve('x'));
  await assert.rejects(client.list(), CloudAuthError);
});

test('push on one device, pull on another, through Dropbox', async () => {
  const dbx = new FakeDropbox();
  const a = tmp();
  const b = tmp();
  write(a, 's1.jsonl', userLine('hello'));
  await device(dbx, 'laptop', a).push();
  assert.ok(dbx.files.has('devices/laptop/projects/proj/s1.jsonl'));

  const other = device(dbx, 'desktop', b);
  assert.deepEqual(
    (await other.devices()).map((d) => d.name),
    ['laptop'],
  );
  await other.pull('laptop');
  assert.equal(read(b, 's1.jsonl'), userLine('hello'));
});

test('a second push uploads only what changed', async () => {
  const dbx = new FakeDropbox();
  const a = tmp();
  write(a, 's1.jsonl', userLine('one'));
  const svc = device(dbx, 'laptop', a);
  await svc.push();
  const uploads = () => dbx.calls.filter((c) => c.endsWith('/files/upload')).length;
  const before = uploads();
  assert.equal((await svc.push()).pushed, false);
  assert.equal(uploads(), before);
  write(a, 's1.jsonl', userLine('one') + userLine('two'));
  await svc.push();
  assert.equal(uploads(), before + 1);
});

test('removing a device deletes its files from Dropbox and nobody else’s', async () => {
  const dbx = new FakeDropbox();
  const a = tmp();
  const b = tmp();
  write(a, 's1.jsonl', userLine('a'));
  write(b, 's2.jsonl', userLine('b'));
  const laptop = device(dbx, 'laptop', a);
  await laptop.push();
  await device(dbx, 'desktop', b).push();

  const r = await laptop.removeDevice('laptop');
  assert.equal(r.removed, 1);
  assert.deepEqual([...dbx.files.keys()], ['devices/desktop/projects/proj/s2.jsonl']);
  assert.equal(fs.existsSync(path.join(a, 's1.jsonl')), true); // the local session is untouched
});

test('non-ASCII paths survive the header encoding', async () => {
  const dbx = new FakeDropbox();
  const client = new DropboxClient(dbx.fetch, () => Promise.resolve('x'));
  await client.upload('devices/Мак/p/s.jsonl', Buffer.from('x'));
  assert.ok(dbx.files.has('devices/Мак/p/s.jsonl'));
});

const callback = (port: number, query: string): Promise<number> =>
  new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/callback?${query}`, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
      .on('error', reject);
  });

test('the loopback server returns the code when the state matches', async () => {
  const port = 53790;
  const code = waitForAuthCode(
    'st',
    `http://127.0.0.1:${port}/callback`,
    () => void callback(port, 'code=abc&state=st'),
  );
  assert.equal(await code, 'abc');
});

test('a wrong state is refused but does not end the sign-in', async () => {
  const port = 53791;
  const code = waitForAuthCode('st', `http://127.0.0.1:${port}/callback`, () => {
    void (async () => {
      assert.equal(await callback(port, 'code=abc&state=evil'), 400);
      assert.equal(await callback(port, 'code=real&state=st'), 200);
    })();
  });
  assert.equal(await code, 'real');
});

test('the loopback server stops waiting when cancelled', async () => {
  const ctl = new AbortController();
  const code = waitForAuthCode(
    'st',
    'http://127.0.0.1:53792/callback',
    () => {
      ctl.abort();
    },
    { signal: ctl.signal },
  );
  await assert.rejects(code, /cancelled/);
});

test('the mirror reports what it is doing: reading, downloading n/m, uploading n/m, deleting n/m', async () => {
  const dbx = new FakeDropbox();
  const messages: string[] = [];
  const client = new DropboxClient(dbx.fetch, tokenProvider(dbx.fetch, dropboxOAuth, 'good-refresh'));
  const transport = new MirrorTransport(path.join(tmp(), 'cache'), client, (m) => messages.push(m));
  const a = tmp();
  write(a, 's1.jsonl', userLine('1'));
  write(a, 's2.jsonl', userLine('2'));
  const svc = new SyncService({ transport, localDir: a, projectKey: 'p', deviceName: 'd' });
  await svc.push();
  assert.ok(messages.includes('Reading the file list…'));
  assert.ok(messages.some((m) => m.startsWith('Uploading 2/2: ')));

  messages.length = 0;
  const other = new MirrorTransport(path.join(tmp(), 'cache'), client, (m) => messages.push(m));
  await other.refresh();
  assert.ok(messages.some((m) => m.startsWith('Downloading 2/2: ')));
});

test('a file name from the network that points outside the cache is ignored', async () => {
  const dbx = new FakeDropbox();
  dbx.files.set('../evil.jsonl', Buffer.from('x'));
  dbx.files.set('devices/ok/projects/p/s.jsonl', Buffer.from('y'));
  const root = path.join(tmp(), 'cache');
  const client = new DropboxClient(dbx.fetch, tokenProvider(dbx.fetch, dropboxOAuth, 'good-refresh'));
  await new MirrorTransport(root, client).refresh();
  assert.equal(fs.existsSync(path.join(root, '..', 'evil.jsonl')), false);
  assert.ok(fs.existsSync(path.join(root, 'devices', 'ok', 'projects', 'p', 's.jsonl')));
});
