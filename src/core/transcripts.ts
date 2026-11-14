import * as fs from 'node:fs';
import * as path from 'node:path';

/** Only files named like a Claude session id are ever touched (also guards against hostile remote content). */
const SESSION_FILE = /^[0-9a-zA-Z-]+\.jsonl$/;
/** What iCloud Drive leaves instead of a file it has evicted to save space. */
const ICLOUD_PLACEHOLDER = /^\.[0-9a-zA-Z-]+\.jsonl\.icloud$/;
const CHUNK = 64 * 1024;
/** A transcript can be 50+ MB and the picker lists all of them: the title is looked for in the head only. */
const TITLE_SCAN_BYTES = 4 * 1024 * 1024;
/** Likewise the time of the last activity is looked for in the tail only. */
const TAIL_BYTES = 256 * 1024;

export interface CopyOptions {
  /** Bigger files are reported in `tooLarge` and not copied. */
  maxBytes?: number;
  /** Files last modified before this time (ms since epoch) are left out and only counted in `tooOld`. */
  modifiedAfterMs?: number;
  /** Copy only these file names (`<id>.jsonl`); everything else is left alone and not counted. */
  only?: ReadonlySet<string>;
  /** Leave these file names out entirely (the user chose not to send them). */
  exclude?: ReadonlySet<string>;
  /** Decide only: report what would be copied without writing anything. */
  dryRun?: boolean;
}

export interface CopyResult {
  copied: string[];
  /** Already up to date, or the destination is further along than the source. */
  skipped: string[];
  /** Both sides diverged (the session was continued on two devices): nothing is overwritten. */
  conflicts: string[];
  /** Over `maxBytes`: never copied, always reported. */
  tooLarge: string[];
  /** Number of files older than `modifiedAfterMs`: the long tail of history, left out without a list. */
  tooOld: number;
  /** iCloud placeholders (`.<name>.icloud`): the file exists in the folder but has not been downloaded yet. */
  notDownloaded: number;
  /** Could not be read or written (locked, removed in the meantime, no permission): the rest was still copied. */
  failed: string[];
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
  // Hidden, so a cloud-synced folder never shows a half-written file under a real session name.
  const tmp = path.join(path.dirname(to), `.${path.basename(to)}.tmp-${process.pid}`);
  fs.copyFileSync(from, tmp);
  fs.renameSync(tmp, to);
}

/**
 * Transcripts are append-only, so a longer file that starts with the shorter one is the more
 * complete version: that is the only case that overwrites. Diverged files are reported, never lost.
 * An old file is left out before it is looked at, so a huge old session is not reported as too large.
 */
export function copyTranscripts(src: string, dst: string, options: CopyOptions = {}): CopyResult {
  const result: CopyResult = {
    copied: [],
    skipped: [],
    conflicts: [],
    tooLarge: [],
    tooOld: 0,
    notDownloaded: 0,
    failed: [],
  };
  if (!fs.existsSync(src)) return result;
  const copy = (from: string, to: string): void => {
    if (options.dryRun) return;
    fs.mkdirSync(dst, { recursive: true });
    atomicCopy(from, to);
  };
  for (const name of fs.readdirSync(src)) {
    if (ICLOUD_PLACEHOLDER.test(name)) result.notDownloaded++;
    if (!SESSION_FILE.test(name) || (options.only && !options.only.has(name)) || options.exclude?.has(name)) continue;
    try {
      copyOne(name);
    } catch {
      result.failed.push(name);
    }
  }
  return result;

  function copyOne(name: string): void {
    const from = path.join(src, name);
    const to = path.join(dst, name);
    const stat = fs.statSync(from);
    if (!stat.isFile()) return; // a folder that happens to be named like a session
    if (stat.size === 0) return; // Claude leaves empty session files behind: nothing to sync
    if (options.modifiedAfterMs !== undefined && stat.mtimeMs < options.modifiedAfterMs) {
      result.tooOld++;
    } else if (options.maxBytes !== undefined && stat.size > options.maxBytes) {
      result.tooLarge.push(name);
    } else if (!fs.existsSync(to)) {
      copy(from, to);
      result.copied.push(name);
    } else if (stat.size > fs.statSync(to).size && isPrefix(to, from)) {
      copy(from, to);
      result.copied.push(name);
    } else if (isPrefix(from, to)) {
      result.skipped.push(name);
    } else {
      result.conflicts.push(name);
    }
  }
}

