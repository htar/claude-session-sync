import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { Transport } from './transport';

/** Public identifier of the «Session Sync for Claude Code» Dropbox app (App folder access: only `Apps/<name>`). */
export const DROPBOX_APP_KEY = 'tcz24ayn6tqaz80';
export const DROPBOX_REDIRECT_PORT = 53682;
export const DROPBOX_REDIRECT_URI = `http://127.0.0.1:${DROPBOX_REDIRECT_PORT}/callback`;

const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';
const AUTHORIZE = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const EXPIRY_MARGIN_MS = 60_000;

export type FetchFn = typeof fetch;

/** The refresh token is gone or revoked: the user has to sign in again. */
export class DropboxAuthError extends Error {}

const b64url = (buf: Buffer): string => buf.toString('base64url');

export function pkcePair(verifier: string = b64url(randomBytes(64))): { verifier: string; challenge: string } {
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export function authorizeUrl(appKey: string, challenge: string, state: string): string {
  const q = new URLSearchParams({
    client_id: appKey,
    response_type: 'code',
    redirect_uri: DROPBOX_REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    token_access_type: 'offline',
    state,
  });
  return `${AUTHORIZE}?${q.toString()}`;
}

interface TokenReply {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}

async function tokenRequest(fetchFn: FetchFn, body: Record<string, string>): Promise<TokenReply> {
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const data = (await res.json().catch(() => ({}))) as TokenReply;
  if (!res.ok || !data.access_token) {
    const msg = `Dropbox sign-in failed (${res.status}${data.error ? `: ${data.error}` : ''})`;
    throw res.status === 400 || res.status === 401 ? new DropboxAuthError(msg) : new Error(msg);
  }
  return data;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export async function exchangeCode(
  fetchFn: FetchFn,
  appKey: string,
  code: string,
  verifier: string,
  now: () => number = Date.now,
): Promise<Tokens> {
  const t = await tokenRequest(fetchFn, {
    grant_type: 'authorization_code',
    code,
    client_id: appKey,
    redirect_uri: DROPBOX_REDIRECT_URI,
    code_verifier: verifier,
  });
  if (!t.refresh_token) throw new Error('Dropbox did not return a refresh token.');
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: now() + (t.expires_in ?? 0) * 1000 };
}

/** Hands out a valid access token, refreshing it from the stored refresh token when it is about to expire. */
export function tokenProvider(
  fetchFn: FetchFn,
  appKey: string,
  refreshToken: string,
  now: () => number = Date.now,
): () => Promise<string> {
  let cached: { token: string; expiresAt: number } | undefined;
  return async () => {
    if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > now()) return cached.token;
    const t = await tokenRequest(fetchFn, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: appKey,
    });
    cached = { token: t.access_token, expiresAt: now() + (t.expires_in ?? 0) * 1000 };
    return cached.token;
  };
}

/**
 * Listens once on the loopback address for Dropbox's redirect and returns the authorisation code.
 * `onListening` runs when the port is open, so the browser is opened only after the server can answer.
 */
export function waitForAuthCode(
  state: string,
  onListening: () => void,
  opts: { timeoutMs?: number; signal?: AbortSignal; port?: number } = {},
): Promise<string> {
  const { timeoutMs = 3 * 60_000, signal, port = DROPBOX_REDIRECT_PORT } = opts;
  return new Promise<string>((resolve, reject) => {
    let finished = false;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const ok = code !== null && url.searchParams.get('state') === state;
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        ok ? 'Signed in. You can close this tab and return to VS Code.' : 'Sign-in was refused or did not match.',
      );
      finish(ok ? undefined : new DropboxAuthError('Dropbox sign-in was refused.'), code ?? undefined);
    });
    const timer = setTimeout(() => {
      finish(new Error('Dropbox sign-in timed out.'));
    }, timeoutMs);
    const onAbort = () => {
      finish(new Error('Dropbox sign-in was cancelled.'));
    };
    signal?.addEventListener('abort', onAbort);

    function finish(err?: Error, code?: string): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      server.close();
      if (err || !code) reject(err ?? new Error('No code received.'));
      else resolve(code);
    }

    server.once('error', (e: NodeJS.ErrnoException) => {
      finish(
        new Error(
          e.code === 'EADDRINUSE'
            ? `Port ${port} is busy (another sign-in running?). Try again in a minute.`
            : `Cannot listen for the Dropbox sign-in: ${e.message}`,
        ),
      );
    });
    server.listen(port, '127.0.0.1', onListening);
  });
}

