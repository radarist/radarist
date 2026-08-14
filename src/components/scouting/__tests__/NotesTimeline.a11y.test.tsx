/**
 * @file NotesTimeline.a11y.test.tsx
 * @description Accessible-name regressions for the scouting notes timeline
 * (UX-040/ACCESS-001): icon-only per-note edit/delete controls must carry
 * contextual accessible names including the note type.
 */

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

jest.mock('@/hooks/use-toast', () => {
  const stableToast = jest.fn();
  return { useToast: () => ({ toast: stableToast }) };
});

jest.mock('@/lib/company-notes', () => ({
  getNotesByCompanyId: jest.fn(),
  createNote: jest.fn(),
  updateNote: jest.fn(),
  deleteNote: jest.fn(),
}));

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { NotesTimeline } from '../NotesTimeline';
import { getNotesByCompanyId } from '@/lib/company-notes';
import type { CompanyNote } from '@/lib/types';

const mockGetNotes = getNotesByCompanyId as jest.MockedFunction<typeof getNotesByCompanyId>;

describe('NotesTimeline accessible names (UX-040)', () => {
  it('names the per-note edit and delete icon buttons with the note type', async () => {
    mockGetNotes.mockResolvedValue([
      {
        id: 'note-1',
        companyId: 'comp-1',
        content: 'Discussed pilot scope.',
        type: 'Meeting',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as CompanyNote,
    ]);

    render(<NotesTimeline companyId="comp-1" />);

    expect(await screen.findByRole('button', { name: /edit meeting note/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete meeting note/i })).toBeInTheDocument();
  });
});
