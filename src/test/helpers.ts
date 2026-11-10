import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'css-'));

export const write = (dir: string, name: string, content: string): void => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
};

export const read = (dir: string, name: string): string => fs.readFileSync(path.join(dir, name), 'utf8');

export function bareRepo(): string {
  const dir = path.join(tmp(), 'remote.git');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', dir]);
  return dir;
}

export const userLine = (text: string): string => `${JSON.stringify({ type: 'user', message: { content: text } })}\n`;
