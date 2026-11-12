import * as os from 'node:os';
import * as path from 'node:path';

/** Claude Code names a project dir after the workspace path: every non-alphanumeric char becomes «-». */
export function encodeProjectDir(workspacePath: string): string {
  return workspacePath.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Stable cross-device key: the git remote slug (`owner/repo`), else the folder name. */
export function projectKey(remoteUrl: string | undefined, workspacePath: string): string {
  const slug = remoteUrl?.trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/)?.[1];
  return (slug ?? path.basename(workspacePath)).replace(/[^a-zA-Z0-9._-]+/g, '_');
}

/** Claude Code's own folder: the setting, else `CLAUDE_CONFIG_DIR` (which Claude Code honours), else `~/.claude`. */
export function claudeProjectsDir(claudeDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = claudeDir || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

/** A key typed by the user (for projects without a git remote or with different remotes): made safe for a folder name. */
export function sanitizeProjectKey(raw: string): string {
  return raw
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^[._]+/, '');
}
