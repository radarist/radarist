/**
 * Component tests for TechnologiesEmptyState (UX-052).
 *
 * The blank library state must be actionable (direct creation is supported —
 * the old "appear here when added to your radars" copy was untruthful and a
 * dead end), the filtered state keeps Clear filters, and a failed load must
 * say "unavailable" instead of pretending the library is empty.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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

import { TechnologiesEmptyState } from '../TechnologiesEmptyState';

function makeProps(overrides: Partial<Parameters<typeof TechnologiesEmptyState>[0]> = {}) {
  return {
    hasFilters: false,
    onClearFilters: jest.fn(),
    onCreateTechnology: jest.fn(),
    onAddViaRadar: jest.fn(),
    ...overrides,
  };
}

describe('TechnologiesEmptyState — blank workspace (UX-052)', () => {
  it('offers direct creation as the primary action', async () => {
    const props = makeProps();
    const user = userEvent.setup();
    render(<TechnologiesEmptyState {...props} />);

    await user.click(screen.getByRole('button', { name: /new technology/i }));
    expect(props.onCreateTechnology).toHaveBeenCalledTimes(1);
  });

  it('offers adding through a radar as the secondary action', async () => {
    const props = makeProps();
    const user = userEvent.setup();
    render(<TechnologiesEmptyState {...props} />);

    await user.click(screen.getByRole('button', { name: /add via radar/i }));
    expect(props.onAddViaRadar).toHaveBeenCalledTimes(1);
  });

  it('tells the truth: technologies can be created directly, not only via radars', () => {
    render(<TechnologiesEmptyState {...makeProps()} />);
    expect(screen.getByText('No technologies yet')).toBeInTheDocument();
    expect(screen.queryByText(/appear here when added to your radars/i)).not.toBeInTheDocument();
    expect(screen.getByText(/create a technology directly/i)).toBeInTheDocument();
  });
});

describe('TechnologiesEmptyState — filtered', () => {
  it('keeps the Clear filters action and copy', async () => {
    const props = makeProps({ hasFilters: true });
    const user = userEvent.setup();
    render(<TechnologiesEmptyState {...props} />);

    expect(screen.getByText('No technologies found')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /clear filters/i }));
    expect(props.onClearFilters).toHaveBeenCalledTimes(1);
  });
});

describe('TechnologiesEmptyState — unavailable (load failed)', () => {
  it('never claims the library is empty when the load failed, and offers retry', async () => {
    const onRetry = jest.fn();
    const props = makeProps({ loadFailed: true, onRetry });
    const user = userEvent.setup();
    render(<TechnologiesEmptyState {...props} />);

    expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();
    expect(screen.queryByText('No technologies yet')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('wins over the filtered state (a failed load is not "no matches")', () => {
    render(<TechnologiesEmptyState {...makeProps({ hasFilters: true, loadFailed: true, onRetry: jest.fn() })} />);
    expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();
    expect(screen.queryByText('No technologies found')).not.toBeInTheDocument();
  });
});
