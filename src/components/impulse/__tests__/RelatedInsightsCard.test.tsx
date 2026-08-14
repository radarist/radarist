/**
 * @file RelatedInsightsCard.test.tsx
 * @description Tests the insight-detail main-column "Related insights" card
 * (Task 20 / P-D4) — both the pure `selectRelatedInsights` filter and the
 * rendered component.
 *
 * Pins:
 *   1. `selectRelatedInsights` excludes the current insight itself.
 *   2. Includes same-type insights.
 *   3. Includes insights that share at least one linked entity, even with
 *      a different type.
 *   4. Excludes insights that are neither same-type nor entity-overlapping.
 *   5. Caps the result at `limit` (default 5).
 *   6. The component renders nothing when the filter yields zero rows.
 *   7. Row click navigates to that insight's own detail page.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  __esModule: true,
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('lucide-react', () => {
  const Stub = () => null;
  return new Proxy({}, { get: () => Stub });
});

import { RelatedInsightsCard, selectRelatedInsights } from '../RelatedInsightsCard';
import type { BriefingInsight } from '@/hooks/useBriefing';

function makeInsight(overrides: Partial<BriefingInsight> = {}): BriefingInsight {
  return {
    id: 'pi-1',
    type: 'connection',
    title: 'Quantum link',
    summary: 'Path goes through VENDOR → USES.',
    agentName: 'scout',
    confidenceScore: 0.8,
    relatedEntities: [{ id: 'comp-ibm', name: 'IBM', type: 'company' }],
    actionable: true,
    actionUrl: '/library/companies?sheet=comp-ibm',
    actionLabel: 'View',
    createdAt: '2026-05-13T00:00:00.000Z',
    liked: false,
    ...overrides,
  };
}

describe('selectRelatedInsights', () => {
  it('excludes the current insight itself', () => {
    const current = makeInsight({ id: 'pi-1' });
    const result = selectRelatedInsights(current, [current]);
    expect(result).toHaveLength(0);
  });

  it('includes same-type insights even without a shared entity', () => {
    const current = makeInsight({ id: 'pi-1', type: 'connection', relatedEntities: [] });
    const other = makeInsight({ id: 'pi-2', type: 'connection', relatedEntities: [] });
    const result = selectRelatedInsights(current, [current, other]);
    expect(result.map((i) => i.id)).toEqual(['pi-2']);
  });

  it('includes insights that share a linked entity, regardless of type', () => {
    const current = makeInsight({
      id: 'pi-1',
      type: 'connection',
      relatedEntities: [{ id: 'comp-ibm', name: 'IBM', type: 'company' }],
    });
    const other = makeInsight({
      id: 'pi-2',
      type: 'pattern',
      relatedEntities: [{ id: 'comp-ibm', name: 'IBM', type: 'company' }],
    });
    const result = selectRelatedInsights(current, [current, other]);
    expect(result.map((i) => i.id)).toEqual(['pi-2']);
  });

  it('excludes insights that are neither same-type nor entity-overlapping', () => {
    const current = makeInsight({
      id: 'pi-1',
      type: 'connection',
      relatedEntities: [{ id: 'comp-ibm', name: 'IBM', type: 'company' }],
    });
    const other = makeInsight({
      id: 'pi-2',
      type: 'pattern',
      relatedEntities: [{ id: 'tech-quantum', name: 'Quantum Computing', type: 'technology' }],
    });
    const result = selectRelatedInsights(current, [current, other]);
    expect(result).toHaveLength(0);
  });

  it('caps the result at the given limit', () => {
    const current = makeInsight({ id: 'pi-1', type: 'connection', relatedEntities: [] });
    const others = Array.from({ length: 8 }, (_, i) => makeInsight({ id: `pi-${i + 2}`, type: 'connection' }));
    const result = selectRelatedInsights(current, [current, ...others], 5);
    expect(result).toHaveLength(5);
  });

  it('defaults the limit to 5', () => {
    const current = makeInsight({ id: 'pi-1', type: 'connection', relatedEntities: [] });
    const others = Array.from({ length: 8 }, (_, i) => makeInsight({ id: `pi-${i + 2}`, type: 'connection' }));
    const result = selectRelatedInsights(current, [current, ...others]);
    expect(result).toHaveLength(5);
  });
});

describe('RelatedInsightsCard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders nothing when no other insight matches', () => {
    const current = makeInsight({ id: 'pi-1' });
    const { container } = render(<RelatedInsightsCard current={current} allInsights={[current]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a row per matching insight with its title', () => {
    const current = makeInsight({ id: 'pi-1', type: 'connection', relatedEntities: [] });
    const other = makeInsight({ id: 'pi-2', type: 'connection', title: 'Another connection', relatedEntities: [] });
    render(<RelatedInsightsCard current={current} allInsights={[current, other]} />);
    expect(screen.getByTestId('related-insights-card')).toBeInTheDocument();
    expect(screen.getByTestId('related-insight-pi-2')).toHaveTextContent('Another connection');
  });

  it('navigates to the clicked insight detail page', () => {
    const current = makeInsight({ id: 'pi-1', type: 'connection', relatedEntities: [] });
    const other = makeInsight({ id: 'pi-2', type: 'connection', title: 'Another connection', relatedEntities: [] });
    render(<RelatedInsightsCard current={current} allInsights={[current, other]} />);
    fireEvent.click(screen.getByTestId('related-insight-pi-2'));
    expect(mockPush).toHaveBeenCalledWith('/triage/insights/pi-2');
  });
});
