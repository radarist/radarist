import { act, fireEvent, render, screen } from '@testing-library/react';

jest.mock('lucide-react', () => ({
  Plus: () => null,
  Trash2: () => null,
  Loader2: () => null,
  Check: () => null,
  AlertCircle: () => null,
  Edit2: () => null,
  X: () => null,
}));

import { NotesTab } from '../NotesTab';

jest.useFakeTimers();

describe('NotesTab autosave', () => {
  it('shows one failure and does not retry without another edit', async () => {
    const onUpdateNote = jest.fn().mockRejectedValue(new Error('write rejected'));
    render(
      <NotesTab
        notes={[
          {
            id: 'note-1',
            content: 'Original note',
            createdAt: 1,
            updatedAt: 1,
          },
        ]}
        onUpdateNote={onUpdateNote}
        enableAutosave
      />
    );

    fireEvent.click(screen.getByRole('button'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Edited note' } });

    await act(async () => {
      jest.advanceTimersByTime(2000);
      await Promise.resolve();
    });

    expect(onUpdateNote).toHaveBeenCalledWith('note-1', 'Edited note');
    expect(screen.getByText('Failed to save')).toBeInTheDocument();

    await act(async () => {
      jest.advanceTimersByTime(10000);
      await Promise.resolve();
    });

    expect(onUpdateNote).toHaveBeenCalledTimes(1);
  });
});
