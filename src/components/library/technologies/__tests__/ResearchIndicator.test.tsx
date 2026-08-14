/**
 * @file ResearchIndicator.test.tsx
 * @description TEST-022 — a failed research attempt must be visibly different
 * from never-researched. Before this, both rendered the same "Research" button,
 * so the operator was told nothing had been tried when something had been tried
 * and lost.
 */

import { render, screen, fireEvent } from '@testing-library/react';

// lucide-react ESM proxy stub — same pattern as the other component tests.
jest.mock('lucide-react', () => {
  const makeIcon = (name: string) => {
    const Icon = (props: Record<string, unknown>) => (
      <span data-testid={`icon-${name}`} className={props.className as string} />
    );
    Icon.displayName = name;
    return Icon;
  };
  return new Proxy({}, { get: (_target, prop: string) => makeIcon(prop) });
});

import { ResearchIndicator } from '../badges';

describe('ResearchIndicator', () => {
  it('shows the in-progress state while researching', () => {
    render(<ResearchIndicator hasDeepResearch={false} isResearching />);
    expect(screen.getByText('Researching...')).toBeInTheDocument();
  });

  it('shows the researched state when research exists', () => {
    render(<ResearchIndicator hasDeepResearch />);
    expect(screen.getByText('Researched')).toBeInTheDocument();
  });

  it('offers the trigger when nothing has been tried', () => {
    render(<ResearchIndicator hasDeepResearch={false} onResearch={jest.fn()} />);
    expect(screen.queryByTestId('research-failed')).not.toBeInTheDocument();
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  describe('failed state', () => {
    it('is visibly distinct from never-researched', () => {
      render(<ResearchIndicator hasDeepResearch={false} hasFailed onResearch={jest.fn()} />);

      expect(screen.getByTestId('research-failed')).toBeInTheDocument();
      expect(screen.getByText('Research failed')).toBeInTheDocument();
    });

    it('stays actionable so the operator can retry', () => {
      const onResearch = jest.fn();
      render(<ResearchIndicator hasDeepResearch={false} hasFailed onResearch={onResearch} />);

      fireEvent.click(screen.getByTestId('research-failed'));

      expect(onResearch).toHaveBeenCalledTimes(1);
    });

    it('is disabled when no retry handler is available', () => {
      render(<ResearchIndicator hasDeepResearch={false} hasFailed />);
      expect(screen.getByTestId('research-failed')).toBeDisabled();
    });

    // A refresh that failed over existing research is not a total loss, so the
    // completed state still wins.
    it('yields to existing research', () => {
      render(<ResearchIndicator hasDeepResearch hasFailed onResearch={jest.fn()} />);

      expect(screen.getByText('Researched')).toBeInTheDocument();
      expect(screen.queryByTestId('research-failed')).not.toBeInTheDocument();
    });

    it('yields to an in-flight retry', () => {
      render(<ResearchIndicator hasDeepResearch={false} hasFailed isResearching onResearch={jest.fn()} />);

      expect(screen.getByText('Researching...')).toBeInTheDocument();
      expect(screen.queryByTestId('research-failed')).not.toBeInTheDocument();
    });
  });

  describe('refresh-pending state (ARUN-028)', () => {
    it('shows a distinct pending-refresh marker over completed research', () => {
      render(<ResearchIndicator hasDeepResearch refreshPending />);

      expect(screen.getByTestId('research-refresh-pending')).toBeInTheDocument();
      expect(screen.getByText('Refresh pending')).toBeInTheDocument();
      // Research succeeded — it is never reported as failed.
      expect(screen.queryByTestId('research-failed')).not.toBeInTheDocument();
      expect(screen.queryByText('Research failed')).not.toBeInTheDocument();
    });

    it('is only shown once research exists, never on an untried technology', () => {
      render(<ResearchIndicator hasDeepResearch={false} refreshPending onResearch={jest.fn()} />);

      expect(screen.queryByTestId('research-refresh-pending')).not.toBeInTheDocument();
    });

    it('yields to an in-flight (re)research run', () => {
      render(<ResearchIndicator hasDeepResearch refreshPending isResearching />);

      expect(screen.getByText('Researching...')).toBeInTheDocument();
      expect(screen.queryByTestId('research-refresh-pending')).not.toBeInTheDocument();
    });
  });
});
