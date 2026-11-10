import * as fs from 'node:fs';
import * as path from 'node:path';

/** Only files named like a Claude session id are ever touched (also guards against hostile remote content). */
const SESSION_FILE = /^[0-9a-zA-Z-]+\.jsonl$/;
const CHUNK = 64 * 1024;

export interface CopyResult {
  copied: string[];
  /** Already up to date, or the destination is further along than the source. */
  skipped: string[];
  /** Both sides diverged (the session was continued on two devices): nothing is overwritten. */
  conflicts: string[];
}

/** True when the whole of `shorter` is the beginning of `longer` — i.e. `longer` is the same transcript, extended. */
export function isPrefix(shorter: string, longer: string): boolean {
  const size = fs.statSync(shorter).size;
  if (size > fs.statSync(longer).size) return false;
  const a = Buffer.alloc(CHUNK);
  const b = Buffer.alloc(CHUNK);
  const fdA = fs.openSync(shorter, 'r');
  const fdB = fs.openSync(longer, 'r');
  try {
    for (let pos = 0; pos < size; pos += CHUNK) {
      const len = Math.min(CHUNK, size - pos);
      fs.readSync(fdA, a, 0, len, pos);
      fs.readSync(fdB, b, 0, len, pos);
      if (!a.subarray(0, len).equals(b.subarray(0, len))) return false;
    }
    return true;
  } finally {
    fs.closeSync(fdA);
    fs.closeSync(fdB);
  }
}

function atomicCopy(from: string, to: string): void {
  const tmp = `${to}.tmp-${process.pid}`;
  fs.copyFileSync(from, tmp);
  fs.renameSync(tmp, to);
}

/**
 * Transcripts are append-only, so a longer file that starts with the shorter one is the more
 * complete version: that is the only case that overwrites. Diverged files are reported, never lost.
 */
export function copyTranscripts(src: string, dst: string): CopyResult {
  const result: CopyResult = { copied: [], skipped: [], conflicts: [] };
  if (!fs.existsSync(src)) return result;
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (!SESSION_FILE.test(name)) continue;
    const from = path.join(src, name);
    const to = path.join(dst, name);
    if (!fs.existsSync(to)) {
      atomicCopy(from, to);
      result.copied.push(name);
    } else if (fs.statSync(from).size > fs.statSync(to).size && isPrefix(to, from)) {
      atomicCopy(from, to);
      result.copied.push(name);
    } else if (isPrefix(from, to)) {
      result.skipped.push(name);
    } else {
      result.conflicts.push(name);
    }
  }
  return result;
}

export interface SessionInfo {
  id: string;
  title: string;
  mtime: number;
}

interface Entry {
  type?: string;
  message?: { content?: string | { type: string; text?: string }[] };
}

/** First real user prompt of a transcript: the title shown in the picker. */
export function readTitle(file: string): string {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as Entry;
      if (entry.type !== 'user') continue;
      const c = entry.message?.content;
      const text = typeof c === 'string' ? c : c?.find((p) => p.type === 'text')?.text;
      if (text && !text.startsWith('<')) return text.replace(/\s+/g, ' ').slice(0, 80);
    } catch {
      // A torn last line is expected while a session is still being written.
    }
  }
  return '(no prompt)';
}

export function listSessions(dir: string): SessionInfo[] {
  if (!fs.existsSync(dir)) return [];
  const out: SessionInfo[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!SESSION_FILE.test(name)) continue;
    const file = path.join(dir, name);
    out.push({ id: name.slice(0, -'.jsonl'.length), title: readTitle(file), mtime: fs.statSync(file).mtimeMs });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
