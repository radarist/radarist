/**
 * @file components/sheets/tabs/__tests__/KnowledgeTab.test.tsx
 * @description Component tests for the KnowledgeTab claims wiring (P5-D).
 *
 * The claims section previously only rendered when a `claims` prop was
 * passed — and no mount site ever passed it, so the 131 live :Assertion
 * nodes had no review surface. These tests pin the new behavior:
 *
 *   1. The tab self-fetches claims via useEntityClaims and renders them.
 *   2. A loading state is shown while claims are being fetched.
 *   3. A successful empty response and an unavailable graph are distinct.
 *   4. A graph failure offers retry without blocking linked documents.
 *   5. An explicitly passed `claims` prop still takes precedence.
 *   6. Evidence snippets render on claims that carry evidence.
 *
 * @jest-environment jsdom
 */

// ============================================================================
// MOCKS
// ============================================================================

// lucide-react ships as ESM which Jest doesn't transform by default.
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

jest.mock('@/hooks/use-toast', () => ({
  useToast: jest.fn(() => ({ toast: jest.fn() })),
}));

jest.mock('@/lib/entity-document-link-service', () => ({
  getLinksWithDocuments: jest.fn().mockResolvedValue([]),
  deleteEntityDocumentLink: jest.fn(),
  approveAISuggestion: jest.fn(),
  rejectAISuggestion: jest.fn(),
}));

jest.mock('@/components/knowledge/LinkedDocumentCard', () => ({
  LinkedDocumentCard: () => <div data-testid="linked-document-card" />,
}));

jest.mock('@/components/knowledge/LinkDocumentForm', () => ({
  LinkDocumentForm: () => null,
}));

const mockUseEntityClaims = jest.fn();
jest.mock('@/hooks/queries/useEntityClaims', () => ({
  useEntityClaims: (...args: unknown[]) => mockUseEntityClaims(...args),
}));

// ============================================================================
// IMPORTS
// ============================================================================

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { KnowledgeTab } from '../KnowledgeTab';
import type { EntityClaims } from '@/lib/graph/types';

// ============================================================================
// FIXTURES
// ============================================================================

function makeClaim(overrides: Record<string, unknown> = {}) {
  return {
    id: 'claim-1',
    statement: 'TensorFlow addresses ML complexity',
    confidence: 85,
    status: 'proposed' as const,
    createdAt: 1000,
    updatedAt: 2000,
    subjectId: 'ent-1',
    subjectType: 'technology' as const,
    subjectName: 'TensorFlow',
    objectId: 'ent-2',
    objectType: 'useCase' as const,
    objectName: 'ML complexity',
    predicate: 'ADDRESSES',
    assertedBy: 'agent:scout',
    asserterType: 'agent' as const,
    evidence: [],
    ...overrides,
  };
}

function renderTab(props: Partial<React.ComponentProps<typeof KnowledgeTab>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <KnowledgeTab entityType="technology" entityId="ent-1" entityName="TensorFlow" {...props} />
    </QueryClientProvider>
  );
}

// ============================================================================
// TESTS
// ============================================================================

describe('KnowledgeTab claims wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseEntityClaims.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: jest.fn(),
    });
  });

  it('renders self-fetched claims from useEntityClaims', async () => {
    mockUseEntityClaims.mockReturnValue({
      data: {
        asSubject: [makeClaim()],
        asObject: [],
        totalCount: 1,
      },
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: jest.fn(),
    });

    renderTab();

    expect(await screen.findByText('Claims & Evidence')).toBeInTheDocument();
    expect(screen.getByText('TensorFlow addresses ML complexity')).toBeInTheDocument();
    expect(screen.getByText('85% confidence')).toBeInTheDocument();
    // The hook was wired with the tab's entityId
    expect(mockUseEntityClaims).toHaveBeenCalledWith('ent-1', expect.anything());
  });

  it('shows the claims loading state while fetching', async () => {
    mockUseEntityClaims.mockReturnValue({
      data: undefined,
      isLoading: true,
      isFetching: true,
      isError: false,
      refetch: jest.fn(),
    });

    renderTab();

    expect(await screen.findByText('Claims & Evidence')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading claims');
  });

  it('shows a genuine empty state after a successful claims response', async () => {
    mockUseEntityClaims.mockReturnValue({
      data: { asSubject: [], asObject: [], totalCount: 0 },
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: jest.fn(),
    });

    renderTab();

    expect(await screen.findByText('Claims & Evidence')).toBeInTheDocument();
    expect(screen.getByText(/No claims yet/)).toBeInTheDocument();
    expect(screen.queryByText('Claims unavailable')).not.toBeInTheDocument();
  });

  it('shows claims as unavailable with retry while documents remain usable', async () => {
    const refetch = jest.fn().mockResolvedValue(undefined);
    mockUseEntityClaims.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetching: false,
      isError: true,
      error: new Error('Graph backend unavailable'),
      refetch,
    });

    renderTab();

    expect(await screen.findByRole('alert')).toHaveTextContent('Claims unavailable');
    expect(screen.getByRole('alert')).toHaveTextContent('Linked documents are still available');
    expect(screen.queryByText(/No claims yet/)).not.toBeInTheDocument();
    expect(screen.getByText('Linked Documents')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Document' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry claims' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('prefers an explicitly passed claims prop over the self-fetch', async () => {
    mockUseEntityClaims.mockReturnValue({
      data: { asSubject: [makeClaim({ id: 'fetched', statement: 'fetched claim' })], asObject: [], totalCount: 1 },
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: jest.fn(),
    });

    const propClaims: EntityClaims = {
      asSubject: [makeClaim({ id: 'from-prop', statement: 'prop claim' })],
      asObject: [],
      totalCount: 1,
    };

    renderTab({ claims: propClaims });

    expect(await screen.findByText('prop claim')).toBeInTheDocument();
    expect(screen.queryByText('fetched claim')).not.toBeInTheDocument();
  });

  it('renders evidence snippets on claims that carry evidence', async () => {
    mockUseEntityClaims.mockReturnValue({
      data: {
        asSubject: [
          makeClaim({
            evidence: [
              {
                id: 'ev-1',
                sourceType: 'web_ref',
                snippet: 'TensorFlow simplifies machine learning workflows.',
                sourceUrl: 'https://example.com/tf',
                capturedAt: 1500,
              },
            ],
          }),
        ],
        asObject: [],
        totalCount: 1,
      },
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: jest.fn(),
    });

    renderTab();

    expect(await screen.findByText(/TensorFlow simplifies machine learning workflows/)).toBeInTheDocument();
  });
});
