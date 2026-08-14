/**
 * @file briefing/__tests__/page.test.tsx
 * @description H5 regression — verifies the /briefing page exists and
 * mounts BriefingFeed so sweep-cycle insights have a UI surface.
 *
 * Regression: sweep-cycle insights must be consumed by the triage surface.
 * sweep → Neo4j → /api/impulse/briefing → useBriefing → BriefingFeed, but
 * the /briefing route was deleted in OSS cleanup so the feed component was
 * orphaned. This test pins the page back into the routing tree.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// SmartLayout pulls in firebase-admin transitively via its sidebar links;
// stub the heavyweight layout modules to a passthrough so the test stays
// at unit scope. The point of this test is mount-validation, not layout.
jest.mock('@/components/layout/AppLayoutV2', () => ({
  __esModule: true,
  SmartLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="layout">{children}</div>,
}));
jest.mock('@/components/layout/PageShell', () => ({
  __esModule: true,
  PageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock('@/components/feedback/ErrorBoundary', () => ({
  __esModule: true,
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock useBriefing to return one sweep-cycle insight. This is the canonical
// shape returned by /api/impulse/briefing after Neo4j detects an insight via
// detectInsightsForUser in the sweep cycle's REFLECT step.
jest.mock('@/hooks/useBriefing', () => {
  const briefingKeys = {
    all: ['briefing'] as const,
    insights: () => ['briefing', 'insights'] as const,
  };
  return {
    __esModule: true,
    briefingKeys,
    useBriefing: () => ({
      data: {
        insights: [
          {
            id: 'pi-h5-sweep-1',
            type: 'discovery',
            title: 'Sweep cycle insight: 3 new gaps',
            summary: 'Sweep discovered three data-quality gaps overnight.',
            agentName: 'sweep-cycle',
            confidenceScore: 0.8,
            relatedEntities: [],
            actionable: false,
            actionUrl: undefined,
            actionLabel: undefined,
            createdAt: '2026-05-04T00:00:00.000Z',
          },
        ],
        tokenUsage: { used: 500, budget: 100_000 },
      },
      isLoading: false,
    }),
  };
});

// InsightCard now uses next/navigation's useRouter (Phase 0 step 0.10 —
// the openSheet path was a silent no-op on /briefing). Stub it so the page
// can render outside an actual Next app-router context.
//
// Option A Chunk 4 added `useUrlState` to the toolbar, which leans on
// `usePathname` and `useSearchParams` — extend the mock to satisfy
// both. `URLSearchParams` works fine without a polyfill in jsdom.
jest.mock('next/navigation', () => ({
  __esModule: true,
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
    refresh: jest.fn(),
    prefetch: jest.fn(),
  }),
  usePathname: () => '/triage/insights',
  useSearchParams: () => new URLSearchParams(),
}));

// firebase auth + fetchWithAuth get touched on dismiss; not needed for this
// test path but stub them to keep the import graph quiet.
jest.mock('@/lib/firebase', () => ({ auth: {}, db: {} }));
// UX-051: the empty state resolves its pipeline status through a uid-scoped
// hook, so the page now reaches AuthProvider → firebase/auth (which needs a
// global fetch this jsdom env lacks). Stub the provider, as sibling suites do.
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { uid: 'user-insights-page' }, loading: false }),
}));
jest.mock('@/lib/fetch-with-auth', () => ({
  __esModule: true,
  fetchWithAuth: jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
}));

// lucide-react ships ESM that Jest's CJS transform can't load directly.
// Stub each icon to a tagged span so InsightCard can still render them.
jest.mock('lucide-react', () => {
  const makeIcon = (name: string) => {
    const Icon = (props: Record<string, unknown>) => (
      <span data-testid={`icon-${name}`} className={props.className as string} />
    );
    Icon.displayName = name;
    return Icon;
  };
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => makeIcon(prop),
    }
  );
});

import InsightsPage from '../page';

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('/triage/insights page', () => {
  it('renders BriefingFeed and surfaces sweep-cycle insights', () => {
    renderWithQuery(<InsightsPage />);

    // The feed container is mounted (not the empty state).
    expect(screen.getByTestId('briefing-feed')).toBeInTheDocument();

    // The sweep-cycle insight title is visible to the user — this is the
    // Phase 4 acceptance check made local: at least one proactive insight
    // is rendered in the briefing UI.
    expect(screen.getByText('Sweep cycle insight: 3 new gaps')).toBeInTheDocument();

    // Page heading reflects the 2026-05-13 rename from "Briefing".
    expect(screen.getByRole('heading', { level: 1, name: 'Insights' })).toBeInTheDocument();
  });
});
