import type { LinkerBundle } from '../../schemas/linker-bundle';

export interface LinkerSingleSourceViolation {
  /** 0-based index into `bundle.edges`. */
  edgeIndex: number;
  sourceEntityName: string;
  targetEntityName: string;
  relationType: string;
  /** Quantitative tokens that triggered the gate. */
  quantitativeMatches: string[];
  /** Distinct URL hostnames found across evidence text + sourceUrl (empty = none). */
  distinctUrls: string[];
}

export type LinkerSingleSourceVerdict =
  | { ok: true; quantitativeEdgeCount: number }
  | { ok: false; violations: LinkerSingleSourceViolation[] };

// Same patterns as scout/creator (deliberate DRY violation across the three
// analyzers; deduplicate later if a fourth shows up).
const QUANTITATIVE_PATTERNS: RegExp[] = [
  /\d+(?:\.\d+)?\s*%/, // percentages: "30%", "7.5 %"
  /\$\s*\d[\d,]*(?:\.\d+)?\s*(?:[BMK]|billion|million|thousand)?\b/i,
  /\d+(?:\.\d+)?\s*(?:USD|EUR|GBP)\b/i,
  /\d+(?:\.\d+)?\s*(?:billion|million|thousand)\b/i,
  /\d+(?:\.\d+)?[BMK]\b/,
  /\d+(?:\.\d+)?\s*x\b/i,
  /\d+\s*(?:req|requests|tokens|qps|rps|tps|users|nodes|seats)\b/i,
  /\d+(?:\.\d+)?\s*(?:ms|μs|ns|us)\b/i, // latency
  /\d+(?:\.\d+)?\s*(?:gb|mb|kb|tb|gib|mib|kib)\b/i, // storage
];

const URL_RE = /https?:\/\/[^\s)]+/gi;

function extractQuantitativeMatches(text: string): string[] {
  const matches: string[] = [];
  for (const pattern of QUANTITATIVE_PATTERNS) {
    const m = text.match(pattern);
    if (m) matches.push(m[0].trim());
  }
  return matches;
}

/**
 * Extract distinct URL hostnames from a text string.
 * Uses try/catch so malformed URLs (e.g. trailing periods) are silently skipped.
 * Strips leading `www.` for host-level deduplication.
 */
function extractHostnames(text: string): Set<string> {
  const hosts = new Set<string>();
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    try {
      const host = new URL(m[0]).hostname.replace(/^www\./, '');
      hosts.add(host);
    } catch {
      // Malformed URL (e.g. trailing punctuation) — skip silently.
    }
  }
  return hosts;
}

export function analyzeLinkerSingleSource(bundle: LinkerBundle): LinkerSingleSourceVerdict {
  const violations: LinkerSingleSourceViolation[] = [];
  let quantitativeEdgeCount = 0;

  for (let i = 0; i < bundle.edges.length; i += 1) {
    const edge = bundle.edges[i];
    const quantitativeMatches = extractQuantitativeMatches(edge.evidence);
    if (quantitativeMatches.length === 0) continue;

    quantitativeEdgeCount += 1;

    // Collect distinct hostnames from evidence text + optional sourceUrl.
    const hosts = extractHostnames(edge.evidence);
    if (edge.sourceUrl) {
      try {
        const host = new URL(edge.sourceUrl).hostname.replace(/^www\./, '');
        hosts.add(host);
      } catch {
        // Invalid sourceUrl — skip.
      }
    }

    const distinctUrls = [...hosts].sort();
    if (distinctUrls.length < 2) {
      violations.push({
        edgeIndex: i,
        sourceEntityName: edge.sourceEntityName,
        targetEntityName: edge.targetEntityName,
        relationType: edge.relationType,
        quantitativeMatches,
        distinctUrls,
      });
    }
  }

  if (violations.length === 0) return { ok: true, quantitativeEdgeCount };
  return { ok: false, violations };
}
