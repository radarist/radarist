/**
 * Basic render tests for PrototypeSheet component
 *
 * These are smoke tests to serve as a safety net before Phase 3 decomposition.
 * They verify the component can mount, shows loading state, and renders its title.
 *
 * Mocking strategy: Mock all heavy transitive dependencies to prevent
 * import chain failures (Firebase, TanStack Query, hooks, etc.).
 */

import React from 'react';
import { render, screen } from '@testing-library/react';

// ============================================================================
// MOCKS — must come before component import
// ============================================================================

// Mock session tracking (Phase 4) so tests don't fetch / need getIdToken
jest.mock('@/hooks/useTrackEntityView', () => ({
  useTrackEntityView: jest.fn(),
}));

// Break Firebase auth chain
jest.mock('@/lib/firebase', () => ({
  db: {},
  auth: { currentUser: { uid: 'test-user' } },
}));

// Mock firebase/firestore
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

// Mock firebase/auth
jest.mock('firebase/auth', () => ({
  getAuth: jest.fn(() => ({ currentUser: { uid: 'test-user' } })),
  onAuthStateChanged: jest.fn(),
}));

// Mock Next.js navigation
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/test',
}));

// Mock next/link
jest.mock('next/link', () => {
  return ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a>;
});

// Mock next/dynamic
jest.mock('next/dynamic', () => () => {
  const DynamicComponent = () => <div data-testid="dynamic-component" />;
  DynamicComponent.displayName = 'DynamicComponent';
  return DynamicComponent;
});

// Mock TanStack Query
jest.mock('@tanstack/react-query', () => ({
  useQuery: jest.fn(() => ({ data: null, isLoading: false, error: null })),
  useMutation: jest.fn(() => ({
    mutate: jest.fn(),
    mutateAsync: jest.fn(),
    isLoading: false,
    isPending: false,
  })),
  useQueryClient: jest.fn(() => ({
    invalidateQueries: jest.fn(),
    setQueryData: jest.fn(),
    cancelQueries: jest.fn(),
  })),
  QueryClientProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock lucide-react with a Proxy so any icon import works
jest.mock('lucide-react', () => {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined;
        const IconComponent = (props: React.SVGProps<SVGSVGElement>) => <svg data-testid={`icon-${prop}`} {...props} />;
        IconComponent.displayName = prop;
        return IconComponent;
      },
    }
  );
});

// Mock ErrorBoundary
jest.mock('@/components/feedback/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock VerificationBadge (avoids firebase import chain)
jest.mock('@/components/impulse/VerificationBadge', () => ({
  VerificationBadge: () => null,
}));

// Mock fetchWithAuth
jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: jest.fn(),
}));

// Mock hooks that use Firebase/fetch
jest.mock('@/hooks/useEntitySearch', () => ({
  useEntitySearch: jest.fn(() => ({
    search: jest.fn(),
    results: [],
    isSearching: false,
  })),
}));

jest.mock('@/hooks/use-toast', () => ({
  useToast: jest.fn(() => ({ toast: jest.fn() })),
}));

jest.mock('@/hooks/useAutosave', () => ({
  useAutosave: jest.fn(() => ({ status: 'idle', save: jest.fn() })),
}));

// Mock the Business Unit options hook (real hook reaches @/lib/org-units +
// orgUnitKeys, which this file's narrow query-keys mock does not provide)
jest.mock('@/hooks/queries/useOrgUnits', () => ({
  useBusinessUnitNames: jest.fn(() => ({ data: [], isLoading: false, isError: false })),
}));

jest.mock('@/hooks/useProposedRelations', () => ({
  usePendingProposedRelations: jest.fn(() => ({
    data: [],
    isLoading: false,
    approveRelation: jest.fn(),
    rejectRelation: jest.fn(),
  })),
}));

// Mock AuthProvider
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: jest.fn(() => ({
    user: { uid: 'test-user', email: 'test@example.com' },
    loading: false,
  })),
}));

// Mock AI discovery flow (transitive from AIRelationDiscovery)
jest.mock('@/ai/flows/discover-relations', () => ({
  discoverRelations: jest.fn(),
}));

// Mock knowledge components
jest.mock('@/components/knowledge/LinkedDocumentCard', () => ({
  LinkedDocumentCard: () => <div data-testid="linked-document-card" />,
}));

jest.mock('@/components/knowledge/LinkDocumentForm', () => ({
  LinkDocumentForm: () => <div data-testid="link-document-form" />,
}));

// Mock query-keys
jest.mock('@/lib/query-keys', () => ({
  entityDocumentLinkKeys: {
    all: ['entity-document-links'],
    byEntity: (type: string, id: string) => ['entity-document-links', type, id],
  },
  proposedRelationKeys: {
    all: ['proposed-relations'],
    byEntity: (id: string) => ['proposed-relations', id],
  },
}));

// ============================================================================
// IMPORT COMPONENT (after mocks)
// ============================================================================

import { PrototypeSheet } from '../PrototypeSheet';

// ============================================================================
// TESTS
// ============================================================================

describe('PrototypeSheet', () => {
  const defaultProps = {
    open: true,
    onOpenChange: jest.fn(),
    onSave: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders without crashing in create mode', () => {
    render(<PrototypeSheet {...defaultProps} />);
    // Component should mount without throwing
    expect(screen.getByText('New Prototype')).toBeInTheDocument();
  });

  it('shows loading skeleton when isLoading is true', () => {
    render(<PrototypeSheet {...defaultProps} isLoading={true} />);
    // When loading, the skeleton replaces form content.
    // The sheet title still renders, but form fields should not.
    expect(screen.getByText('New Prototype')).toBeInTheDocument();
    // Skeleton renders into portal — query document.body for animate-pulse divs
    const skeletonElements = document.body.querySelectorAll('.animate-pulse');
    expect(skeletonElements.length).toBeGreaterThan(0);
  });

  it('renders the sheet title for create mode', () => {
    render(<PrototypeSheet {...defaultProps} />);
    expect(screen.getByText('New Prototype')).toBeInTheDocument();
  });

  it('renders the sheet title for edit mode', () => {
    const prototype = {
      id: 'proto-1',
      name: 'AI Chatbot',
      description: 'A customer service chatbot',
      status: 'In Development' as const,
      targetBusinessUnit: 'Customer Support',
      team: ['user-1'],
      presentedTo: [],
      artifacts: {},
      impact: {
        type: 'Cost Saving' as const,
        estimatedValue: 50000,
        timeToImpact: '6 months',
        confidence: 70,
        notes: 'Initial estimate',
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    render(<PrototypeSheet {...defaultProps} prototype={prototype as never} />);

    // In edit mode the title should include the prototype name
    expect(screen.getByText('AI Chatbot')).toBeInTheDocument();
  });

  it('does not render content when open is false', () => {
    render(<PrototypeSheet {...defaultProps} open={false} />);
    expect(screen.queryByText('New Prototype')).not.toBeInTheDocument();
  });
});
