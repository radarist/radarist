/**
 * Secret redaction for the agent runtime's logs and transport diagnostics (SEC-013).
 *
 * HAND-SYNCED MIRROR of `src/lib/redaction.ts`. The `@impulse/agent` sub-package
 * builds independently and cannot import from `src/lib`, so the rule tables live
 * in both files; `src/lib/__tests__/redaction-agent-mirror.test.ts` compares the
 * `shared-rules` region of the two files and fails the build on any drift.
 * Change the canonical file first, then copy the region here.
 *
 * Three independent nets, applied together:
 *
 * 1. **Live-value masking** — every value currently held by a secret-named
 *    environment variable is masked wherever it appears, whatever its shape.
 * 2. **Key-name masking** — object/header keys whose *name* marks the value as a
 *    credential (`authorization`, `x-api-key`, `*_secret`, …) are masked.
 * 3. **Shape masking** — well-known credential shapes (`sk-ant-…`, JWTs, PEM
 *    private keys, `Bearer …`, URL userinfo, `?api_key=…`) are masked in free text.
 */

/** Replacement written in place of a redacted value. */
export const REDACTED = '[REDACTED]';

// ---------------------------------------------------------------------------
// SHARED RULE TABLES — keep byte-identical with src/lib/redaction.ts
// ---------------------------------------------------------------------------
// #region shared-rules

/**
 * Environment variables whose value is a credential. Matching is by exact name
 * or by suffix pattern; `NEXT_PUBLIC_*` is deliberately excluded because those
 * are shipped to the browser and are public by construction (masking them would
 * add noise without adding containment).
 */
export const SECRET_ENV_NAMES: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'BRAVE_API_KEY',
  'EXA_API_KEY',
  'FIRECRAWL_API_KEY',
  'GEMINI_API_KEY',
  'GITHUB_PERSONAL_ACCESS_TOKEN',
  'GITHUB_TOKEN',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS_JSON',
  'IMPULSE_API_KEY',
  'IMPULSE_INTERNAL_KEY',
  'IMPULSE_SESSION_TOKEN',
  'INNGEST_EVENT_KEY',
  'INNGEST_SIGNING_KEY',
  'NEO4J_PASSWORD',
  'OPENROUTER_API_KEY',
  'TAVILY_API_KEY',
];

/** Suffix/shape patterns that mark an env var name as secret-valued. */
export const SECRET_ENV_NAME_PATTERNS: readonly RegExp[] = [
  /_API_KEY$/,
  /_ACCESS_TOKEN$/,
  /_AUTH_TOKEN$/,
  /_CLIENT_SECRET$/,
  /_CREDENTIALS$/,
  /_PASSWORD$/,
  /_PRIVATE_KEY$/,
  /_SECRET$/,
  /_SIGNING_KEY$/,
];

/**
 * Object / HTTP header keys whose value is always a credential. Matched
 * case-insensitively against the key name with `-` and `_` treated alike.
 */
export const SECRET_KEY_NAMES: readonly string[] = [
  'authorization',
  'proxyauthorization',
  'wwwauthenticate',
  'cookie',
  'setcookie',
  'xapikey',
  'apikey',
  'xgoogapikey',
  'xauthtoken',
  'xaccesstoken',
  'xsessiontoken',
  'xinternalkey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'bearertoken',
  'clientsecret',
  'privatekey',
  'password',
  'passwd',
  'secret',
  'credentials',
];

/**
 * Credential shapes recognised in free text. Each pattern replaces only the
 * secret span, never the surrounding context, so redacted logs stay readable.
 */
export const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  // PEM private key blocks (whole block).
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
  // Anthropic / OpenAI style prefixed keys.
  /\bsk-ant-[A-Za-z0-9_-]{12,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9]{20,}/g,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  // GitHub tokens.
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // Slack tokens.
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  // JSON Web Tokens.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
];

// #endregion shared-rules

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RedactionOptions {
  /** Environment read for live secret values. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Additional literal secrets to mask (e.g. a per-mission token). */
  extraSecrets?: readonly string[];
  /** Maximum object depth to walk. Deeper values collapse to a marker. */
  maxDepth?: number;
  /** Maximum length of any single redacted string. Longer values are truncated. */
  maxStringLength?: number;
}

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_STRING_LENGTH = 20_000;

/**
 * Shortest literal that may be masked by substring search. Masking a 3-character
 * value would corrupt unrelated text (and leak nothing useful anyway), so short
 * values are covered by the key-name and shape nets instead.
 */
const MIN_LIVE_SECRET_LENGTH = 8;

// ---------------------------------------------------------------------------
// Live secret collection
// ---------------------------------------------------------------------------