export type SessionStatus = 'new' | 'updated' | 'same' | 'conflict';

/** What copying `from` onto `to` would do: the same decision `copyTranscripts` makes, without doing it. */
export function sessionStatus(from: string, to: string): SessionStatus {
  if (!fs.existsSync(to)) return 'new';
  if (fs.statSync(from).size > fs.statSync(to).size && isPrefix(to, from)) return 'updated';
  return isPrefix(from, to) ? 'same' : 'conflict';
}

export interface SessionInfo {
  id: string;
  /** Size of the transcript in bytes. */
  bytes: number;
  title: string;
  /** Time (ms since epoch) of the newest entry in the transcript. */
  lastActivity: number;
}

interface Block {
  type: string;
  text?: string;
}

interface Entry {
  type?: string;
  timestamp?: unknown;
  message?: { content?: string | Block[] };
}

/** Complete lines from the start of a file, reading at most `limitBytes`; a line cut by the limit is not yielded. */
function* headLines(file: string, limitBytes: number): Generator<string> {
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(CHUNK);
    let pending = Buffer.alloc(0);
    let offset = 0;
    while (offset < limitBytes) {
      const n = fs.readSync(fd, chunk, 0, CHUNK, offset);
      if (n === 0) {
        if (pending.length) yield pending.toString('utf8'); // the last line has no trailing newline
        return;
      }
      offset += n;
      pending = Buffer.concat([pending, chunk.subarray(0, n)]);
      // A newline byte never occurs inside a multi-byte UTF-8 sequence, so splitting on bytes is safe.
      for (let nl = pending.indexOf(0x0a); nl !== -1; nl = pending.indexOf(0x0a)) {
        yield pending.subarray(0, nl).toString('utf8');
        pending = pending.subarray(nl + 1);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** The user's own words: IDE context and system reminders start with «<» and are not a title. */
function promptText(content: string | Block[] | undefined): string | undefined {
  if (typeof content === 'string') return content.startsWith('<') ? undefined : content;
  for (const block of content ?? []) {
    if (block.type === 'text' && block.text && !block.text.startsWith('<')) return block.text;
  }
  return undefined;
}

/** First real user prompt of a transcript: the title shown in the picker. */
export function readTitle(file: string): string {
  for (const line of headLines(file, TITLE_SCAN_BYTES)) {
    try {
      const entry = JSON.parse(line) as Entry;
      const text = entry.type === 'user' ? promptText(entry.message?.content) : undefined;
      if (text) return text.replace(/\s+/g, ' ').slice(0, 80);
    } catch {
      // Not valid JSON, e.g. a torn last line while a session is still being written.
    }
  }
  return '(no prompt)';
}

/**
 * When the session was last worked on: the newest entry that carries a timestamp. A pulled file's mtime
 * is the pull time and the very last entry of a transcript is a statistics record without one.
 */
export function lastActivity(file: string, stat: fs.Stats): number {
  const length = Math.min(TAIL_BYTES, stat.size);
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, length, stat.size - length);
  } finally {
    fs.closeSync(fd);
  }
  const lines = buf.toString('utf8').split('\n');
  const first = stat.size > length ? 1 : 0; // a window that starts mid-file starts mid-line: drop that line
  for (let i = lines.length - 1; i >= first; i--) {
    try {
      const { timestamp } = JSON.parse(lines[i] ?? '') as Entry;
      const time = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN;
      if (!Number.isNaN(time)) return time;
    } catch {
      // Torn or non-JSON line: keep looking backwards.
    }
  }
  return stat.mtimeMs;
}

export function listSessions(dir: string): SessionInfo[] {
  if (!fs.existsSync(dir)) return [];
  const out: SessionInfo[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!SESSION_FILE.test(name) || name.startsWith('agent-')) continue; // sub-agent logs cannot be resumed
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size === 0) continue; // an empty file is not a session worth resuming
      out.push({
        id: name.slice(0, -'.jsonl'.length),
        bytes: stat.size,
        title: readTitle(file),
        lastActivity: lastActivity(file, stat),
      });
    } catch {
      // unreadable or gone in the meantime: leave it out of the list
    }
  }
  return out.sort((a, b) => b.lastActivity - a.lastActivity);
}
