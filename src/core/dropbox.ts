import { FetchFn, OAuthConfig } from './oauth';
import { CloudAuthError, RemoteFile, RemoteStore } from './remote';

/** Public identifier of the «Session Sync for Claude Code» Dropbox app (App folder access: only `Apps/<name>`). */
export const DROPBOX_APP_KEY = 'tcz24ayn6tqaz80';
export const DROPBOX_REDIRECT_URI = 'http://127.0.0.1:53682/callback';

const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';

export const dropboxOAuth: OAuthConfig = {
  clientId: DROPBOX_APP_KEY,
  redirectUri: DROPBOX_REDIRECT_URI,
  tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
  authorizeUrl: (challenge, state) =>
    `https://www.dropbox.com/oauth2/authorize?${new URLSearchParams({
      client_id: DROPBOX_APP_KEY,
      response_type: 'code',
      redirect_uri: DROPBOX_REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      token_access_type: 'offline',
      state,
    }).toString()}`,
};

/** Dropbox-API-Arg is an HTTP header: non-ASCII characters must travel as \u escapes. */
const headerJson = (v: unknown): string =>
  JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

export class DropboxClient implements RemoteStore {
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
    if (res.status === 401) throw new CloudAuthError('Dropbox rejected the sign-in. Sign in again.');
    return res;
  }

  private rpc(endpoint: string, body: unknown): Promise<Response> {
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
