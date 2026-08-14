import { analyzeSingleSourceQuantitative } from '../mission-quality/analyzers/scout-single-source-analyzer';
import type { ScoutBundle } from '../schemas/scout-bundle';

function bundleWith(findings: string[]): ScoutBundle {
  return {
    queries: ['q1', 'q2', 'q3'],
    sources: [
      {
        id: 1,
        title: 'A',
        url: 'https://a.example',
        fetched_via: 'exa',
        tool_call_id: 't1',
        admiralty: 'A2',
        date_accessed: '2026-04-25',
      },
      {
        id: 2,
        title: 'B',
        url: 'https://b.example',
        fetched_via: 'exa',
        tool_call_id: 't2',
        admiralty: 'A2',
        date_accessed: '2026-04-25',
      },
    ],
    findings,
    unresolved: [],
  } as unknown as ScoutBundle;
}

describe('analyzeSingleSourceQuantitative', () => {
  it('passes when no findings contain quantitative tokens', () => {
    const verdict = analyzeSingleSourceQuantitative(
      bundleWith(['The vendor pivoted to enterprise. [1]', 'Open source community is active. [2]'])
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.quantitativeFindingCount).toBe(0);
  });

  it('passes when a quantitative finding cites two sources', () => {
    const verdict = analyzeSingleSourceQuantitative(bundleWith(['Adoption grew 30% year over year. [1, 2]']));
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.quantitativeFindingCount).toBe(1);
  });

  it('fails when a quantitative finding cites only one source', () => {
    const verdict = analyzeSingleSourceQuantitative(bundleWith(['Adoption grew 30% year over year. [1]']));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations).toHaveLength(1);
      expect(verdict.violations[0].quantitativeMatches).toEqual(['30%']);
      expect(verdict.violations[0].citedSourceIds).toEqual([1]);
    }
  });

  it('reports each violating finding separately when multiple are single-sourced', () => {
    const verdict = analyzeSingleSourceQuantitative(
      bundleWith([
        'Funding closed at $120M. [1]',
        'The community grew 5x in 2 years. [2]',
        'A qualitative story without numbers. [1]',
      ])
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations).toHaveLength(2);
      expect(verdict.violations.map((v) => v.findingIndex).sort()).toEqual([0, 1]);
    }
  });

  it('fails when a quantitative finding has zero citations', () => {
    const verdict = analyzeSingleSourceQuantitative(bundleWith(['Inference latency dropped to 80ms.']));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations[0].citedSourceIds).toEqual([]);
    }
  });

  it('treats years and small counts as non-quantitative (skips them)', () => {
    const verdict = analyzeSingleSourceQuantitative(
      bundleWith([
        'The product launched in 2024 with 3 founding engineers. [1]',
        'It runs on version 1.4 of the framework. [2]',
      ])
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.quantitativeFindingCount).toBe(0);
  });
});
