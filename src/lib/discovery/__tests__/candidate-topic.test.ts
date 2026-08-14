/**
 * @jest-environment node
 *
 * The single topic primitive. `deriveTopicFromTags` is the SHARED derivation the
 * selector (read), recordProposalFeedback (write), and deriveInterestFromBehavior
 * (seed) all key on — unifying the three previously-disjoint key-spaces. It is
 * behaviour-identical to the selector's old private `deriveCandidateTopic` (primary
 * non-empty tag, kebab, entityType fallback) so the extraction changes nothing.
 * `meaningfulTags` adds stopword filtering used ONLY by the seed side.
 */
import {
  deriveTopicFromTags,
  deriveFeedbackTopic,
  meaningfulTags,
  normalizeTopicKey,
  TOPIC_SEPARATOR_CHARACTERS,
  TAG_STOPWORDS,
} from '../candidate-topic';

describe('normalizeTopicKey', () => {
  it('canonicalizes whitespace, repeated hyphens, and case', () => {
    expect(normalizeTopicKey('  RAG   Pipelines  ')).toBe('rag-pipelines');
    expect(normalizeTopicKey('graph--rag')).toBe('graph-rag');
  });

  it('uses one explicit Unicode separator alphabet and removes boundary-only separators', () => {
    expect(normalizeTopicKey('--\u2003Graph\u202f RAG\u3000--')).toBe('graph-rag');
    expect(normalizeTopicKey('\u00a0-\u1680-\ufeff')).toBe('');
    for (const separator of TOPIC_SEPARATOR_CHARACTERS) {
      expect(normalizeTopicKey(`left${separator}right`)).toBe('left-right');
    }
  });
});

describe('deriveTopicFromTags (selector-parity primitive)', () => {
  it('returns the kebab-cased primary tag', () => {
    expect(deriveTopicFromTags(['Vector Database', 'ai'], 'technology')).toBe('vector-database');
  });

  it('lowercases and collapses whitespace runs', () => {
    expect(deriveTopicFromTags(['LLM   Orchestration'], 'technology')).toBe('llm-orchestration');
  });

  it('falls back to entityType when there is no usable tag', () => {
    expect(deriveTopicFromTags([], 'technology')).toBe('technology');
    expect(deriveTopicFromTags(['  ', ''], 'useCase')).toBe('usecase');
    expect(deriveTopicFromTags(['---', '\u2003', 'Graph RAG'], 'technology')).toBe('graph-rag');
  });

  it('tolerates non-array / non-string input (selector parity)', () => {
    expect(deriveTopicFromTags(undefined, 'painPoint')).toBe('painpoint');
    expect(deriveTopicFromTags([42, 'graph-db'], 'technology')).toBe('graph-db');
  });

  it('does NOT stopword-filter (a meta tag is still a valid primary topic here)', () => {
    // Parity: the selector ranks on the primary tag whatever it is. Only the SEED
    // side (meaningfulTags) drops meta tags.
    expect(deriveTopicFromTags(['competitor', 'pqc'], 'company')).toBe('competitor');
  });
});

describe('deriveFeedbackTopic (M17 — first meaningful tag)', () => {
  it('keys on the first MEANINGFUL tag, skipping a leading stopword', () => {
    // The selector reads weights over meaningfulTags, so feedback must land there
    // too — a stopword-keyed posterior is stranded and inverts the exploration bonus.
    expect(deriveFeedbackTopic(['competitor', 'Vector Database'], 'technology')).toBe('vector-database');
  });

  it('falls back to entityType when every tag is a stopword', () => {
    expect(deriveFeedbackTopic(['competitor', 'hyped'], 'technology')).toBe('technology');
  });

  it('falls back to entityType when there are no tags', () => {
    expect(deriveFeedbackTopic([], 'painPoint')).toBe('painpoint');
    expect(deriveFeedbackTopic(undefined, 'useCase')).toBe('usecase');
  });
});

describe('meaningfulTags (seed-side filter)', () => {
  it('drops stopwords + blanks and kebabs the rest', () => {
    expect(meaningfulTags(['e2e-test', 'AI', 'competitor', 'Vector DB', '', '---', '\u2003'])).toEqual([
      'ai',
      'vector-db',
    ]);
  });

  it('returns [] when everything is noise', () => {
    expect(meaningfulTags(['e2e-test', 'ai-created'])).toEqual([]);
  });

  it('tolerates non-array input', () => {
    expect(meaningfulTags(undefined)).toEqual([]);
  });

  it('TAG_STOPWORDS holds known meta tags from real exploration data', () => {
    expect(TAG_STOPWORDS.has('e2e-test')).toBe(true);
    expect(TAG_STOPWORDS.has('competitor')).toBe(true);
    expect(TAG_STOPWORDS.has('llm')).toBe(false); // a real topic, never a stopword
  });
});
