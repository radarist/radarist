/**
 * @file components/__tests__/ResearchDialog.readonly.test.tsx
 * @description UX-061 — the public/shared radar blip detail must perform no
 * authenticated-only requests and expose no mutation controls.
 *
 * TrendChart calls `/api/trends`, the blip link panels read auth-gated Firestore
 * collections, and the Graph button opens an authenticated relationship panel.
 * A signed-out viewer would otherwise get 401s, console permission errors, and
 * mutation affordances. In read-only mode none of these mount; the dialog only
 * renders facts already in the radar payload.
 *
 * @jest-environment jsdom
 */

jest.mock('lucide-react', () => {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined;
        const IconComponent = (props: React.SVGProps<SVGSVGElement>) => <svg data-testid={`icon-${prop}`} {...props} />;
        IconComponent.displayName = prop as string;
        return IconComponent;
      },
    },
  );
});

jest.mock('react-markdown', () => {
  const MockMarkdown = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  MockMarkdown.displayName = 'MockReactMarkdown';
  return MockMarkdown;
});

// Tracked children — each records that it mounted via a test-id sentinel.
jest.mock('../TrendChart', () => ({
  TrendChart: () => <div data-testid="trend-chart" />,
}));
jest.mock('../radar-page/BlipCompanyLinks', () => ({
  BlipCompanyLinks: () => <div data-testid="blip-company-links" />,
}));
jest.mock('../radar-page/BlipUseCaseLinks', () => ({
  BlipUseCaseLinks: () => <div data-testid="blip-use-case-links" />,
}));
jest.mock('@/components/graphs/EntityRelationshipPanel', () => ({
  EntityRelationshipPanel: () => <div data-testid="entity-relationship-panel" />,
}));
jest.mock('../sheets/tabs/TechnologyResearchTab', () => ({
  TechnologyResearchTab: ({ research }: { research?: unknown }) => (
    <div data-testid="technology-research-tab">{String(research ?? '')}</div>
  ),
}));
jest.mock('recharts', () => ({
  LineChart: () => null,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Line: () => null,
  Tooltip: () => null,
}));
jest.mock('@/components/ui/chart', () => ({
  ChartContainer: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  ChartTooltipContent: () => null,
}));
jest.mock('@/lib/migration', () => ({
  safeResolve: jest.fn().mockResolvedValue('tech-resolved'),
}));
jest.mock('@/hooks/useDataRefresh', () => ({
  useDataRefresh: jest.fn(),
}));

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ResearchDialog } from '../ResearchDialog';
import type { RadarEntry } from '@/lib/types';

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const entry: RadarEntry = {
  id: 42,
  name: 'Quantum Mesh',
  description: 'A shared technology entry.',
  quadrantId: 'q_1',
  quadrantName: 'Platforms',
  ring: 'Trial',
  status: 'Stable',
  tags: ['public'],
  history: [],
} as unknown as RadarEntry;

function renderDialog(readOnly: boolean) {
  return render(
    <ResearchDialog
      isOpen
      onOpenChange={jest.fn()}
      entry={entry}
      onDelete={jest.fn()}
      onEdit={jest.fn()}
      onSaveAnalysis={jest.fn()}
      rings={['Adopt', 'Trial', 'Assess', 'Hold']}
      readOnly={readOnly}
      radarId="radar-shared"
    />,
  );
}

describe('ResearchDialog public/read-only contract (UX-061)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('mounts the authenticated sub-fetchers in the authenticated (non-read-only) dialog', () => {
    renderDialog(false);

    expect(screen.getByTestId('trend-chart')).toBeInTheDocument();
    expect(screen.getByTestId('blip-company-links')).toBeInTheDocument();
    expect(screen.getByTestId('blip-use-case-links')).toBeInTheDocument();
    // Graph affordance is present for an authenticated editor.
    expect(screen.getByRole('button', { name: /graph/i })).toBeInTheDocument();
  });

  it('does NOT mount TrendChart, blip link panels, or the Graph panel in read-only mode', () => {
    renderDialog(true);

    // No authenticated-only requests can originate from these.
    expect(screen.queryByTestId('trend-chart')).not.toBeInTheDocument();
    expect(screen.queryByTestId('blip-company-links')).not.toBeInTheDocument();
    expect(screen.queryByTestId('blip-use-case-links')).not.toBeInTheDocument();
    expect(screen.queryByTestId('entity-relationship-panel')).not.toBeInTheDocument();
  });

  it('hides every mutation affordance (Delete, Edit, Graph) in read-only mode', () => {
    renderDialog(true);

    expect(screen.queryByRole('button', { name: /delete entry/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit entry/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /graph/i })).not.toBeInTheDocument();
    // Close (dismiss) is the only footer action a public viewer gets. The
    // Radix X affordance also exposes an sr-only "Close", so assert at least one.
    expect(screen.getAllByRole('button', { name: /close/i }).length).toBeGreaterThan(0);
  });

  it('still renders the radar-payload facts that need no extra request', () => {
    renderDialog(true);

    // Entry name + description come from the already-fetched radar data.
    expect(screen.getByRole('heading', { name: /quantum mesh/i })).toBeInTheDocument();
    expect(screen.getByText(/shared technology entry/i)).toBeInTheDocument();
    // Static research tab (entry.comprehensiveResearch) is shown without a fetch.
    expect(screen.getByTestId('technology-research-tab')).toBeInTheDocument();
  });
});
