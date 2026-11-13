import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const TIMEOUT_MS = 120_000;

/** Never prompt (a hidden prompt would hang the extension host) and never run `ext::` transports. */
const SAFE_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
const SAFE_FLAGS = ['-c', 'protocol.ext.allow=never'];

/** https, ssh, scp-style (`git@host:owner/repo`) or an absolute local path. Never something git could read as an option. */
const REPO_URL = /^(https:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:|\/)[^\s]+$/;

export function isValidRepoUrl(url: string): boolean {
  return !url.startsWith('-') && REPO_URL.test(url);
}

/** `extraEnv` carries credentials (never on the command line, where `ps` would show them). */
export type GitEnv = Record<string, string>;

export async function git(cwd: string, args: string[], extraEnv: GitEnv = {}): Promise<string> {
  const { stdout } = await run('git', [...SAFE_FLAGS, ...args], {
    cwd,
    env: { ...SAFE_ENV, ...extraEnv },
    timeout: TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

const succeeds = (cwd: string, args: string[], env?: GitEnv) =>
  git(cwd, args, env).then(
    () => true,
    () => false,
  );

/** Clones on first use; afterwards makes sure the remote matches the setting. */
export async function ensureClone(repoDir: string, url: string, env?: GitEnv): Promise<void> {
  if (!isValidRepoUrl(url)) throw new Error(`Unsupported repository URL: ${url}`);
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    fs.mkdirSync(repoDir, { recursive: true });
    await git(repoDir, ['clone', '--', url, '.'], env);
    return;
  }
  if ((await git(repoDir, ['remote', 'get-url', 'origin'])) !== url) {
    await git(repoDir, ['remote', 'set-url', 'origin', url]);
  }
}

/** Brings the clone up to date, including the case where it was cloned empty and the remote got its first branch later. */
export async function pullRepo(repoDir: string, env?: GitEnv): Promise<void> {
  if (await succeeds(repoDir, ['rev-parse', '--verify', 'HEAD'])) {
    await git(repoDir, ['pull', '--rebase', '--autostash'], env);
    return;
  }
  const head = await git(repoDir, ['ls-remote', '--symref', 'origin', 'HEAD'], env);
  const branch = head.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)?.[1];
  if (!branch) return; // The remote is still empty: nothing to pull.
  await git(repoDir, ['fetch', 'origin'], env);
  await git(repoDir, ['checkout', '-B', branch, `origin/${branch}`]);
}

async function identityArgs(repoDir: string): Promise<string[]> {
  const has = async (key: string) => (await git(repoDir, ['config', key]).catch(() => '')) !== '';
  const args: string[] = [];
  if (!(await has('user.name'))) args.push('-c', 'user.name=Claude Session Sync');
  if (!(await has('user.email'))) args.push('-c', 'user.email=claude-session-sync@localhost');
  return args;
}

/** Commits not on the remote yet: a push that failed earlier (network, a lost race) left them behind. */
async function hasUnpushed(repoDir: string): Promise<boolean> {
  if (!(await succeeds(repoDir, ['rev-parse', '--verify', 'HEAD']))) return false;
  const ahead = await git(repoDir, ['rev-list', '--count', '@{u}..HEAD']).catch(() => undefined);
  return ahead === undefined || Number(ahead) > 0; // no upstream yet: the branch was never pushed
}

/** Returns false when there was nothing to commit and nothing left unpushed. */
export async function commitAndPush(repoDir: string, message: string, env?: GitEnv): Promise<boolean> {
  await git(repoDir, ['add', '-A']);
  if (await git(repoDir, ['status', '--porcelain'])) {
    await git(repoDir, [...(await identityArgs(repoDir)), 'commit', '-m', message]);
  } else if (!(await hasUnpushed(repoDir))) {
    return false;
  }
  await git(repoDir, ['push', '-u', 'origin', 'HEAD'], env);
  return true;
}

export const remoteOf = (dir: string): Promise<string | undefined> =>
  git(dir, ['remote', 'get-url', 'origin']).then(
    (u) => u,
    () => undefined,
  );
