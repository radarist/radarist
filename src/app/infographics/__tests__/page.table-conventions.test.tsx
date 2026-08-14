/**
 * @file infographics/__tests__/page.table-conventions.test.tsx
 * @description Library-table-convention regression tests for the Infographics
 * page (/infographics) — Task 13 of the 2026-07 UI design sprint (P-B9).
 *
 * Pins:
 *   1. The redundant per-row "AI-Generated" pill is GONE (every row is
 *      AI-generated — the page subtitle already says so; CONV-BADGE).
 *   2. The per-row thumbs up/down (preference feedback, CONV-ACTIONS) stay
 *      wired to `useLikeVisualization` — untouched by the density/menu pass.
 *   3. The Actions cell ends with a `⋯` DropdownMenu (CONV-ROWMENU): "Open"
 *      reuses the same navigation as the row/thumbnail click; "Delete" runs
 *      the existing per-item `useDeleteVisualization` mutation behind an
 *      `AlertDialog` confirm, mirroring the detail page's delete flow.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// lucide-react is ESM; stub icons as null-rendering components.
jest.mock('lucide-react', () => {
  const Stub = () => null;
  return new Proxy({}, { get: () => Stub });
});

// SmartLayout/PageShell pull in the sidebar (-> firebase) transitively;
// stub to passthroughs so the test stays at unit scope (matches the
// triage/insights table-conventions precedent).
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

// BulkActionToolbar animates via framer-motion; flatten to plain divs.
jest.mock('framer-motion', () => ({
  __esModule: true,
  motion: {
    div: ({ children, className }: React.HTMLAttributes<HTMLDivElement>) => <div className={className}>{children}</div>,
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockRouterPush = jest.fn();
jest.mock('next/navigation', () => ({
  __esModule: true,
  useRouter: () => ({ push: mockRouterPush }),
}));

const mockUseVisualizations = jest.fn();
const mockLikeMutate = jest.fn();
const mockDeleteMutate = jest.fn();
const mockBulkDeleteMutate = jest.fn();
jest.mock('@/hooks/useVisualizations', () => ({
  __esModule: true,
  useVisualizations: () => mockUseVisualizations(),
  useBulkDeleteVisualizations: () => ({ mutateAsync: mockBulkDeleteMutate }),
  useLikeVisualization: () => ({ mutate: mockLikeMutate }),
  useDeleteVisualization: () => ({
    mutate: (id: string, opts?: { onSuccess?: () => void }) => {
      mockDeleteMutate(id, opts);
      opts?.onSuccess?.();
    },
  }),
}));

const mockToast = jest.fn();
jest.mock('@/hooks/use-toast', () => ({
  __esModule: true,
  useToast: () => ({ toast: mockToast }),
}));

import InfographicsPage from '../page';
import type { Visualization } from '@/lib/schemas/visualization';

// ============================================================================
// JSDOM POLYFILLS (Radix dropdown menu + alert dialog)
// ============================================================================

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
  Element.prototype.hasPointerCapture = jest.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = jest.fn();
  Element.prototype.releasePointerCapture = jest.fn();
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function makeViz(overrides: Partial<Visualization> & { id: string; title: string }): Visualization {
  return {
    prompt: 'A prompt describing the infographic',
    refinedPrompt: '',
    imageUrl: 'https://example.com/image.png',
    thumbnailUrl: 'https://example.com/thumb.png',
    mimeType: 'image/png',
    style: 'professional',
    dataSnapshot: { entities: [], description: '' },
    createdAt: '2026-07-01T00:00:00.000Z',
    createdBy: 'user-1',
    shared: false,
    userId: 'user-1',
    metadata: { model: 'gemini', width: 100, height: 100, sizeBytes: 100 },
    ...overrides,
  } as Visualization;
}

const VIZ_1 = makeViz({ id: 'viz-1', title: 'Agentic AI Ecosystem Poster' });

function renderPage(list: Visualization[] = [VIZ_1]) {
  mockUseVisualizations.mockReturnValue({ data: list, isLoading: false });
  render(<InfographicsPage />);
}

describe('InfographicsPage — library-table conventions (Task 13 / P-B9)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================================================
  // (1) Redundant per-row AI-Generated pill is gone
  // ==========================================================================

  it('does not render a per-row "AI-Generated" badge (page subtitle already discloses it)', () => {
    renderPage();

    expect(screen.queryByText(/AI-Generated/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-disclosure-badge')).not.toBeInTheDocument();
    // The page-level disclosure (subtitle) is the one place this is said.
    expect(screen.getByText('AI-generated infographics and visual representations')).toBeInTheDocument();
  });

  // ==========================================================================
  // (2) Thumbs preference-feedback stays wired (CONV-ACTIONS)
  // ==========================================================================

  it('keeps the per-row like/dislike buttons wired to useLikeVisualization', () => {
    renderPage();

    screen.getByTestId(`viz-like-${VIZ_1.id}`).click();
    expect(mockLikeMutate).toHaveBeenCalledWith({ id: VIZ_1.id, liked: true });

    screen.getByTestId(`viz-dislike-${VIZ_1.id}`).click();
    expect(mockLikeMutate).toHaveBeenCalledWith({ id: VIZ_1.id, liked: false });
  });

  // ==========================================================================
  // (3) Trailing ⋯ row menu (CONV-ROWMENU)
  // ==========================================================================

  it('renders a trailing "⋯" row menu ending the Actions cell, after the thumbs', () => {
    renderPage();
    expect(screen.getByTestId(`viz-menu-${VIZ_1.id}`)).toBeInTheDocument();
  });

  it('"Open" reuses the same navigation as the row/thumbnail click', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPage();

    await user.click(screen.getByTestId(`viz-menu-${VIZ_1.id}`));
    const openItem = await screen.findByTestId(`viz-menu-open-${VIZ_1.id}`);
    await user.click(openItem);

    expect(mockRouterPush).toHaveBeenCalledWith(`/infographics/${VIZ_1.id}`);
  });

  it('replaces an unavailable thumbnail with a bounded fallback instead of a broken image', () => {
    renderPage();

    fireEvent.error(screen.getByTestId(`viz-thumb-${VIZ_1.id}`));

    expect(screen.queryByTestId(`viz-thumb-${VIZ_1.id}`)).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: `${VIZ_1.title}: media unavailable` })).toBeInTheDocument();
  });

  it('"Delete" confirms via AlertDialog, then runs useDeleteVisualization and toasts', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPage();

    await user.click(screen.getByTestId(`viz-menu-${VIZ_1.id}`));
    const deleteItem = await screen.findByTestId(`viz-menu-delete-${VIZ_1.id}`);
    await user.click(deleteItem);

    // Confirmation dialog gates the mutation — no delete on the menu click alone.
    expect(await screen.findByText('Delete infographic?')).toBeInTheDocument();
    expect(mockDeleteMutate).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(mockDeleteMutate).toHaveBeenCalledWith(VIZ_1.id, expect.any(Object));
    expect(mockToast).toHaveBeenCalledWith({ title: 'Visualization deleted' });
  });

  it('does not navigate when only opening the row menu (stopPropagation on the Actions cell)', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPage();

    await user.click(screen.getByTestId(`viz-menu-${VIZ_1.id}`));
    await screen.findByTestId(`viz-menu-open-${VIZ_1.id}`);

    expect(mockRouterPush).not.toHaveBeenCalled();
  });
});
