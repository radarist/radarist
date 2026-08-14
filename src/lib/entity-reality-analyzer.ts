export interface SearchContext {
  /** Gemini's search-result summary text for the entity name. */
  summary: string;
  /** Set by executeWebSearch when the grounded-search infra itself failed. */
  searchFailed?: boolean;
}

export type RealityVerdict =
  | { ok: true; evidenceText: string; reason: 'verified' | 'inconclusive' }
  | { ok: false; reason: 'no-results' | 'no-name-match'; summary: string };

const REGEX_META_CHARS = /[.*+?^${}()|[\]\\]/g;
const MIN_SUMMARY_LENGTH = 50;
const EVIDENCE_TEXT_CAP = 200;

function escapeRegex(s: string): string {
  return s.replace(REGEX_META_CHARS, '\\$&');
}

function nameAppearsInSummary(name: string, summary: string): boolean {
  const summaryLower = summary.toLowerCase();
  const significantWords = name.toLowerCase().match(/\b\w{3,}\b/g) ?? [];
  if (significantWords.length === 0) {
    const nameLower = name.trim().toLowerCase();
    if (nameLower.length === 0) return false;
    return new RegExp(`\\b${escapeRegex(nameLower)}\\b`).test(summaryLower);
  }
  return significantWords.every((w) => new RegExp(`\\b${escapeRegex(w)}\\b`).test(summaryLower));
}

export function analyzeEntityReality(name: string, context: SearchContext): RealityVerdict {
  if (context.searchFailed) {
    return {
      ok: true,
      reason: 'inconclusive',
      evidenceText: context.summary.slice(0, EVIDENCE_TEXT_CAP),
    };
  }
  if (!context.summary || context.summary.trim().length < MIN_SUMMARY_LENGTH) {
    return { ok: false, reason: 'no-results', summary: context.summary ?? '' };
  }
  if (!nameAppearsInSummary(name, context.summary)) {
    return { ok: false, reason: 'no-name-match', summary: context.summary };
  }
  return {
    ok: true,
    reason: 'verified',
    evidenceText: context.summary.slice(0, EVIDENCE_TEXT_CAP),
  };
}
