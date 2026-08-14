/**
 * @file lib/scout-bundle-parser.ts
 * @description Extract + Zod-parse scout's structured bundle from its output.
 *
 * Scout is instructed to end every research bundle with a fenced ```json
 * block matching `scoutBundleSchema`. This parser pulls the LAST such block
 * (scout may include exploratory JSON earlier) and validates it. Consumers
 * (L1 quality check, creator chain step) get a discriminated union — a
 * malformed or missing bundle is a fail-fast signal.
 */

import { scoutBundleSchema, type ScoutBundle } from './schemas/scout-bundle';

const FENCED_JSON_BLOCK_RE = /```json\s*\n([\s\S]*?)\n```/g;

/**
 * Marker text scout's prompt must contain for the L1 bundle-parseable check to
 * run. `tool_call_id` is distinctive — no other agent prompt in the codebase
 * uses that token. `fetched_via` adds belt-and-suspenders so a stray reference
 * doesn't false-positive. The older ```\s*json.*bundle pattern was too fragile
 * (line-boundary dependent) and drifted out of sync with the actual scout prompt.
 */
const BUNDLE_MARKER_PATTERNS = [/\btool_call_id\b/i, /\bfetched_via\b/i];

export type ParseResult = { ok: true; bundle: ScoutBundle } | { ok: false; error: string };

/** Verdict a scout source contributes to an entity observation (M13). */
export type ObservationVerdict = 'confirming' | 'contradicting' | 'inconclusive';

/**
 * Map a NATO Admiralty code (e.g. "A1", "C6") to an honest observation verdict.
 *
 * M13: mission observations previously hard-coded every source as
 * `confirming`, making downstream verify-entity scoring a rubber stamp
 * (always 100/verified). The Admiralty code scout already assigns each source
 * carries the real signal:
 *
 *  - Letter = source reliability (A completely reliable … F cannot be judged;
 *    E = unreliable). An unreliable source (E/F) can never *confirm* — its
 *    contribution is at best inconclusive regardless of the credibility digit.
 *  - Digit  = information credibility (1 confirmed … 5 improbable/contradicted;
 *    6 cannot be judged).
 *
 * Verdict:
 *  - `contradicting` when the credibility digit is 5 (improbable/known-false),
 *    from any source that can be judged.
 *  - `confirming` when the source is usable (A–D) and the credibility digit is
 *    1–2 (confirmed / probably true).
 *  - `inconclusive` otherwise — doubtful/unjudgeable digits (3, 4, 6), any
 *    unreliable source (E/F), or a malformed code. Never guess `confirming`.
 */
export function verdictFromAdmiralty(code: string): ObservationVerdict {
  const match = /^([A-F])([1-6])$/.exec((code ?? '').trim().toUpperCase());
  if (!match) return 'inconclusive';

  const reliability = match[1];
  const credibility = Number(match[2]);

  // Improbable / contradicted information is a contradiction from any
  // judgeable source.
  if (credibility === 5) return 'contradicting';

  // An unreliable source (E) or one whose reliability cannot be judged (F)
  // cannot positively confirm anything.
  if (reliability === 'E' || reliability === 'F') return 'inconclusive';

  // Usable source + confirmed/probably-true information → confirming.
  if (credibility <= 2) return 'confirming';

  // Digits 3 (possibly true), 4 (doubtful), 6 (cannot be judged) → inconclusive.
  return 'inconclusive';
}

/**
 * Detect whether a prompt asked scout to emit the structured bundle. Used by
 * the L1 quality check to skip the bundle-parseable check on missions that
 * were never asked to produce one in the first place (legacy, or ad-hoc scout
 * dispatches outside the chain).
 */
export function containsBundleMarker(prompt: string): boolean {
  return BUNDLE_MARKER_PATTERNS.some((re) => re.test(prompt));
}

/**
 * Extract and validate scout's bundle JSON from a free-form result string.
 * Returns a discriminated union with a human-readable error string on failure.
 */
export function parseScoutBundle(result: string): ParseResult {
  // Reset lastIndex in case the regex was used previously at module scope.
  FENCED_JSON_BLOCK_RE.lastIndex = 0;

  // Pick the LAST fenced json block — scout may include intermediate ones
  // (e.g. a smaller example block earlier in the output).
  let lastBlock: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = FENCED_JSON_BLOCK_RE.exec(result)) !== null) {
    lastBlock = match[1];
  }

  if (lastBlock === null) {
    return { ok: false, error: 'no fenced ```json block in output' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(lastBlock);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `json parse failed: ${msg}` };
  }

  const zodResult = scoutBundleSchema.safeParse(parsed);
  if (!zodResult.success) {
    const firstIssue = zodResult.error.issues[0];
    const path = firstIssue.path.join('.');
    return { ok: false, error: `schema violation at ${path || '<root>'}: ${firstIssue.message}` };
  }

  return { ok: true, bundle: zodResult.data };
}
