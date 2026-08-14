/**
 * Basic render tests for TechnologySheet component
 *
 * These are smoke tests to serve as a safety net before Phase 3 decomposition.
 * They verify the component can mount, shows loading state, and renders its title.
 *
 * Mocking strategy: Mock all heavy transitive dependencies to prevent
 * import chain failures (Firebase, TanStack Query, hooks, etc.).
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

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

// Mock marked (used for markdown rendering in TechnologySheet)
jest.mock('marked', () => ({
  marked: jest.fn((text: string) => `<p>${text}</p>`),
}));

// Mock TrendChart (uses recharts which is heavy)
jest.mock('@/components/TrendChart', () => ({
  TrendChart: () => <div data-testid="trend-chart" />,
}));

// Mock EntityRelationshipPanel (imports Firebase + relations)
jest.mock('@/components/graphs/EntityRelationshipPanel', () => ({
  EntityRelationshipPanel: () => <div data-testid="entity-relationship-panel" />,
}));

// Mock TechnologyRingBadge
jest.mock('@/components/cards/TechnologyCard', () => ({
  TechnologyRingBadge: ({ ring }: { ring?: string }) => <span data-testid="ring-badge">{ring}</span>,
}));

// Mock fetchWithAuth
jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: jest.fn(),
}));

// Mock technology-service (generateSlug)
jest.mock('@/lib/technology-service', () => ({
  generateSlug: jest.fn((name: string) => name.toLowerCase().replace(/\s+/g, '-')),
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

import { TechnologySheet } from '../TechnologySheet';

// ============================================================================
// TESTS
// ============================================================================

describe('TechnologySheet', () => {
  const defaultProps = {
    open: true,
    onOpenChange: jest.fn(),
    onSave: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders without crashing in create mode', () => {
    render(<TechnologySheet {...defaultProps} />);
    // Component should mount without throwing
    expect(screen.getByText('New Technology')).toBeInTheDocument();
  });

  it('shows loading skeleton when isLoading is true', () => {
    render(<TechnologySheet {...defaultProps} isLoading={true} />);
    // When loading, the skeleton replaces form content.
    // The sheet title still renders, but form fields (e.g. "Technology name") should not.
    expect(screen.getByText('New Technology')).toBeInTheDocument();
    // Skeleton renders into portal — query document.body for animate-pulse divs
    const skeletonElements = document.body.querySelectorAll('.animate-pulse');
    expect(skeletonElements.length).toBeGreaterThan(0);
  });

  it('renders the sheet title for create mode', () => {
    render(<TechnologySheet {...defaultProps} />);
    expect(screen.getByText('New Technology')).toBeInTheDocument();
  });

  it('renders the sheet title for edit mode', () => {
    const technology = {
      id: 'tech-1',
      name: 'React',
      slug: 'react',
      description: 'A JavaScript library',
      category: 'framework' as const,
      tags: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    render(<TechnologySheet {...defaultProps} technology={technology as never} />);

    // In edit mode the title should include the technology name
    expect(screen.getByText('React')).toBeInTheDocument();
  });

  it('preserves a dirty edit when live data rebuilds the same technology object', async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    const technology = {
      id: 'tech-1',
      name: 'React',
      slug: 'react',
      description: 'Original description',
      category: 'framework' as const,
      tags: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const { rerender } = render(
      <TechnologySheet {...defaultProps} onSave={onSave} technology={technology as never} />
    );

    const description = await screen.findByPlaceholderText(/Brief description of the technology/i);
    fireEvent.change(description, { target: { value: 'Unsaved operator draft' } });
    const save = screen.getByRole('button', { name: 'Save Changes' });
    await waitFor(() => expect(save).toBeEnabled());

    rerender(
      <TechnologySheet
        {...defaultProps}
        onSave={onSave}
        technology={{ ...technology, researchStatus: 'pending' } as never}
      />
    );

    expect(description).toHaveValue('Unsaved operator draft');
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ description: 'Unsaved operator draft' }))
    );
  });

  it('does not render content when open is false', () => {
    render(<TechnologySheet {...defaultProps} open={false} />);
    expect(screen.queryByText('New Technology')).not.toBeInTheDocument();
  });

  it('closes after a successful delete and releases the modal pointer lock', async () => {
    let resolveDelete!: (value: boolean) => void;
    const onDelete = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveDelete = resolve;
        })
    );
    const technology = {
      id: 'tech-1',
      name: 'React',
      slug: 'react',
      description: 'A JavaScript library',
      category: 'framework' as const,
      tags: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    function Harness() {
      const [open, setOpen] = React.useState(true);
      return (
        <>
          <output data-testid="sheet-open">{String(open)}</output>
          <TechnologySheet
            {...defaultProps}
            open={open}
            onOpenChange={setOpen}
            onDelete={onDelete}
            technology={technology as never}
          />
        </>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await screen.findByText('Delete React?');
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1)!);

    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('sheet-open')).toHaveTextContent('true');
    expect(document.body.style.pointerEvents).toBe('none');

    resolveDelete(true);

    await waitFor(() => expect(screen.getByTestId('sheet-open')).toHaveTextContent('false'));
    await waitFor(() => expect(document.body.style.pointerEvents).not.toBe('none'));
  });

  it('keeps a failed delete retryable and releases the pointer lock on teardown', async () => {
    const onDelete = jest.fn().mockResolvedValue(false);
    const technology = {
      id: 'tech-1',
      name: 'React',
      slug: 'react',
      description: 'A JavaScript library',
      category: 'framework' as const,
      tags: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const { unmount } = render(
      <TechnologySheet
        {...defaultProps}
        onDelete={onDelete}
        technology={technology as never}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await screen.findByText('Delete React?');
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1)!);

    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
    expect(screen.getByText('React')).toBeInTheDocument();
    expect(document.body.style.pointerEvents).toBe('none');

    unmount();

    await waitFor(() => expect(document.body.style.pointerEvents).not.toBe('none'));
  });

  describe('pending research refresh polling', () => {
    const technology = {
      id: 'tech-research',
      name: 'Quantum Sensors',
      slug: 'quantum-sensors',
      description: 'Quantum sensing technology',
      category: 'hardware' as const,
      tags: [],
      researchStatus: 'pending' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('starts refreshing an open technology after the conservative interval', async () => {
      const onAIResearch = jest.fn().mockResolvedValue(undefined);
      const { unmount } = render(
        <TechnologySheet {...defaultProps} technology={technology as never} onAIResearch={onAIResearch} />
      );

      await act(async () => {
        await jest.advanceTimersByTimeAsync(9_999);
      });
      expect(onAIResearch).not.toHaveBeenCalled();

      await act(async () => {
        await jest.advanceTimersByTimeAsync(1);
      });
      expect(onAIResearch).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('never overlaps refresh calls when one request is still pending', async () => {
      let resolveFirstRefresh!: () => void;
      const onAIResearch = jest
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resolveFirstRefresh = resolve;
            })
        )
        .mockResolvedValue(undefined);
      const { unmount } = render(
        <TechnologySheet {...defaultProps} technology={technology as never} onAIResearch={onAIResearch} />
      );

      await act(async () => {
        await jest.advanceTimersByTimeAsync(10_000);
      });
      expect(onAIResearch).toHaveBeenCalledTimes(1);

      await act(async () => {
        await jest.advanceTimersByTimeAsync(60_000);
      });
      expect(onAIResearch).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveFirstRefresh();
        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(10_000);
      });
      expect(onAIResearch).toHaveBeenCalledTimes(2);
      unmount();
    });

    it('stops refreshing when research reaches a terminal state', async () => {
      const onAIResearch = jest.fn().mockResolvedValue(undefined);
      const { rerender, unmount } = render(
        <TechnologySheet {...defaultProps} technology={technology as never} onAIResearch={onAIResearch} />
      );

      await act(async () => {
        await jest.advanceTimersByTimeAsync(10_000);
      });
      expect(onAIResearch).toHaveBeenCalledTimes(1);

      rerender(
        <TechnologySheet
          {...defaultProps}
          technology={{ ...technology, researchStatus: 'completed' } as never}
          onAIResearch={onAIResearch}
        />
      );
      await act(async () => {
        await jest.advanceTimersByTimeAsync(30_000);
      });
      expect(onAIResearch).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('clears the refresh timer when the sheet closes', async () => {
      const onAIResearch = jest.fn().mockResolvedValue(undefined);
      const { rerender, unmount } = render(
        <TechnologySheet {...defaultProps} technology={technology as never} onAIResearch={onAIResearch} />
      );

      await act(async () => {
        await jest.advanceTimersByTimeAsync(10_000);
      });
      expect(onAIResearch).toHaveBeenCalledTimes(1);

      rerender(
        <TechnologySheet
          {...defaultProps}
          open={false}
          technology={technology as never}
          onAIResearch={onAIResearch}
        />
      );
      await act(async () => {
        await jest.advanceTimersByTimeAsync(30_000);
      });
      expect(onAIResearch).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('clears the refresh timer when the sheet unmounts', async () => {
      const onAIResearch = jest.fn().mockResolvedValue(undefined);
      const { unmount } = render(
        <TechnologySheet {...defaultProps} technology={technology as never} onAIResearch={onAIResearch} />
      );

      unmount();
      await act(async () => {
        await jest.advanceTimersByTimeAsync(30_000);
      });
      expect(onAIResearch).not.toHaveBeenCalled();
    });
  });
});
