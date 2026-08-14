/**
 * @file components/layout/__tests__/AppSidebar.activity-nav.test.tsx
 * @description UX-068 navigation regression — the Activity sidebar group holds
 * both Agent Runs and Jobs, each deep-linkable, each marked active on its own
 * route and only on its own route.
 *
 * Exercises `NavMain` with the real `getNavMain()` shape rather than a fixture,
 * so a change to the sidebar entries has to keep these guarantees.
 *
 * @jest-environment jsdom
 */

let mockPathname = '/agents/runs';
jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

jest.mock('next/link', () => {
  const React = require('react');
  // `SidebarMenuSubButton` renders `asChild`, so Radix's Slot forwards a ref
  // into this component — a plain function component would warn.
  const Link = React.forwardRef(
    ({ href, children, ...rest }: { href: string; children: React.ReactNode }, ref: React.Ref<HTMLAnchorElement>) =>
      React.createElement('a', { href, ref, ...rest }, children)
  );
  Link.displayName = 'Link';
  return { __esModule: true, default: Link };
});

// lucide-react is ESM; stub icons as inert spans.
jest.mock('lucide-react', () => {
  const React = require('react');
  const makeIcon = (name: string) => {
    const Icon = (props: Record<string, unknown>) =>
      React.createElement('span', { 'data-testid': `icon-${name}`, className: props.className });
    Icon.displayName = name;
    return Icon;
  };
  return new Proxy({}, { get: (_t: never, prop: string) => makeIcon(prop) });
});

// Badges reach Firestore-backed queries; they are irrelevant to navigation.
jest.mock('@/components/linker/LinkerNavBadge', () => ({ LinkerNavBadge: () => null }));
jest.mock('@/components/assessment/AssessmentNavBadge', () => ({ AssessmentNavBadge: () => null }));

// AppSidebar's footer pulls NavUser → AuthProvider → the Firebase auth SDK,
// which needs a real `fetch`. Nothing under test touches it.
jest.mock('@/components/nav-user', () => ({ NavUser: () => null }));
jest.mock('@/lib/firebase', () => ({ auth: {}, db: {} }));

import * as React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SidebarProvider } from '@/components/ui/sidebar';
import { NavMain } from '@/components/nav-main';
import { getNavMain } from '../AppSidebar';

// `SidebarProvider` reads the mobile breakpoint; jsdom has no matchMedia.
beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

function renderNav(pathname: string) {
  mockPathname = pathname;
  return render(
    <SidebarProvider>
      <NavMain items={getNavMain()} />
    </SidebarProvider>
  );
}

function activityLinks() {
  return {
    runs: screen.getByRole('link', { name: 'Agent Runs' }),
    jobs: screen.getByRole('link', { name: 'Jobs' }),
  };
}

describe('Activity sidebar group (UX-068)', () => {
  it('lists Agent Runs and Jobs as siblings under Activity', () => {
    renderNav('/agents/runs');

    const activity = getNavMain().find((item) => item.title === 'Activity');
    expect(activity?.items).toEqual([
      { title: 'Agent Runs', url: '/agents/runs' },
      { title: 'Jobs', url: '/agents/jobs' },
    ]);
  });

  it('deep-links each child to its own stable route', () => {
    renderNav('/agents/runs');

    const { runs, jobs } = activityLinks();
    expect(runs).toHaveAttribute('href', '/agents/runs');
    expect(jobs).toHaveAttribute('href', '/agents/jobs');
  });

  it('marks Agent Runs active on /agents/runs and Jobs inactive', () => {
    renderNav('/agents/runs');

    const { runs, jobs } = activityLinks();
    expect(runs).toHaveAttribute('data-active', 'true');
    expect(jobs).not.toHaveAttribute('data-active', 'true');
  });

  it('marks Jobs active on /agents/jobs and Agent Runs inactive', () => {
    renderNav('/agents/jobs');

    const { runs, jobs } = activityLinks();
    expect(jobs).toHaveAttribute('data-active', 'true');
    expect(runs).not.toHaveAttribute('data-active', 'true');
  });

  it('keeps the Activity group expanded when Jobs is the active route', () => {
    renderNav('/agents/jobs');

    // The children are only rendered when the collapsible is open, so their
    // presence is the assertion that a direct visit to /agents/jobs does not
    // land the operator on a collapsed group.
    expect(screen.getByRole('link', { name: 'Jobs' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Agent Runs' })).toBeVisible();
  });

  it('reaches both children by keyboard from the Activity trigger', async () => {
    renderNav('/agents/jobs');

    const trigger = screen.getByRole('button', { name: /activity/i });
    trigger.focus();
    expect(trigger).toHaveFocus();

    await userEvent.tab();
    expect(screen.getByRole('link', { name: 'Agent Runs' })).toHaveFocus();

    await userEvent.tab();
    expect(screen.getByRole('link', { name: 'Jobs' })).toHaveFocus();
  });

  it('stays collapsed on an unrelated route and marks neither child active when opened', async () => {
    renderNav('/agents/signals');

    // `/agents/signals` is not an Activity child, so the group starts closed.
    expect(screen.queryByRole('link', { name: 'Jobs' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /activity/i }));

    const submenu = screen.getByRole('link', { name: 'Jobs' }).closest('ul')!;
    expect(within(submenu).getByRole('link', { name: 'Jobs' })).not.toHaveAttribute('data-active', 'true');
    expect(within(submenu).getByRole('link', { name: 'Agent Runs' })).not.toHaveAttribute('data-active', 'true');
  });
});