/** True when an environment variable name marks its value as a credential. */
export function isSecretEnvName(name: string): boolean {
  if (name.startsWith('NEXT_PUBLIC_')) return false;
  if (SECRET_ENV_NAMES.includes(name)) return true;
  return SECRET_ENV_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Every distinct live credential value present in `env`, longest first so that
 * masking a longer secret cannot leave a shorter overlapping one behind.
 */
export function collectLiveSecrets(
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {}
): string[] {
  const found = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length < MIN_LIVE_SECRET_LENGTH) continue;
    if (!isSecretEnvName(name)) continue;
    // An unresolved `${VAR}` placeholder is not a secret — masking it would hide
    // the very thing that proves the plaintext never reached the transport.
    if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(trimmed)) continue;
    found.add(trimmed);
  }
  return [...found].sort((a, b) => b.length - a.length);
}

// ---------------------------------------------------------------------------
// Key-name matching
// ---------------------------------------------------------------------------

/** Normalise a key for comparison: lowercase, separators stripped. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s.]/g, '');
}

/**
 * True when a key name marks its value as a credential.
 *
 * Deliberately anchored on the whole normalised key rather than a substring
 * search: a substring rule would mask `tokenUsage`, `cacheReadTokens`, and
 * `MISSION_TOKEN_BUDGET`, destroying accounting telemetry that the release
 * depends on.
 */
export function isSecretKeyName(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SECRET_KEY_NAMES.includes(normalized)) return true;
  // `<vendor>apikey`, `<vendor>secret`, `<vendor>password`, `<vendor>privatekey`
  return /(?:apikey|clientsecret|privatekey|password|passphrase|accesstoken|refreshtoken)$/.test(normalized);
}

// ---------------------------------------------------------------------------
// Text redaction
// ---------------------------------------------------------------------------

/** Mask credentials embedded in a URL: userinfo and secret-named query params. */
function redactUrlCredentials(text: string): string {
  return (
    text
      // scheme://user:password@host  →  scheme://[REDACTED]@host
      .replace(/\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s:@"']+:[^/\s@"']*@/g, `$1${REDACTED}@`)
      // ?api_key=… / &token=… / #access_token=…
      .replace(
        /([?&#](?:api[-_]?key|apikey|key|token|access[-_]?token|id[-_]?token|auth|password|secret|sig|signature)=)[^&#\s"'<>]+/gi,
        `$1${REDACTED}`
      )
  );
}

/**
 * True when a value following an auth scheme looks like a credential rather
 * than an English word. Real credentials carry entropy markers — digits, URL-safe
 * punctuation, mixed case, or substantial length; prose does not.
 */
function looksLikeCredential(value: string): boolean {
  if (value.length >= 20) return true;
  if (/[0-9]/.test(value)) return true;
  if (/[._~+/=-]/.test(value)) return true;
  return /[a-z]/.test(value) && /[A-Z]/.test(value);
}

/** Mask `header: value` / `"header": "value"` pairs written into free text. */
function redactInlineHeaders(text: string): string {
  return (
    text
      // JSON-ish:  "x-api-key": "abc"   /   'authorization': 'Bearer abc'
      .replace(
        /(["']?)([A-Za-z][A-Za-z0-9_-]{2,40})\1(\s*[:=]\s*)(["'])((?:\\.|[^\\])*?)\4/g,
        (match, q1, key: string, sep: string, q2: string, value: string) =>
          isSecretKeyName(key) && value.length > 0 ? `${q1}${key}${q1}${sep}${q2}${REDACTED}${q2}` : match
      )
      // Header-line:  x-api-key: abc
      .replace(
        /^([ \t]*)([A-Za-z][A-Za-z0-9_-]{2,40})(:[ \t]*)([^\r\n]+)$/gm,
        (match, indent, key: string, sep: string) => (isSecretKeyName(key) ? `${indent}${key}${sep}${REDACTED}` : match)
      )
      // `Bearer <token>` / `Basic <token>` anywhere in prose.
      //
      // The trailing value must LOOK like a credential. Matching any 8+ word
      // after the scheme mangles ordinary log prose — "slow auth token
      // acquisition before fetch" became "slow auth token [REDACTED] before
      // fetch", and "Basic authentication required" would go the same way.
      // `Token` is deliberately not a recognised scheme here: it is far too
      // common an English word, and real tokens are already covered by the
      // live-value and key-name nets.
      .replace(/\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{8,})/g, (match, scheme: string, value: string) =>
        looksLikeCredential(value) ? `${scheme} ${REDACTED}` : match
      )
  );
}

/**
 * Redact a single string: live secret values first (exact, shape-independent),
 * then URL credentials, inline headers, and known credential shapes.
 */
export function redactText(text: string, options?: RedactionOptions): string {
  if (typeof text !== 'string' || text.length === 0) return text;

  const maxLength = options?.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
  let out = text.length > maxLength ? `${text.slice(0, maxLength)}…[truncated ${text.length - maxLength} chars]` : text;

  for (const secret of liveSecretsFor(options)) {
    out = out.split(secret).join(REDACTED);
  }

  out = redactUrlCredentials(out);
  out = redactInlineHeaders(out);

  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, pattern.flags), REDACTED);
  }

  return out;
}

function liveSecretsFor(options?: RedactionOptions): string[] {
  const fromEnv = collectLiveSecrets(options?.env);
  const extra = (options?.extraSecrets ?? []).filter(
    (secret): secret is string => typeof secret === 'string' && secret.trim().length >= MIN_LIVE_SECRET_LENGTH
  );
  return [...new Set([...fromEnv, ...extra.map((s) => s.trim())])].sort((a, b) => b.length - a.length);
}

// ---------------------------------------------------------------------------
// Deep redaction
// ---------------------------------------------------------------------------

/**
 * Deep-copy `input` with every credential masked. Cycles become
 * `'[Circular]'`; values past `maxDepth` become `'[Depth limit]'`. Non-plain
 * values (functions, symbols) are stringified so nothing is silently dropped.
 */
export function redactSecrets<T>(input: T, options?: RedactionOptions): T {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const seen = new WeakSet<object>();

  const walk = (value: unknown, depth: number): unknown => {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return redactText(value, options);
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;
    if (typeof value === 'function' || typeof value === 'symbol') return String(value);
    if (depth >= maxDepth) return '[Depth limit]';

    if (value instanceof Error) {
      const redactedError: Record<string, unknown> = {
        name: value.name,
        message: redactText(value.message, options),
      };
      if (value.stack) redactedError.stack = redactText(value.stack, options);
      return redactedError;
    }
    if (value instanceof Date) return value.toISOString();
    if (value instanceof RegExp) return redactText(String(value), options);
    if (value instanceof URL) return redactText(value.toString(), options);

    if (typeof value === 'object') {
      if (seen.has(value as object)) return '[Circular]';
      seen.add(value as object);

      if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));

      if (value instanceof Map) {
        return Object.fromEntries(
          [...value.entries()].map(([key, entryValue]) => [
            String(key),
            isSecretKeyName(String(key)) ? REDACTED : walk(entryValue, depth + 1),
          ])
        );
      }
      if (value instanceof Set) return [...value].map((item) => walk(item, depth + 1));

      const out: Record<string, unknown> = {};
      for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
        if (isSecretKeyName(key)) {
          out[key] = entryValue === undefined || entryValue === null ? entryValue : REDACTED;
          continue;
        }
        // An env-shaped map: mask by variable name as well as by key name.
        if (isSecretEnvName(key) && typeof entryValue === 'string' && entryValue.length > 0) {
          out[key] = REDACTED;
          continue;
        }
        out[key] = walk(entryValue, depth + 1);
      }
      return out;
    }

    return String(value);
  };

  return walk(input, 0) as T;
}

