import { refinePreludeTargets, MAX_PRELUDE_TARGETS } from '../targets';

describe('refinePreludeTargets', () => {
  describe('acceptance + normalization', () => {
    it('accepts clean entity names unchanged', () => {
      const r = refinePreludeTargets(['Anthropic', 'Workday Skills Cloud', 'Eightfold AI']);
      expect(r.accepted).toEqual(['Anthropic', 'Workday Skills Cloud', 'Eightfold AI']);
      expect(r.rejected).toEqual([]);
      expect(r.duplicates).toEqual([]);
      expect(r.droppedForCountCap).toEqual([]);
    });

    it('strips markdown bullet, emphasis, list-number, and trailing punctuation artifacts', () => {
      const r = refinePreludeTargets(['- **Anthropic**', '1. OpenAI', '`Cohere`', 'Mistral AI.']);
      expect(r.accepted).toEqual(['Anthropic', 'OpenAI', 'Cohere', 'Mistral AI']);
    });

    it('collapses internal whitespace', () => {
      const r = refinePreludeTargets(['Hugging   Face']);
      expect(r.accepted).toEqual(['Hugging Face']);
    });
  });

  describe('rejects non-resolvable fragments with a reason', () => {
    const cases: Array<[string, string]> = [
      ['2024', 'timeframe'],
      ['2024-2026', 'timeframe'],
      ['next 5 years', 'timeframe'],
      ['Q1 2025', 'timeframe'],
      ['H2 2026', 'timeframe'],
      ['present', 'timeframe'],
      ['42', 'numeric'],
      ['35%', 'numeric'],
      ['$5B', 'numeric'],
      ['20 percent', 'numeric'],
      ['5 billion', 'numeric'],
      ['Q3', 'timeframe'],
      ['the market', 'generic-prose'],
      ['emerging technologies', 'generic-prose'],
      ['various vendors', 'generic-prose'],
      ['Executive Summary', 'generic-prose'],
      ['Introduction', 'generic-prose'],
      ['Inc', 'generic-prose'],
      ['DEPTH: full', 'malformed'],
      ['a | b', 'malformed'],
      ['A', 'too-short'],
      ['x'.repeat(120), 'too-long'],
      ['   ', 'empty'],
    ];
    it.each(cases)('rejects %p as %s', (input, reason) => {
      const r = refinePreludeTargets([input]);
      expect(r.accepted).toEqual([]);
      expect(r.rejected).toHaveLength(1);
      expect(r.rejected[0].reason).toBe(reason);
    });

    it('keeps a borderline name when only a leading article is generic (precision over recall)', () => {
      // "the talent marketplace" has non-generic tokens -> not dropped as generic prose
      const r = refinePreludeTargets(['The Talent Marketplace']);
      expect(r.accepted).toEqual(['The Talent Marketplace']);
    });

    it('keeps ambiguous glued digit+letter tokens — real company names (precision over recall)', () => {
      // "3M" must NOT be read as "3 million"; a bare glued digit+single-letter is
      // ambiguous with real entity names, so it is kept (worst case it runs).
      const r = refinePreludeTargets(['3M', '10x', '23andMe', 'C3.ai', '2K Games']);
      expect(r.accepted).toEqual(['3M', '10x', '23andMe', 'C3.ai', '2K Games']);
      expect(r.rejected).toEqual([]);
    });
  });

  describe('deduplication', () => {
    it('dedupes case-insensitively, keeping the first occurrence', () => {
      const r = refinePreludeTargets(['Anthropic', 'anthropic', 'ANTHROPIC']);
      expect(r.accepted).toEqual(['Anthropic']);
      expect(r.duplicates.map((d) => d.value)).toEqual(['anthropic', 'ANTHROPIC']);
      expect(r.duplicates.every((d) => d.canonicalKey === 'anthropic')).toBe(true);
    });

    it('folds diacritics when deduping', () => {
      const r = refinePreludeTargets(['Nestlé', 'Nestle']);
      expect(r.accepted).toEqual(['Nestlé']);
      expect(r.duplicates.map((d) => d.value)).toEqual(['Nestle']);
    });
  });

  describe('independent count cap', () => {
    it(`caps accepted targets at MAX_PRELUDE_TARGETS (${MAX_PRELUDE_TARGETS})`, () => {
      const many = Array.from({ length: MAX_PRELUDE_TARGETS + 3 }, (_, i) => `Vendor${i}`);
      const r = refinePreludeTargets(many);
      expect(r.accepted).toHaveLength(MAX_PRELUDE_TARGETS);
      expect(r.droppedForCountCap).toHaveLength(3);
      expect(r.countCap).toBe(MAX_PRELUDE_TARGETS);
    });

    it('honors an explicit lower cap', () => {
      const r = refinePreludeTargets(['A Corp', 'B Corp', 'C Corp'], { maxTargets: 2 });
      expect(r.accepted).toEqual(['A Corp', 'B Corp']);
      expect(r.droppedForCountCap).toEqual(['C Corp']);
      expect(r.countCap).toBe(2);
    });

    it('applies rejection and dedup BEFORE the count cap', () => {
      // 6 raw: 2 junk + 1 dup -> 3 unique valid, under the cap, so nothing is dropped for cap
      const r = refinePreludeTargets(['Gloat', '2025', 'Gloat', 'the market', 'Workday', 'Eightfold']);
      expect(r.accepted).toEqual(['Gloat', 'Workday', 'Eightfold']);
      expect(r.droppedForCountCap).toEqual([]);
    });
  });

  describe('ARUN-025 real-world SCOPE line', () => {
    it('keeps only resolvable unique entities and explains every drop', () => {
      const r = refinePreludeTargets([
        'Workday Skills Cloud',
        'Eightfold AI',
        'Gloat',
        '2024-2026',
        'the market',
        'Gloat',
      ]);
      expect(r.accepted).toEqual(['Workday Skills Cloud', 'Eightfold AI', 'Gloat']);
      expect(r.rejected).toEqual([
        { value: '2024-2026', reason: 'timeframe' },
        { value: 'the market', reason: 'generic-prose' },
      ]);
      expect(r.duplicates).toEqual([{ value: 'Gloat', canonicalKey: 'gloat' }]);
    });
  });

  describe('empty input', () => {
    it('returns empty buckets for an empty list', () => {
      expect(refinePreludeTargets([])).toEqual({
        accepted: [],
        rejected: [],
        duplicates: [],
        droppedForCountCap: [],
        countCap: MAX_PRELUDE_TARGETS,
      });
    });
  });
});
