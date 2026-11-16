import { GitEnv } from './git';

export const SYNC_REPO_NAME = 'claude-sessions';
const API = 'https://api.github.com';

export class PublicRepoError extends Error {}

type Fetch = typeof fetch;

/** Authenticates git over https through the environment, so the token is in no URL, config file or argv. */
export function githubAuthEnv(token: string): GitEnv {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraheader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

interface Repo {
  clone_url: string;
  private: boolean;
}

/**
 * The signed-in user's private `claude-sessions` repository, created on first use.
 * An existing repository that is NOT private is refused: transcripts may hold secrets.
 */
export async function ensurePrivateRepo(token: string, fetchFn: Fetch = fetch): Promise<{ cloneUrl: string }> {
  const call = async (path: string, init?: { method: string; body: string }) => {
    const res = await fetchFn(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'session-sync-for-claude-code',
        ...(init ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    return res;
  };

  const me = await call('/user');
  if (!me.ok) throw new Error(`GitHub: cannot read the account (HTTP ${me.status}).`);
  const { login } = (await me.json()) as { login: string };

  const existing = await call(`/repos/${login}/${SYNC_REPO_NAME}`);
  if (existing.ok) {
    const repo = (await existing.json()) as Repo;
    if (!repo.private) {
      throw new PublicRepoError(
        `${login}/${SYNC_REPO_NAME} is PUBLIC. Make it private, or pick another sync method: transcripts may contain secrets.`,
      );
    }
    return { cloneUrl: repo.clone_url };
  }
  if (existing.status !== 404)
    throw new Error(`GitHub: cannot read ${login}/${SYNC_REPO_NAME} (HTTP ${existing.status}).`);

  const created = await call('/user/repos', {
    method: 'POST',
    body: JSON.stringify({
      name: SYNC_REPO_NAME,
      private: true,
      description: 'Claude Code session transcripts (created by the Session Sync for Claude Code extension)',
    }),
  });
  if (!created.ok) throw new Error(`GitHub: cannot create ${SYNC_REPO_NAME} (HTTP ${created.status}).`);
  const repo = (await created.json()) as Repo;
  if (!repo.private) throw new PublicRepoError('GitHub created a non-private repository; refusing to use it.');
  return { cloneUrl: repo.clone_url };
}

/** `owner/repo` of a github.com address (https, ssh or git@), or undefined for any other host. */
export function githubSlug(repoUrl: string): string | undefined {
  const m = repoUrl
    .trim()
    .match(/^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1] ?? ''}/${m[2] ?? ''}` : undefined;
}

/**
 * True only when GitHub itself says a repository is public: asked without a token, a private one answers 404. Any
 * failure to ask (no network, rate limit) is «not known» and never blocks a push.
 */
export async function isPublicGithubRepo(repoUrl: string, fetchFn: Fetch = fetch): Promise<boolean> {
  const slug = githubSlug(repoUrl);
  if (!slug) return false;
  try {
    const res = await fetchFn(`${API}/repos/${slug}`, { headers: { Accept: 'application/vnd.github+json' } });
    if (res.status !== 200) return false;
    return ((await res.json()) as { private?: boolean }).private === false;
  } catch {
    return false;
  }
}
