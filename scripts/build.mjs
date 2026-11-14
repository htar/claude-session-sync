// Bundles the extension. The Google OAuth client secret is not kept in the repository: it is read from the
// GOOGLE_CLIENT_SECRET environment variable or the git-ignored `.google-client-secret` file and compiled into
// the bundle. Without it the build still works and the «Google Drive» method is simply hidden.
import { existsSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';

const prod = process.argv.includes('--prod');

const secretFile = new URL('../.google-client-secret', import.meta.url);
const secret =
  process.env.GOOGLE_CLIENT_SECRET ?? (existsSync(secretFile) ? readFileSync(secretFile, 'utf8').trim() : '');

await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
  outfile: 'dist/extension.js',
  sourcemap: !prod,
  minify: prod,
  define: { __GOOGLE_CLIENT_SECRET__: JSON.stringify(secret) },
});

console.log(
  `built (${prod ? 'production' : 'development'}), Google Drive ${secret ? 'enabled' : 'hidden: no client secret'}`,
);
