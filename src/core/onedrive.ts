import { FetchFn, OAuthConfig, TokenFn } from './oauth';
import { CloudAuthError, RemoteFile, RemoteStore } from './remote';

/** Public identifier of the «Session Sync for Claude Code» Microsoft app (Files.ReadWrite.AppFolder: `Apps/<name>`). */
export const ONEDRIVE_CLIENT_ID = 'd29e1be7-3a3c-4401-bded-d0f3cb02c692';
/** Microsoft matches loopback redirects by host and path and ignores the port. */
export const ONEDRIVE_REDIRECT_URI = 'http://localhost:53683';
const SCOPE = 'Files.ReadWrite.AppFolder offline_access';
const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0/me/drive/special/approot';

/** A single PUT is limited to 4 MB; bigger files go through an upload session in chunks (a multiple of 320 KiB). */
export const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
export const CHUNK = 10 * 320 * 1024;

export const onedriveOAuth: OAuthConfig = {
  clientId: ONEDRIVE_CLIENT_ID,
  redirectUri: ONEDRIVE_REDIRECT_URI,
  tokenUrl: `${AUTHORITY}/token`,
  tokenParams: { scope: SCOPE },
  authorizeUrl: (challenge, state) =>
    `${AUTHORITY}/authorize?${new URLSearchParams({
      client_id: ONEDRIVE_CLIENT_ID,
      response_type: 'code',
      redirect_uri: ONEDRIVE_REDIRECT_URI,
      response_mode: 'query',
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
      state,
    }).toString()}`,
};

const encodePath = (rel: string): string => rel.split('/').map(encodeURIComponent).join('/');
const itemUrl = (rel: string): string => `${GRAPH}:/${encodePath(rel)}:`;

interface Item {
  name: string;
  size?: number;
  folder?: unknown;
}
interface Page {
  value: Item[];
  '@odata.nextLink'?: string;
}

export class OneDriveClient implements RemoteStore {
  constructor(
    private readonly fetchFn: FetchFn,
    private readonly token: TokenFn,
  ) {}

  private async call(url: string, init: { method: string; headers?: Record<string, string>; body?: BodyInit }) {
    const send = async (fresh: boolean) =>
      this.fetchFn(url, {
        ...init,
        headers: { authorization: `Bearer ${await this.token({ fresh })}`, ...init.headers },
      });
    // An access token can be revoked before it expires: get a new one and try once more before asking to sign in.
    let res = await send(false);
    if (res.status === 401) res = await send(true);
    if (res.status === 401) throw new CloudAuthError('OneDrive rejected the sign-in. Sign in again.');
    return res;
  }

  private async failure(what: string, res: Response): Promise<Error> {
    return new Error(`OneDrive ${what} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  async list(): Promise<RemoteFile[]> {
    const out: RemoteFile[] = [];
    await this.walk('', out);
    return out;
  }

  private async walk(rel: string, out: RemoteFile[]): Promise<void> {
    let url: string | undefined = `${rel ? itemUrl(rel) : GRAPH}/children?$top=200`;
    while (url) {
      const res = await this.call(url, { method: 'GET' });
      if (res.status === 404) return;
      if (!res.ok) throw await this.failure('listing', res);
      const page = (await res.json()) as Page;
      for (const item of page.value) {
        const childRel = rel ? `${rel}/${item.name}` : item.name;
        if (item.folder) await this.walk(childRel, out);
        else out.push({ rel: childRel, size: item.size ?? 0 });
      }
      url = page['@odata.nextLink'];
    }
  }

  async download(rel: string): Promise<Buffer> {
    const res = await this.call(`${itemUrl(rel)}/content`, { method: 'GET' });
    if (!res.ok) throw await this.failure(`download of ${rel}`, res);
    return Buffer.from(await res.arrayBuffer());
  }

  async upload(rel: string, data: Buffer): Promise<void> {
    if (data.length <= SIMPLE_UPLOAD_MAX) {
      const res = await this.call(`${itemUrl(rel)}/content`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array(data),
      });
      if (!res.ok) throw await this.failure(`upload of ${rel}`, res);
      return;
    }
    const session = await this.call(`${itemUrl(rel)}/createUploadSession`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
    });
    if (!session.ok) throw await this.failure(`upload of ${rel}`, session);
    const { uploadUrl } = (await session.json()) as { uploadUrl: string };
    for (let start = 0; start < data.length; start += CHUNK) {
      const end = Math.min(start + CHUNK, data.length);
      // The upload address is pre-authorised: it must not get the bearer token.
      const res = await this.fetchFn(uploadUrl, {
        method: 'PUT',
        headers: { 'content-range': `bytes ${start}-${end - 1}/${data.length}` },
        body: new Uint8Array(data.subarray(start, end)),
      });
      if (!res.ok) throw await this.failure(`upload of ${rel}`, res);
    }
  }

  async remove(rel: string): Promise<void> {
    const res = await this.call(itemUrl(rel), { method: 'DELETE' });
    if (res.ok || res.status === 404) return;
    throw await this.failure(`delete of ${rel}`, res);
  }
}
