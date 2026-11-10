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

export function claudeProjectsDir(claudeDir: string): string {
  return path.join(claudeDir || path.join(os.homedir(), '.claude'), 'projects');
}
