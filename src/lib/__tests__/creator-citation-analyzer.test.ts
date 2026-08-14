import { analyzeCreatorCitations } from '../mission-quality/analyzers/creator-citation-analyzer';
import type { ScoutBundle } from '../schemas/scout-bundle';

function makeBundle(ids: number[]): ScoutBundle {
  return {
    queries: ['q1', 'q2', 'q3'],
    sources: ids.map((id) => ({
      id,
      title: `Source ${id}`,
      url: `https://example.com/${id}`,
      fetched_via: 'exa' as const,
      tool_call_id: `toolu_${id}`,
      admiralty: 'A2',
      date_accessed: '2026-04-23',
    })),
    findings: ['anything [1]'],
    unresolved: [],
  };
}

describe('analyzeCreatorCitations', () => {
  it('passes when every [N] citation resolves to a bundle source id', () => {
    const result = analyzeCreatorCitations(
      'The report says cost dropped 30% [1] and adoption rose [2].',
      makeBundle([1, 2, 3])
    );
    expect(result.ok).toBe(true);
  });

  it('fails when a [N] citation references an unknown source id', () => {
    const result = analyzeCreatorCitations(
      'The report says cost dropped 30% [1] and adoption rose [7].',
      makeBundle([1, 2, 3])
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unknownIds).toEqual([7]);
    }
  });

  it('reports multiple unknown citations deduplicated and sorted', () => {
    const result = analyzeCreatorCitations(
      'Claim A [99], claim B [1], claim C [99], claim D [42].',
      makeBundle([1, 2])
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unknownIds).toEqual([42, 99]);
    }
  });

  it('passes for a qualitative report with no [N] citations', () => {
    const result = analyzeCreatorCitations(
      'The report is a qualitative analysis with no quantitative claims.',
      makeBundle([1, 2])
    );
    expect(result.ok).toBe(true);
  });

  it('fails when any [N] is used with an empty bundle.sources[]', () => {
    const result = analyzeCreatorCitations('The report says cost dropped 30% [1].', {
      queries: ['q1', 'q2', 'q3'],
      sources: [],
      findings: ['x'],
      unresolved: [],
    } as unknown as ScoutBundle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unknownIds).toEqual([1]);
    }
  });

  it('does not flag [N] inside a ```json block as a citation', () => {
    const result = analyzeCreatorCitations(
      'The report analysis follows.\n\n```json\n{"findings": ["cost dropped 30% [99]"]}\n```\n\nThe creator says cost dropped 30% [1].',
      makeBundle([1, 2])
    );
    expect(result.ok).toBe(true);
  });
});
