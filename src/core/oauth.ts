import { createHash, randomBytes } from 'node:crypto';
import * as http from 'node:http';
import { CloudAuthError } from './remote';

export type FetchFn = typeof fetch;

const EXPIRY_MARGIN_MS = 60_000;

/** One cloud service's OAuth settings (authorisation code + PKCE, answered on a loopback address). */
export interface OAuthConfig {
  clientId: string;
  /** Full address of the sign-in page in the browser. */
  authorizeUrl: (challenge: string, state: string) => string;
  tokenUrl: string;
  /** Where the browser is sent back to: a loopback address registered with the service. */
  redirectUri: string;
  /** Sent with every token request (scope, client secret…). */
  tokenParams?: Record<string, string>;
}

const b64url = (buf: Buffer): string => buf.toString('base64url');

export const randomState = (): string => b64url(randomBytes(16));

export function pkcePair(verifier: string = b64url(randomBytes(64))): { verifier: string; challenge: string } {
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

interface TokenReply {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}

async function tokenRequest(fetchFn: FetchFn, cfg: OAuthConfig, params: Record<string, string>): Promise<TokenReply> {
  const res = await fetchFn(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, ...cfg.tokenParams, ...params }).toString(),
  });
  const data = (await res.json().catch(() => ({}))) as TokenReply;
  if (!res.ok || !data.access_token) {
    const msg = `Sign-in failed (${res.status}${data.error ? `: ${data.error}` : ''})`;
    throw res.status === 400 || res.status === 401 ? new CloudAuthError(msg) : new Error(msg);
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
  cfg: OAuthConfig,
  code: string,
  verifier: string,
  now: () => number = Date.now,
): Promise<Tokens> {
  const t = await tokenRequest(fetchFn, cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    code_verifier: verifier,
  });
  if (!t.refresh_token) throw new Error('The service did not return a refresh token.');
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: now() + (t.expires_in ?? 0) * 1000,
  };
}

/**
 * Hands out a valid access token, refreshing it from the stored refresh token when it is about to expire.
 * Some services (Microsoft) rotate the refresh token on every refresh: `onRefreshToken` stores the new one.
 */
export function tokenProvider(
  fetchFn: FetchFn,
  cfg: OAuthConfig,
  refreshToken: string,
  onRefreshToken: (token: string) => void | Promise<void> = () => undefined,
  now: () => number = Date.now,
): () => Promise<string> {
  let current = refreshToken;
  let cached: { token: string; expiresAt: number } | undefined;
  return async () => {
    if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > now()) return cached.token;
    const t = await tokenRequest(fetchFn, cfg, { grant_type: 'refresh_token', refresh_token: current });
    if (t.refresh_token && t.refresh_token !== current) {
      current = t.refresh_token;
      await onRefreshToken(current);
    }
    cached = { token: t.access_token, expiresAt: now() + (t.expires_in ?? 0) * 1000 };
    return cached.token;
  };
}

/**
 * Listens once on the loopback address of `redirectUri` and returns the authorisation code.
 * `onListening` runs when the port is open, so the browser is opened only after the server can answer.
 */
export function waitForAuthCode(
  state: string,
  redirectUri: string,
  onListening: () => void,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const { timeoutMs = 3 * 60_000, signal } = opts;
  const target = new URL(redirectUri);
  const port = Number(target.port);
  // `localhost` may reach the browser as IPv4 or IPv6: answer on both.
  const hosts = target.hostname === 'localhost' ? ['127.0.0.1', '::1'] : [target.hostname];

  return new Promise<string>((resolve, reject) => {
    let finished = false;
    const servers: http.Server[] = [];

    const handler: http.RequestListener = (req, res) => {
      const url = new URL(req.url ?? '/', redirectUri);
      if (url.pathname !== target.pathname) {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      // Anything on the machine can call this port: a request without our state is not the browser's answer, so it
      // must not end the sign-in the user is still finishing.
      if (url.searchParams.get('state') !== state) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('This sign-in link is not current.');
        return;
      }
      const ok = code !== null;
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        ok ? 'Signed in. You can close this tab and return to VS Code.' : 'Sign-in was refused or did not match.',
      );
      finish(ok ? undefined : new CloudAuthError('Sign-in was refused.'), code ?? undefined);
    };

    const timer = setTimeout(() => {
      finish(new Error('Sign-in timed out.'));
    }, timeoutMs);
    const onAbort = () => {
      finish(new Error('Sign-in was cancelled.'));
    };
    signal?.addEventListener('abort', onAbort);

    function finish(err?: Error, code?: string): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      for (const s of servers) {
        s.close();
        s.closeAllConnections(); // a browser's keep-alive would hold the port until it times out
      }
      if (err || !code) reject(err ?? new Error('No code received.'));
      else resolve(code);
    }

    hosts.forEach((host, i) => {
      const server = http.createServer(handler);
      servers.push(server);
      server.once('error', (e: NodeJS.ErrnoException) => {
        if (i > 0) return; // the second address (IPv6) may simply not exist
        finish(
          new Error(
            e.code === 'EADDRINUSE'
              ? `Port ${port} is busy (another sign-in running?). Try again in a minute.`
              : `Cannot listen for the sign-in: ${e.message}`,
          ),
        );
      });
      server.listen(port, host, i === 0 ? onListening : undefined);
    });
  });
}

/** Browser sign-in (OAuth code + PKCE). `openUrl` opens the address in the user's browser. */
export async function signIn(
  fetchFn: FetchFn,
  cfg: OAuthConfig,
  openUrl: (url: string) => void,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Tokens> {
  const { verifier, challenge } = pkcePair();
  const state = randomState();
  const code = await waitForAuthCode(
    state,
    cfg.redirectUri,
    () => {
      openUrl(cfg.authorizeUrl(challenge, state));
    },
    opts,
  );
  return exchangeCode(fetchFn, cfg, code, verifier);
}
