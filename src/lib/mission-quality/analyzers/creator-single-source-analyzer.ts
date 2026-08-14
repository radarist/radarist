export interface CreatorSingleSourceViolation {
  /** 0-based sentence index in the input. */
  sentenceIndex: number;
  /** The sentence text (trimmed). */
  sentence: string;
  /** Quantitative tokens that triggered the gate. */
  quantitativeMatches: string[];
  /** Distinct source IDs cited in the sentence (empty array if none). */
  citedSourceIds: number[];
}

export type CreatorSingleSourceVerdict =
  | { ok: true; quantitativeSentenceCount: number }
  | { ok: false; violations: CreatorSingleSourceViolation[] };

// Same patterns as scout-single-source-analyzer (deliberate DRY violation
// across the three analyzers; deduplicate later if a fourth shows up).
const QUANTITATIVE_PATTERNS: RegExp[] = [
  /\d+(?:\.\d+)?\s*%/,
  /\$\s*\d[\d,]*(?:\.\d+)?\s*(?:[BMK]|billion|million|thousand)?\b/i,
  /\d+(?:\.\d+)?\s*(?:USD|EUR|GBP)\b/i,
  /\d+(?:\.\d+)?\s*(?:billion|million|thousand)\b/i,
  /\d+(?:\.\d+)?[BMK]\b/,
  /\d+(?:\.\d+)?\s*x\b/i,
  /\d+\s*(?:req|requests|tokens|qps|rps|tps|users|nodes|seats)\b/i,
  /\d+(?:\.\d+)?\s*(?:ms|μs|ns|us)\b/i,
  /\d+(?:\.\d+)?\s*(?:gb|mb|kb|tb|gib|mib|kib)\b/i,
];

const CITATION_RE = /\[([\d\s,]+)\]/g;
const CITATION_NUM_RE = /\d+/g;

// Sentence boundary pattern: [terminator] followed by optional inline citations
// ([N], [1, 2]) and whitespace, then a capital letter starting the next sentence.
// This keeps trailing citations attached to the sentence they annotate.
const SENTENCE_BOUNDARY_RE = /(?<=[.!?])(?:\s*\[[\d\s,]+\])*\s+(?=[A-Z])/g;

function extractQuantitativeMatches(text: string): string[] {
  const raw: string[] = [];
  for (const pattern of QUANTITATIVE_PATTERNS) {
    const m = text.match(pattern);
    if (m) raw.push(m[0].trim());
  }
  // Deduplicate: discard a match that is a substring of a longer match.
  return raw.filter((candidate) => !raw.some((other) => other !== candidate && other.includes(candidate)));
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

/** Split prose into sentences, keeping trailing citations attached. */
function splitSentences(text: string): string[] {
  // Find all boundary positions and slice the text between them.
  const boundaries: number[] = [0];
  SENTENCE_BOUNDARY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SENTENCE_BOUNDARY_RE.exec(text)) !== null) {
    boundaries.push(m.index + m[0].length);
  }
  boundaries.push(text.length);

  const sentences: string[] = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const s = text.slice(boundaries[i], boundaries[i + 1]).trim();
    if (s.length > 0) sentences.push(s);
  }
  return sentences;
}

export function analyzeCreatorSingleSource(text: string): CreatorSingleSourceVerdict {
  const sentences = splitSentences(text);
  const violations: CreatorSingleSourceViolation[] = [];
  let quantitativeSentenceCount = 0;

  for (let i = 0; i < sentences.length; i += 1) {
    const sentence = sentences[i].trim();
    if (sentence.length === 0) continue;
    const quantitativeMatches = extractQuantitativeMatches(sentence);
    if (quantitativeMatches.length === 0) continue;

    quantitativeSentenceCount += 1;
    const citedSourceIds = extractCitedSourceIds(sentence);
    if (citedSourceIds.length < 2) {
      violations.push({
        sentenceIndex: i,
        sentence,
        quantitativeMatches,
        citedSourceIds,
      });
    }
  }

  if (violations.length === 0) return { ok: true, quantitativeSentenceCount };
  return { ok: false, violations };
}
