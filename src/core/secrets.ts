import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Well-known credential formats. Only formats with a distinctive prefix are listed, so ordinary code and prose in a
 * transcript are not flagged. No leading word boundary: in JSONL a newline is the two characters `\n`, so a key that
 * starts a line follows the letter «n».
 */
const PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'private key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: 'AWS access key', re: /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/ },
  { kind: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,}/ },
  { kind: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: 'OpenAI API key', re: /sk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { kind: 'Slack token', re: /xox[abprs]-[A-Za-z0-9-]{10,}/ },
  { kind: 'Stripe live key', re: /[rs]k_live_[A-Za-z0-9]{20,}/ },
  { kind: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { kind: 'npm token', re: /npm_[A-Za-z0-9]{36}/ },
];

/** The kinds of credentials found in `text`, each once, in the order of `PATTERNS`. */
export function findSecrets(text: string): string[] {
  return PATTERNS.filter((p) => p.re.test(text)).map((p) => p.kind);
}

const CHUNK_BYTES = 4 * 1024 * 1024;
/** Longest pattern match we need to catch when it straddles two chunks. */
const OVERLAP_BYTES = 512;
/** File → what was found, valid while its size and modification time stay the same: a session is not read twice. */
const scanned = new Map<string, { size: number; mtimeMs: number; kinds: string[] }>();

/**
 * The kinds of credentials in one file. Read in chunks and with awaits in between, so a transcript of tens of
 * megabytes never blocks the editor; decoded as latin1 (fast, and every pattern is plain ASCII).
 */
async function scanFile(file: string): Promise<string[]> {
  const stat = await fs.promises.stat(file);
  const hit = scanned.get(file);
  if (hit?.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.kinds;
  const found = new Set<string>();
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES + OVERLAP_BYTES);
    let carry = 0;
    for (let position = 0; position < stat.size;) {
      const { bytesRead } = await handle.read(buffer, carry, CHUNK_BYTES, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const length = carry + bytesRead;
      for (const kind of findSecrets(buffer.toString('latin1', 0, length))) found.add(kind);
      carry = Math.min(OVERLAP_BYTES, length);
      buffer.copy(buffer, 0, length - carry, length);
    }
  } finally {
    await handle.close();
  }
  const kinds = PATTERNS.filter((p) => found.has(p.kind)).map((p) => p.kind);
  scanned.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, kinds });
  return kinds;
}

/** Sessions in `dir` (only `names`, when given) that look like they hold credentials: file name → kinds found. */
export async function scanSessions(dir: string, names: Iterable<string>): Promise<Map<string, string[]>> {
  const hits = new Map<string, string[]>();
  for (const name of names) {
    let kinds: string[];
    try {
      kinds = await scanFile(path.join(dir, name));
    } catch {
      continue; // gone in the meantime, or not a file: the push itself will deal with it
    }
    if (kinds.length) hits.set(name, kinds);
  }
  return hits;
}
