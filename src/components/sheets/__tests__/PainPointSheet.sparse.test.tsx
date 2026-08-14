/**
 * @file PainPointSheet.sparse.test.tsx
 * @description UX-059 regression — opening the Pain Point sheet on a normalized
 * sparse (triage-created) Pain Point yields usable empty-list edit defaults and
 * does not crash. The boundary normalizer guarantees the array fields, so the
 * sheet's `painPoint.field || []` reset resolves to `[]`.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';

// --- MOCKS (must precede sheet imports; mirrors LibraryEntitySheets.notes) --
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

import { PainPointSheet } from '../PainPointSheet';
import { normalizePainPointForRead } from '@/lib/pain-points-shared';
import type { PainPoint } from '@/lib/types';

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
  global.matchMedia = global.matchMedia || ((q: string) => ({ matches: false, media: q, addListener: jest.fn(), removeListener: jest.fn(), addEventListener: jest.fn(), removeEventListener: jest.fn(), onchange: null, dispatchEvent: jest.fn() }));
});

// A sparse scout-approved record exactly as stored before the boundary fix.
const sparseRaw = {
  id: 'painpoint-sheet-sparse',
  slug: 'sheet-sparse',
  title: 'Sparse Sheet Pain',
  description: 'Edited from a triage-created record',
  severity: 'medium',
  status: 'identified',
  category: 'operational',
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

describe('PainPointSheet — sparse edit defaults (UX-059)', () => {
  it('opens on a normalized sparse pain point with usable empty-list defaults', async () => {
    const painPoint = normalizePainPointForRead(sparseRaw) as PainPoint;

    expect(() =>
      render(
        <PainPointSheet
          open
          onOpenChange={jest.fn()}
          painPoint={painPoint}
          onSave={jest.fn().mockResolvedValue(undefined)}
        />
      )
    ).not.toThrow();

    // The title is reflected into the editable title input (Overview tab).
    await waitFor(() => {
      expect(screen.getByDisplayValue('Sparse Sheet Pain')).toBeInTheDocument();
    });

    // The normalized arrays resolve to usable empty-list defaults.
    expect(painPoint.affectedOrgUnitIds).toEqual([]);
    expect(painPoint.tags).toEqual([]);
    expect(painPoint.linkedPrototypeIds).toEqual([]);
    expect(painPoint.linkedTechnologyIds).toEqual([]);
    expect(painPoint.linkedInitiativeIds).toEqual([]);
  });

  it('preserves populated arrays when opening a fully-populated pain point', async () => {
    const populated = normalizePainPointForRead({
      ...sparseRaw,
      id: 'painpoint-sheet-full',
      title: 'Full Sheet Pain',
      affectedOrgUnitIds: ['org-1', 'org-2'],
      tags: ['a', 'b', 'c'],
    }) as PainPoint;

    render(
      <PainPointSheet
        open
        onOpenChange={jest.fn()}
        painPoint={populated}
        onSave={jest.fn().mockResolvedValue(undefined)}
      />
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue('Full Sheet Pain')).toBeInTheDocument();
    });
    expect(populated.affectedOrgUnitIds).toEqual(['org-1', 'org-2']);
    expect(populated.tags).toEqual(['a', 'b', 'c']);
  });
});
