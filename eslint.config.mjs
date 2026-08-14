import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import unusedImports from 'eslint-plugin-unused-imports';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '.next/**', 'scripts/**', 'tests/**'],
  },
  {
    plugins: {
      'react-hooks': reactHooks,
      'unused-imports': unusedImports,
    },
  },
  ...tseslint.configs.recommended,
  nextPlugin.configs['core-web-vitals'],
  {
    rules: {
      // Relax rules that produce too much noise on existing codebase
      '@typescript-eslint/no-explicit-any': 'warn',
      // Catch dead imports ESLint's no-unused-vars structurally misses — e.g. an
      // unused `React` import in a JSX file (legacy JSX-pragma exemption). Auto-fixable.
      'unused-imports/no-unused-imports': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      // LINT-001: block the hook-order correctness class outright; keep the
      // dependency debt VISIBLE as warnings for the tracked post-release
      // burn-down (never auto-fix, never hide). Deliberately NOT the plugin's
      // recommended preset — react-hooks v7 recommended would also enable
      // React-Compiler rules, a larger change than LINT-001. The severity
      // split is pinned by src/lib/__tests__/eslint-hooks-config.contract.test.ts.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  // Server-only code (API routes, Inngest background functions) should use
  // the admin SDK from `@/lib/firebase-admin`. The Firebase client SDK
  // called from a server context has no signed-in user — production
  // Firestore rules that require `request.auth != null` then filter the
  // read to [] and the UI silently shows empty. Caused the empty-reports /
  // empty-infographics regression fixed in 984abb9f.
  //
  // Severity is "error" — every server-side call site under
  // `src/app/api/**` and `src/lib/inngest/**` was migrated to the admin
  // SDK in commits 984abb9f / 8b79ad12 / cefe25fb / cacc197f / 34a85af7,
  // so there are zero exemptions. A build-time seal via
  // `import 'client-only'` in src/lib/firebase.ts was attempted on
  // 2026-05-12 and reverted (see the comment at the top of that file
  // for why). This lint rule is the active boundary policy.
  {
    files: ['src/app/api/**/*.{ts,tsx}', 'src/lib/inngest/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@/lib/firebase',
              importNames: ['db'],
              message:
                "Server-side code should use `db` from '@/lib/firebase-admin'. The client SDK has no auth context server-side and gets filtered to [] by production rules.",
            },
            {
              name: 'firebase/firestore',
              message:
                "Server-side code should use 'firebase-admin/firestore' (via `@/lib/firebase-admin`). The client SDK has no auth context server-side.",
            },
          ],
        },
      ],
    },
  },
  // Service-module boundary (regression lock for the 2026-06 client→admin
  // migration). Server-side surfaces must not VALUE-import the Firebase
  // client-SDK *service modules* — they transitively load `firebase/firestore`
  // and crash server-side with `a540` (request paths) / `code:'unavailable'`
  // (Inngest workers) against production. The earlier rule blocks only direct
  // `db`/`firestore` imports; this blocks the service barrels too. Every server
  // surface uses the `*-admin` helpers + `entity-factory-admin`. Type-only
  // imports are allowed; pure exports (DuplicateEntityError / generateSlug /
  // ENTITY_CONFIGS, validateFile / ALLOWED_MIME_TYPES / MAX_FILE_SIZE) stay
  // allowed via `importNames`.
  {
    files: [
      'src/app/api/**/*.{ts,tsx}',
      'src/lib/ai/tools/**/*.ts',
      'src/lib/mcp/**/*.ts',
      'src/lib/inngest/**/*.ts',
      'src/lib/linker/**/*.ts',
      'src/lib/pipeline/**/*.ts',
    ],
    ignores: ['**/__tests__/**', '**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@/lib/companies',
                '@/lib/technology-service',
                '@/lib/technology-core',
                '@/lib/technologies',
                '@/lib/radars',
                '@/lib/radar-placement-service',
                '@/lib/signals-core',
                '@/lib/signals-approval',
                '@/lib/signals-expansion',
                '@/lib/relations',
                '@/lib/relations-core',
                '@/lib/relations-queries',
                '@/lib/proposed-relations',
                '@/lib/prototypes',
                '@/lib/use-cases',
                '@/lib/strategies',
                '@/lib/initiatives',
                '@/lib/org-units',
                '@/lib/pain-points',
                '@/lib/document-service',
                '@/lib/document-chunk-service',
                '@/lib/entity-document-link-service',
                '@/lib/concept-service',
                '@/lib/platform-config',
                '@/lib/contacts',
                '@/lib/company-notes',
              ],
              allowTypeImports: true,
              message:
                "Server-side code must use the admin twin '@/lib/<service>-admin' — the client-SDK service module crashes server-side (a540 / code:'unavailable'). Type-only imports are allowed.",
            },
          ],
          paths: [
            {
              // Exact match (not the gitignore-style `patterns`) so the pure
              // `@/lib/signals/*` sub-modules (scorer, enrichment, trust-score,
              // expand-signal — no Firestore) stay importable; only the
              // client-SDK barrel `@/lib/signals` is restricted.
              name: '@/lib/signals',
              allowTypeImports: true,
              message:
                "Server-side code must use '@/lib/signals-admin' — the client-SDK signals barrel crashes server-side (a540 / code:'unavailable'). Type-only imports are allowed.",
            },
            {
              name: '@/lib/entity-factory',
              importNames: ['createEntity', 'getOrCreateEntity', 'entityExists', 'validateEntityName'],
              allowTypeImports: true,
              message:
                "Server-side code must use `adminCreateEntity` from '@/lib/entity-factory-admin'. (DuplicateEntityError / generateSlug / generateEntityId / ENTITY_CONFIGS are pure and remain allowed.)",
            },
            {
              name: '@/lib/document-storage-service',
              importNames: [
                'uploadDocument',
                'getDocumentContent',
                'deleteStoredDocument',
                'deleteStoredDocuments',
                'getDocumentDownloadUrl',
                'getDocumentMetadata',
              ],
              allowTypeImports: true,
              message:
                "Server-side code must use '@/lib/document-storage-admin'. (validateFile / ALLOWED_MIME_TYPES / MAX_FILE_SIZE are pure and remain allowed.)",
            },
          ],
        },
      ],
    },
  },
  // AI-040 — the same service-module boundary, enforced against DYNAMIC
  // `await import('@/lib/<service>')`.
  //
  // `no-restricted-imports` only inspects static `import`/`export from`
  // declarations, so a dynamic import walked straight through the block above.
  // That is not hypothetical: `resolve-linked-entities.ts` reached
  // `@/lib/companies` and `@/lib/technology-service` this way from inside the
  // chat tool executor, the client SDK's `asyncQueue` rejected server-side, the
  // helper caught it, and every Assistant-created signal silently persisted
  // `linkedEntities: []`. `linker-metrics.ts` reached `@/lib/proposed-relations`
  // the same way. Both are now on the admin twins; this rule keeps the class
  // from returning.
  //
  // Deliberately limited to the modules where importing AT ALL is the hazard.
  // The `importNames`-scoped entries above (`@/lib/entity-factory`,
  // `@/lib/document-storage-service`) keep legitimate pure-export consumers, and
  // a selector cannot tell which binding a dynamic import destructures.
  {
    files: [
      'src/app/api/**/*.{ts,tsx}',
      'src/lib/ai/tools/**/*.ts',
      'src/lib/mcp/**/*.ts',
      'src/lib/inngest/**/*.ts',
      'src/lib/linker/**/*.ts',
      'src/lib/pipeline/**/*.ts',
    ],
    ignores: ['**/__tests__/**', '**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'ImportExpression > Literal[value=/^@\\u002Flib\\u002F(companies|technology-service|technology-core|technologies|radars|radar-placement-service|signals|signals-core|signals-approval|signals-expansion|relations|relations-core|relations-queries|proposed-relations|prototypes|use-cases|strategies|initiatives|org-units|pain-points|document-service|document-chunk-service|entity-document-link-service|concept-service|platform-config|contacts|company-notes)$/]',
          message:
            "Server-side code must dynamically import the admin twin '@/lib/<service>-admin' — the client-SDK service module has no auth context server-side and its reads reject or filter to []. A dynamic import bypasses no-restricted-imports, so this selector is the boundary here.",
        },
      ],
    },
  },
  // Structured logging is canonical. Use `createLogger('module-name')` from
  // `@/lib/logger` for any non-trivial log line in `src/lib/**` and
  // `src/app/api/**`. Bare `console.log/info/debug/trace` is banned.
  // `console.warn` and `console.error` are still allowed for incidental
  // last-resort error paths (logger init failures, etc.).
  {
    files: ['src/lib/**/*.{ts,tsx}', 'src/app/api/**/*.{ts,tsx}'],
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  // The logger itself uses `console.*` as its sink — that is the canonical
  // implementation, not a violation.
  {
    files: ['src/lib/logger.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  // Test files use `any` heavily in mocks/spies/`as any` bypasses; not a
  // production code-quality signal worth flagging. Integration tests also
  // construct Firestore fixtures via the client SDK against the emulator,
  // so the server-only import ban does not apply. Tests can also log freely
  // for debugging. Placed AFTER the server-only / logging blocks so it
  // overrides for test files under src/lib/ and src/app/api/.
  {
    files: ['**/__tests__/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-imports': 'off',
      'no-console': 'off',
    },
  }
);