/** Browser sign-in (OAuth code + PKCE). `openUrl` opens the address in the user's browser. */
export async function signIn(
  fetchFn: FetchFn,
  openUrl: (url: string) => void,
  opts: { appKey?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Tokens> {
  const appKey = opts.appKey ?? DROPBOX_APP_KEY;
  const { verifier, challenge } = pkcePair();
  const state = b64url(randomBytes(16));
  const code = await waitForAuthCode(
    state,
    () => {
      openUrl(authorizeUrl(appKey, challenge, state));
    },
    opts,
  );
  return exchangeCode(fetchFn, appKey, code, verifier);
}

/** Dropbox-API-Arg is an HTTP header: non-ASCII characters must travel as \u escapes. */
const headerJson = (v: unknown): string =>
  JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

export interface RemoteFile {
  /** Path relative to the app folder, `/`-separated, no leading slash. */
  rel: string;
  size: number;
}

export class DropboxClient {
  constructor(
    private readonly fetchFn: FetchFn,
    private readonly token: () => Promise<string>,
  ) {}

  private async call(url: string, init: { headers?: Record<string, string>; body?: BodyInit }): Promise<Response> {
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.token()}`, ...init.headers },
      body: init.body,
    });
    if (res.status === 401) throw new DropboxAuthError('Dropbox rejected the sign-in. Sign in again.');
    return res;
  }

  private async rpc(endpoint: string, body: unknown): Promise<Response> {
    return this.call(`${API}/${endpoint}`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async failure(what: string, res: Response): Promise<Error> {
    return new Error(`Dropbox ${what} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  async list(): Promise<RemoteFile[]> {
    const files: RemoteFile[] = [];
    let res = await this.rpc('files/list_folder', { path: '', recursive: true, limit: 2000 });
    for (;;) {
      if (!res.ok) throw await this.failure('listing', res);
      const page = (await res.json()) as {
        entries: { '.tag': string; path_display: string; size?: number }[];
        has_more: boolean;
        cursor: string;
      };
      for (const e of page.entries)
        if (e['.tag'] === 'file') files.push({ rel: e.path_display.replace(/^\//, ''), size: e.size ?? 0 });
      if (!page.has_more) return files;
      res = await this.rpc('files/list_folder/continue', { cursor: page.cursor });
    }
  }

  async download(rel: string): Promise<Buffer> {
    const res = await this.call(`${CONTENT}/files/download`, {
      headers: { 'dropbox-api-arg': headerJson({ path: `/${rel}` }) },
    });
    if (!res.ok) throw await this.failure(`download of ${rel}`, res);
    return Buffer.from(await res.arrayBuffer());
  }

  async upload(rel: string, data: Buffer): Promise<void> {
    const res = await this.call(`${CONTENT}/files/upload`, {
      headers: {
        'dropbox-api-arg': headerJson({ path: `/${rel}`, mode: 'overwrite', mute: true }),
        'content-type': 'application/octet-stream',
      },
      body: new Uint8Array(data),
    });
    if (!res.ok) throw await this.failure(`upload of ${rel}`, res);
  }

  async remove(rel: string): Promise<void> {
    const res = await this.rpc('files/delete_v2', { path: `/${rel}` });
    if (res.ok || res.status === 409) return; // 409 = already gone
    throw await this.failure(`delete of ${rel}`, res);
  }
}

const isHidden = (name: string): boolean => name.startsWith('.');

/** Every regular file under `dir`, as `/`-separated paths relative to it; hidden files (tmp copies) are skipped. */
function walk(dir: string, base = ''): RemoteFile[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (isHidden(e.name)) return [];
    const rel = base ? `${base}/${e.name}` : e.name;
    return e.isDirectory()
      ? walk(path.join(dir, e.name), rel)
      : [{ rel, size: fs.statSync(path.join(dir, e.name)).size }];
  });
}

function pruneEmptyDirs(dir: string, isRoot = true): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) pruneEmptyDirs(path.join(dir, e.name), false);
  }
  if (!isRoot && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

/**
 * Dropbox's app folder, mirrored into a local cache that the rest of the extension reads and writes like any
 * folder. `refresh` makes the cache equal to Dropbox; `publish` uploads what changed in it and deletes what is gone.
 */
export class DropboxTransport implements Transport {
  private remote = new Map<string, number>();

  constructor(
    readonly root: string,
    private readonly client: DropboxClient,
  ) {}

  async refresh(): Promise<void> {
    fs.mkdirSync(this.root, { recursive: true });
    const listed = await this.client.list();
    this.remote = new Map(listed.map((f) => [f.rel, f.size]));
    for (const f of listed) {
      const local = path.join(this.root, ...f.rel.split('/'));
      if (fs.existsSync(local) && fs.statSync(local).size === f.size) continue;
      const data = await this.client.download(f.rel);
      fs.mkdirSync(path.dirname(local), { recursive: true });
      const tmp = path.join(path.dirname(local), `.${path.basename(local)}.tmp-${process.pid}`);
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, local);
    }
    for (const f of walk(this.root)) {
      if (!this.remote.has(f.rel)) fs.rmSync(path.join(this.root, ...f.rel.split('/')));
    }
    pruneEmptyDirs(this.root);
  }

  async publish(): Promise<boolean> {
    const local = walk(this.root);
    const localRels = new Set(local.map((f) => f.rel));
    let changed = false;
    for (const f of local) {
      if (this.remote.get(f.rel) === f.size) continue;
      await this.client.upload(f.rel, fs.readFileSync(path.join(this.root, ...f.rel.split('/'))));
      this.remote.set(f.rel, f.size);
      changed = true;
    }
    for (const rel of [...this.remote.keys()]) {
      if (localRels.has(rel)) continue;
      await this.client.remove(rel);
      this.remote.delete(rel);
      changed = true;
    }
    return changed;
  }
}
