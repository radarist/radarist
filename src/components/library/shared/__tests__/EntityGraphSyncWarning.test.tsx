/** @jest-environment jsdom */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EntityGraphSyncWarning } from '../EntityGraphSyncWarning';

jest.mock('lucide-react', () => ({
  AlertTriangle: () => <span aria-hidden="true" />,
  Loader2: () => <span aria-hidden="true" />,
  RefreshCw: () => <span aria-hidden="true" />,
}));

describe('EntityGraphSyncWarning', () => {
  it('renders committed local truth and retries only graph synchronization', async () => {
    const user = userEvent.setup();
    const onRetry = jest.fn().mockResolvedValue(undefined);

    render(
      <EntityGraphSyncWarning
        entityTypeLabel="company"
      entityLabel="Acme Renamed"
        operation="update"
        retryAttempts={0}
        maxRetryAttempts={3}
        isRetrying={false}
        onRetry={onRetry}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Saved locally; graph sync not acknowledged');
    expect(screen.getByRole('alert')).toHaveTextContent('Acme Renamed');
    expect(screen.getByRole('alert')).toHaveTextContent('The saved company data is shown');

    await user.click(screen.getByRole('button', { name: 'Retry graph sync' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows bounded exhaustion and removes the retry action after three failures', () => {
    render(
      <EntityGraphSyncWarning
        entityTypeLabel="company"
      entityLabel="Acme"
        operation="create"
        retryAttempts={3}
        maxRetryAttempts={3}
        isRetrying={false}
        onRetry={jest.fn()}
      />
    );

    expect(screen.queryByRole('button', { name: 'Retry graph sync' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('The retry limit is reached');
  });

  it('prevents overlapping retry attempts', () => {
    render(
      <EntityGraphSyncWarning
        entityTypeLabel="company"
      entityLabel="Acme"
        operation="update"
        retryAttempts={1}
        maxRetryAttempts={3}
        isRetrying
        onRetry={jest.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Retrying graph sync' })).toBeDisabled();
  });
});
