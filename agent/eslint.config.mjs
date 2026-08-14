import unusedImports from 'eslint-plugin-unused-imports';
import tseslint from 'typescript-eslint';

// Dedicated flat config for the `@impulse/agent` sub-package.
//
// The agent is a plain Node/TypeScript package, NOT a Next.js app. The root
// `eslint.config.mjs` loads `@next/eslint-plugin-next` (core-web-vitals)
// globally, and that plugin emits a spurious load-time
// "Pages directory cannot be found" console warning whenever it runs in a
// tree without a pages/ dir — which no rule-severity override can silence
// (it fires at plugin load, not per file). Flat config uses the single
// nearest config file (no cascade), so defining this config here means
// `eslint src/` inside `agent/` never loads the Next plugin and the warning
// disappears (HYGIENE-003).
//
// The real warning ceiling is preserved 1:1 with the root config's general
// block: typescript-eslint recommended, unused-imports, and no-unused-vars
// with the `^_` intentional-boundary escape hatch.
export default tseslint.config(
  {
    ignores: ['**/node_modules/**', 'dist/**'],
  },
  {
    plugins: {
      'unused-imports': unusedImports,
    },
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      'unused-imports/no-unused-imports': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  }
);