// ---------------------------------------------------------------------------
// Export gate
// ---------------------------------------------------------------------------

/** A credential that survived redaction, described without reproducing it. */
export interface SecretFinding {
  /** Stable machine-readable kind: `live-env-value` or `shape:<index>`. */
  kind: string;
  /** How many times the finding occurred. */
  occurrences: number;
}

/**
 * Scan already-redacted output for surviving credentials. The report never
 * contains the secret itself — only its kind and count — so it is safe to print,
 * commit, and attach to a backlog row.
 */
export function findSurvivingSecrets(text: string, options?: RedactionOptions): SecretFinding[] {
  const findings: SecretFinding[] = [];
  if (typeof text !== 'string' || text.length === 0) return findings;

  let liveHits = 0;
  for (const secret of liveSecretsFor(options)) {
    let index = text.indexOf(secret);
    while (index !== -1) {
      liveHits += 1;
      index = text.indexOf(secret, index + secret.length);
    }
  }
  if (liveHits > 0) findings.push({ kind: 'live-env-value', occurrences: liveHits });

  SECRET_VALUE_PATTERNS.forEach((pattern, index) => {
    const matches = text.match(new RegExp(pattern.source, pattern.flags));
    if (matches && matches.length > 0) {
      findings.push({ kind: `shape:${index}`, occurrences: matches.length });
    }
  });

  return findings;
}

/**
 * Throw unless `text` is free of credentials. Used as the fail-closed gate on
 * every support/debug export path: an export that still carries a secret is
 * refused rather than written.
 */
export function assertRedactedForExport(text: string, label: string, options?: RedactionOptions): void {
  const findings = findSurvivingSecrets(text, options);
  if (findings.length === 0) return;
  const summary = findings.map((f) => `${f.kind}×${f.occurrences}`).join(', ');
  throw new Error(
    `Refusing to export "${label}": ${findings.length} secret pattern(s) survived redaction (${summary}). ` +
      `The value itself is intentionally not reproduced. Fix the redaction rule before exporting.`
  );
}
