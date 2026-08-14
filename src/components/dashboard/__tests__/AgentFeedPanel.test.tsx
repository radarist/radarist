/**
 * UX-019 — the AI Agent Feed must describe honestly and navigate to the exact run.
 *
 * Before UX-019 the panel subtitle claimed "Recently completed agent runs" even
 * though the feed mixes completed, failed, and needs-review runs, and every card
 * linked to a generic per-agent triage surface (`getAgentDestination`) rather
 * than the run the user actually clicked. These tests lock the honest subtitle
 * and the exact-run navigation (`/agents/runs/[id]`).
 *
 * Mirrors the sibling DashboardOverview.test.tsx harness: Proxy mock for
 * lucide-react, passthrough anchor for next/link.
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import type { AgentActivity } from '@/lib/types';

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

import { AgentFeedPanel } from '../AgentFeedPanel';

function makeActivity(overrides: Partial<AgentActivity> = {}): AgentActivity {
  return {
    id: 'run-1',
    type: 'automation',
    title: 'Scout run',
    description: 'scout · claude · $0.01',
    agent: 'ScoutAgent',
    status: 'completed',
    priority: 'medium',
    relatedEntities: {},
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  } as AgentActivity;
}

describe('AgentFeedPanel (UX-019)', () => {
  it('uses an honest subtitle instead of claiming every run "completed"', () => {
    render(<AgentFeedPanel activities={[makeActivity()]} />);
    expect(screen.getByText('Recent agent runs')).toBeInTheDocument();
    // The old, inaccurate copy must be gone — the feed includes failures too.
    expect(screen.queryByText('Recently completed agent runs')).not.toBeInTheDocument();
  });

  it('links each card to the exact run detail page, not a per-agent surface', () => {
    render(<AgentFeedPanel activities={[makeActivity({ id: 'run-42', title: 'Scout run 42' })]} />);
    const card = screen.getByText('Scout run 42').closest('a');
    expect(card).toHaveAttribute('href', '/agents/runs/run-42');
  });

  it('opens the exact run even for an agent with no dedicated triage surface', () => {
    // A LinkerAgent card used to route to /triage/relations; a failed or
    // unknown run there hid the actual outcome. Now it opens the run itself.
    render(
      <AgentFeedPanel activities={[makeActivity({ id: 'run-linker', title: 'Linker run', agent: 'LinkerAgent' })]} />
    );
    const card = screen.getByText('Linker run').closest('a');
    expect(card).toHaveAttribute('href', '/agents/runs/run-linker');
  });

  it("surfaces each run's real status so a mixed feed reads honestly", () => {
    render(
      <AgentFeedPanel
        activities={[
          makeActivity({ id: 'ok', title: 'Done run', status: 'completed' }),
          makeActivity({ id: 'bad', title: 'Broken run', status: 'failed' }),
          makeActivity({ id: 'part', title: 'Partial run', status: 'needs_review' }),
        ]}
      />
    );

    // Each card links to its own run…
    expect(screen.getByText('Done run').closest('a')).toHaveAttribute('href', '/agents/runs/ok');
    expect(screen.getByText('Broken run').closest('a')).toHaveAttribute('href', '/agents/runs/bad');
    expect(screen.getByText('Partial run').closest('a')).toHaveAttribute('href', '/agents/runs/part');

    // …and shows its true status rather than a blanket "completed".
    const failedCard = screen.getByText('Broken run').closest('a') as HTMLElement;
    expect(within(failedCard).getByText('failed')).toBeInTheDocument();
    const reviewCard = screen.getByText('Partial run').closest('a') as HTMLElement;
    expect(within(reviewCard).getByText('needs review')).toBeInTheDocument();
  });

  it('shows the empty state when there is no recent activity', () => {
    render(<AgentFeedPanel activities={[]} />);
    expect(screen.getByText('No recent agent activity')).toBeInTheDocument();
  });
});
