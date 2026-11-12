import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { FetchFn, tokenProvider } from '../core/oauth';
import { CHUNK, onedriveOAuth, OneDriveClient, SIMPLE_UPLOAD_MAX } from '../core/onedrive';
import { CloudAuthError, MirrorTransport } from '../core/remote';
import { SyncService } from '../core/syncService';
import { read, tmp, userLine, write } from './helpers';

const APPROOT = '/v1.0/me/drive/special/approot';

/** A tiny in-memory OneDrive (Microsoft Graph, path-addressed app folder) plus the token endpoint. */
class FakeOneDrive {
  files = new Map<string, Buffer>();
  refreshTokens: string[] = [];
  uploadsOfSession: { range: string; auth: string | undefined }[] = [];
  simplePuts = 0;
  rejectToken = false;
  private pendingSession: string | undefined;
  private rotation = 0;

  fetch: FetchFn = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const json = (v: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(v), { status }));
    const bytes = (b: BodyInit | null | undefined) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array());

    if (url.pathname.endsWith('/oauth2/v2.0/token')) {
      const p = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
      if (this.rejectToken) return json({ error: 'invalid_grant' }, 400);
      this.refreshTokens.push(p.get('refresh_token') ?? 'code');
      this.rotation++;
      return json({
        access_token: `access-${this.rotation}`,
        refresh_token: `refresh-${this.rotation}`,
        expires_in: 3600,
      });
    }
    if (url.host === 'upload.example') {
      this.uploadsOfSession.push({ range: headers['content-range'] ?? '', auth: headers.authorization });
      const [, start, end] = /bytes (\d+)-(\d+)\//.exec(headers['content-range'] ?? '') ?? [];
      const chunk = bytes(init?.body);
      const path_ = this.pendingSession ?? '';
      const prev = this.files.get(path_) ?? Buffer.alloc(0);
      assert.equal(prev.length, Number(start));
      assert.equal(Number(end) - Number(start) + 1, chunk.length);
      this.files.set(path_, Buffer.concat([prev, chunk]));
      return json({});
    }

    assert.ok(url.pathname.startsWith(APPROOT), url.pathname);
    const rest = decodeURIComponent(url.pathname.slice(APPROOT.length));
    if (rest === '/children' || /^:\/.*:\/children$/.test(rest)) {
      const dir = rest === '/children' ? '' : rest.slice(2, -':/children'.length);
      const prefix = dir ? `${dir}/` : '';
      const seen = new Set<string>();
      const value: object[] = [];
      for (const [rel, data] of this.files) {
        if (!rel.startsWith(prefix)) continue;
        const [first, ...more] = rel.slice(prefix.length).split('/');
        const name = first ?? '';
        if (more.length) {
          if (!seen.has(name)) value.push({ name, folder: {} });
          seen.add(name);
        } else value.push({ name, size: data.length });
      }
      return json({ value });
    }
    const m = /^:\/(.*):(\/content|\/createUploadSession)?$/.exec(rest);
    if (!m) return json({ error: 'unexpected' }, 500);
    const rel = m[1] ?? '';
    if (method === 'GET') {
      const data = this.files.get(rel);
      return Promise.resolve(data ? new Response(new Uint8Array(data)) : new Response('', { status: 404 }));
    }
    if (method === 'PUT') {
      this.simplePuts++;
      this.files.set(rel, bytes(init?.body));
      return json({});
    }
    if (method === 'POST') {
      this.pendingSession = rel;
      this.files.delete(rel);
      return json({ uploadUrl: 'https://upload.example/session/1' });
    }
    if (method === 'DELETE') return new Response(null, { status: this.files.delete(rel) ? 204 : 404 });
    return json({ error: 'unexpected' }, 500);
  };
}

const client = (od: FakeOneDrive) => new OneDriveClient(od.fetch, tokenProvider(od.fetch, onedriveOAuth, 'refresh-0'));

