import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RadarManagementResult } from '@/lib/types';

jest.mock('lucide-react', () => ({
  X: (props: React.SVGProps<SVGSVGElement>) => <svg data-testid="icon-X" {...props} />,
}));

import { RadarManagementDialog } from '../RadarManagementDialog';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface RenderOptions {
  mode?: 'create' | 'rename';
  currentName?: string;
  onCreate?: jest.Mock;
  onRename?: jest.Mock;
  onOpenChange?: jest.Mock;
}

function renderDialog(options: RenderOptions = {}) {
  const onCreate = options.onCreate ?? jest.fn().mockResolvedValue({ ok: true });
  const onRename = options.onRename ?? jest.fn().mockResolvedValue({ ok: true });
  const onOpenChange = options.onOpenChange ?? jest.fn();

  render(
    <RadarManagementDialog
      isOpen
      onOpenChange={onOpenChange}
      mode={options.mode ?? 'create'}
      currentName={options.currentName}
      onCreate={onCreate}
      onRename={onRename}
    />
  );

  return { onCreate, onRename, onOpenChange };
}

describe('RadarManagementDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('awaits create, locks Enter plus click re-entry, and closes exactly once on success', async () => {
    const pendingCreate = deferred<RadarManagementResult>();
    const onCreate = jest.fn(() => pendingCreate.promise);
    const { onOpenChange } = renderDialog({ onCreate });
    const input = screen.getByLabelText('Name');

    fireEvent.change(input, { target: { value: '  Release Radar  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Saving...' }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith('Release Radar');
    expect(input).toBeDisabled();
    expect(onOpenChange).not.toHaveBeenCalled();

    pendingCreate.resolve({ ok: true });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledTimes(1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('awaits rename and closes exactly once on success', async () => {
    const user = userEvent.setup();
    const onRename = jest.fn().mockResolvedValue({ ok: true });
    const { onOpenChange } = renderDialog({ mode: 'rename', currentName: 'Old name', onRename });

    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'New name');
    await user.click(screen.getByRole('button', { name: 'Rename Radar' }));

    await waitFor(() => expect(onRename).toHaveBeenCalledWith('New name'));
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps the dialog and input open for a duplicate result', async () => {
    const user = userEvent.setup();
    const onCreate = jest.fn().mockResolvedValue({
      ok: false,
      error: 'A radar named "Existing" already exists. Choose a different name.',
    });
    const { onOpenChange } = renderDialog({ onCreate });

    await user.type(screen.getByLabelText('Name'), 'Existing');
    await user.click(screen.getByRole('button', { name: 'Create Radar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a different name');
    expect(screen.getByLabelText('Name')).toHaveValue('Existing');
    expect(screen.getByLabelText('Name')).toBeEnabled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('keeps the dialog open with an actionable error after a backend failure', async () => {
    const user = userEvent.setup();
    const onRename = jest.fn().mockRejectedValue(new Error('backend unavailable'));
    const { onOpenChange } = renderDialog({ mode: 'rename', currentName: 'Old name', onRename });

    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Retry name');
    await user.click(screen.getByRole('button', { name: 'Rename Radar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Check your connection and try again');
    expect(screen.getByLabelText('Name')).toHaveValue('Retry name');
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('retains the attempted rename when its optimistic display name is rolled back', async () => {
    const user = userEvent.setup();
    const onOpenChange = jest.fn();

    function OptimisticRenameHarness() {
      const [displayName, setDisplayName] = React.useState('Old name');
      return (
        <RadarManagementDialog
          isOpen
          onOpenChange={onOpenChange}
          mode="rename"
          currentName={displayName}
          onCreate={jest.fn()}
          onRename={async (name) => {
            setDisplayName(name);
            await Promise.resolve();
            setDisplayName('Old name');
            throw new Error('backend unavailable');
          }}
        />
      );
    }

    render(<OptimisticRenameHarness />);
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Attempted name');
    await user.click(screen.getByRole('button', { name: 'Rename Radar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Check your connection and try again');
    expect(screen.getByLabelText('Name')).toHaveValue('Attempted name');
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
