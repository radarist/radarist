/**
 * @file key-resolution.ts
 * @description Gemini API key resolution — single source of truth.
 *
 * Lives in its own PURE module (no SDK imports, no directive) because the
 * consumers span every boundary: `client.ts` is a `'use server'` module (which
 * forbids exporting classes/sync functions), API routes import the helpers
 * directly, and `scripts/lib/local-demo.ts` shares the placeholder heuristic
 * from plain Node. Keep this file dependency-free so all of them can import it.
 */

/**
 * Typed error thrown when no usable Gemini API key is configured (absent or a
 * setup-scaffold placeholder). Thrown BEFORE any reliability-wrapped call so a
 * keyless environment never records circuit-breaker failures. Callers branch
 * on `instanceof MissingAIKeyError` to fail fast with setup guidance.
 */
export class MissingAIKeyError extends Error {
  constructor(
    message: string = 'Google AI API key not found. Set GOOGLE_API_KEY or GEMINI_API_KEY in your environment ' +
      '(placeholder scaffold values count as missing).'
  ) {
    super(message);
    this.name = 'MissingAIKeyError';
  }
}

/**
 * True when an env value is absent OR a setup-scaffold placeholder. The
 * documented keyless first-clone path (`npm run setup:local` / `npm run
 * demo:full`) writes the literal 'your-google-genai-api-key' into
 * GOOGLE_API_KEY / GEMINI_API_KEY when no real key exists (see
 * scripts/lib/local-demo.ts buildDemoEnv), so a truthiness check alone would
 * never detect the keyless state. scripts/lib/local-demo.ts re-uses this
 * predicate — pinned by the table-driven test in __tests__/client.test.ts.
 */
export function isPlaceholderKey(value: string | undefined): boolean {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === '' ||
    normalized === 'change-me' ||
    normalized === 'change-me-required' ||
    normalized.startsWith('your-') ||
    normalized.includes('<your-')
  );
}

/** First usable (non-placeholder) Gemini API key, or undefined when keyless. */
export function resolveGeminiApiKey(): string | undefined {
  return [process.env.GOOGLE_API_KEY, process.env.GEMINI_API_KEY].find((key) => !isPlaceholderKey(key));
}

/**
 * Throws {@link MissingAIKeyError} when no usable key is configured. Called at
 * the top of every public generate* entry point so the keyless state surfaces
 * BEFORE the reliability layer (no circuit-breaker/rate-limiter involvement).
 */
export function assertGeminiKey(): void {
  if (resolveGeminiApiKey() === undefined) {
    throw new MissingAIKeyError();
  }
}
