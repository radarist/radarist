import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockToast = jest.fn();

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

jest.mock('@/components/layout/AppLayoutV2', () => ({
  SmartLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock('@/components/layout/PageShell', () => ({
  PageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock('@/components/feedback/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ErrorFallback: () => <div role="alert">Graph error</div>,
}));

jest.mock('@/components/skeletons', () => ({
  GraphSkeleton: () => <div>Loading graph</div>,
}));

jest.mock('@/components/ui/resizable', () => ({
  ResizableHandle: () => <div />,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () =>
    function MockGraphVisualization({
      nodes,
      relationships,
      onNodeClick,
      onRelationshipClick,
      selectedNodeId,
      selectedRelationshipId,
      isolatedNodeId,
      activeLabel,
      activeRelationshipType,
      isLoading,
      loadingPhase,
    }: {
      nodes: Array<{ id: string; labels: string[]; properties: Record<string, unknown> }>;
      relationships: Array<{
        id: string;
        from: string;
        to: string;
        type: string;
        properties: Record<string, unknown>;
      }>;
      onNodeClick?: (node: { id: string; labels: string[]; properties: Record<string, unknown> }) => void;
      onRelationshipClick?: (relationship: {
        id: string;
        from: string;
        to: string;
        type: string;
        properties: Record<string, unknown>;
      }) => void;
      selectedNodeId?: string | null;
      selectedRelationshipId?: string | null;
      isolatedNodeId?: string | null;
      activeLabel?: string | null;
      activeRelationshipType?: string | null;
      isLoading?: boolean;
      loadingPhase?: string | null;
    }) {
      return (
        <div>
          <span data-testid="mock-graph-count">
            {nodes.length} nodes, {relationships.length} relationships
          </span>
          <span data-testid="mock-busy">{isLoading ? 'busy' : 'idle'}</span>
          <span data-testid="mock-phase">{loadingPhase ?? ''}</span>
          <span data-testid="mock-isolated-node">{isolatedNodeId ?? ''}</span>
          <span data-testid="mock-selected-node">{selectedNodeId ?? ''}</span>
          <span data-testid="mock-selected-relationship">{selectedRelationshipId ?? ''}</span>
          <span data-testid="mock-active-label">{activeLabel ?? ''}</span>
          <span data-testid="mock-active-relationship-type">{activeRelationshipType ?? ''}</span>
          <button type="button" disabled={!nodes[0]} onClick={() => nodes[0] && onNodeClick?.(nodes[0])}>
            Select first graph node
          </button>
          <button
            type="button"
            disabled={!relationships[0]}
            onClick={() => relationships[0] && onRelationshipClick?.(relationships[0])}
          >
            Select first graph relationship
          </button>
          {nodes.map((node) => (
            <button key={node.id} type="button" onClick={() => onNodeClick?.(node)}>
              Select graph node {node.id}
            </button>
          ))}
          {relationships.map((relationship) => (
            <button key={relationship.id} type="button" onClick={() => onRelationshipClick?.(relationship)}>
              Select graph relationship {relationship.id}
            </button>
          ))}
        </div>
      );
    },
}));

jest.mock('@/components/visualizations/graph', () => ({
  // GRAPH-055: the real input stays submittable while loading — a re-submit
  // deliberately supersedes a hung operation (recovery without a reload).
  CypherQueryInput: ({
    value,
    onChange,
    onExecute,
  }: {
    value: string;
    onChange: (next: string) => void;
    onExecute: () => void;
    isLoading?: boolean;
  }) => (
    <>
      {/* The real control is editable; GRAPH-071 needs that to prove an edit
          does not re-arm the one-shot autorun. */}
      <input data-testid="mock-cypher-input" value={value} onChange={(event) => onChange(event.target.value)} />
      <button type="button" onClick={onExecute}>
        Run query
      </button>
    </>
  ),
  QueryTemplates: () => <div />,
  GraphOverviewPanel: ({
    stats,
    onLabelClick,
    onTypeClick,
    activeLabel,
    activeType,
  }: {
    stats: {
      nodeCount: number;
      relationshipCount: number;
      labelCounts: Record<string, number>;
      typeCounts: Record<string, number>;
    };
    onLabelClick?: (label: string | null) => void;
    onTypeClick?: (type: string | null) => void;
    activeLabel?: string | null;
    activeType?: string | null;
  }) => (
    <div>
      <span data-testid="mock-overview-counts">
        Overview: {stats.nodeCount} / {stats.relationshipCount}
      </span>
      <span data-testid="mock-overview-active-label">{activeLabel ?? ''}</span>
      <span data-testid="mock-overview-active-type">{activeType ?? ''}</span>
      {Object.entries(stats.labelCounts).map(([label, count]) => (
        <button key={label} type="button" onClick={() => onLabelClick?.(label)}>
          Focus {label} nodes ({count})
        </button>
      ))}
      {Object.entries(stats.typeCounts).map(([type, count]) => (
        <button key={type} type="button" onClick={() => onTypeClick?.(type)}>
          Focus {type} relationships ({count})
        </button>
      ))}
    </div>
  ),
  GraphDetailPanel: ({
    selectedNode,
    onExpandNeighbors,
    onIsolateNode,
    isIsolated,
    onClose,
    expansionState,
  }: {
    selectedNode?: { id: string } | null;
    onExpandNeighbors?: (nodeId: string) => void;
    onIsolateNode?: (nodeId: string) => void;
    isIsolated?: boolean;
    onClose?: () => void;
    expansionState?: 'idle' | 'loading' | 'complete' | 'global-limit' | 'stalled';
  }) => {
    if (!selectedNode) return <div>No selection</div>;
    const labels = {
      idle: 'Expand',
      loading: 'Expanding',
      complete: 'Complete',
      'global-limit': 'Limit reached',
      stalled: 'Unavailable',
    } as const;
    const state = expansionState || 'idle';
    return (
      <div data-testid="mock-node-detail">
        <span>{selectedNode.id}</span>
        <button type="button" disabled={state !== 'idle'} onClick={() => onExpandNeighbors?.(selectedNode.id)}>
          {labels[state]}
        </button>
        <button type="button" onClick={() => onIsolateNode?.(selectedNode.id)}>
          {isIsolated ? 'Clear isolate' : 'Isolate'}
        </button>
        <button type="button" onClick={onClose}>
          Close detail
        </button>
      </div>
    );
  },
}));

jest.mock('lucide-react', () => {
  const makeIcon = (name: string) => {
    const Icon = () => <span data-testid={`icon-${name}`} />;
    Icon.displayName = name;
    return Icon;
  };
  return new Proxy({}, { get: (_target, prop: string) => makeIcon(prop) });
});

jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: jest.fn(),
}));

import { fetchWithAuth } from '@/lib/fetch-with-auth';
import GraphPage from '../page';

interface MockNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
}

