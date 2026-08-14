/**
 * @file lib/scout-bundle-analyzer.ts
 * @description Citation-padding detector for scout bundles.
 *
 * The L2 judge routinely catches scout pairing single-sourced numeric claims
 * with a second citation that only covers the general topic (e.g. citing
 * `[1, 2]` where source 1 contains the number and source 2 doesn't). Explicit
 * prompt guidance alone cannot enforce. This analyzer applies the rule at L1.
 *
 * For every finding in the bundle with ≥ 2 `[N, M, ...]` citations and ≥ 1
 * numeric token (percentage, dollar amount, plain number), every cited
 * source's `snippet` must independently contain at least one of the
 * finding's numeric tokens. Missing snippets on multi-cite findings are
 * treated as padding — if scout can't produce a snippet proving the cited
 * source supports the claim, the citation doesn't count.
 */

import type { ScoutBundle, ScoutBundleSource } from '../../schemas/scout-bundle';

const NUMERIC_TOKEN_RE = /(\$?\d[\d,]*\.?\d*%?)/g;
const CITATION_RE = /\[([\d\s,]+)\]/g;

export interface PaddingViolation {
  findingIndex: number;
  finding: string;
  numericTokens: string[];
  citedSourceIds: number[];
  offendingSourceIds: number[];
  reason: string;
}

export type AnalysisResult = { ok: true } | { ok: false; violations: PaddingViolation[] };

export function analyzeCitationPadding(bundle: ScoutBundle): AnalysisResult {
  const sourceById = new Map<number, ScoutBundleSource>();
  for (const src of bundle.sources) sourceById.set(src.id, src);

  const violations: PaddingViolation[] = [];

  bundle.findings.forEach((finding, findingIndex) => {
    const numericTokens = extractNumericTokens(finding);
    if (numericTokens.length === 0) return;

    const citedIds = extractCitedSourceIds(finding);
    if (citedIds.length < 2) return;

    const offendingSourceIds: number[] = [];
    const reasons: string[] = [];

    for (const id of citedIds) {
      const src = sourceById.get(id);
      if (!src) {
        offendingSourceIds.push(id);
        reasons.push(`source ${id} not found in bundle`);
        continue;
      }
      const snippet = src.snippet ?? '';
      if (snippet.trim().length === 0) {
        offendingSourceIds.push(id);
        reasons.push(`source ${id} has no snippet (required to verify multi-cite claims)`);
        continue;
      }
      if (!snippetContainsAnyToken(snippet, numericTokens)) {
        offendingSourceIds.push(id);
        reasons.push(
          `source ${id} snippet does not contain any of the finding's numeric tokens (${numericTokens.join(', ')})`
        );
      }
    }

    if (offendingSourceIds.length > 0) {
      violations.push({
        findingIndex,
        finding,
        numericTokens,
        citedSourceIds: citedIds,
        offendingSourceIds,
        reason: reasons.join('; '),
      });
    }
  });

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

function extractNumericTokens(text: string): string[] {
  // Strip citation brackets first so their digits (e.g. [1, 2]) are never
  // mistaken for quantitative tokens. The regex matches both [1] and [1, 2, 3].
  const stripped = text.replace(/\[[\d\s,]+\]/g, '');
  const tokens = stripped.match(NUMERIC_TOKEN_RE) ?? [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const t of tokens) {
    const trimmed = t.trim();
    if (trimmed.length === 0) continue;
    // Skip pure-digit tokens of 1–2 chars that don't carry units — almost
    // certainly citation markers (e.g. [1], [12]), not quantitative claims.
    if (/^\d{1,2}$/.test(trimmed) && !trimmed.includes('%') && !trimmed.startsWith('$')) {
      continue;
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

function extractCitedSourceIds(text: string): number[] {
  const ids = new Set<number>();
  CITATION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CITATION_RE.exec(text)) !== null) {
    const parts = match[1].split(',').map((s) => s.trim());
    for (const p of parts) {
      const n = Number.parseInt(p, 10);
      if (Number.isFinite(n) && n > 0) ids.add(n);
    }
  }
  return Array.from(ids).sort((a, b) => a - b);
}

function snippetContainsAnyToken(snippet: string, tokens: string[]): boolean {
  const normalized = snippet.toLowerCase();
  return tokens.some((t) => normalized.includes(t.toLowerCase()));
}
