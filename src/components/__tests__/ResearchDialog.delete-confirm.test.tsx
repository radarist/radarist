/**
 * @file components/__tests__/ResearchDialog.delete-confirm.test.tsx
 * @description Real-component tests for the ResearchDialog entry-delete flow
 * (UX-044). Deletion must be confirmed through an accessible AlertDialog —
 * not `window.confirm` — with Cancel guaranteed side-effect free and Confirm
 * deleting exactly once.
 *
 * Renders the REAL Radix Dialog + AlertDialog wrappers so role/description
 * wiring is genuinely exercised; only data-heavy children are stubbed.
 */

// ============================================================================
// MOCKS
// ============================================================================

// lucide-react ships as ESM which Jest doesn't transform by default.
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

// react-markdown is ESM-only.
jest.mock('react-markdown', () => {
  const MockMarkdown = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  MockMarkdown.displayName = 'MockReactMarkdown';
  return MockMarkdown;
});

// Data-heavy children — irrelevant to the delete flow under test.
jest.mock('@/components/graphs/EntityRelationshipPanel', () => ({
  EntityRelationshipPanel: () => null,
}));
jest.mock('../TrendChart', () => ({
  TrendChart: () => null,
}));
jest.mock('../radar-page/BlipCompanyLinks', () => ({
  BlipCompanyLinks: () => null,
}));
jest.mock('../radar-page/BlipUseCaseLinks', () => ({
  BlipUseCaseLinks: () => null,
}));
jest.mock('../sheets/tabs/TechnologyResearchTab', () => ({
  TechnologyResearchTab: () => null,
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
  ChartContainer: () => null,
  ChartTooltipContent: () => null,
}));
jest.mock('@/lib/migration', () => ({
  safeResolve: jest.fn().mockResolvedValue('tech-resolved'),
}));
jest.mock('@/hooks/useDataRefresh', () => ({
  useDataRefresh: jest.fn(),
}));

// ============================================================================
// IMPORTS
// ============================================================================

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { ResearchDialog } from '../ResearchDialog';
import type { RadarEntry } from '@/lib/types';

// Radix ScrollArea requires ResizeObserver, which jsdom does not provide.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

// ============================================================================
// FIXTURES
// ============================================================================

const entry: RadarEntry = {
  id: 42,
  name: 'Quantum Mesh',
  description: 'A test technology entry.',
  quadrantId: 'q_1',
  quadrantName: 'Platforms',
  ring: 'Trial',
  status: 'Stable',
  tags: [],
  history: [],
} as unknown as RadarEntry;

function renderDialog(overrides: { onDelete?: jest.Mock; readOnly?: boolean } = {}) {
  const onDelete = overrides.onDelete ?? jest.fn();
  const utils = render(
    <ResearchDialog
      isOpen
      onOpenChange={jest.fn()}
      entry={entry}
      onDelete={onDelete}
      onEdit={jest.fn()}
      onSaveAnalysis={jest.fn()}
      rings={['Adopt', 'Trial', 'Assess', 'Hold']}
      readOnly={overrides.readOnly}
      radarId="radar-1"
    />
  );
  return { ...utils, onDelete };
}

// ============================================================================
// TESTS
// ============================================================================

describe('ResearchDialog delete confirmation (UX-044)', () => {
  let confirmSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // The native browser confirm must never be part of this flow again.
    confirmSpy = jest.spyOn(window, 'confirm').mockImplementation(() => {
      throw new Error('window.confirm must not be called');
    });
  });

  afterEach(() => {
    confirmSpy.mockRestore();
  });

  it('opens an accessible AlertDialog instead of window.confirm and does not delete yet', async () => {
    const user = userEvent.setup();
    const { onDelete } = renderDialog();

    await user.click(screen.getByRole('button', { name: /delete entry/i }));

    const alert = await screen.findByRole('alertdialog');
    expect(alert).toBeInTheDocument();
    // Real description wired via aria-describedby, naming the entry.
    const describedBy = alert.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const description = document.getElementById(describedBy as string);
    expect(description).toHaveTextContent(/Quantum Mesh/);
    expect(onDelete).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('does not mutate on Cancel', async () => {
    const user = userEvent.setup();
    const { onDelete } = renderDialog();

    await user.click(screen.getByRole('button', { name: /delete entry/i }));
    await screen.findByRole('alertdialog');
    await user.click(screen.getByRole('button', { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('deletes exactly once with the entry id on Confirm', async () => {
    const user = userEvent.setup();
    const { onDelete } = renderDialog();

    await user.click(screen.getByRole('button', { name: /delete entry/i }));
    const alert = await screen.findByRole('alertdialog');
    // Confirm action lives inside the alert dialog.
    const confirmButton = Array.from(alert.querySelectorAll('button')).find((b) => /delete/i.test(b.textContent ?? ''));
    expect(confirmButton).toBeDefined();
    await user.click(confirmButton as HTMLButtonElement);

    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
    expect(onDelete).toHaveBeenCalledWith(42);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('hides the delete action entirely in read-only mode', () => {
    renderDialog({ readOnly: true });
    expect(screen.queryByRole('button', { name: /delete entry/i })).not.toBeInTheDocument();
  });
});