interface MockRelationship {
  id: string;
  from: string;
  to: string;
  type: string;
  properties: Record<string, unknown>;
}

interface QueryRequest {
  query: string;
  params?: { nodeId?: string; excludedRelationshipIds?: string[] };
}

const mockedFetchWithAuth = fetchWithAuth as jest.MockedFunction<typeof fetchWithAuth>;

function node(id: string): MockNode {
  return { id, labels: ['Entity', 'Technology'], properties: { id, name: id } };
}

function relationship(index: number): MockRelationship {
  return {
    id: `relationship-${index}`,
    from: 'hub',
    to: `neighbor-${index}`,
    type: 'RELATED_TO',
    properties: {},
  };
}

function successfulResponse(nodes: MockNode[], relationships: MockRelationship[]) {
  const labelCounts: Record<string, number> = {};
  const typeCounts: Record<string, number> = {};
  for (const item of nodes) {
    for (const label of item.labels) labelCounts[label] = (labelCounts[label] ?? 0) + 1;
  }
  for (const item of relationships) typeCounts[item.type] = (typeCounts[item.type] ?? 0) + 1;
  return {
    ok: true,
    json: async () => ({
      success: true,
      nodes,
      relationships,
      stats: {
        nodeCount: nodes.length,
        relationshipCount: relationships.length,
        labelCounts,
        typeCounts,
      },
      executionTimeMs: 1,
      truncated: false,
    }),
  } as Response;
}

