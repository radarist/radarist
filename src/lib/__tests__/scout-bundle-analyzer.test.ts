import { analyzeCitationPadding } from '../mission-quality/analyzers/scout-bundle-analyzer';
import type { ScoutBundle } from '../schemas/scout-bundle';

function makeBundle(overrides: Partial<ScoutBundle> = {}): ScoutBundle {
  return {
    queries: ['q1', 'q2', 'q3'],
    sources: [
      {
        id: 1,
        title: 'S1',
        url: 'https://s1.example.com',
        fetched_via: 'exa',
        tool_call_id: 'toolu_1',
        admiralty: 'A2',
        date_accessed: '2026-04-23',
        snippet: 'Cost dropped 30% in 2026.',
      },
      {
        id: 2,
        title: 'S2',
        url: 'https://s2.example.com',
        fetched_via: 'exa',
        tool_call_id: 'toolu_2',
        admiralty: 'B2',
        date_accessed: '2026-04-23',
        snippet: 'Adoption reached 40% of Fortune 500.',
      },
    ],
    findings: ['Cost dropped 30% [1, 2]'],
    unresolved: [],
    ...overrides,
  };
}

describe('analyzeCitationPadding', () => {
  it('passes when all multi-cite numeric findings have snippets containing the claim number', () => {
    const bundle = makeBundle({
      sources: [
        {
          id: 1,
          title: 'S1',
          url: 'https://s1.example.com',
          fetched_via: 'exa',
          tool_call_id: 'toolu_1',
          admiralty: 'A2',
          date_accessed: '2026-04-23',
          snippet: 'Cost dropped 30% in 2026 according to report.',
        },
        {
          id: 2,
          title: 'S2',
          url: 'https://s2.example.com',
          fetched_via: 'exa',
          tool_call_id: 'toolu_2',
          admiralty: 'A2',
          date_accessed: '2026-04-23',
          snippet: 'Survey confirmed 30% cost reduction in the sector.',
        },
      ],
      findings: ['Cost dropped 30% [1, 2]'],
    });
    const result = analyzeCitationPadding(bundle);
    expect(result.ok).toBe(true);
  });

  it('passes qualitative findings with no numeric tokens regardless of citation count', () => {
    const bundle = makeBundle({
      findings: ['Enterprise adoption is broadly accelerating [1, 2]'],
    });
    const result = analyzeCitationPadding(bundle);
    expect(result.ok).toBe(true);
  });

  it('passes single-citation findings (handled by the separate single-source rule)', () => {
    const bundle = makeBundle({
      findings: ['Only one source cites this 42% figure [1]'],
    });
    const result = analyzeCitationPadding(bundle);
    expect(result.ok).toBe(true);
  });

  it('fails when a multi-cite numeric finding has a source whose snippet does not contain any of the numbers', () => {
    const bundle = makeBundle({
      sources: [
        {
          id: 1,
          title: 'S1',
          url: 'https://s1.example.com',
          fetched_via: 'exa',
          tool_call_id: 'toolu_1',
          admiralty: 'A2',
          date_accessed: '2026-04-23',
          snippet: 'Cost dropped 30% in 2026.',
        },
        {
          id: 2,
          title: 'S2',
          url: 'https://s2.example.com',
          fetched_via: 'exa',
          tool_call_id: 'toolu_2',
          admiralty: 'B3',
          date_accessed: '2026-04-23',
          snippet: 'General market overview with no matching quantitative data.',
        },
      ],
      findings: ['Cost dropped 30% [1, 2]'],
    });
    const result = analyzeCitationPadding(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].findingIndex).toBe(0);
      expect(result.violations[0].offendingSourceIds).toEqual([2]);
    }
  });

  it('fails when a multi-cite numeric finding cites a source with a missing snippet', () => {
    const bundle = makeBundle({
      sources: [
        {
          id: 1,
          title: 'S1',
          url: 'https://s1.example.com',
          fetched_via: 'exa',
          tool_call_id: 'toolu_1',
          admiralty: 'A2',
          date_accessed: '2026-04-23',
          snippet: 'Cost dropped 30% in 2026.',
        },
        {
          id: 2,
          title: 'S2',
          url: 'https://s2.example.com',
          fetched_via: 'exa',
          tool_call_id: 'toolu_2',
          admiralty: 'C2',
          date_accessed: '2026-04-23',
          // snippet omitted
        },
      ],
      findings: ['Cost dropped 30% [1, 2]'],
    });
    const result = analyzeCitationPadding(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0].offendingSourceIds).toContain(2);
      expect(result.violations[0].reason).toMatch(/snippet/i);
    }
  });

  it('reports multiple violations when several findings pad their citations', () => {
    const bundle = makeBundle({
      sources: [
        {
          id: 1,
          title: 'S1',
          url: 'https://s1.example.com',
          fetched_via: 'exa',
          tool_call_id: 'toolu_1',
          admiralty: 'A2',
          date_accessed: '2026-04-23',
          snippet: 'Cost dropped 30% and prices at $0.28 per million tokens.',
        },
        {
          id: 2,
          title: 'S2',
          url: 'https://s2.example.com',
          fetched_via: 'exa',
          tool_call_id: 'toolu_2',
          admiralty: 'B3',
          date_accessed: '2026-04-23',
          snippet: 'Broad topic coverage without specific numbers.',
        },
        {
          id: 3,
          title: 'S3',
          url: 'https://s3.example.com',
          fetched_via: 'exa',
          tool_call_id: 'toolu_3',
          admiralty: 'A2',
          date_accessed: '2026-04-23',
          snippet: 'Another unrelated topic entirely.',
        },
      ],
      findings: ['Cost dropped 30% [1, 2]', 'Prices hit $0.28 per million tokens [1, 3]'],
    });
    const result = analyzeCitationPadding(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(2);
      expect(result.violations[0].findingIndex).toBe(0);
      expect(result.violations[1].findingIndex).toBe(1);
    }
  });

  it('treats percentages and dollar amounts as numeric tokens (not just bare digits)', () => {
    const bundle = makeBundle({
      sources: [
        {
          id: 1,
          title: 'S1',
          url: 'https://s1.example.com',
          fetched_via: 'exa',
          tool_call_id: 'toolu_1',
          admiralty: 'A2',
          date_accessed: '2026-04-23',
          snippet: 'Price was $0.28 per million tokens.',
        },
        {
          id: 2,
          title: 'S2',
          url: 'https://s2.example.com',
          fetched_via: 'exa',
          tool_call_id: 'toolu_2',
          admiralty: 'A2',
          date_accessed: '2026-04-23',
          snippet: 'A separate corroborating report put pricing at $0.28.',
        },
      ],
      findings: ['Open-weight inference hit $0.28 per million tokens [1, 2]'],
    });
    const result = analyzeCitationPadding(bundle);
    expect(result.ok).toBe(true);
  });
});
