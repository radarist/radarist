import type { ScoutBundle } from '../../schemas/scout-bundle';

export interface SingleSourceViolation {
  findingIndex: number;
  finding: string;
  /** The quantitative tokens that triggered the gate. */
  quantitativeMatches: string[];
  /** Distinct source IDs cited by this finding (empty array = no citation). */
  citedSourceIds: number[];
}

export type SingleSourceVerdict =
  | { ok: true; quantitativeFindingCount: number }
  | { ok: false; violations: SingleSourceViolation[] };

const QUANTITATIVE_PATTERNS: RegExp[] = [
  /\d+(?:\.\d+)?\s*%/, // percentages: "30%", "7.5 %"
  /\$\s*\d[\d,]*(?:\.\d+)?\s*(?:[BMK]|billion|million|thousand)?\b/i,
  /\d+(?:\.\d+)?\s*(?:USD|EUR|GBP)\b/i,
  /\d+(?:\.\d+)?\s*(?:billion|million|thousand)\b/i,
  /\d+(?:\.\d+)?[BMK]\b/,
  /\d+(?:\.\d+)?\s*x\b/i,
  /\d+\s*(?:req|requests|tokens|qps|rps|tps|users|nodes|seats)\b/i,
  /\d+(?:\.\d+)?\s*(?:ms|μs|ns|us)\b/i, // latency: "80ms", "1.5μs"
  /\d+(?:\.\d+)?\s*(?:gb|mb|kb|tb|gib|mib|kib)\b/i, // storage: "10GB", "512MB"
];

const CITATION_RE = /\[([\d\s,]+)\]/g;
const CITATION_NUM_RE = /\d+/g;

function extractQuantitativeMatches(text: string): string[] {
  const matches: string[] = [];
  for (const pattern of QUANTITATIVE_PATTERNS) {
    const m = text.match(pattern);
    if (m) matches.push(m[0].trim());
  }
  return matches;
}

function extractCitedSourceIds(text: string): number[] {
  const ids = new Set<number>();
  CITATION_RE.lastIndex = 0;
  let bracket: RegExpExecArray | null;
  while ((bracket = CITATION_RE.exec(text)) !== null) {
    const inner = bracket[1].match(CITATION_NUM_RE) ?? [];
    for (const idStr of inner) {
      const id = Number.parseInt(idStr, 10);
      if (Number.isFinite(id) && id > 0) ids.add(id);
    }
  }
  return [...ids].sort((a, b) => a - b);
}

export function analyzeSingleSourceQuantitative(bundle: ScoutBundle): SingleSourceVerdict {
  const violations: SingleSourceViolation[] = [];
  let quantitativeFindingCount = 0;

  for (let i = 0; i < bundle.findings.length; i += 1) {
    const finding = bundle.findings[i];
    const quantitativeMatches = extractQuantitativeMatches(finding);
    if (quantitativeMatches.length === 0) continue;

    quantitativeFindingCount += 1;
    const citedSourceIds = extractCitedSourceIds(finding);
    if (citedSourceIds.length < 2) {
      violations.push({
        findingIndex: i,
        finding,
        quantitativeMatches,
        citedSourceIds,
      });
    }
  }

  if (violations.length === 0) return { ok: true, quantitativeFindingCount };
  return { ok: false, violations };
}
