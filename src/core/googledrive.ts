import { FetchFn, OAuthConfig, TokenFn } from './oauth';
import { CloudAuthError, RemoteFile, RemoteStore } from './remote';

/**
 * The «Session Sync for Claude Code» Google Cloud OAuth client (type «Desktop app»). The id is public.
 * Google asks desktop apps to send a «secret» too, but does not treat it as confidential (it ships inside every
 * installed copy). It is kept out of the repository anyway: `scripts/build.mjs` compiles it in from the
 * environment, so a build without it simply hides the Google Drive method.
 */
export const GOOGLE_CLIENT_ID = '308826107962-17u1qhsb2aarp24411t1q4553scrpga2.apps.googleusercontent.com';

declare const __GOOGLE_CLIENT_SECRET__: string | undefined;
export const GOOGLE_CLIENT_SECRET: string =
  typeof __GOOGLE_CLIENT_SECRET__ === 'string' ? __GOOGLE_CLIENT_SECRET__ : '';
export const GOOGLE_REDIRECT_URI = 'http://127.0.0.1:53684/callback';

/** Only the app's own hidden folder: the app cannot see anything else in the user's Drive. */
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export const googleOAuth = (clientId: string, clientSecret: string): OAuthConfig => ({
  clientId,
  redirectUri: GOOGLE_REDIRECT_URI,
  tokenUrl: 'https://oauth2.googleapis.com/token',
  tokenParams: { client_secret: clientSecret },
  authorizeUrl: (challenge, state) =>
    `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: GOOGLE_REDIRECT_URI,
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      // Without these Google hands out a refresh token only on the very first sign-in.
      access_type: 'offline',
      prompt: 'consent',
      state,
    }).toString()}`,
});

interface DriveFile {
  id: string;
  name: string;
  /** Google sends sizes as strings. */
  size?: string;
}

/**
 * Drive's app data folder has no paths, only a flat list of files: the file name is the whole relative path
 * (`devices/laptop/projects/p/s.jsonl`), which Drive accepts as a plain name.
 */
export class GoogleDriveClient implements RemoteStore {
  /** name → id, refreshed by every `list()`. */
  private ids = new Map<string, string>();

  constructor(
    private readonly fetchFn: FetchFn,
    private readonly token: TokenFn,
  ) {}

  private async call(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: BodyInit },
  ): Promise<Response> {
    const send = async (fresh: boolean) =>
      this.fetchFn(url, {
        ...init,
        headers: { authorization: `Bearer ${await this.token({ fresh })}`, ...init.headers },
      });
    // An access token can be revoked before it expires: get a new one and try once more before asking to sign in.
    let res = await send(false);
    if (res.status === 401) res = await send(true);
    if (res.status === 401) throw new CloudAuthError('Google Drive rejected the sign-in. Sign in again.');
    return res;
  }

  private async failure(what: string, res: Response): Promise<Error> {
    return new Error(`Google Drive ${what} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  async list(): Promise<RemoteFile[]> {
    const ids = new Map<string, string>();
    const files: RemoteFile[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({
        spaces: 'appDataFolder',
        fields: 'nextPageToken,files(id,name,size)',
        pageSize: '1000',
        orderBy: 'modifiedTime desc',
      });
      if (pageToken) q.set('pageToken', pageToken);
      const res = await this.call(`${API}/files?${q.toString()}`, {});
      if (!res.ok) throw await this.failure('listing', res);
      const page = (await res.json()) as { files: DriveFile[]; nextPageToken?: string };
      for (const f of page.files) {
        // Two files with one name can exist: the newest wins (the list is newest first).
        if (ids.has(f.name)) continue;
        ids.set(f.name, f.id);
        files.push({ rel: f.name, size: Number(f.size ?? 0) });
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    this.ids = ids;
    return files;
  }

  async download(rel: string): Promise<Buffer> {
    const id = this.ids.get(rel);
    if (!id) throw new Error(`Google Drive download of ${rel} failed: not in the last listing`);
    const res = await this.call(`${API}/files/${id}?alt=media`, {});
    if (!res.ok) throw await this.failure(`download of ${rel}`, res);
    return Buffer.from(await res.arrayBuffer());
  }

  async upload(rel: string, data: Buffer): Promise<void> {
    const id = this.ids.get(rel);
    // A resumable upload takes the whole body in one request: first the metadata, then the bytes.
    const start = await this.call(
      id ? `${UPLOAD}/files/${id}?uploadType=resumable` : `${UPLOAD}/files?uploadType=resumable&fields=id`,
      {
        method: id ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json; charset=UTF-8' },
        body: JSON.stringify(id ? {} : { name: rel, parents: ['appDataFolder'] }),
      },
    );
    if (!start.ok) throw await this.failure(`upload of ${rel}`, start);
    const location = start.headers.get('location');
    if (!location) throw new Error(`Google Drive upload of ${rel} failed: no upload address`);
    // The upload address is pre-authorised.
    const res = await this.fetchFn(location, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(data),
    });
    if (!res.ok) throw await this.failure(`upload of ${rel}`, res);
    if (!id) this.ids.set(rel, ((await res.json()) as { id: string }).id);
  }

  async remove(rel: string): Promise<void> {
    const id = this.ids.get(rel);
    if (!id) return; // not in the last listing: already gone
    const res = await this.call(`${API}/files/${id}`, { method: 'DELETE' });
    if (res.ok || res.status === 404) {
      this.ids.delete(rel);
      return;
    }
    throw await this.failure(`delete of ${rel}`, res);
  }
}
