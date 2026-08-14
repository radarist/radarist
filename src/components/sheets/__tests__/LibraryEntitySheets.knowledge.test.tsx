/**
 * UX-027/028/029 — Knowledge (entity-document link) tab for the Org Unit,
 * Initiative, and Pain Point sheets.
 *
 * These three sheets previously rendered no Knowledge tab. The tab itself is
 * self-contained (it fetches/creates/removes document links, maintains the
 * Firestore counter, and triggers Neo4j sync via the service). The sheet's job
 * is only to render it with the correct identity — and critically the correct
 * `entityType`, which for KnowledgeTab is the snake_case TransformationEntityType
 * (`org_unit`/`pain_point`), NOT the camelCase EntityType the RelationsTab uses.
 * A casing slip would silently query the wrong Neo4j label, so lock it here.
 *
 * The tabs barrel is stubbed so KnowledgeTab's heavy document/claim dependency
 * chain does not load; we assert the props the sheet hands it.
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

// Stub the tab barrel: capture the props each sheet passes to KnowledgeTab.
jest.mock('../tabs', () => ({
  __esModule: true,
  NotesTab: () => <div data-testid="notes-tab" />,
  RelationsTab: () => <div data-testid="relations-tab" />,
  KnowledgeTab: (props: { entityType?: string; entityId?: string; entityName?: string }) => (
    <div
      data-testid="knowledge-tab"
      data-entity-type={props.entityType}
      data-entity-id={props.entityId}
      data-entity-name={props.entityName}
    />
  ),
}));

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
jest.mock('@tanstack/react-query', () => ({
  useQuery: jest.fn(() => ({ data: null, isLoading: false, error: null })),
  useMutation: jest.fn(() => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false })),
  useQueryClient: jest.fn(() => ({ invalidateQueries: jest.fn(), setQueryData: jest.fn(), cancelQueries: jest.fn() })),
  QueryClientProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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

type SheetComponent = React.ComponentType<Record<string, unknown>>;

const cases: Array<{
  label: string;
  Sheet: SheetComponent;
  subject: Record<string, unknown>;
  expectType: string;
  expectId: string;
  expectName: string;
}> = [
  { label: 'OrgUnitSheet', Sheet: OrgUnitSheet as unknown as SheetComponent, subject: { orgUnit }, expectType: 'org_unit', expectId: 'ou-1', expectName: 'Platform Team' },
  { label: 'InitiativeSheet', Sheet: InitiativeSheet as unknown as SheetComponent, subject: { initiative }, expectType: 'initiative', expectId: 'init-1', expectName: 'Cloud Migration' },
  { label: 'PainPointSheet', Sheet: PainPointSheet as unknown as SheetComponent, subject: { painPoint }, expectType: 'pain_point', expectId: 'pp-1', expectName: 'Slow onboarding' },
];

describe('Library entity sheets — Knowledge wiring (UX-027/028/029)', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(cases)(
    '$label renders KnowledgeTab with the snake_case entityType and entity identity',
    ({ Sheet, subject, expectType, expectId, expectName }) => {
      render(<Sheet open onOpenChange={jest.fn()} onSave={jest.fn()} {...subject} />);

      // Knowledge tab exists and is reachable in edit mode.
      const knowledgeTab = screen.getByRole('tab', { name: /knowledge/i });
      fireEvent.mouseDown(knowledgeTab);
      fireEvent.click(knowledgeTab);

      const tab = screen.getByTestId('knowledge-tab');
      expect(tab).toHaveAttribute('data-entity-type', expectType);
      expect(tab).toHaveAttribute('data-entity-id', expectId);
      expect(tab).toHaveAttribute('data-entity-name', expectName);
    }
  );
});
