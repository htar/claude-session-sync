import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

const root = process.cwd();
const placeholders = (s: string): string => [...new Set(s.match(/\{\d+\}/g) ?? [])].sort().join();

/** Every message the extension shows through `t('…')`. */
function messages(): string[] {
  const source = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
  return [...source.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => (m[1] ?? '').replace(/\\'/g, "'"));
}

for (const lang of ['uk', 'es', 'zh-cn']) {
  test(`l10n bundle ${lang} has every message, with the same placeholders`, () => {
    const bundle = JSON.parse(fs.readFileSync(path.join(root, 'l10n', `bundle.l10n.${lang}.json`), 'utf8')) as Record<
      string,
      string
    >;
    for (const key of messages()) {
      assert.ok(bundle[key], `missing in ${lang}: ${key}`);
      assert.equal(placeholders(bundle[key]), placeholders(key), `placeholders differ in ${lang}: ${key}`);
    }
  });
}
