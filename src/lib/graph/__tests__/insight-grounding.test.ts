import { groundGraphPathEvidence, validateNarrativeHypothesisLanguage } from '../insight-grounding';

function evidence(overrides: Partial<Parameters<typeof groundGraphPathEvidence>[0]> = {}) {
  return {
    predicates: ['VENDOR'],
    sourceRelationTypes: ['vendor'],
    relationIds: ['rel-1'],
    assertedBy: ['user:u1'],
    claimStatuses: ['curated'],
    edgeConfidences: [100],
    ...overrides,
  };
}

describe('groundGraphPathEvidence', () => {
  it('classifies one reviewed hop as a graph observation', () => {
    expect(groundGraphPathEvidence(evidence())).toEqual({
      ok: true,
      epistemicKind: 'observation',
      predicates: ['VENDOR'],
      sourceRelationTypes: ['vendor'],
      relationIds: ['rel-1'],
      assertedBy: ['user:u1'],
      edgeConfidences: [100],
      hasCounterEvidence: false,
      confidenceCeiling: 0.9,
    });
  });

  it('classifies two reviewed hops as inference rather than a direct relationship', () => {
    const result = groundGraphPathEvidence(
      evidence({
        predicates: ['ALIGNS_WITH', 'USES'],
        sourceRelationTypes: ['aligns_with', 'uses'],
        relationIds: ['rel-1', 'rel-2'],
        assertedBy: ['user:u1', 'agent:linker'],
        claimStatuses: ['curated', 'curated'],
        edgeConfidences: [100, 100],
      })
    );

    expect(result).toMatchObject({
      ok: true,
      epistemicKind: 'inference',
      hasCounterEvidence: false,
      confidenceCeiling: 0.5,
    });
  });

  it('preserves counter-evidence and caps it at the briefing visibility boundary', () => {
    const result = groundGraphPathEvidence(
      evidence({
        predicates: ['ALIGNS_WITH', 'COMPETES_WITH'],
        sourceRelationTypes: ['aligns_with', 'competes_with'],
        relationIds: ['rel-1', 'rel-2'],
        assertedBy: ['user:u1', 'user:u1'],
        claimStatuses: ['curated', 'curated'],
        edgeConfidences: [100, 100],
      })
    );

    expect(result).toMatchObject({
      ok: true,
      epistemicKind: 'inference',
      hasCounterEvidence: true,
      confidenceCeiling: 0.35,
    });
  });

  it.each([
    ['relation identity', { relationIds: [null] }],
    ['asserter identity', { assertedBy: [''] }],
  ])('fails closed when %s provenance is missing', (_label, override) => {
    expect(groundGraphPathEvidence(evidence(override))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Missing durable provenance'),
    });
  });

  it.each(['proposed', 'derived', 'rejected', null])('rejects non-curated claim status %p', (claimStatus) => {
    expect(groundGraphPathEvidence(evidence({ claimStatuses: [claimStatus] }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not curated'),
    });
  });

  it('rejects generic predicates without their source relation semantics', () => {
    expect(
      groundGraphPathEvidence(
        evidence({ predicates: ['RELATED_TO'], sourceRelationTypes: [null] })
      )
    ).toMatchObject({ ok: false, reason: expect.stringContaining('semantic provenance') });
  });

  it('rejects contradictory predicate metadata instead of guessing', () => {
    expect(groundGraphPathEvidence(evidence({ sourceRelationTypes: ['uses'] }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('disagrees'),
    });
  });

  it('caps epistemic confidence by the weakest reviewed edge', () => {
    expect(groundGraphPathEvidence(evidence({ edgeConfidences: [10] }))).toMatchObject({
      ok: true,
      confidenceCeiling: 0.1,
    });
  });

  it.each([null, Number.NaN, -1, 101])('rejects invalid edge confidence %p', (edgeConfidence) => {
    expect(groundGraphPathEvidence(evidence({ edgeConfidences: [edgeConfidence] }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('confidence'),
    });
  });
});

describe('validateNarrativeHypothesisLanguage', () => {
  const narrative = (overrides: Partial<Parameters<typeof validateNarrativeHypothesisLanguage>[0]> = {}) => ({
    title: 'Adjacent theme',
    narrative: 'The path suggests a possible theme worth investigating.',
    impact: 'Further research could assess its strategic relevance.',
    ...overrides,
  });

  it.each([
    ['cross-sentence hedge', { narrative: 'Strategy A funds Company C. This may create value.' }],
    ['late hedge', { narrative: 'Strategy A funds Company C, possibly creating value.' }],
    [
      'contrastive-clause laundering',
      { narrative: 'The team may investigate pricing, but Strategy A funds Company C.' },
    ],
    [
      'new-subject coordination laundering',
      { narrative: 'It could be useful to assess the market and Strategy A owns Company C.' },
    ],
    ['or-clause laundering', { narrative: 'It might be useful to assess pricing or Strategy A funds Company C.' }],
    ['then-clause laundering', { narrative: 'We could investigate pricing then Strategy A funds Company C.' }],
    ['newline laundering', { narrative: 'The team may investigate pricing\nStrategy A funds Company C.' }],
    ['hyphen laundering', { narrative: 'The team may investigate pricing - Strategy A funds Company C.' }],
    ['en-dash laundering', { narrative: 'The team may investigate pricing – Strategy A funds Company C.' }],
    ['em-dash laundering', { narrative: 'The team may investigate pricing—Strategy A funds Company C.' }],
    ['parenthetical laundering', { narrative: 'It may be useful to study pricing (Strategy A funds Company C).' }],
    [
      'unrelated whether laundering',
      { narrative: 'Whether prices rise or fall Strategy A will fund Company C.' },
    ],
    [
      'short unrelated potential laundering',
      { narrative: 'Potential pricing pressure means Strategy A funds Company C.' },
    ],
    [
      'short unrelated possible laundering',
      { narrative: 'Possible market shifts indicate Strategy A owns Company C.' },
    ],
    [
      'short unrelated suggestion laundering',
      { narrative: 'The graph suggests unrelated pricing pressure means Strategy A funds Company C.' },
    ],
    [
      'subordinate suggestion laundering',
      { narrative: 'The path suggests pricing pressure before Strategy A funds Company C.' },
    ],
    [
      'subordinate appearance laundering',
      { narrative: 'The evidence appears relevant as Strategy A owns Company C.' },
    ],
    [
      'whether-conditioned future certainty',
      { narrative: 'Whether pricing conditions change Strategy A will fund Company C.' },
    ],
    [
      'whether-conditioned acquisition certainty',
      { narrative: 'Whether demand improves Strategy A must acquire Company C.' },
    ],
    [
      'negated-evidence polarity laundering',
      { narrative: 'There is no evidence against the fact that Strategy A funds Company C.' },
    ],
    [
      'negated-proof polarity laundering',
      { narrative: 'No proof contradicts the fact that Strategy A owns Company C.' },
    ],
    [
      'negated evidence with contradicting continuation',
      { narrative: 'There is no evidence that contradicts the fact that Strategy A funds Company C.' },
    ],
    [
      'negated proof with false continuation',
      { narrative: 'There is no proof that it is false that Strategy A owns Company C.' },
    ],
    [
      'negated evidence with refuting continuation',
      { narrative: 'There is no evidence that refutes the claim that Strategy A funds Company C.' },
    ],
    [
      'negated proof with disproving continuation',
      { narrative: 'There is no proof that disproves the claim that Strategy A owns Company C.' },
    ],
    [
      'negated evidence with undermining continuation',
      { narrative: 'No evidence that undermines the claim that Strategy A funds Company C.' },
    ],
    [
      'negated evidence with disputed continuation',
      { narrative: 'No evidence that disputes the claim Strategy A funds Company C.' },
    ],
    [
      'negated evidence with invalidating continuation',
      { narrative: 'No evidence that invalidates the claim Strategy A owns Company C.' },
    ],
    [
      'negated evidence with rule-out continuation',
      { narrative: 'No evidence that rules out the claim Strategy A funds Company C.' },
    ],
    ['nominal partnership claim', { narrative: 'Strategy A and Company C have a partnership.' }],
    ['nominal ownership claim', { narrative: 'Strategy A has ownership of Company C.' }],
    ['nominal adoption claim', { narrative: 'The adoption by Strategy A creates value.' }],
    ['mixed qualified and certain actions', { narrative: 'Strategy A may partner with Company C and will fund it.' }],
    ['certainty over ownership', { narrative: 'This proves Strategy A owns Company C.' }],
    ['funding alias', { title: 'Strategy A finances Company C.' }],
    ['bankrolling alias', { title: 'Strategy A bankrolls Company C.' }],
    ['control alias', { title: 'Strategy A controls Company C.' }],
    ['merger alias', { title: 'Strategy A merges with Company C.' }],
    ['contract alias', { title: 'Strategy A contracts with Company C.' }],
    ['alliance nominal', { title: 'Strategy A forms an alliance with Company C.' }],
    ['joint venture nominal', { title: 'Strategy A enters a joint venture with Company C.' }],
    ['takeover alias', { title: 'Strategy A takes over Company C.' }],
    ['unqualified use verb', { title: 'Strategy A uses Platform B.' }],
    ['unqualified noun use', { title: 'The use of Platform B by Strategy A.' }],
    ['unqualified strategic noun use', { title: 'A strategic use of Platform B by Strategy A.' }],
    ['entity suffix mistaken for an article', { title: 'Strategy A use of Platform B.' }],
    [
      'late hedge over noun use',
      { narrative: 'The use of Platform B by Strategy A is unverified.' },
    ],
    [
      'contrast-boundary noun-use laundering',
      { impact: 'This could be irrelevant, but Strategy A benefits through effective use of Platform B.' },
    ],
    [
      'cross-sentence causal claim',
      { narrative: 'The path may indicate a theme. This relationship causes revenue growth for Strategy A.' },
    ],
    [
      'cross-sentence value claim',
      { narrative: 'The path may indicate a theme. This creates strategic value.' },
    ],
    [
      'cross-sentence outcome claim',
      { narrative: 'The path may matter. This results in lower costs.' },
    ],
    [
      'unsupported counter story',
      {
        title: 'Guaranteed partnership',
        narrative: 'The companies will partner and adopt the platform.',
        impact: 'This guarantees revenue.',
      },
    ],
  ])('rejects %s', (_label, override) => {
    expect(validateNarrativeHypothesisLanguage(narrative(override))).toMatchObject({ ok: false });
  });

  it.each([
    'Strategy A may partner with Company C; investigate whether it could create value.',
    'Strategy A may partner with Company C and support Company D.',
    'Strategy A may partner with Company C, and support Company D.',
    'Strategy A may, after evidence review, fund Company C.',
    'Strategy A may (after evidence review) fund Company C.',
    'Strategy A may strategically fund Company C.',
    'Strategy A could eventually partner with Company C.',
    'Strategy A may seek to partner with Company C.',
    'Strategy A may be able to support Company C.',
    'Strategy A might jointly develop the platform.',
    'Strategy A may co-fund Company C.',
    'Strategy A may be a partner of Company C.',
    'Strategy A could become a strategic partner of Company C.',
    'Strategy A appears to support Company C.',
    'The path suggests Strategy A could support Company C, but this remains unverified.',
    'Strategy A may provide technical support to Company C.',
    'Strategy A may develop a supporting capability.',
    'Strategy A could use enabling technology.',
    'Strategy A may, subject to further evidence review, jointly develop a capability.',
    'A plausible partnership opportunity merits investigation.',
    'A hypothetical partnership with Company C merits investigation.',
    'The graph does not show that Strategy A funds Company C.',
    'Further research will assess whether a relationship exists.',
    'Teams must investigate the adjacency.',
    'This could provide strategic value by enabling faster decisions.',
    'This could support innovation by enabling new experiments.',
    'This could create value by reducing costs.',
    'This may improve resilience by supporting alternative suppliers.',
    'This might enable adoption by providing technical support.',
    'A possible use case for the technology warrants investigation.',
    'A potential use of the technology merits research.',
    'Further research could assess the use case.',
    'The path may reveal a use case worth investigating.',
    'This could reduce costs through more efficient use of the platform.',
    'Strategy A may use Platform B.',
    'It is possible that Strategy A funds Company C.',
    'This does not prove Strategy A funds Company C; investigate whether it could.',
    'There is no direct evidence that Strategy A funds Company C.',
    'No direct partnership is established; the adjacency warrants analysis.',
    'Competition may constrain alignment; assess alternatives.',
    'A fundamental question is whether a partnership opportunity merits investigation.',
    'The path may indicate a theme. Teams should monitor the space.',
    'The path may indicate a theme. This relationship could create strategic value.',
  ])('accepts bounded exploratory language: %s', (boundedNarrative) => {
    expect(validateNarrativeHypothesisLanguage(narrative({ narrative: boundedNarrative }))).toEqual({ ok: true });
  });

  it.each([
    'Could Strategy A fund Company C?',
    'Could Strategy A and Company C partner?',
  ])('accepts modal hypothesis title: %s', (title) => {
    expect(validateNarrativeHypothesisLanguage(narrative({ title }))).toEqual({ ok: true });
  });
});
