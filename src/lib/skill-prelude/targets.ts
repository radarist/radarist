/**
 * @file lib/skill-prelude/targets.ts
 * @description Bounded, schema-valid prelude target extraction (ARUN-025).
 *
 * The mission prelude fans out one paid helper session per (per-entity skill ×
 * target). Historically the targets were whatever comma-separated fragments sat
 * on the prompt's `SCOPE:` line — including timeframes, bare numbers, generic
 * prose, and duplicates — each of which spawned a real sub-session. This module
 * is the single gate every target passes before it can consume a session:
 *
 *   - normalize   — strip markdown/list/emphasis artifacts, collapse whitespace
 *   - classify    — reject empty / too-short / too-long / timeframe / numeric /
 *                   generic-prose / malformed fragments, each with a reason
 *   - deduplicate — by a diacritics-folded, case-insensitive canonical key
 *   - cap         — an independent count cap, applied AFTER dedup/rejection so a
 *                   duplicate or a junk fragment can never displace a real entity
 *
 * The bar is deliberately tuned for PRECISION over recall: only unambiguous
 * non-targets are dropped. When in doubt a target is kept — worst case it runs,
 * which is the pre-ARUN-025 status quo; it can never silently starve a mission.
 */

/** Independent count cap on accepted prelude targets (parity with MAX_ENTITIES). */
export const MAX_PRELUDE_TARGETS = 6;

export type TargetRejectionReason =
  'empty' | 'too-short' | 'too-long' | 'timeframe' | 'numeric' | 'generic-prose' | 'malformed';

export interface RejectedTarget {
  /** The normalized fragment that was rejected. */
  value: string;
  reason: TargetRejectionReason;
}

export interface DuplicateTarget {
  /** The normalized fragment that duplicated an earlier accepted target. */
  value: string;
  /** The canonical key it collided on. */
  canonicalKey: string;
}

export interface PreludeTargetPlan {
  /** Normalized, unique, schema-valid targets, capped at `countCap`. */
  accepted: string[];
  /** Fragments dropped as non-resolvable, each with a reason. */
  rejected: RejectedTarget[];
  /** Later occurrences of an already-accepted canonical key. */
  duplicates: DuplicateTarget[];
  /** Unique valid targets dropped solely because they exceeded `countCap`. */
  droppedForCountCap: string[];
  /** The effective count cap applied. */
  countCap: number;
}

const MAX_TARGET_LENGTH = 80;

// Generic filler words: articles, prepositions, qualifiers, and domain nouns
// that carry no entity identity. A fragment whose every token is generic is
// prose, not a resolvable target.
const GENERIC_WORDS = new Set<string>([
  // articles / prepositions / conjunctions / determiners
  'the',
  'a',
  'an',
  'of',
  'and',
  'or',
  'for',
  'in',
  'on',
  'to',
  'with',
  'by',
  'as',
  'at',
  'its',
  'their',
  'this',
  'that',
  'these',
  'those',
  // qualifiers
  'various',
  'emerging',
  'multiple',
  'several',
  'key',
  'major',
  'leading',
  'other',
  'others',
  'general',
  'new',
  'top',
  'best',
  'current',
  'overall',
  'related',
  'relevant',
  'potential',
  'possible',
  'main',
  'core',
  // domain filler nouns
  'market',
  'markets',
  'industry',
  'industries',
  'sector',
  'sectors',
  'space',
  'spaces',
  'ecosystem',
  'ecosystems',
  'landscape',
  'landscapes',
  'technology',
  'technologies',
  'tech',
  'trend',
  'trends',
  'solution',
  'solutions',
  'vendor',
  'vendors',
  'product',
  'products',
  'tool',
  'tools',
  'platform',
  'platforms',
  'company',
  'companies',
  'startup',
  'startups',
  'player',
  'players',
  'competitor',
  'competitors',
  'competition',
  'future',
  'overview',
  'analysis',
  'area',
  'areas',
  'field',
  'fields',
  'domain',
  'domains',
  'category',
  'categories',
  'segment',
  'segments',
  'approach',
  'approaches',
  'option',
  'options',
]);

// Known-generic fragments whose non-generic adjective would otherwise let them
// slip past the all-tokens-generic heuristic (e.g. "competitive landscape").
const GENERIC_DENYLIST = new Set<string>([
  'na',
  'tbd',
  'todo',
  'misc',
  'etc',
  'summary',
  'competitive landscape',
  'the competitive landscape',
  'future trends',
  'market trends',
  'emerging trends',
  // section headings a malformed prompt can splice onto the SCOPE line
  'introduction',
  'conclusion',
  'background',
  'methodology',
  'executive summary',
  'vendor comparison',
  // bare legal-entity suffixes — comma-split debris of "OpenAI, Inc."
  'inc',
  'llc',
  'corp',
  'ltd',
  'co',
  'plc',
  'gmbh',
]);

