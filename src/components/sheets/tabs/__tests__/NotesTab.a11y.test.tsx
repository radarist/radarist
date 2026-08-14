/**
 * @file NotesTab.a11y.test.tsx
 * @description Accessible-name regressions for the entity-sheet notes tab
 * (UX-040/ACCESS-001): the icon-only per-note edit and delete controls must
 * carry explicit accessible names.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

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

describe('NotesTab accessible names (UX-040)', () => {
  it('names the per-note edit and delete icon buttons', () => {
    render(
      <NotesTab
        notes={[{ id: 'note-1', content: 'Original note', createdAt: 1, updatedAt: 1 }]}
        onUpdateNote={jest.fn()}
        onDeleteNote={jest.fn()}
      />
    );

    expect(screen.getByRole('button', { name: /edit note/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete note/i })).toBeInTheDocument();
  });
});
