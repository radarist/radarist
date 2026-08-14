/**
 * @file scripts/server-only-stub.ts
 * @description Loader stub for `server-only`.
 *
 * The `server-only` package is a compile-time guard for Next.js server
 * components: its real implementation throws unconditionally when imported
 * outside the Next.js runtime. Standalone seed/utility scripts that run through
 * `tsx` are not Client Components, but they still hit that throw. This stub
 * registers a require hook that neutralises `server-only` so production server-
 * only repositories can be safely exercised by isolated scripts.
 */

import Module from 'node:module';

/**
 * Node exposes `_load` at runtime for CommonJS hooks but intentionally omits it
 * from its public TypeScript declarations. Keep that unsupported boundary local
 * to this emulator-only script rather than weakening repository types globally.
 */
interface CommonJsLoaderModule {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
}

const commonJsLoader = Module as unknown as CommonJsLoaderModule;
const originalLoad = commonJsLoader._load;

commonJsLoader._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'server-only') {
    return {};
  }
  return originalLoad(request, parent, isMain);
};

export {};
