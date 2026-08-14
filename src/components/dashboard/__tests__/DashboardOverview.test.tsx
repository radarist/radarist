/**
 * Render smoke test for DashboardOverview (G3).
 *
 * Validates that the props-driven dashboard container mounts cleanly with a
 * minimal but type-correct DashboardData fixture and that each of its four
 * child panels renders. Mirrors the canonical sibling pattern from
 * EntitySheetShell.test.tsx — Proxy mock for lucide-react, passthrough mock
 * for next/link, no provider wrapping (no QueryClient required).
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import type { DashboardData } from '@/lib/types';

// Mock lucide-react with a Proxy so any icon import works
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
    }
  );
});

// Mock next/link as a passthrough anchor — panels render real <Link href>s.
jest.mock('next/link', () => {
  const MockLink = ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = 'NextLink';
  return { __esModule: true, default: MockLink };
});

import { DashboardOverview } from '../DashboardOverview';

const fixture: DashboardData = {
  needsAttention: [
    {
      id: 'attn-1',
      type: 'signal-pending',
      title: 'Review pending signal',
      description: 'A new signal awaits triage.',
      priority: 'high',
      timestamp: 1_700_000_000_000,
      actionUrl: '/triage/signals',
    },
  ],
  portfolioMetrics: {
    totalTechnologies: 12,
    technologiesByRing: { Adopt: 4, Trial: 3, Assess: 3, Hold: 2 },
    technologiesByQuadrant: {
      'q-tools': { name: 'Tools', count: 5 },
      'q-techniques': { name: 'Techniques', count: 7 },
    },
    averageStrategicAlignment: 72,
    totalCompanies: 8,
    totalUseCases: 4,
    totalStrategies: 3,
    totalPainPoints: 6,
    prototypeMetrics: {
      total: 5,
      byStatus: { 'In Development': 2, 'Demo Ready': 1, Delivered: 2 },
      activeCount: 3,
      deliveredCount: 2,
      totalEstimatedValue: 100_000,
      totalActualValue: 40_000,
    },
    signalMetrics: {
      totalDetected: 21,
      pendingReview: 5,
      importRate: 0.6,
      averageRelevance: 0.74,
      byType: { news: 12, paper: 9 },
    },
    agentMetrics: {
      totalActivities: 18,
      pendingReview: 2,
      autoActionRate: 0.5,
      averageConfidence: 0.81,
      byAgent: { ScoutAgent: 10, EvaluationAgent: 8 },
    },
  },
  agentFeed: [
    {
      id: 'agent-1',
      type: 'discovery',
      title: 'Scout discovered new technology',
      description: 'ScoutAgent found a new candidate technology.',
      agent: 'ScoutAgent',
      status: 'completed',
      priority: 'medium',
      relatedEntities: { technologies: ['radar-1:tech-1'] },
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    },
  ],
  recentUpdates: [
    {
      id: 'update-1',
      entityType: 'technology',
      entityId: 'tech-1',
      entityName: 'Vector Databases',
      action: 'created',
      description: 'Added to the Adopt ring.',
      timestamp: Date.now() - 60_000,
      actionUrl: '/technologies/tech-1',
    },
  ],
  lastRefreshed: Date.now(),
};

describe('DashboardOverview', () => {
  it('renders without throwing when data is provided', () => {
    expect(() => render(<DashboardOverview data={fixture} />)).not.toThrow();
  });

  it('renders the PortfolioMetricsCards panel', () => {
    render(<DashboardOverview data={fixture} />);
    // PortfolioMetricsCards has no card title — assert via its labels instead.
    expect(screen.getByText('Technologies')).toBeInTheDocument();
    expect(screen.getByText('Companies')).toBeInTheDocument();
    expect(screen.getByText('Pain Points')).toBeInTheDocument();
    expect(screen.getByText('Use Cases')).toBeInTheDocument();
  });

  it('renders the NeedsAttentionPanel with title "Needs Attention"', () => {
    render(<DashboardOverview data={fixture} />);
    expect(screen.getByText('Needs Attention')).toBeInTheDocument();
    expect(screen.getByText('Review pending signal')).toBeInTheDocument();
  });

  it('renders the AgentFeedPanel with title "AI Agent Feed"', () => {
    render(<DashboardOverview data={fixture} />);
    expect(screen.getByText('AI Agent Feed')).toBeInTheDocument();
    expect(screen.getByText('Scout discovered new technology')).toBeInTheDocument();
  });

  it('renders the RecentUpdatesTimeline with title "Recent Updates"', () => {
    render(<DashboardOverview data={fixture} />);
    expect(screen.getByText('Recent Updates')).toBeInTheDocument();
    expect(screen.getByText('Vector Databases')).toBeInTheDocument();
  });
});