/**
 * GRAPH-071 — the page auto-runs the shipped default exactly once on mount, so
 * every scenario below starts with one query already spent. Rendering through
 * this helper makes that operation explicit and lets each test express its
 * expectations relative to `AUTORUN_QUERIES` instead of hard-coding an offset
 * that would silently rot if the first-run behaviour changed again.
 */
const AUTORUN_QUERIES = 1;

async function renderAfterAutoRun(): Promise<HTMLElement> {
  render(<GraphPage />);
  const run = await screen.findByRole('button', { name: 'Run query' });
  // The autorun's REQUEST is what must have happened before a test scripts its
  // own operations. Waiting on the call (not on a settled response) keeps this
  // usable for the deferred/hanging-promise scenarios too.
  await waitFor(() => expect(mockedFetchWithAuth).toHaveBeenCalledTimes(AUTORUN_QUERIES));
  return run;
}

describe('GRAPH-071 first-run defaults', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('runs the shipped default once on arrival with the Overview cockpit already open', async () => {
    mockedFetchWithAuth.mockResolvedValue(successfulResponse([node('hub')], []));

    render(<GraphPage />);

    // No click. First paint must be a graph attempt, not `No data to display`.
    await screen.findByText('1 nodes, 0 relationships');
    expect(screen.getByRole('button', { name: 'Hide graph sidebar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show graph sidebar' })).not.toBeInTheDocument();

    const submitted = JSON.parse(String(mockedFetchWithAuth.mock.calls[0][1]?.body)) as QueryRequest;
    expect(submitted.query).toContain('any(label IN labels(n) WHERE label IN domainLabels)');
    expect(submitted.query).toContain('r.t_invalidated IS NULL');
  });

  it('does not re-arm the autorun when the operator edits the Cypher', async () => {
    mockedFetchWithAuth.mockResolvedValue(successfulResponse([node('hub')], []));

    render(<GraphPage />);
    await screen.findByText('1 nodes, 0 relationships');
    expect(mockedFetchWithAuth).toHaveBeenCalledTimes(AUTORUN_QUERIES);

    // `executeQuery` changes identity on every keystroke. A dependency-guarded
    // autorun would fire the operator's half-typed query out from under them.
    fireEvent.change(screen.getByTestId('mock-cypher-input'), {
      target: { value: 'MATCH (n:Company) RETURN n LIMIT 5' },
    });
    await waitFor(() => expect(mockedFetchWithAuth).toHaveBeenCalledTimes(AUTORUN_QUERIES));
  });
});

