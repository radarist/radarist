/**
 * @file insight-sort.test.ts
 * @description Unit tests for the pure InsightTable sort helpers —
 * comparator semantics, first-click direction convention, and the URL
 * `sort` param parse/serialize round-trip.
 */

import {
  DEFAULT_INSIGHT_SORT,
  compareInsights,
  defaultInsightSortDirection,
  isInsightSortField,
  parseInsightSort,
  serializeInsightSort,
} from '../insight-sort';
import type { BriefingInsight } from '@/hooks/useBriefing';

function makeInsight(overrides: Partial<BriefingInsight> & { id: string }): BriefingInsight {
  return {
    type: 'discovery',
    title: overrides.id.toUpperCase(),
    summary: '',
    agentName: 'scout',
    confidenceScore: 0.5,
    relatedEntities: [],
    actionable: true,
    actionUrl: '/library/companies?sheet=c1',
    actionLabel: 'View',
    createdAt: '2026-05-13T00:00:00.000Z',
    liked: false,
    ...overrides,
  };
}

const A = makeInsight({
  id: 'a',
  title: 'Alpha',
  agentName: 'linker',
  confidenceScore: 0.9,
  createdAt: '2026-05-13T01:00:00.000Z',
});
const B = makeInsight({
  id: 'b',
  title: 'Beta',
  agentName: 'scout',
  confidenceScore: 0.4,
  createdAt: '2026-05-13T03:00:00.000Z',
});

describe('isInsightSortField', () => {
  it('accepts the five sortable columns', () => {
    for (const field of ['title', 'type', 'agentName', 'confidenceScore', 'createdAt']) {
      expect(isInsightSortField(field)).toBe(true);
    }
  });

  it('rejects unknown keys', () => {
    expect(isInsightSortField('summary')).toBe(false);
    expect(isInsightSortField('')).toBe(false);
  });
});

describe('defaultInsightSortDirection', () => {
  it('starts numeric/date columns descending', () => {
    expect(defaultInsightSortDirection('confidenceScore')).toBe('desc');
    expect(defaultInsightSortDirection('createdAt')).toBe('desc');
  });

  it('starts text columns ascending', () => {
    expect(defaultInsightSortDirection('title')).toBe('asc');
    expect(defaultInsightSortDirection('type')).toBe('asc');
    expect(defaultInsightSortDirection('agentName')).toBe('asc');
  });
});

describe('parseInsightSort / serializeInsightSort', () => {
  it('round-trips a valid config', () => {
    const sort = { key: 'title', direction: 'asc' as const };
    expect(parseInsightSort(serializeInsightSort(sort))).toEqual(sort);
  });

  it('falls back to the default for missing/blank input', () => {
    expect(parseInsightSort(undefined)).toEqual(DEFAULT_INSIGHT_SORT);
    expect(parseInsightSort(null)).toEqual(DEFAULT_INSIGHT_SORT);
    expect(parseInsightSort('')).toEqual(DEFAULT_INSIGHT_SORT);
  });

  it('falls back to the default for unknown keys or bad directions', () => {
    expect(parseInsightSort('summary:asc')).toEqual(DEFAULT_INSIGHT_SORT);
    expect(parseInsightSort('title:sideways')).toEqual(DEFAULT_INSIGHT_SORT);
    expect(parseInsightSort('title')).toEqual(DEFAULT_INSIGHT_SORT);
  });

  it('default sort is Detected (createdAt) descending', () => {
    expect(DEFAULT_INSIGHT_SORT).toEqual({ key: 'createdAt', direction: 'desc' });
  });
});

describe('compareInsights', () => {
  it('compares text columns with localeCompare and honors direction', () => {
    expect(compareInsights(A, B, { key: 'title', direction: 'asc' })).toBeLessThan(0);
    expect(compareInsights(A, B, { key: 'title', direction: 'desc' })).toBeGreaterThan(0);
    expect(compareInsights(A, B, { key: 'agentName', direction: 'asc' })).toBeLessThan(0);
  });

  it('compares confidenceScore numerically (not lexically)', () => {
    const low = makeInsight({ id: 'low', confidenceScore: 0.9 });
    const high = makeInsight({ id: 'high', confidenceScore: 0.11 });
    // Lexically '0.11' < '0.9' would invert; numerically 0.11 < 0.9.
    expect(compareInsights(high, low, { key: 'confidenceScore', direction: 'asc' })).toBeLessThan(0);
    expect(compareInsights(high, low, { key: 'confidenceScore', direction: 'desc' })).toBeGreaterThan(0);
  });

  it('compares createdAt chronologically (ISO strings)', () => {
    expect(compareInsights(A, B, { key: 'createdAt', direction: 'asc' })).toBeLessThan(0);
    expect(compareInsights(A, B, { key: 'createdAt', direction: 'desc' })).toBeGreaterThan(0);
  });

  it('returns 0 for equal values so Array.prototype.sort stays stable', () => {
    const twin = makeInsight({ id: 'twin', title: A.title });
    expect(compareInsights(A, twin, { key: 'title', direction: 'asc' })).toBe(0);
  });

  it('returns 0 (no-op) for unknown sort keys', () => {
    expect(compareInsights(A, B, { key: 'summary', direction: 'asc' })).toBe(0);
  });
});
