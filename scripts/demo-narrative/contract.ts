/**
 * @file scripts/demo-narrative/contract.ts
 * @description SKILL-002 — the machine-readable demo-narrative contract.
 *
 * This is the single source of truth for "what makes a demo narrative coherent
 * enough that a stranger understands the value in 60 seconds" (findings §6). It
 * is plain, JSON-serialisable data so it can be emitted verbatim into the
 * quality receipt and referenced by the app-inception build skill.
 *
 * The rules split into HARD rules (any failure fails the receipt) and SCORED
 * dimensions (a weighted 0–100 benchmark). Nothing here seeds data or changes
 * runtime behaviour; it only judges an already-built demo dataset.
 */

/** A generic-fixture token the contract rejects. */
export interface BannedToken {
  id: string;
  /** The literal token to search for (case-insensitive). */
  token: string;
  /**
   * When true, match only on word boundaries (`\bbar\b`) so real words that
   * merely contain the token (toolbar, embargo) are not flagged. When false the
   * token is matched as a raw substring (for phrases / email-ish placeholders).
   */
  boundary: boolean;
}

export const DEMO_NARRATIVE_CONTRACT = {
  version: '1.0.0',

  /** The real seed must clear this weighted score; below it the receipt fails. */
  scoreThreshold: 85,

  /**
   * Benchmark ceiling: a deliberately-generic anti-fixture must score at or
   * below this. The gap between the real seed (≥ scoreThreshold) and a toy
   * dataset (≤ this) is the objective evidence the contract discriminates.
   */
  antiFixtureCeiling: 40,

  /**
   * Generic-fixture tokens that make an app read as a toy. Word-boundary tokens
   * (`boundary: true`) match only as whole words, so real words that merely
   * contain the token are never flagged (`toolbar`/`navbar` do not hit any token,
   * `sample items` does not hit `sample item`). Bare `bar` is deliberately NOT a
   * token: it is a legitimate data-viz word (`bar chart`, `progress bar`) and the
   * classic placeholder triple is already caught by `foo`/`baz`/`foobar`.
   * `boundary: false` is reserved for email/domain-shaped placeholders whose
   * punctuation defeats word boundaries and which never occur in real prose.
   */
  bannedTokens: [
    { id: 'foo', token: 'foo', boundary: true },
    { id: 'foobar', token: 'foobar', boundary: true },
    { id: 'baz', token: 'baz', boundary: true },
    { id: 'qux', token: 'qux', boundary: true },
    { id: 'quux', token: 'quux', boundary: true },
    { id: 'test123', token: 'test123', boundary: true },
    { id: 'asdf', token: 'asdf', boundary: true },
    { id: 'xyzzy', token: 'xyzzy', boundary: true },
    { id: 'changeme', token: 'changeme', boundary: true },
    { id: 'placeholder', token: 'placeholder', boundary: true },
    { id: 'lorem-ipsum', token: 'lorem ipsum', boundary: true },
    { id: 'john-doe', token: 'john doe', boundary: true },
    { id: 'jane-doe', token: 'jane doe', boundary: true },
    { id: 'test-user', token: 'test user', boundary: true },
    { id: 'sample-item', token: 'sample item', boundary: true },
    { id: 'my-entity', token: 'my entity', boundary: true },
    { id: 'example-email', token: 'example@', boundary: false },
    { id: 'example-domain', token: 'example.com', boundary: false },
  ] as BannedToken[],

  /** Minimum entity counts so the story is non-trivial. */
  coverageFloor: {
    technologies: 8,
    companies: 5,
    signals: 5,
    reports: 1,
    agentRuns: 1,
    radarQuadrants: 4,
  },

  /**
   * Realism thresholds for human-visible labels and descriptions. A label is
   * "distinctive" when it is at least `minLabelChars` long AND is either
   * multi-word OR carries an uppercase letter or digit — so real single-token
   * product names (vLLM, Modal, GPT-5) pass while lowercase stubs (foo, app) do
   * not. (The banned-token list separately rejects foo/bar/test123 outright.)
   */
  realism: {
    minLabelChars: 4,
    /** A real description is a sentence, not a stub. */
    minDescriptionChars: 40,
  },

  /** The hero record must anchor at least this many linked entities. */
  heroMinLinkedEntities: 8,

  /** Scored-dimension weights (must sum to 100). */
  weights: {
    heroRichness: 20,
    labelRealism: 20,
    descriptionDepth: 15,
    narrativeLinkage: 30,
    antiGeneric: 15,
  },
} as const;

export type DemoNarrativeContract = typeof DEMO_NARRATIVE_CONTRACT;