describe('GraphPage progressive expansion controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requests deterministic unseen pages, preserves selection, and ends at complete', async () => {
    const requests: QueryRequest[] = [];
    mockedFetchWithAuth.mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as QueryRequest;
      requests.push(request);
      if (!request.params) return successfulResponse([node('hub')], []);

      if (requests.filter((candidate) => candidate.params).length === 1) {
        const relationships = Array.from({ length: 13 }, (_, index) => relationship(index));
        return successfulResponse(
          [node('hub'), ...relationships.map((item, index) => node(`neighbor-${index}`))],
          relationships
        );
      }

      const relationships = [relationship(12), relationship(13)];
      return successfulResponse([node('hub'), node('neighbor-12'), node('neighbor-13')], relationships);
    });

    render(<GraphPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run query' }));
    await screen.findByText('1 nodes, 0 relationships');
    fireEvent.click(screen.getByRole('button', { name: 'Select first graph node' }));

    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    await screen.findByText('13 nodes, 12 relationships');
    expect(screen.getByTestId('mock-node-detail')).toHaveTextContent('hub');
    expect(screen.getByRole('button', { name: 'Expand' })).toBeEnabled();

    const firstExpansion = requests.find((request) => request.params);
    expect(firstExpansion?.query).toContain('ORDER BY elementId(r)');
    expect(firstExpansion?.params).toEqual({ nodeId: 'hub', excludedRelationshipIds: [] });

    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    await screen.findByText('15 nodes, 14 relationships');
    expect(screen.getByRole('button', { name: 'Complete' })).toBeDisabled();
    expect(screen.getByTestId('mock-node-detail')).toHaveTextContent('hub');

    const expansionRequests = requests.filter((request) => request.params);
    expect(expansionRequests).toHaveLength(2);
    expect(expansionRequests[1].params?.excludedRelationshipIds).toEqual(
      Array.from({ length: 12 }, (_, index) => `relationship-${index}`)
    );
  });

  it('synchronously rejects duplicate expansion attempts while a request is in flight', async () => {
    let resolveExpansion: ((response: Response) => void) | undefined;
    mockedFetchWithAuth.mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as QueryRequest;
      if (!request.params) return successfulResponse([node('hub')], []);
      return new Promise<Response>((resolve) => {
        resolveExpansion = resolve;
      });
    });

    fireEvent.click(await renderAfterAutoRun());
    await screen.findByText('1 nodes, 0 relationships');
    fireEvent.click(screen.getByRole('button', { name: 'Select first graph node' }));

    const expand = screen.getByRole('button', { name: 'Expand' });
    fireEvent.click(expand);
    fireEvent.click(expand);

    await screen.findByRole('button', { name: 'Expanding' });
    // autorun + base query + one expansion
    expect(mockedFetchWithAuth).toHaveBeenCalledTimes(AUTORUN_QUERIES + 2);
    resolveExpansion?.(successfulResponse([node('hub')], []));
    await screen.findByRole('button', { name: 'Complete' });
  });

  it('disables expansion without a request when the loaded graph is at the global node cap', async () => {
    const cappedNodes = Array.from({ length: 300 }, (_, index) => node(index === 0 ? 'hub' : `node-${index}`));
    mockedFetchWithAuth.mockResolvedValue(successfulResponse(cappedNodes, []));

    fireEvent.click(await renderAfterAutoRun());
    await screen.findByText('300 nodes, 0 relationships');
    fireEvent.click(screen.getByRole('button', { name: 'Select first graph node' }));

    expect(screen.getByRole('button', { name: 'Limit reached' })).toBeDisabled();
    // The cap is refused CLIENT-side: no expansion request is issued on top of
    // the autorun and the explicit base query.
    expect(mockedFetchWithAuth).toHaveBeenCalledTimes(AUTORUN_QUERIES + 1);
    await waitFor(() => expect(mockToast).toHaveBeenCalled());
  });

  it('a late stale response never clobbers the newer graph or busy state', async () => {
    interface Deferred {
      resolve: (response: Response) => void;
      signal: AbortSignal | null;
    }
    const deferreds: Deferred[] = [];
    mockedFetchWithAuth.mockImplementation(
      (_url, init) =>
        new Promise<Response>((resolve) => {
          deferreds.push({ resolve, signal: init?.signal ?? null });
        })
    );

    // The autorun's own request hangs here too and occupies `deferreds[0]`; the
    // ops this test scripts start after it.
    const run = await renderAfterAutoRun();

    fireEvent.click(run); // op 1 — will hang, then settle late
    expect(screen.getByTestId('mock-busy')).toHaveTextContent('busy');
    fireEvent.click(run); // op 2 — supersedes op 1
    expect(deferreds).toHaveLength(AUTORUN_QUERIES + 2);

    deferreds[AUTORUN_QUERIES + 1].resolve(successfulResponse([node('hub'), node('n2')], []));
    await screen.findByText('2 nodes, 0 relationships');
    await waitFor(() => expect(screen.getByTestId('mock-busy')).toHaveTextContent('idle'));

    // The stale op-1 response settles AFTER op 2 committed — it must be discarded.
    // Flush the stale continuation deterministically before asserting.
    await act(async () => {
      deferreds[AUTORUN_QUERIES].resolve(
        successfulResponse([node('hub'), node('a'), node('b'), node('c'), node('d')], [])
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('mock-graph-count')).toHaveTextContent('2 nodes, 0 relationships');
    expect(screen.getByTestId('mock-busy')).toHaveTextContent('idle');
    expect(mockToast.mock.calls.filter(([args]) => args?.title === 'Query executed')).toHaveLength(1);
  });

  it('re-submitting aborts the hung request and surfaces no error for the superseded op', async () => {
    interface Deferred {
      resolve: (response: Response) => void;
      reject: (reason: unknown) => void;
      signal: AbortSignal | null;
    }
    const deferreds: Deferred[] = [];
    mockedFetchWithAuth.mockImplementation(
      (_url, init) =>
        new Promise<Response>((resolve, reject) => {
          // Mirror real fetch: reject with AbortError when the signal fires.
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          deferreds.push({ resolve, reject, signal: init?.signal ?? null });
        })
    );

    const run = await renderAfterAutoRun();

    fireEvent.click(run); // op 1 hangs
    fireEvent.click(run); // op 2 supersedes → op 1's signal aborts, fetch rejects

    expect(deferreds[AUTORUN_QUERIES].signal?.aborted).toBe(true);

    // Flush op 1's abort continuation while op 2 is still pending: the
    // superseded op's finally must NOT cross-clear the newer op's busy state.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('mock-busy')).toHaveTextContent('busy');

    deferreds[AUTORUN_QUERIES + 1].resolve(successfulResponse([node('hub')], []));
    await screen.findByText('1 nodes, 0 relationships');
    await waitFor(() => expect(screen.getByTestId('mock-busy')).toHaveTextContent('idle'));

    // The aborted op must not produce a "Query failed" toast or an error banner.
    expect(mockToast.mock.calls.filter(([args]) => args?.title === 'Query failed')).toHaveLength(0);
  });

  it('clears busy and retains the prior graph on failed, malformed, and network-error responses', async () => {
    mockedFetchWithAuth
      // The autorun consumes the first queued response; the explicit base query
      // below consumes the second, then the three failure modes follow.
      .mockResolvedValueOnce(successfulResponse([node('hub')], []))
      .mockResolvedValueOnce(successfulResponse([node('hub')], []))
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ success: false, message: 'server exploded' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
      } as unknown as Response)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));

    render(<GraphPage />);
    const run = await screen.findByRole('button', { name: 'Run query' });
    fireEvent.click(run);
    await screen.findByText('1 nodes, 0 relationships');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      fireEvent.click(run);
      // Busy must clear on EVERY terminal path…
      await waitFor(() => expect(screen.getByTestId('mock-busy')).toHaveTextContent('idle'));
      // …and the last valid graph must survive the bounded failure.
      expect(screen.getByTestId('mock-graph-count')).toHaveTextContent('1 nodes, 0 relationships');
    }

    expect(mockToast.mock.calls.filter(([args]) => args?.title === 'Query failed')).toHaveLength(3);
  });

  it('clears a hard isolate before a replacement query can fail', async () => {
    mockedFetchWithAuth
      // First response belongs to the autorun, second to the explicit base query.
      .mockResolvedValueOnce(successfulResponse([node('hub')], []))
      .mockResolvedValueOnce(successfulResponse([node('hub')], []))
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ success: false, message: 'bounded failure' }),
      } as Response);

    const run = await renderAfterAutoRun();
    fireEvent.click(run);
    await screen.findByText('1 nodes, 0 relationships');
    fireEvent.click(screen.getByRole('button', { name: 'Select first graph node' }));
    fireEvent.click(screen.getByRole('button', { name: 'Isolate' }));
    expect(screen.getByTestId('mock-isolated-node')).toHaveTextContent('hub');

    fireEvent.click(run);
    await waitFor(() => expect(screen.getByTestId('mock-busy')).toHaveTextContent('idle'));
    expect(screen.getByTestId('mock-isolated-node')).toBeEmptyDOMElement();
    expect(screen.getByText('1 nodes, 0 relationships')).toBeInTheDocument();
  });

  it('never strands isolate state when detail, focus, relationship, or view context changes', async () => {
    const nodes = [node('hub'), node('neighbor-0')];
    const relationships = [relationship(0)];
    mockedFetchWithAuth.mockResolvedValue(successfulResponse(nodes, relationships));

    render(<GraphPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run query' }));
    await screen.findByText('2 nodes, 1 relationships');

    const isolateFirstNode = () => {
      fireEvent.click(screen.getByRole('button', { name: 'Select first graph node' }));
      fireEvent.click(screen.getByRole('button', { name: 'Isolate' }));
      expect(screen.getByTestId('mock-isolated-node')).toHaveTextContent('hub');
    };

    isolateFirstNode();
    fireEvent.click(screen.getByRole('button', { name: 'Close detail' }));
    expect(screen.getByTestId('mock-isolated-node')).toBeEmptyDOMElement();

    isolateFirstNode();
    fireEvent.click(screen.getByRole('button', { name: 'Hide graph sidebar' }));
    expect(screen.getByTestId('mock-isolated-node')).toBeEmptyDOMElement();

    isolateFirstNode();
    fireEvent.click(screen.getByRole('button', { name: 'Select first graph relationship' }));
    expect(screen.getByTestId('mock-isolated-node')).toBeEmptyDOMElement();
    expect(screen.getByTestId('mock-selected-relationship')).toHaveTextContent('relationship-0');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Domain view' }));
    expect(screen.getByTestId('mock-selected-relationship')).toHaveTextContent('relationship-0');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Raw audit view' }));

    isolateFirstNode();
    fireEvent.click(screen.getByRole('button', { name: 'Focus Technology nodes (2)' }));
    expect(screen.getByTestId('mock-isolated-node')).toBeEmptyDOMElement();

    isolateFirstNode();
    fireEvent.click(screen.getByRole('button', { name: 'Focus RELATED_TO relationships (1)' }));
    expect(screen.getByTestId('mock-isolated-node')).toBeEmptyDOMElement();

    isolateFirstNode();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Domain view' }));
    expect(screen.getByTestId('mock-isolated-node')).toBeEmptyDOMElement();
    expect(screen.getByTestId('mock-node-detail')).toHaveTextContent('hub');
  });

  it('reconciles focus, selection, detail, and overview truth across Raw and Domain views', async () => {
    const auditNode: MockNode = {
      id: 'audit',
      labels: ['Evidence'],
      properties: { id: 'audit' },
    };
    const domainOne: MockNode = {
      id: 'domain-1',
      labels: ['Technology'],
      properties: { id: 'domain-1' },
    };
    const domainTwo: MockNode = {
      id: 'domain-2',
      labels: ['Company'],
      properties: { id: 'domain-2' },
    };
    const auditRelationship: MockRelationship = {
      id: 'audit-edge',
      from: 'audit',
      to: 'domain-1',
      type: 'SUPPORTED_BY',
      properties: {},
    };
    const domainRelationship: MockRelationship = {
      id: 'domain-edge',
      from: 'domain-1',
      to: 'domain-2',
      type: 'USES',
      properties: {},
    };
    mockedFetchWithAuth.mockResolvedValue(
      successfulResponse([auditNode, domainOne, domainTwo], [auditRelationship, domainRelationship])
    );

    render(<GraphPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run query' }));
    await screen.findByText('3 nodes, 2 relationships');
    // GRAPH-071 — the Overview cockpit is open on arrival; there is no longer a
    // `Show graph sidebar` button to click here.
    expect(screen.getByRole('button', { name: 'Hide graph sidebar' })).toBeInTheDocument();

    expect(screen.getByTestId('mock-overview-counts')).toHaveTextContent('Overview: 3 / 2');
    fireEvent.click(screen.getByRole('button', { name: 'Focus Evidence nodes (1)' }));
    expect(screen.getByTestId('mock-active-label')).toHaveTextContent('Evidence');

    fireEvent.click(screen.getByRole('button', { name: 'Switch to Domain view' }));
    expect(screen.getByTestId('mock-active-label')).toBeEmptyDOMElement();
    expect(screen.getByTestId('mock-overview-active-label')).toBeEmptyDOMElement();
    expect(screen.queryByRole('button', { name: 'Focus Evidence nodes (1)' })).not.toBeInTheDocument();
    expect(screen.getByTestId('mock-overview-counts')).toHaveTextContent('Overview: 2 / 1');

    fireEvent.click(screen.getByRole('button', { name: 'Switch to Raw audit view' }));
    fireEvent.click(screen.getByRole('button', { name: 'Focus SUPPORTED_BY relationships (1)' }));
    expect(screen.getByTestId('mock-active-relationship-type')).toHaveTextContent('SUPPORTED_BY');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Domain view' }));
    expect(screen.getByTestId('mock-active-relationship-type')).toBeEmptyDOMElement();
    expect(screen.queryByRole('button', { name: 'Focus SUPPORTED_BY relationships (1)' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Switch to Raw audit view' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select graph node audit' }));
    expect(screen.getByTestId('mock-selected-node')).toHaveTextContent('audit');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Domain view' }));
    expect(screen.getByTestId('mock-selected-node')).toBeEmptyDOMElement();
    expect(screen.queryByTestId('mock-node-detail')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Switch to Raw audit view' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select graph relationship audit-edge' }));
    expect(screen.getByTestId('mock-selected-relationship')).toHaveTextContent('audit-edge');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Domain view' }));
    expect(screen.getByTestId('mock-selected-relationship')).toBeEmptyDOMElement();

    fireEvent.click(screen.getByRole('button', { name: 'Select graph node domain-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Raw audit view' }));
    expect(screen.getByTestId('mock-selected-node')).toHaveTextContent('domain-1');
    fireEvent.click(screen.getByRole('button', { name: 'Select graph relationship domain-edge' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Domain view' }));
    expect(screen.getByTestId('mock-selected-relationship')).toHaveTextContent('domain-edge');
  });

  it('disables the discovery scout until Entity-labeled nodes are in view, then sends that context (DISC-016)', async () => {
    // GRAPH-071 — the autorun would otherwise put nodes in view before this test
    // can observe the empty state at all. Give the autorun an EMPTY result so the
    // scout's context-required precondition is still exercised for real: an empty
    // view offers no click, a populated one does.
    let graphQueries = 0;
    mockedFetchWithAuth.mockImplementation(async (url, init) => {
      if (String(url).includes('/api/discovery/scout')) {
        return { ok: true, json: async () => ({ dispatched: true }) } as Response;
      }
      const request = JSON.parse(String(init?.body)) as QueryRequest;
      void request;
      graphQueries += 1;
      if (graphQueries <= AUTORUN_QUERIES) return successfulResponse([], []);
      return successfulResponse([node('hub')], []);
    });

    const run = await renderAfterAutoRun();
    const scout = await screen.findByRole('button', { name: /discovery scout/i });
    // Empty view — nothing to scope the scout to, so the click is not offered.
    await waitFor(() => expect(scout).toBeDisabled());

    fireEvent.click(run);
    await screen.findByText('1 nodes, 0 relationships');
    const enabledScout = screen.getByRole('button', { name: /discovery scout/i });
    expect(enabledScout).toBeEnabled();

    fireEvent.click(enabledScout);
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Discovery scout queued' }))
    );
    const scoutCall = mockedFetchWithAuth.mock.calls.find(([url]) => String(url).includes('/api/discovery/scout'));
    expect(scoutCall).toBeDefined();
    const body = JSON.parse(String(scoutCall![1]?.body)) as {
      context?: { focusEntityIds?: string[]; focusTopics?: string[] };
    };
    // The click always carries the bounded view context — never an empty body —
    // and entity names provide the topic scope even without tags (DISC-016).
    expect(body.context?.focusEntityIds).toEqual(['hub']);
    expect(body.context?.focusTopics).toEqual(['hub']);
  });

  it('does not claim completion when an unseen relationship has a missing endpoint', async () => {
    mockedFetchWithAuth.mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as QueryRequest;
      if (!request.params) return successfulResponse([node('hub')], []);
      return successfulResponse(
        [node('hub')],
        [
          {
            id: 'malformed-relationship',
            from: 'hub',
            to: 'missing-endpoint',
            type: 'RELATED_TO',
            properties: {},
          },
        ]
      );
    });

    render(<GraphPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run query' }));
    await screen.findByText('1 nodes, 0 relationships');
    fireEvent.click(screen.getByRole('button', { name: 'Select first graph node' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));

    expect(await screen.findByRole('button', { name: 'Unavailable' })).toBeDisabled();
    expect(screen.getByText('1 nodes, 0 relationships')).toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Expansion stopped', variant: 'destructive' })
    );
  });
});
