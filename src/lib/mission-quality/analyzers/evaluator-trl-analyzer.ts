/**
 * @file lib/evaluator-trl-analyzer.ts
 * @description TRL-defensibility analyzer.
 *
 * Scans text for TRL [5-9] claims and, for each, checks a ±1500-char window
 * for at least one deployment marker (pilot | deployed | production |
 * customer | reference | live | in use | commercial | shipping |
 * rolled out | installed | real-world | field test).
 * Bare "deployment" and "operational" are excluded (false-positive prone in
 * negated phrases); compound "reference deployment" is still matched.
 *
 * TRL 1–4 (lab/research stages) are exempt — no deployment evidence needed.
 * Returns { ok: true, claimCount } or { ok: false, unsupported: [...] }.
 *
 * Pure function — no I/O, caller provides the text.
 */

export interface UnsupportedTrlClaim {
  /** The TRL level claimed (5–9). */
  trlLevel: number;
  /** Character offset where the claim starts in the input text. */
  claimOffset: number;
  /** The matched text (e.g. "TRL 7" or "trl: 8"). */
  claimText: string;
  /** The ±windowChars slice of input around the claim. */
  contextWindow: string;
}

export type TrlDefensibilityVerdict =
  | { ok: true; claimCount: number }
  | { ok: false; unsupported: UnsupportedTrlClaim[] };

const TRL_CLAIM_RE = /\bTRL\s*:?\s*([5-9])\b/gi;

// Note: bare "deployment" and "operational" are intentionally excluded — they
// appear naturally in negated phrases ("no evidence of operational deployment")
// and cause false positives. Compound forms like "reference deployment" and
// positive action words like "deployed" / "rolled out" are retained.
const DEPLOYMENT_MARKER_RE =
  /\b(pilot|deployed|production|productionized|in\s+service|customer|customers|reference\s+(customer|site|deployment|install)|live|in\s+use|at\s+scale|customer[-\s]?facing|commercial(?:ly)?|shipping|rolled\s+out|installed|real[-\s]?world|field\s+(test|trial))\b/i;

// Window widened from 500 → 1500 on 2026-04-24 after the live Kubernetes
// evaluator benchmark exposed false-positives on long-form structured
// reports (L2 awarded 100% but L1 flagged 9 TRL claims whose deployment
// evidence lived in a distinct methodology section ~800–1200 chars away).
// 1500 chars comfortably covers cross-section references in typical
// multi-H2 evaluator outputs while still halting fake reports that
// contain zero deployment markers anywhere.
const DEFAULT_WINDOW_CHARS = 1500;
const MIN_GATED_LEVEL_DEFAULT = 5;

export interface AnalyzeOptions {
  minGatedLevel?: number;
  windowChars?: number;
}

export function analyzeTrlDefensibility(text: string, options: AnalyzeOptions = {}): TrlDefensibilityVerdict {
  const minLevel = options.minGatedLevel ?? MIN_GATED_LEVEL_DEFAULT;
  const windowChars = options.windowChars ?? DEFAULT_WINDOW_CHARS;

  TRL_CLAIM_RE.lastIndex = 0;
  const unsupported: UnsupportedTrlClaim[] = [];
  let gatedClaimCount = 0;

  let match: RegExpExecArray | null;
  while ((match = TRL_CLAIM_RE.exec(text)) !== null) {
    const level = Number.parseInt(match[1], 10);
    if (!Number.isFinite(level) || level < minLevel) continue;
    gatedClaimCount += 1;

    const claimOffset = match.index;
    const windowStart = Math.max(0, claimOffset - windowChars);
    const windowEnd = Math.min(text.length, claimOffset + match[0].length + windowChars);
    const contextWindow = text.slice(windowStart, windowEnd);

    if (!DEPLOYMENT_MARKER_RE.test(contextWindow)) {
      unsupported.push({ trlLevel: level, claimOffset, claimText: match[0], contextWindow });
    }
  }

  if (unsupported.length === 0) return { ok: true, claimCount: gatedClaimCount };
  return { ok: false, unsupported };
}
