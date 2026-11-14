import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { googleOAuth, GoogleDriveClient } from '../core/googledrive';
import { FetchFn, tokenProvider } from '../core/oauth';
import { CloudAuthError, MirrorTransport } from '../core/remote';
import { SyncService } from '../core/syncService';
import { read, tmp, userLine, write } from './helpers';

const OAUTH = googleOAuth('test-client', 'test-secret');

interface StoredFile {
  id: string;
  name: string;
  data: Buffer;
}

/** A tiny in-memory Google Drive app data folder (flat files, resumable uploads) plus the token endpoint. */
class FakeDrive {
  /** Newest first, like `orderBy=modifiedTime desc`. */
  files: StoredFile[] = [];
  tokenBodies: URLSearchParams[] = [];
  expireAccessTokens = false;
  pageSize = 1000;
  private pending = new Map<string, { name?: string; id?: string }>();
  private n = 0;

  fetch: FetchFn = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const text = typeof init?.body === 'string' ? init.body : '';
    const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
      Promise.resolve(new Response(JSON.stringify(v), { status, headers }));

    if (url.host === 'oauth2.googleapis.com') {
      const p = new URLSearchParams(text);
      this.tokenBodies.push(p);
      return json({ access_token: `access-${this.tokenBodies.length}`, refresh_token: 'r', expires_in: 3600 });
    }
    if (this.expireAccessTokens) return json({ error: 'expired' }, 401);

    if (url.host === 'upload.example') {
      const slot = this.pending.get(url.pathname) ?? {};
      const data = Buffer.from(init?.body instanceof Uint8Array ? init.body : new Uint8Array());
      const existing = this.files.find((f) => f.id === slot.id);
      this.files = this.files.filter((f) => f !== existing);
      const file = { id: slot.id ?? `id-${++this.n}`, name: slot.name ?? existing?.name ?? '', data };
      this.files.unshift(file);
      return json({ id: file.id });
    }

    assert.equal(url.host, 'www.googleapis.com');
    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      assert.equal(url.searchParams.get('spaces'), 'appDataFolder');
      const start = Number(url.searchParams.get('pageToken') ?? 0);
      const slice = this.files.slice(start, start + this.pageSize);
      const next = start + this.pageSize < this.files.length ? String(start + this.pageSize) : undefined;
      return json({
        files: slice.map((f) => ({ id: f.id, name: f.name, size: String(f.data.length) })),
        nextPageToken: next,
      });
    }
    const media = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (media && method === 'GET') {
      const f = this.files.find((x) => x.id === media[1]);
      return Promise.resolve(f ? new Response(new Uint8Array(f.data)) : new Response('', { status: 404 }));
    }
    if (media && method === 'DELETE') {
      this.files = this.files.filter((x) => x.id !== media[1]);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    const upload = /^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/.exec(url.pathname);
    if (upload && url.searchParams.get('uploadType') === 'resumable') {
      const meta = text ? (JSON.parse(text) as { name?: string; parents?: string[] }) : {};
      if (method === 'POST') assert.deepEqual(meta.parents, ['appDataFolder']);
      const slot = `/session/${++this.n}`;
      this.pending.set(slot, { name: meta.name, id: upload[1] });
      return json({}, 200, { location: `https://upload.example${slot}` });
    }
    return json({ error: 'unexpected' }, 500);
  };
}

const client = (g: FakeDrive) => new GoogleDriveClient(g.fetch, tokenProvider(g.fetch, OAUTH, 'refresh-0'));

const device = (g: FakeDrive, deviceName: string, localDir: string) =>
  new SyncService({
    transport: new MirrorTransport(path.join(tmp(), 'cache'), client(g)),
    localDir,
    projectKey: 'proj',
    deviceName,
  });

test('authorize URL asks for the app data scope, offline access and a fresh consent', () => {
  const u = new URL(OAUTH.authorizeUrl('ch', 'st'));
  assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.appdata');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('prompt'), 'consent');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:53684/callback');
});

test('the client secret and id go with every token request', async () => {
  const g = new FakeDrive();
  await tokenProvider(g.fetch, OAUTH, 'refresh-0')();
  const body = g.tokenBodies.at(0);
  assert.ok(body);
  assert.equal(body.get('client_secret'), 'test-secret');
  assert.equal(body.get('client_id'), 'test-client');
  assert.equal(body.get('grant_type'), 'refresh_token');
});

test('push on one device, pull on another, through Google Drive; the file name is the whole path', async () => {
  const g = new FakeDrive();
  const a = tmp();
  const b = tmp();
  write(a, 's1.jsonl', userLine('hello'));
  await device(g, 'laptop', a).push();
  assert.ok(g.files.some((f) => f.name === 'devices/laptop/projects/proj/s1.jsonl'));

  const other = device(g, 'desktop', b);
  assert.deepEqual(
    (await other.devices()).map((d) => d.name),
    ['laptop'],
  );
  await other.pull('laptop');
  assert.equal(read(b, 's1.jsonl'), userLine('hello'));
});

test('a changed file is updated in place, not duplicated', async () => {
  const g = new FakeDrive();
  const a = tmp();
  write(a, 's1.jsonl', userLine('one'));
  const svc = device(g, 'laptop', a);
  await svc.push();
  write(a, 's1.jsonl', userLine('one') + userLine('two'));
  await svc.push();
  const same = g.files.filter((f) => f.name.endsWith('s1.jsonl'));
  assert.equal(same.length, 1);
  assert.equal(same[0]?.data.toString(), userLine('one') + userLine('two'));
});

test('removing a device deletes its files and nobody else’s', async () => {
  const g = new FakeDrive();
  const a = tmp();
  const b = tmp();
  write(a, 's1.jsonl', userLine('a'));
  write(b, 's2.jsonl', userLine('b'));
  const laptop = device(g, 'laptop', a);
  await laptop.push();
  await device(g, 'desktop', b).push();
  assert.equal((await laptop.removeDevice('laptop')).removed, 1);
  assert.ok(g.files.every((f) => f.name.includes('desktop')));
});

test('listing follows pages, and the newest of two files with one name wins', async () => {
  const g = new FakeDrive();
  g.pageSize = 2;
  g.files = [
    { id: 'new', name: 'a.jsonl', data: Buffer.from('newer') },
    { id: 'x', name: 'b.jsonl', data: Buffer.from('b') },
    { id: 'old', name: 'a.jsonl', data: Buffer.from('older!') },
    { id: 'y', name: 'c.jsonl', data: Buffer.from('c') },
  ];
  const c = client(g);
  const list = await c.list();
  assert.deepEqual(list.map((f) => f.rel).sort(), ['a.jsonl', 'b.jsonl', 'c.jsonl']);
  assert.equal(list.find((f) => f.rel === 'a.jsonl')?.size, 5);
  assert.equal((await c.download('a.jsonl')).toString(), 'newer');
});

test('a rejected access token is refreshed once; if it is still refused it is an auth error', async () => {
  const g = new FakeDrive();
  g.expireAccessTokens = true;
  await assert.rejects(client(g).list(), CloudAuthError);
  assert.ok(g.tokenBodies.length >= 2); // the second request asked for a fresh token
});

test('deleting a file that is not there is not an error', async () => {
  await client(new FakeDrive()).remove('nope.jsonl');
});
