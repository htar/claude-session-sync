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

/** `isPrefix` for the copy loop: reads in pieces with awaits in between, so a big transcript does not freeze the editor. */
async function isPrefixAsync(shorter: string, longer: string): Promise<boolean> {
  const size = (await fs.promises.stat(shorter)).size;
  if (size > (await fs.promises.stat(longer)).size) return false;
  const a = Buffer.alloc(CHUNK);
  const b = Buffer.alloc(CHUNK);
  const fdA = await fs.promises.open(shorter, 'r');
  const fdB = await fs.promises.open(longer, 'r');
  try {
    for (let pos = 0; pos < size; pos += CHUNK) {
      const len = Math.min(CHUNK, size - pos);
      await fdA.read(a, 0, len, pos);
      await fdB.read(b, 0, len, pos);
      if (!a.subarray(0, len).equals(b.subarray(0, len))) return false;
    }
    return true;
  } finally {
    await fdA.close();
    await fdB.close();
  }
}

async function atomicCopy(from: string, to: string): Promise<void> {
  // Hidden, so a cloud-synced folder never shows a half-written file under a real session name.
  const tmp = path.join(path.dirname(to), `.${path.basename(to)}.tmp-${process.pid}`);
  await fs.promises.copyFile(from, tmp);
  await fs.promises.rename(tmp, to);
}

/**
 * Transcripts are append-only, so a longer file that starts with the shorter one is the more
 * complete version: that is the only case that overwrites. Diverged files are reported, never lost.
 * An old file is left out before it is looked at, so a huge old session is not reported as too large.
 */
export async function copyTranscripts(src: string, dst: string, options: CopyOptions = {}): Promise<CopyResult> {
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
  const copy = async (from: string, to: string): Promise<void> => {
    if (options.dryRun) return;
    await fs.promises.mkdir(dst, { recursive: true });
    await atomicCopy(from, to);
  };
  for (const name of fs.readdirSync(src)) {
    if (ICLOUD_PLACEHOLDER.test(name)) result.notDownloaded++;
    if (!SESSION_FILE.test(name) || (options.only && !options.only.has(name)) || options.exclude?.has(name)) continue;
    try {
      await copyOne(name);
    } catch {
      result.failed.push(name);
    }
  }
  return result;

  async function copyOne(name: string): Promise<void> {
    const from = path.join(src, name);
    const to = path.join(dst, name);
    const stat = await fs.promises.stat(from);
    if (!stat.isFile()) return; // a folder that happens to be named like a session
    if (stat.size === 0) return; // Claude leaves empty session files behind: nothing to sync
    if (options.modifiedAfterMs !== undefined && stat.mtimeMs < options.modifiedAfterMs) {
      result.tooOld++;
    } else if (options.maxBytes !== undefined && stat.size > options.maxBytes) {
      result.tooLarge.push(name);
    } else if (!fs.existsSync(to)) {
      await copy(from, to);
      result.copied.push(name);
    } else if (stat.size > (await fs.promises.stat(to)).size && (await isPrefixAsync(to, from))) {
      await copy(from, to);
      result.copied.push(name);
    } else if (await isPrefixAsync(from, to)) {
      result.skipped.push(name);
    } else {
      result.conflicts.push(name);
    }
  }
}

export type SessionStatus = 'new' | 'updated' | 'same' | 'conflict';

/** What copying `from` onto `to` would do: the same decision `copyTranscripts` makes, without doing it. */
export async function sessionStatus(from: string, to: string): Promise<SessionStatus> {
  if (!fs.existsSync(to)) return 'new';
  if ((await fs.promises.stat(from)).size > (await fs.promises.stat(to)).size && (await isPrefixAsync(to, from)))
    return 'updated';
  return (await isPrefixAsync(from, to)) ? 'same' : 'conflict';
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

/** Title and last activity per file, valid while its size and modification time stay the same (reading them is the slow part). */
const infoCache = new Map<string, { size: number; mtimeMs: number; title: string; lastActivity: number }>();

export function listSessions(dir: string): SessionInfo[] {
  if (!fs.existsSync(dir)) return [];
  const out: SessionInfo[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!SESSION_FILE.test(name) || name.startsWith('agent-')) continue; // sub-agent logs cannot be resumed
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size === 0) continue; // an empty file is not a session worth resuming
      let info = infoCache.get(file);
      if (info?.size !== stat.size || info.mtimeMs !== stat.mtimeMs) {
        info = {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          title: readTitle(file),
          lastActivity: lastActivity(file, stat),
        };
        infoCache.set(file, info);
      }
      out.push({
        id: name.slice(0, -'.jsonl'.length),
        bytes: stat.size,
        title: info.title,
        lastActivity: info.lastActivity,
      });
    } catch {
      // unreadable or gone in the meantime: leave it out of the list
    }
  }
  return out.sort((a, b) => b.lastActivity - a.lastActivity);
}

/** The folder Claude Code shows a session under: the newest «relocated» record, else the first `cwd` the transcript names. */
export function transcriptCwd(file: string): string | undefined {
  const stat = fs.statSync(file);
  const length = Math.min(TAIL_BYTES, stat.size);
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, length, stat.size - length);
  } finally {
    fs.closeSync(fd);
  }
  const lines = buf.toString('utf8').split('\n');
  const first = stat.size > length ? 1 : 0;
  for (let i = lines.length - 1; i >= first; i--) {
    try {
      const entry = JSON.parse(lines[i] ?? '') as { type?: string; relocatedCwd?: unknown };
      if (entry.type === 'relocated' && typeof entry.relocatedCwd === 'string') return entry.relocatedCwd;
    } catch {
      // torn or non-JSON line
    }
  }
  for (const line of headLines(file, TITLE_SCAN_BYTES)) {
    try {
      const { cwd } = JSON.parse(line) as { cwd?: unknown };
      if (typeof cwd === 'string') return cwd;
    } catch {
      // not JSON
    }
  }
  return undefined;
}

/** Claude Code compares folders by their project-dir spelling; Windows and macOS file systems ignore case. */
function sameFolder(a: string, b: string): boolean {
  const key = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');
  const fold = process.platform === 'win32' || process.platform === 'darwin';
  return fold ? key(a).toLowerCase() === key(b).toLowerCase() : key(a) === key(b);
}

/**
 * Makes a transcript that was recorded in another folder (a pulled one: the other device's path) show up under
 * `workspacePath` in Claude Code's own session list, by appending the «relocated» record Claude Code itself writes
 * when a session is resumed elsewhere. Returns true when the file was changed.
 */
export function relocateTranscript(file: string, workspacePath: string): boolean {
  const cwd = transcriptCwd(file);
  if (cwd === undefined || sameFolder(cwd, workspacePath)) return false;
  const sessionId = path.basename(file, '.jsonl');
  const record = `${JSON.stringify({ type: 'relocated', relocatedCwd: workspacePath, sessionId })}\n`;
  const fd = fs.openSync(file, 'r+');
  try {
    const size = fs.fstatSync(fd).size;
    const last = Buffer.alloc(1);
    const endsWithNewline = size > 0 && fs.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] === 0x0a;
    fs.writeSync(fd, (endsWithNewline ? '' : '\n') + record, size);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}
