/**
 * @file discovery/candidate-topic.ts
 * @description The SINGLE topic-derivation primitive for the discovery loop.
 *
 * One key-space, three callers:
 *  - READ  — the selector scores a candidate over its `meaningfulTags` (display
 *            fallback via `deriveTopicFromTags`).
 *  - WRITE — `recordProposalFeedback` aggregates the posterior on
 *            `deriveFeedbackTopic` (first meaningful tag — same filtered space).
 *  - SEED  — `deriveInterestFromBehavior` seeds InterestProfile + UserPreference
 *            weights on the same key (filtered via `meaningfulTags`).
 *
 * Before this module each site derived its own topic, and the write key
 * (`entityType:proposalType`) was disjoint from the read key (the tag), so
 * approve/reject never re-ranked. `deriveTopicFromTags` is behaviour-identical
 * to the selector's old private derivation, so unifying on it changes nothing on
 * the read side while making the write + seed sides line up.
 *
 * Pure module — no side-effecting imports — safe to import anywhere.
 */

/**
 * The exact separator alphabet shared with the InterestProfile Cypher writers.
 * Keeping it as data (rather than separate JS/Java regexes) prevents Unicode
 * whitespace from normalizing differently on either side of the Neo4j boundary.
 */
export const TOPIC_SEPARATOR_CHARACTERS: readonly string[] = Object.freeze([
  '-',
  '\u0009',
  '\u000a',
  '\u000b',
  '\u000c',
  '\u000d',
  '\u0020',
  '\u0085',
  '\u00a0',
  '\u1680',
  '\u2000',
  '\u2001',
  '\u2002',
  '\u2003',
  '\u2004',
  '\u2005',
  '\u2006',
  '\u2007',
  '\u2008',
  '\u2009',
  '\u200a',
  '\u2028',
  '\u2029',
  '\u202f',
  '\u205f',
  '\u3000',
  '\ufeff',
]);

const TOPIC_SEPARATOR_SET = new Set(TOPIC_SEPARATOR_CHARACTERS);

/** Lowercase and collapse whitespace/hyphens, without leading/trailing separators. */
export function normalizeTopicKey(value: string): string {
  let normalized = '';

  for (const character of value.toLowerCase()) {
    if (TOPIC_SEPARATOR_SET.has(character)) {
      if (normalized !== '' && !normalized.endsWith('-')) normalized += '-';
    } else {
      normalized += character;
    }
  }

  return normalized.endsWith('-') ? normalized.slice(0, -1) : normalized;
}

/**
 * Meta / provenance / workflow tokens that are NOT interests — filtered out on
 * BOTH the write side (`meaningfulTags`, seeding InterestProfile/UserPreference
 * from entity tags) and the fetch side (`getAggregateInterestKeywords` in
 * `interest-keywords.ts`, ranking aggregate topics into a fetch-keyword list).
 * This is the SINGLE stopword source for the discovery loop (DUP-6 unification,
 * 2026-07 — was two disjoint lists, one per side, so a token stopped on one side
 * could still leak through the other). Observed in live exploration data. NB:
 * the READ-side `deriveTopicFromTags` deliberately does NOT apply these (it
 * keeps strict selector parity); only `meaningfulTags` and the fetch-side
 * ranker filter.
 */
export const TAG_STOPWORDS: ReadonlySet<string> = new Set([
  // Originally tag-only (write/seed side).
  'e2e-test',
  'ai-created',
  'competitor',
  'tech',
  'opportunity',
  'hyped',
  'fast-growing',
  'maturing',
  'navigation',
  // Originally topic-only (fetch side) — workflow/priority/visibility markers
  // that leak into UserPreference.topics upstream but are NOT research topics.
  'public',
  'private',
  'p0-priority',
  'p1-priority',
  'p2-priority',
  'comprehensive',
  'document',
  'general',
  'other',
  'misc',
  'unknown',
]);

/**
 * A topic key from an entity's tags: the kebab-cased primary (first non-empty)
 * tag, falling back to the entity type. Behaviour-identical to the selector's old
 * `deriveCandidateTopic`. No stopword filtering (selector parity).
 */
export function deriveTopicFromTags(tags: unknown, entityType: string): string {
  const arr = Array.isArray(tags) ? tags : [];
  for (const tag of arr) {
    if (typeof tag !== 'string') continue;
    const topic = normalizeTopicKey(tag);
    if (topic) return topic;
  }
  return normalizeTopicKey(entityType);
}

/**
 * The FEEDBACK-side topic key: the first MEANINGFUL (stopword-filtered) tag,
 * falling back to the entity type. The selector's `scoreCandidate` only reads
 * learned weights over `meaningfulTags`, so feedback keyed on the raw first tag
 * (which may be a stopword like 'competitor') would be stranded — worse, its
 * engagement count would still shrink the class's exploration bonus, INVERTING
 * the learning signal (approve → rank down). Keying on the first meaningful tag
 * keeps the write key inside the selector's read key-space (M17).
 */
export function deriveFeedbackTopic(tags: unknown, entityType: string): string {
  return meaningfulTags(tags)[0] ?? normalizeTopicKey(entityType);
}

/**
 * The kebab'd, stopword-filtered, non-blank tags of an entity — the SEED side's
 * view of "what this entity is about". Order preserved; duplicates NOT collapsed
 * (callers that need uniqueness should dedupe).
 */
export function meaningfulTags(tags: unknown): string[] {
  const arr = Array.isArray(tags) ? tags : [];
  const out: string[] = [];
  for (const t of arr) {
    if (typeof t !== 'string') continue;
    const topic = normalizeTopicKey(t);
    if (topic && !TAG_STOPWORDS.has(topic)) out.push(topic);
  }
  return out;
}
