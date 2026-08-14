/**
 * UX-024/025/026 — Notes wiring for the Org Unit, Initiative, and Pain Point
 * sheets.
 *
 * Each sheet already RENDERED a Notes tab but previously received no note data
 * or callbacks from its page (the "live Add Note assertion failed"). These
 * tests prove the sheet now forwards the shared entity-notes contract:
 * provided notes render on the Notes tab, and the Add Note control invokes the
 * supplied `onAddNote`. The add/edit/reload/failure/delete behavior of the
 * shared hook + service is covered by useEntityNotes.test.tsx /
 * entity-notes.test.ts; this file locks the sheet→NotesTab wiring specifically.
 *
 * Mocking mirrors PrototypeSheet.test.tsx — mock heavy transitive deps so the
 * sheet mounts without a Firebase/Query import chain.
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

// --- MOCKS (must precede sheet imports) -------------------------------------
// Proxy so any lucide icon import resolves (its ESM build is not transformed).
jest.mock('lucide-react', () =>
  new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (typeof prop !== 'string') return undefined;
        const Icon = (props: React.SVGProps<SVGSVGElement>) => <svg data-testid={`icon-${prop}`} {...props} />;
        Icon.displayName = prop;
        return Icon;
      },
    }
  )
);
jest.mock('@/hooks/useTrackEntityView', () => ({ useTrackEntityView: jest.fn() }));
jest.mock('@/lib/firebase', () => ({ db: {}, auth: { currentUser: { uid: 'test-user' } } }));
jest.mock('firebase/firestore', () => ({
  collection: jest.fn(),
  doc: jest.fn(),
  getDoc: jest.fn(),
  getDocs: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
  limit: jest.fn(),
  onSnapshot: jest.fn(),
  setDoc: jest.fn(),
  updateDoc: jest.fn(),
  deleteDoc: jest.fn(),
  serverTimestamp: jest.fn(),
  Timestamp: { now: jest.fn(() => ({ toDate: () => new Date() })) },
}));
jest.mock('firebase/auth', () => ({
  getAuth: jest.fn(() => ({ currentUser: { uid: 'test-user' } })),
  onAuthStateChanged: jest.fn(),
}));
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/test',
}));
jest.mock('next/link', () => {
  const Link = ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a>;
  Link.displayName = 'Link';
  return Link;
});
jest.mock('@tanstack/react-query', () => ({
  useQuery: jest.fn(() => ({ data: null, isLoading: false, error: null })),
  useMutation: jest.fn(() => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false })),
  useQueryClient: jest.fn(() => ({ invalidateQueries: jest.fn(), setQueryData: jest.fn(), cancelQueries: jest.fn() })),
  QueryClientProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('@/components/feedback/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('@/components/impulse/VerificationBadge', () => ({ VerificationBadge: () => null }));
jest.mock('@/lib/fetch-with-auth', () => ({ fetchWithAuth: jest.fn() }));
jest.mock('@/hooks/useEntitySearch', () => ({
  useEntitySearch: jest.fn(() => ({ searchEntities: jest.fn(), search: jest.fn(), results: [], isSearching: false })),
}));
jest.mock('@/hooks/use-toast', () => ({ useToast: jest.fn(() => ({ toast: jest.fn() })) }));
jest.mock('@/hooks/useAutosave', () => ({ useAutosave: jest.fn(() => ({ status: 'idle', save: jest.fn() })) }));
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: jest.fn(() => ({ user: { uid: 'test-user', email: 'test@example.com' }, loading: false })),
}));

import { OrgUnitSheet } from '../OrgUnitSheet';
import { InitiativeSheet } from '../InitiativeSheet';
import { PainPointSheet } from '../PainPointSheet';

// --- Minimal edit-mode subjects (cast to bypass full entity shapes) ---------
const orgUnit = { id: 'ou-1', name: 'Platform Team', type: 'team', level: 2, tags: [] } as never;
const initiative = { id: 'init-1', name: 'Cloud Migration', status: 'active', priority: 'high', tags: [] } as never;
const painPoint = {
  id: 'pp-1',
  name: 'Slow onboarding',
  title: 'Slow onboarding',
  severity: 'high',
  status: 'identified',
  category: 'process',
  tags: [],
} as never;

// Sheets take entity-specific prop shapes; this file only exercises their
// shared Notes wiring, so treat them uniformly as prop-agnostic components.
type SheetComponent = React.ComponentType<Record<string, unknown>>;
type Case = { label: string; title: string; Sheet: SheetComponent; subject: Record<string, unknown> };

const cases: Case[] = [
  { label: 'OrgUnitSheet', title: 'Platform Team', Sheet: OrgUnitSheet as unknown as SheetComponent, subject: { orgUnit } },
  {
    label: 'InitiativeSheet',
    title: 'Cloud Migration',
    Sheet: InitiativeSheet as unknown as SheetComponent,
    subject: { initiative },
  },
  {
    label: 'PainPointSheet',
    title: 'Slow onboarding',
    Sheet: PainPointSheet as unknown as SheetComponent,
    subject: { painPoint },
  },
];

describe('Library entity sheets — Notes wiring (UX-024/025/026)', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(cases)('$label renders provided notes and forwards Add Note to onAddNote', async ({ Sheet, subject, title }) => {
    const onAddNote = jest.fn().mockResolvedValue(undefined);
    const baseProps: Record<string, unknown> = {
      open: true,
      onOpenChange: jest.fn(),
      onSave: jest.fn().mockResolvedValue(undefined),
      notes: [{ id: 'note-1', content: 'Existing note body', createdAt: 1, updatedAt: 1 }],
      onAddNote,
      onUpdateNote: jest.fn().mockResolvedValue(undefined),
      onDeleteNote: jest.fn().mockResolvedValue(undefined),
    };

    render(<Sheet {...baseProps} {...subject} />);

    // Edit-mode title renders.
    expect(screen.getByText(title)).toBeInTheDocument();

    // Switch to the Notes tab (disabled in create mode, enabled here). Radix
    // TabsTrigger changes value on mouseDown, so click alone is a no-op here.
    const notesTab = screen.getByRole('tab', { name: /notes/i });
    fireEvent.mouseDown(notesTab);
    fireEvent.click(notesTab);

    // The supplied note reaches NotesTab (proves the `notes` prop is wired).
    expect(await screen.findByText('Existing note body')).toBeInTheDocument();

    // The Add Note control forwards to the supplied callback (proves onAddNote wired).
    fireEvent.change(screen.getByPlaceholderText(/add a note/i), { target: { value: 'A brand new note' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add note/i }));
    });
    expect(onAddNote).toHaveBeenCalledWith('A brand new note');
  });
});
