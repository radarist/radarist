/**
 * @file InsightCard.test.tsx
 * @description Regression tests for the briefing-page insight card.
 *
 * Pins three fixes:
 *   1. 2026-05-12 — click target switched from `relatedEntities[0]`
 *      (non-deterministic Neo4j collect()) to `observedEntityId`.
 *   2. Phase 0 step 0.10 (2026-05-13) — navigation switched from
 *      `useSheetUrl().openSheet(id)` to `router.push(insight.actionUrl)`.
 *      openSheet only updated `?sheet=<id>` on /briefing, which has no
 *      sheet container — the old behaviour was a silent no-op.
 *   3. Phase 0 step 0.10 (2026-05-13) — when `insight.actionUrl` is
 *      absent (older insights), the unified `getInsightAction` helper
 *      derives the URL from the primary entity's type. If neither path
 *      yields a URL the button is hidden.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { InsightCard } from '../InsightCard';
import type { BriefingInsight } from '@/hooks/useBriefing';

// lucide-react ships as ESM and Jest's CJS transform can't load it. Stub
// each icon as a span so the card renders in the test environment.
jest.mock('lucide-react', () => ({
  __esModule: true,
  Search: () => null,
  TrendingUp: () => null,
  Link2: () => null,
  X: () => null,
}));

const mockPush = jest.fn();

jest.mock('next/navigation', () => ({
  __esModule: true,
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: jest.fn().mockResolvedValue({ ok: true }),
}));

function makeInsight(overrides: Partial<BriefingInsight> = {}): BriefingInsight {
  return {
    id: 'insight-1',
    type: 'connection',
    title: 'Test insight',
    summary: 'Path goes through VENDOR → USES.',
    agentName: 'scout',
    confidenceScore: 0.9,
    relatedEntities: [
      { id: 'tech-quantum', name: 'Quantum', type: 'technology' },
      { id: 'comp-ibm', name: 'IBM', type: 'company' },
    ],
    actionable: true,
    actionUrl: '/library/companies?sheet=comp-ibm',
    actionLabel: 'View company',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('InsightCard', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it('navigates to the persisted actionUrl when the view button is clicked', () => {
    // Post-fix insights carry an `actionUrl` like
    // `/library/companies?sheet=<id>`. The card must router.push it
    // verbatim — anything else (e.g. only writing `?sheet=<id>` on the
    // current route) is the silent-no-op regression we just fixed.
    const insight = makeInsight({
      observedEntityId: 'comp-ibm',
      exploredEntityId: 'tech-quantum',
      actionUrl: '/library/companies?sheet=comp-ibm',
    });
    render(<InsightCard insight={insight} onDismiss={jest.fn()} />);

    fireEvent.click(screen.getByTestId('insight-view-insight-1'));

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/library/companies?sheet=comp-ibm');
  });

  it('falls back to a library URL derived from the observed entity when actionUrl is missing', () => {
    // Older insights stored before the actionUrl plumbing landed don't
    // carry the URL. The card derives one from the observed entity's
    // type via `getInsightAction`.
    const insight = makeInsight({
      observedEntityId: 'comp-ibm',
      exploredEntityId: 'tech-quantum',
      actionUrl: undefined,
    });
    render(<InsightCard insight={insight} onDismiss={jest.fn()} />);

    fireEvent.click(screen.getByTestId('insight-view-insight-1'));

    expect(mockPush).toHaveBeenCalledWith('/library/companies?company=comp-ibm');
  });

  it('falls back to relatedEntities[0] when actionUrl AND observedEntityId are missing', () => {
    const insight = makeInsight({
      observedEntityId: undefined,
      exploredEntityId: undefined,
      actionUrl: undefined,
    });
    render(<InsightCard insight={insight} onDismiss={jest.fn()} />);

    fireEvent.click(screen.getByTestId('insight-view-insight-1'));

    expect(mockPush).toHaveBeenCalledWith('/library/technologies?technology=tech-quantum');
  });

  it('hides the view button when no target URL can be derived', () => {
    // No actionUrl, no observed entity, no related entities — nothing to
    // navigate to, so the button stays off-screen. Dismiss remains
    // available so the user can still clear the card.
    const insight = makeInsight({
      observedEntityId: undefined,
      exploredEntityId: undefined,
      actionUrl: undefined,
      relatedEntities: [],
    });
    render(<InsightCard insight={insight} onDismiss={jest.fn()} />);

    expect(screen.queryByTestId('insight-view-insight-1')).toBeNull();
    expect(screen.getByTestId('insight-dismiss-insight-1')).toBeInTheDocument();
  });

  it('hides the view button when the entity type is unknown (helper returns null URL)', () => {
    // Regression guard for the `getInsightAction` null-URL contract from
    // step 0.4: unknown entity types must not produce a `/library`
    // home-page click destination.
    const insight = makeInsight({
      observedEntityId: undefined,
      exploredEntityId: undefined,
      actionUrl: undefined,
      relatedEntities: [{ id: 'm-1', name: 'Mystery', type: 'mystery' }],
    });
    render(<InsightCard insight={insight} onDismiss={jest.fn()} />);

    expect(screen.queryByTestId('insight-view-insight-1')).toBeNull();
  });

  it('dismiss button fires the onDismiss callback with the insight id', () => {
    const onDismiss = jest.fn();
    const insight = makeInsight();
    render(<InsightCard insight={insight} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByTestId('insight-dismiss-insight-1'));

    expect(onDismiss).toHaveBeenCalledWith('insight-1');
  });
});