const device = (od: FakeOneDrive, deviceName: string, localDir: string) =>
  new SyncService({
    transport: new MirrorTransport(path.join(tmp(), 'cache'), client(od)),
    localDir,
    projectKey: 'proj',
    deviceName,
  });

test('authorize URL asks for the app folder scope, a refresh token and the localhost redirect', () => {
  const u = new URL(onedriveOAuth.authorizeUrl('ch', 'st'));
  assert.equal(u.searchParams.get('scope'), 'Files.ReadWrite.AppFolder offline_access');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:53683');
  assert.equal(u.searchParams.get('state'), 'st');
});

test('the rotated refresh token is handed back so it can be stored', async () => {
  const od = new FakeOneDrive();
  const stored: string[] = [];
  let now = 0;
  const get = tokenProvider(
    od.fetch,
    onedriveOAuth,
    'refresh-0',
    (t) => void stored.push(t),
    () => now,
  );
  assert.equal(await get(), 'access-1');
  assert.deepEqual(stored, ['refresh-1']);
  now = 3600 * 1000;
  await get();
  assert.deepEqual(od.refreshTokens, ['refresh-0', 'refresh-1']);
  assert.deepEqual(stored, ['refresh-1', 'refresh-2']);
});

test('a revoked refresh token is an auth error', async () => {
  const od = new FakeOneDrive();
  od.rejectToken = true;
  await assert.rejects(client(od).list(), CloudAuthError);
});

test('push on one device, pull on another, through OneDrive', async () => {
  const od = new FakeOneDrive();
  const a = tmp();
  const b = tmp();
  write(a, 's1.jsonl', userLine('hello'));
  await device(od, 'laptop', a).push();
  assert.ok(od.files.has('devices/laptop/projects/proj/s1.jsonl'));

  const other = device(od, 'desktop', b);
  assert.deepEqual(
    (await other.devices()).map((d) => d.name),
    ['laptop'],
  );
  await other.pull('laptop');
  assert.equal(read(b, 's1.jsonl'), userLine('hello'));
});

test('removing a device deletes its files from OneDrive and nobody else’s', async () => {
  const od = new FakeOneDrive();
  const a = tmp();
  const b = tmp();
  write(a, 's1.jsonl', userLine('a'));
  write(b, 's2.jsonl', userLine('b'));
  const laptop = device(od, 'laptop', a);
  await laptop.push();
  await device(od, 'desktop', b).push();
  assert.equal((await laptop.removeDevice('laptop')).removed, 1);
  assert.deepEqual([...od.files.keys()], ['devices/desktop/projects/proj/s2.jsonl']);
});

test('small files go in one PUT, big ones through an upload session in aligned chunks without the bearer token', async () => {
  const od = new FakeOneDrive();
  const c = client(od);
  await c.upload('small.jsonl', Buffer.from('x'));
  assert.equal(od.simplePuts, 1);

  const big = Buffer.alloc(SIMPLE_UPLOAD_MAX + CHUNK + 5, 7);
  await c.upload('devices/d/big.jsonl', big);
  assert.equal(od.simplePuts, 1);
  assert.deepEqual(od.files.get('devices/d/big.jsonl'), big);
  assert.ok(od.uploadsOfSession.length >= 2);
  assert.ok(od.uploadsOfSession.every((u) => u.auth === undefined));
});

test('listing walks nested folders; names with spaces and non-ASCII survive', async () => {
  const od = new FakeOneDrive();
  const c = client(od);
  await c.upload('devices/Мак Про/projects/p q/s.jsonl', Buffer.from('abc'));
  assert.deepEqual(await c.list(), [{ rel: 'devices/Мак Про/projects/p q/s.jsonl', size: 3 }]);
  assert.equal((await c.download('devices/Мак Про/projects/p q/s.jsonl')).toString(), 'abc');
});

test('deleting a file that is already gone is not an error', async () => {
  await client(new FakeOneDrive()).remove('nope.jsonl');
});
