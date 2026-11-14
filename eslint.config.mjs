import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'out', 'node_modules', '*.vsix', 'scripts/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.mjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  // node:test's test() returns a promise the runner tracks itself.
  { files: ['src/test/**'], rules: { '@typescript-eslint/no-floating-promises': 'off' } },
  { files: ['eslint.config.mjs'], ...tseslint.configs.disableTypeChecked },
);
