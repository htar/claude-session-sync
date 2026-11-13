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

/** Sessions in `dir` (only `names`, when given) that look like they hold credentials: file name → kinds found. */
export function scanSessions(dir: string, names: Iterable<string>): Map<string, string[]> {
  const hits = new Map<string, string[]>();
  for (const name of names) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      continue; // gone in the meantime, or not a file: the push itself will deal with it
    }
    const kinds = findSecrets(text);
    if (kinds.length) hits.set(name, kinds);
  }
  return hits;
}