function normalizeTarget(raw: string): string {
  return raw
    .replace(/\r?\n/g, ' ')
    .replace(/^[\s>#•*\-–—]+/, '') // leading markdown bullets / heading / quote / emphasis
    .replace(/^\d+[.)]\s+/, '') // leading "1. " / "1) " list numbering
    .replace(/^["'`*_]+/, '') // leading quotes / emphasis
    .replace(/["'`*_]+$/, '') // trailing quotes / emphasis
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:]+$/, '') // trailing sentence punctuation
    .trim();
}

function canonicalTargetKey(normalized: string): string {
  return normalized
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // fold diacritics (e.g. accented E -> E)
    .toLowerCase()
    .replace(/[.,;:!?'"`/\\]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isTimeframe(value: string): boolean {
  const t = value.toLowerCase().trim();
  return (
    /^(19|20)\d{2}$/.test(t) || // 2024
    /^(19|20)\d{2}\s*(?:[-–—]|to)\s*((?:19|20)?\d{2})$/.test(t) || // 2024-2026, 2024 to 26
    /^(19|20)\d{2}\s*[-–—]\s*present$/.test(t) || // 2024-present
    /^q[1-4]\s*'?\s*(?:19|20)?\d{2}$/.test(t) || // Q1 2025, Q1'25
    /^(?:q[1-4]|h[12])$/.test(t) || // bare quarter/half: Q3, H1
    /^(?:h[12]|fy)\s*'?\s*(?:19|20)?\d{2}$/.test(t) || // H2 2026, FY25
    /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(19|20)\d{2}$/.test(t) || // March 2025
    /\b(?:next|last|past|coming|previous)\s+(?:\d+|few|several|couple)\s+(?:year|month|quarter|decade|week|day)s?\b/.test(
      t
    ) || // next 5 years
    /\b(?:next|last|past|coming|previous)\s+(?:year|month|quarter|decade|week|day)s?\b/.test(t) || // next year
    /^(?:today|tomorrow|yesterday|now|present|current|near[-\s]term|long[-\s]term|mid[-\s]term|short[-\s]term)$/.test(t)
  );
}

function isNumeric(value: string): boolean {
  const t = value.trim();
  return (
    /^[+-]?[\d.,]+\s*%?$/.test(t) || // 42, 3.5, 1,234, 35%
    /^[$€£¥]\s*[\d.,]+\s*(?:k|m|b|t|bn|mn|billion|million|trillion|thousand)?$/i.test(t) || // $5B
    /^[\d.,]+\s*(?:bn|mn|billion|million|trillion|thousand|percent)$/i.test(t) || // 5bn, 20 percent (multi-letter)
    /^[\d.,]+\s+(?:k|m|b|t|x)$/i.test(t) // "5 M", "10 x" — single-letter units require a space, so a
    // GLUED digit+single-letter ("3M", "10x", "2K") is kept as a possible entity name (precision).
  );
}

function isMalformed(value: string): boolean {
  return (
    /[|<>]/.test(value) || // table / markup residue
    /:/.test(value) || // directive/heading residue e.g. "DEPTH: full"
    /^#{1,6}\s/.test(value) || // markdown heading residue
    /^[^\p{L}\p{N}]+$/u.test(value) // nothing but punctuation / symbols
  );
}

function isGenericProse(canonicalKey: string): boolean {
  if (GENERIC_DENYLIST.has(canonicalKey)) return true;
  const tokens = canonicalKey.split(' ').filter(Boolean);
  return tokens.length > 0 && tokens.every((tok) => GENERIC_WORDS.has(tok));
}

type Classification =
  { ok: true; value: string; key: string } | { ok: false; value: string; reason: TargetRejectionReason };

function classifyTarget(raw: string): Classification {
  const value = normalizeTarget(raw);
  if (value.length === 0) return { ok: false, value, reason: 'empty' };

  const key = canonicalTargetKey(value);
  if (key.length === 0) return { ok: false, value, reason: 'empty' };
  if (value.length === 1) return { ok: false, value, reason: 'too-short' };
  if (value.length > MAX_TARGET_LENGTH) return { ok: false, value, reason: 'too-long' };
  if (isMalformed(value)) return { ok: false, value, reason: 'malformed' };
  if (isTimeframe(value)) return { ok: false, value, reason: 'timeframe' };
  if (isNumeric(value)) return { ok: false, value, reason: 'numeric' };
  if (isGenericProse(key)) return { ok: false, value, reason: 'generic-prose' };

  return { ok: true, value, key };
}

/**
 * Turn a raw list of comma-split SCOPE fragments into a bounded, deduplicated,
 * schema-valid target plan. Pure and deterministic — safe to recompute.
 */
export function refinePreludeTargets(raw: string[], opts?: { maxTargets?: number }): PreludeTargetPlan {
  const countCap = opts?.maxTargets != null && opts.maxTargets >= 0 ? opts.maxTargets : MAX_PRELUDE_TARGETS;

  const rejected: RejectedTarget[] = [];
  const duplicates: DuplicateTarget[] = [];
  const uniques: string[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    const result = classifyTarget(entry);
    if (!result.ok) {
      rejected.push({ value: result.value, reason: result.reason });
      continue;
    }
    if (seen.has(result.key)) {
      duplicates.push({ value: result.value, canonicalKey: result.key });
      continue;
    }
    seen.add(result.key);
    uniques.push(result.value);
  }

  const accepted = uniques.slice(0, countCap);
  const droppedForCountCap = uniques.slice(countCap);

  return { accepted, rejected, duplicates, droppedForCountCap, countCap };
}
