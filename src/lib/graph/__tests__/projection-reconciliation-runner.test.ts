const mockCollections = new Map<string, Array<{ id: string; data: Record<string, unknown> }>>();
const mockCursors = new Map<string, Record<string, unknown>>();
const mockCursorSet = jest.fn(async (kind: string, value: Record<string, unknown>) => {
  mockCursors.set(kind, value);
});
const mockQueryLimit = jest.fn();
const mockGetAll = jest.fn();
const mockProjectAgentRun = jest.fn();
const mockAgentRunStates = new Map<string, import('../agent-run-sync').AgentRunGraphState>();
let mockMalformedAgentRunRows: Array<{
  elementId: string;
  reason: 'missing-id' | 'blank-id' | 'non-string-id';
}> = [];
interface MockEvent {
  id?: string;
  name: string;
  data: Record<string, unknown>;
}
const mockSend = jest.fn(async (_event: MockEvent) => ({ ids: ['accepted'] }));
const mockRunRead = jest.fn(
  async (
    _cypher: string,
    _params?: Record<string, unknown>
  ): Promise<{ records: Array<Record<string, unknown>> }> => ({ records: [] })
);
const mockReferencedSignals = new Map();

function snapshotRows(rows: Array<{ id: string; data: Record<string, unknown> }>) {
  return {
    docs: rows.map((row) => ({ id: row.id, data: () => row.data })),
    size: rows.length,
    empty: rows.length === 0,
  };
}

interface MockOrderedQuery {
  startAfter: jest.Mock<MockOrderedQuery, [string]>;
  limit: jest.Mock<MockOrderedQuery, [number]>;
  get: jest.Mock<Promise<ReturnType<typeof snapshotRows>>, []>;
}

function orderedQuery(
  collection: string,
  afterId: string | null = null,
  limit = Number.POSITIVE_INFINITY
): MockOrderedQuery {
  const query = {} as MockOrderedQuery;
  query.startAfter = jest.fn((id: string) => {
    return orderedQuery(collection, id, limit);
  });
  query.limit = jest.fn((value: number) => {
    mockQueryLimit(collection, value);
    return orderedQuery(collection, afterId, value);
  });
  query.get = jest.fn(async () => {
    const rows = [...(mockCollections.get(collection) ?? [])]
      .sort((left, right) => (left.id === right.id ? 0 : left.id < right.id ? -1 : 1))
      .filter((row) => afterId === null || row.id > afterId)
      .slice(0, limit);
    return snapshotRows(rows);
  });
  return query;
}

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    getAll: (...refs: Array<{ id: string }>) => mockGetAll(...refs),
    collection: jest.fn((collection: string) => ({
      orderBy: jest.fn(() => orderedQuery(collection)),
      where: jest.fn((_field: string, _operator: string, value: unknown) => ({
        limit: jest.fn((_limit: number) => ({
          get: jest.fn(async () =>
            snapshotRows(
              (mockCollections.get(collection) ?? []).filter((row) => row.data.entityType === value)
            )
          ),
        })),
      })),
      doc: jest.fn((id: string) => ({
        id,
        get: jest.fn(async () => {
          if (collection === 'graphReconciliationCursors') {
            const cursor = mockCursors.get(id);
            return { exists: cursor !== undefined, data: () => cursor };
          }
          const row = (mockCollections.get(collection) ?? []).find((candidate) => candidate.id === id);
          return { exists: row !== undefined, data: () => row?.data };
        }),
        set: jest.fn(async (value: Record<string, unknown>) => mockCursorSet(id, value)),
      })),
    })),
  },
}));

jest.mock('@/lib/inngest/client', () => ({
  inngest: { send: (event: MockEvent) => mockSend(event) },
}));
jest.mock('@/lib/graph/neo4j-client', () => ({
  runReadTransaction: (cypher: string, params?: Record<string, unknown>) => mockRunRead(cypher, params),
}));
jest.mock('../agent-run-sync', () => ({
  ...jest.requireActual('../agent-run-sync'),
  projectAgentRunToNeo4j: (...args: unknown[]) => mockProjectAgentRun(...args),
}));
jest.mock('../signal-projection-policy-admin', () => ({
  loadReferencedSignalIds: jest.fn(async () => mockReferencedSignals),
}));

import {
  RECONCILIATION_KINDS,
  relationProjectionFingerprint,
} from '../projection-reconciliation';
import {
  buildExpectedAgentRunProjection,
  type AgentRunGraphState,
  type AgentRunSyncParams,
} from '../agent-run-sync';
import {
  assertReconciliationRegistryComplete,
  ENTITY_PROJECTION_CONFIGS,
  reconcileAgentRuns,
  runProjectionReconciliationCycle,
} from '../projection-reconciliation-runner';
import { createEntitySourceFingerprint } from '@/lib/entity-source-version';

const EMPTY_COLLECTIONS = [
  'companies',
  'technologies',
  'strategies',
  'painPoints',
  'use-cases',
  'documents',
  'signals',
  'org-units',
  'initiatives',
  'prototypes',
  'radars',
  'radarPlacements',
  'concepts',
  'relations',
  'entityDocumentLinks',
  'agentRuns',
];

function setRows(collection: string, rows: Array<{ id: string; data?: Record<string, unknown> }>) {
  mockCollections.set(
    collection,
    rows.map((row) => ({ id: row.id, data: row.data ?? {} }))
  );
}

function agentRun(
  id: string,
  overrides: Partial<AgentRunSyncParams> = {}
): AgentRunSyncParams & Record<string, unknown> {
  return {
    id,
    agentName: 'scout',
    action: `Run ${id}`,
    status: 'success',
    userId: 'user-1',
    createdAt: '2026-07-14T10:00:00.000Z',
    costUsd: 0.1,
    duration: 1000,
    missionId: `mission-${id}`,
    ...overrides,
  };
}

function exactAgentRunState(params: AgentRunSyncParams): AgentRunGraphState {
  const expected = buildExpectedAgentRunProjection(params);
  const owner = {
    id: `episode-${params.id}`,
    missionId: expected.correlationId,
    userId: expected.userId,
    agentName: expected.agentName,
    memoryLane: expected.memoryLane,
    correlationId: expected.correlationId,
    labels: ['Episode'],
  };
  return { run: expected, owners: [owner], candidates: [owner] };
}

function setupGraph(
  labels: Record<string, string[]> = {},
  signalStatuses: Record<string, unknown> = {},
  relationSourceVersions: Record<
    string,
    { correlationId?: string; sourceFingerprint?: string }
  > = {},
  /** GRAPH-056: fingerprint stamped on each projected entity node, by node id. */
  entityFingerprints: Record<string, unknown> = {}
) {
  mockRunRead.mockImplementation(async (cypher: string, params?: Record<string, unknown>) => {
    if (cypher.includes('UNWIND $expectedRows AS expected')) {
      const expectedRows = (params?.expectedRows ?? []) as Array<{
        id: string;
        correlationId: string;
        memoryLane: string;
        userId: string;
        agentName: string;
      }>;
      return {
        records: expectedRows.map((expected) => {
          const configured = mockAgentRunStates.get(expected.id);
          return {
            id: expected.id,
            run: configured?.run ?? null,
            owners: configured?.owners ?? [],
            candidates: configured?.candidates ?? [
              {
                id: `episode-${expected.id}`,
                missionId: expected.correlationId,
                userId: expected.userId,
                agentName: expected.agentName,
                memoryLane: expected.memoryLane,
                correlationId: expected.correlationId,
                labels: ['Episode'],
              },
            ],
          };
        }),
      };
    }
    if (cypher.includes('RETURN graphElementId AS elementId')) {
      const afterElementId =
        typeof params?.afterElementId === 'string' ? params.afterElementId : null;
      return {
        records: mockMalformedAgentRunRows
          .slice()
          .sort((left, right) => left.elementId.localeCompare(right.elementId))
          .filter((row) => afterElementId === null || row.elementId > afterElementId)
          .slice(0, 100),
      };
    }
    if (cypher.includes('MATCH (run:AgentRun)') && cypher.includes('RETURN validId AS id')) {
      const afterId = typeof params?.afterId === 'string' ? params.afterId : null;
      const limit = typeof params?.limit === 'number' ? params.limit : 100;
      return {
        records: (labels.AgentRun ?? [])
          .slice()
          .sort()
          .filter((id) => afterId === null || id > afterId)
          .slice(0, limit)
          .map((id) => ({ id })),
      };
    }
    if (cypher.includes('MATCH (node:Signal)') && cypher.includes('node.status AS status')) {
      return {
        records: (labels.Signal ?? []).map((id) => ({
          id,
          status: signalStatuses[id],
          sourceFingerprint: entityFingerprints[id],
        })),
      };
    }
    const label = cypher.match(/MATCH \(node:(\w+)\)/)?.[1];
    if (label) {
      return {
        records: (labels[label] ?? []).map((id) => ({ id, sourceFingerprint: entityFingerprints[id] })),
      };
    }
    if (cypher.includes('MATCH (radar:Radar)')) {
      return { records: (labels.Radar ?? []).map((id) => ({ id, updatedAt: 1 })) };
    }
    if (cypher.includes('MATCH (placement:RadarPlacement)')) {
      return { records: (labels.RadarPlacement ?? []).map((id) => ({ id })) };
    }
    if (cypher.includes('edge.relationId IS NOT NULL')) {
      return {
        records: (labels.Relation ?? []).map((relationId) => {
          const sourceVersion = relationSourceVersions[relationId];
          return {
            relationId,
            sourceId: 'company-1',
            targetId: 'document-1',
            predicate: 'USES',
            active: true,
            sourceCorrelationId: sourceVersion?.correlationId,
            sourceFingerprint: sourceVersion?.sourceFingerprint,
          };
        }),
      };
    }
    if (cypher.includes('MATCH (assertion:Assertion)')) return { records: [] };
    if (cypher.includes('edge.linkId IS NOT NULL')) {
      return {
        records: (labels.DocumentLink ?? []).map((linkId) => ({
          linkId,
          sourceId: 'company-1',
          sourceLabels: ['Company', 'Entity'],
          documentId: 'document-1',
          relationshipType: 'DOCUMENTED_BY',
        })),
      };
    }
    throw new Error(`Unexpected graph query: ${cypher}`);
  });
}

describe('projection reconciliation runner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockImplementation(async () => ({ ids: ['accepted'] }));
    mockCursorSet.mockImplementation(async (kind, value) => {
      mockCursors.set(kind, value);
    });
    mockCollections.clear();
    mockCursors.clear();
    mockReferencedSignals.clear();
    mockAgentRunStates.clear();
    mockMalformedAgentRunRows = [];
    for (const collection of EMPTY_COLLECTIONS) setRows(collection, []);
    mockGetAll.mockImplementation(async (...refs: Array<{ id: string }>) => {
      const sourceIds = new Set((mockCollections.get('agentRuns') ?? []).map((row) => row.id));
      return refs.map((ref) => ({ id: ref.id, exists: sourceIds.has(ref.id) }));
    });
    mockProjectAgentRun.mockResolvedValue({ status: 'created', reason: 'missing-node' });
    setupGraph();
  });

  it('keeps the kind registry complete and globally bounded', () => {
    expect(() => assertReconciliationRegistryComplete()).not.toThrow();
    expect(new Set(ENTITY_PROJECTION_CONFIGS.map((config) => config.kind)).size).toBe(10);
  });

  it('asks Firestore for bounded cursor pages for every registered kind', async () => {
    await runProjectionReconciliationCycle();
    expect(mockQueryLimit).toHaveBeenCalledTimes(16);
    expect(mockQueryLimit.mock.calls).toEqual(
      expect.arrayContaining(RECONCILIATION_KINDS.map((_kind) => [expect.any(String), 100]))
    );
  });

  it('gives every kind a bounded turn and resumes the same kind from its durable cursor', async () => {
    setRows(
      'companies',
      Array.from({ length: 8 }, (_, index) => ({ id: `company-0${index + 1}` }))
    );
    setupGraph();

    const first = await runProjectionReconciliationCycle();
    const firstCompanyEvents = mockSend.mock.calls
      .map(([event]) => event)
      .filter((event) => event.name === 'app/unified-entity.sync.requested' && event.data.entityType === 'company');

    expect(firstCompanyEvents.map((event) => event.data.entityId)).toEqual([
      'company-01',
      'company-02',
      'company-03',
      'company-04',
      'company-05',
      'company-06',
    ]);
    expect(first.cursors.companies).toMatchObject({ cursorAfter: 'company-06', dispatched: 6 });
    expect(mockCursors.size).toBe(18);
    const firstCompanyEventId = firstCompanyEvents[0].id;

    mockSend.mockClear();
    const second = await runProjectionReconciliationCycle();
    const secondCompanyEvents = mockSend.mock.calls
      .map(([event]) => event)
      .filter((event) => event.name === 'app/unified-entity.sync.requested' && event.data.entityType === 'company');
    expect(secondCompanyEvents.map((event) => event.data.entityId)).toEqual(['company-07', 'company-08']);
    expect(second.cursors.companies).toMatchObject({ cursorBefore: 'company-06', cursorAfter: 'company-08' });

    mockSend.mockClear();
    const wrapped = await runProjectionReconciliationCycle();
    const wrappedCompanyEvents = mockSend.mock.calls
      .map(([event]) => event)
      .filter((event) => event.name === 'app/unified-entity.sync.requested' && event.data.entityType === 'company');
    expect(wrappedCompanyEvents[0]).toMatchObject({
      id: 'graph-reconcile-v1:companies:1:company-01',
      data: { entityId: 'company-01' },
    });
    expect(wrappedCompanyEvents[0].id).not.toBe(firstCompanyEventId);
    expect(wrapped.cursors.companies).toMatchObject({ cycle: 1, wrapped: true });
  });

  it('persists only through the last successful dispatch and resumes at the failed row', async () => {
    setRows('companies', [{ id: 'company-01' }, { id: 'company-02' }, { id: 'company-03' }]);
    let failedOnce = false;
    mockSend.mockImplementation(async (event) => {
      if (event.data.entityId === 'company-02' && !failedOnce) {
        failedOnce = true;
        throw new Error('dispatch unavailable');
      }
      return { ids: ['accepted'] };
    });

    const first = await runProjectionReconciliationCycle();
    expect(first.cursors.companies).toMatchObject({
      cursorAfter: 'company-01',
      dispatched: 1,
      errors: [expect.stringContaining('companies/company-02')],
    });

    mockSend.mockClear();
    const second = await runProjectionReconciliationCycle();
    const resumedCompanyIds = mockSend.mock.calls
      .map(([event]) => event)
      .filter((event) => event.data.entityType === 'company')
      .map((event) => event.data.entityId);
    expect(resumedCompanyIds).toEqual(['company-02', 'company-03']);
    expect(second.cursors.companies).toMatchObject({ cursorAfter: 'company-03', errors: [] });
  });

  it('applies one Signal policy to missing, downgrade, and reference-required rows', async () => {
    setRows('signals', [
      { id: 'signal-approved', data: { status: 'Approved' } },
      { id: 'signal-detected', data: { status: 'Detected' } },
      { id: 'signal-referenced', data: { status: 'Rejected' } },
    ]);
    mockReferencedSignals.set('signal-referenced', [{ id: 'rel-1', kind: 'relation-endpoint' }]);
    setupGraph({ Signal: ['signal-detected'] });

    const result = await runProjectionReconciliationCycle();
    const signalEvents = mockSend.mock.calls
      .map(([event]) => event)
      .filter((event) => event.name === 'app/unified-entity.sync.requested' && event.data.entityType === 'signal');

    expect(signalEvents.map((event) => event.data.entityId).sort()).toEqual([
      'signal-approved',
      'signal-detected',
      'signal-referenced',
    ]);
    expect(result.entities.signals).toMatchObject({ source: 3, firestore: 2, excluded: 1, missing: 2 });
  });

  it('replays an eligible Signal whose Neo4j status is stale', async () => {
    setRows('signals', [{ id: 'signal-approved', data: { status: 'Approved' } }]);
    setupGraph({ Signal: ['signal-approved'] }, { 'signal-approved': 'Detected' });

    const result = await runProjectionReconciliationCycle();

    expect(result.entities.signals).toMatchObject({ missing: 0, stale: 1 });
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app/unified-entity.sync.requested',
        data: { operation: 'update', entityType: 'signal', entityId: 'signal-approved' },
      })
    );
    expect(result.repairPlan.operations).toContainEqual(
      expect.objectContaining({ kind: 'signals', id: 'signal-approved', action: 'replay', reason: 'stale-status' })
    );
  });

  describe('GRAPH-056 version-aware entity projections', () => {
    const companyDoc = { name: 'Acme', status: 'active', tags: ['ai'] };

    const companyEvents = () =>
      mockSend.mock.calls
        .map(([event]) => event)
        .filter(
          (event) =>
            event.name === 'app/unified-entity.sync.requested' && event.data.entityType === 'company'
        );

    it('leaves a projection alone when it already matches its source', async () => {
      // The load-bearing case. Reconciliation previously compared entity IDs
      // alone, so every assertion about drift can also be satisfied by a
      // reconciler that simply replays everything, every cycle. This is the
      // test that fails if it does.
      setRows('companies', [{ id: 'company-1', data: companyDoc }]);
      setupGraph({ Company: ['company-1'] }, {}, {}, {
        'company-1': await createEntitySourceFingerprint('company', 'company-1', companyDoc),
      });

      const result = await runProjectionReconciliationCycle();

      expect(result.entities.companies).toMatchObject({ missing: 0, stale: 0 });
      expect(companyEvents()).toEqual([]);
    });

    it('replays a projection whose content drifted from its source', async () => {
      // The defect GRAPH-056 reopens on: the node exists, so the old
      // ID-existence check reported it healthy while Neo4j held stale content.
      setRows('companies', [{ id: 'company-1', data: companyDoc }]);
      setupGraph({ Company: ['company-1'] }, {}, {}, {
        'company-1': await createEntitySourceFingerprint('company', 'company-1', {
          ...companyDoc,
          name: 'Acme Corp',
        }),
      });

      const result = await runProjectionReconciliationCycle();

      expect(result.entities.companies).toMatchObject({ missing: 0, stale: 1 });
      expect(result.repairPlan.operations).toContainEqual(
        expect.objectContaining({
          kind: 'companies',
          id: 'company-1',
          action: 'replay',
          reason: 'stale-source-version',
        })
      );
    });

    it('heals a projection written before the fingerprint contract existed', async () => {
      // No migration ships with this contract; unstamped nodes converge on
      // their first pass instead.
      setRows('companies', [{ id: 'company-1', data: companyDoc }]);
      setupGraph({ Company: ['company-1'] });

      const result = await runProjectionReconciliationCycle();

      expect(result.repairPlan.operations).toContainEqual(
        expect.objectContaining({ kind: 'companies', id: 'company-1', reason: 'pre-contract-projection' })
      );
    });

    it('heals and counts a malformed fingerprint rather than wedging the cursor', async () => {
      // Throwing here would stall this kind's cursor page on the same document
      // every cycle; replaying re-stamps a valid value and converges, while the
      // count keeps the corruption visible.
      setRows('companies', [{ id: 'company-1', data: companyDoc }]);
      setupGraph({ Company: ['company-1'] }, {}, {}, { 'company-1': 'not-a-valid-digest' });

      const result = await runProjectionReconciliationCycle();

      expect(result.entities.companies).toMatchObject({ malformed: 1 });
      expect(result.repairPlan.operations).toContainEqual(
        expect.objectContaining({ kind: 'companies', reason: 'malformed-projection-fingerprint' })
      );
      expect(result.errors).toEqual([]);
    });

    it('replays a Signal whose status matches but whose content drifted', async () => {
      // Status parity was the only content check Signals had; it cannot see a
      // change to any other projected field.
      const signalDoc = { status: 'Approved', title: 'Original title' };
      setRows('signals', [{ id: 'signal-1', data: signalDoc }]);
      setupGraph({ Signal: ['signal-1'] }, { 'signal-1': 'Approved' }, {}, {
        'signal-1': await createEntitySourceFingerprint('signal', 'signal-1', {
          ...signalDoc,
          title: 'Edited title',
        }),
      });

      const result = await runProjectionReconciliationCycle();

      expect(result.entities.signals).toMatchObject({ stale: 1 });
      expect(result.repairPlan.operations).toContainEqual(
        expect.objectContaining({ kind: 'signals', id: 'signal-1', reason: 'stale-source-version' })
      );
    });
  });

  it('recovers valid links, reports orphan and reverse links, and never emits a delete', async () => {
    setRows('companies', [{ id: 'company-1' }]);
    setRows('documents', [{ id: 'document-1' }]);
    setRows('entityDocumentLinks', [
      {
        id: 'link-good',
        data: {
          entityType: 'company',
          entityId: 'company-1',
          documentId: 'document-1',
          relationshipType: 'documentation',
        },
      },
      {
        id: 'link-orphan',
        data: {
          entityType: 'company',
          entityId: 'company-1',
          documentId: 'document-missing',
          relationshipType: 'documentation',
        },
      },
    ]);
    setupGraph({ DocumentLink: ['link-graph-only'] });

    const result = await runProjectionReconciliationCycle();
    const linkEvents = mockSend.mock.calls.map(([event]) => event).filter((event) => event.name.includes('document-link'));

    expect(linkEvents).toHaveLength(1);
    expect(linkEvents[0].data).toEqual({ operation: 'update', linkId: 'link-good' });
    expect(result.documentLinks.orphaned).toBe(1);
    expect(result.reverse.documentLinks).toEqual(['link-graph-only']);
    expect(result.repairPlan.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'link-orphan', action: 'delete-candidate' }),
        expect.objectContaining({ id: 'link-graph-only', action: 'delete-candidate' }),
      ])
    );
    expect(mockSend.mock.calls.flatMap(([event]) => (event.data.operation === 'delete' ? [event] : []))).toEqual([]);
  });

  it('replays a link projected from the right ID under the wrong source label', async () => {
    setRows('companies', [{ id: 'company-1' }]);
    setRows('documents', [{ id: 'document-1' }]);
    setRows('entityDocumentLinks', [
      {
        id: 'link-wrong-label',
        data: {
          entityType: 'company',
          entityId: 'company-1',
          documentId: 'document-1',
          relationshipType: 'documentation',
        },
      },
    ]);
    setupGraph();
    mockRunRead.mockImplementation(async (cypher: string, _params?: Record<string, unknown>) => {
      if (cypher.includes('edge.linkId IS NOT NULL')) {
        return {
          records: [
            {
              linkId: 'link-wrong-label',
              sourceId: 'company-1',
              sourceLabels: ['Technology', 'Entity'],
              documentId: 'document-1',
              relationshipType: 'DOCUMENTED_BY',
            },
          ],
        };
      }
      const label = cypher.match(/MATCH \(node:(\w+)\)/)?.[1];
      if (label) return { records: [] };
      if (cypher.includes('MATCH (radar:Radar)') || cypher.includes('MATCH (placement:RadarPlacement)')) {
        return { records: [] };
      }
      if (cypher.includes('edge.relationId IS NOT NULL')) return { records: [] };
      if (cypher.includes('MATCH (assertion:Assertion)')) return { records: [] };
      if (
        cypher.includes('MATCH (run:AgentRun)') &&
        (cypher.includes('RETURN validId AS id') ||
          cypher.includes('RETURN graphElementId AS elementId'))
      ) {
        return { records: [] };
      }
      throw new Error(`Unexpected graph query: ${cypher}`);
    });

    const result = await runProjectionReconciliationCycle();
    expect(result.documentLinks.missing).toBe(1);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app/entity-document-link.sync.requested',
        data: { operation: 'update', linkId: 'link-wrong-label' },
      })
    );
  });

  it('leaves a poison relation cursor retryable without starving the later document-link kind', async () => {
    setRows('relations', [
      { id: 'a-poison', data: { relationType: 'uses' } },
      {
        id: 'z-valid',
        data: {
          sourceSnapshot: { id: 'company-1', type: 'company', name: 'Company' },
          targetSnapshot: { id: 'document-1', type: 'document', name: 'Document' },
          relationType: 'uses',
          claimStatus: 'curated',
        },
      },
    ]);
    setRows('companies', [{ id: 'company-1' }]);
    setRows('documents', [{ id: 'document-1' }]);
    setRows('entityDocumentLinks', [
      {
        id: 'link-after-poison',
        data: {
          entityType: 'company',
          entityId: 'company-1',
          documentId: 'document-1',
          relationshipType: 'documentation',
        },
      },
    ]);
    setupGraph();

    const result = await runProjectionReconciliationCycle();

    expect(result.errors).toEqual([expect.stringContaining('relations/a-poison')]);
    expect(result.cursors.relations).toMatchObject({ cursorBefore: null, cursorAfter: null });
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app/entity-document-link.sync.requested',
        data: { operation: 'update', linkId: 'link-after-poison' },
      })
    );
  });

  it('replays a relation with its authoritative stored source version', async () => {
    const correlationId = 'corr_123e4567-e89b-42d3-a456-426614174000';
    const source = {
      sourceSnapshot: { id: 'company-1', type: 'company', name: 'Company' },
      targetSnapshot: { id: 'document-1', type: 'document', name: 'Document' },
      relationType: 'uses',
      claimStatus: 'curated',
    };
    const sourceFingerprint = relationProjectionFingerprint(source);
    setRows('relations', [
      {
        id: 'rel-versioned',
        data: {
          ...source,
          sourceCorrelationId: correlationId,
          sourceFingerprint,
        },
      },
    ]);
    setupGraph();

    await runProjectionReconciliationCycle();

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app/relation.sync.requested',
        data: {
          operation: 'update',
          relationId: 'rel-versioned',
          correlationId,
          sourceFingerprint,
        },
      })
    );
  });

  it.each([
    [
      'correlation',
      { sourceCorrelationId: 'corr_123e4567-e89b-42d3-a456-426614174000' },
    ],
    ['fingerprint', { sourceFingerprint: 'a'.repeat(64) }],
  ])('fails closed on a relation with only a source %s', async (_field, sourceVersion) => {
    setRows('relations', [
      {
        id: 'rel-incomplete',
        data: {
          sourceSnapshot: { id: 'company-1', type: 'company', name: 'Company' },
          targetSnapshot: { id: 'document-1', type: 'document', name: 'Document' },
          relationType: 'uses',
          claimStatus: 'curated',
          ...sourceVersion,
        },
      },
    ]);
    setupGraph();

    const result = await runProjectionReconciliationCycle();

    expect(result.relations).toMatchObject({ malformed: 1, missing: 0 });
    expect(result.errors).toEqual([
      expect.stringContaining('incomplete source version metadata'),
    ]);
    expect(mockSend).not.toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app/relation.sync.requested',
        data: expect.objectContaining({ relationId: 'rel-incomplete' }),
      })
    );
  });

  it('does not replay a topology-correct relation with the current source version', async () => {
    const correlationId = 'corr_123e4567-e89b-42d3-a456-426614174000';
    const source = {
      sourceSnapshot: { id: 'company-1', type: 'company', name: 'Company' },
      targetSnapshot: { id: 'document-1', type: 'document', name: 'Document' },
      relationType: 'uses',
      claimStatus: 'curated',
    };
    const sourceFingerprint = relationProjectionFingerprint(source);
    setRows('relations', [
      {
        id: 'rel-current',
        data: { ...source, sourceCorrelationId: correlationId, sourceFingerprint },
      },
    ]);
    setupGraph(
      { Relation: ['rel-current'] },
      {},
      { 'rel-current': { correlationId, sourceFingerprint } }
    );

    await runProjectionReconciliationCycle();

    expect(mockSend).not.toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app/relation.sync.requested',
        data: expect.objectContaining({ relationId: 'rel-current' }),
      })
    );
  });

  it('replays a topology-correct relation when its graph source version is stale', async () => {
    const correlationId = 'corr_123e4567-e89b-42d3-a456-426614174000';
    const source = {
      sourceSnapshot: { id: 'company-1', type: 'company', name: 'Company' },
      targetSnapshot: { id: 'document-1', type: 'document', name: 'Document' },
      relationType: 'uses',
      claimStatus: 'curated',
    };
    const sourceFingerprint = relationProjectionFingerprint(source);
    setRows('relations', [
      {
        id: 'rel-stale',
        data: { ...source, sourceCorrelationId: correlationId, sourceFingerprint },
      },
    ]);
    setupGraph(
      { Relation: ['rel-stale'] },
      {},
      {
        'rel-stale': {
          correlationId: 'corr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          sourceFingerprint: 'a'.repeat(64),
        },
      }
    );

    await runProjectionReconciliationCycle();

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app/relation.sync.requested',
        data: {
          operation: 'update',
          relationId: 'rel-stale',
          correlationId,
          sourceFingerprint,
        },
      })
    );
  });

  it('advances past standalone and malformed AgentRuns without guessing lifecycle ownership', async () => {
    const standalone = agentRun('a-standalone', { missionId: undefined });
    const dualOwner = agentRun('b-dual', { sweepId: 'sweep-b-dual' });
    const exact = agentRun('c-exact');
    setRows('agentRuns', [
      { id: standalone.id, data: standalone },
      { id: dualOwner.id, data: dualOwner },
      { id: exact.id, data: exact },
    ]);
    mockAgentRunStates.set(exact.id, exactAgentRunState(exact));
    setupGraph({ AgentRun: [exact.id] });

    const result = await reconcileAgentRuns();

    expect(result.source).toMatchObject({ scanned: 3, eligible: 1, cursorAfter: 'c-exact', errors: [] });
    expect(result.categories.standalone).toEqual({ ids: ['a-standalone'], count: 1 });
    expect(result.categories['malformed-source']).toEqual({ ids: ['b-dual'], count: 1 });
    expect(result.classifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'a-standalone', outcome: 'standalone' }),
        expect.objectContaining({ id: 'b-dual', outcome: 'malformed-source', reason: 'dual-owner' }),
        expect.objectContaining({ id: 'c-exact', outcome: 'exact' }),
      ])
    );
    expect(mockProjectAgentRun).not.toHaveBeenCalled();
  });

  it('preserves estimated cost authority through the source parser and graph-state read', async () => {
    const estimated = agentRun('a-estimated', { costState: 'estimated' });
    setRows('agentRuns', [{ id: estimated.id, data: estimated }]);
    mockAgentRunStates.set(estimated.id, exactAgentRunState(estimated));
    setupGraph({ AgentRun: [estimated.id] });

    const result = await reconcileAgentRuns();

    expect(result.categories.exact).toEqual({ ids: [estimated.id], count: 1 });
    expect(mockProjectAgentRun).not.toHaveBeenCalled();
    const graphStateRead = mockRunRead.mock.calls.find(([cypher]) =>
      String(cypher).includes('UNWIND $expectedRows AS expected')
    );
    expect(graphStateRead?.[0]).toContain('.costUsd, .costState, .duration');
  });

  it('repairs missing AgentRun nodes and edges once, then converges without another repair', async () => {
    const missingNode = agentRun('a-missing-node');
    const missingEdge = agentRun('b-missing-edge');
    const preContract = agentRun('c-pre-contract');
    const edgeState = exactAgentRunState(missingEdge);
    edgeState.owners = [];
    const preContractExpected = buildExpectedAgentRunProjection(preContract);
    const preContractState: AgentRunGraphState = {
      run: {
        id: preContractExpected.id,
        agentName: preContractExpected.agentName,
        action: preContractExpected.action,
        status: preContractExpected.status,
        userId: preContractExpected.userId,
        createdAt: preContractExpected.createdAt,
        costUsd: preContractExpected.costUsd,
        duration: preContractExpected.duration,
      },
      owners: [],
      candidates: exactAgentRunState(preContract).candidates,
    };
    setRows('agentRuns', [
      { id: missingNode.id, data: missingNode },
      { id: missingEdge.id, data: missingEdge },
      { id: preContract.id, data: preContract },
    ]);
    mockAgentRunStates.set(missingNode.id, {
      run: null,
      owners: [],
      candidates: exactAgentRunState(missingNode).candidates,
    });
    mockAgentRunStates.set(missingEdge.id, edgeState);
    mockAgentRunStates.set(preContract.id, preContractState);
    setupGraph({ AgentRun: [missingNode.id, missingEdge.id, preContract.id] });
    mockProjectAgentRun.mockImplementation(async (params: AgentRunSyncParams) => {
      const before = mockAgentRunStates.get(params.id);
      mockAgentRunStates.set(params.id, exactAgentRunState(params));
      if (before?.run === null) return { status: 'created', reason: 'missing-node' };
      return before?.run?.correlationId === undefined
        ? { status: 'healed', reason: 'pre-contract' }
        : { status: 'healed', reason: 'missing-edge' };
    });

    const first = await reconcileAgentRuns();
    expect(first.repairs).toMatchObject({ attempted: 3, applied: 3, created: 1, healed: 2 });
    expect(first.categories['missing-node']).toEqual({ ids: ['a-missing-node'], count: 1 });
    expect(first.categories['missing-edge']).toEqual({ ids: ['b-missing-edge'], count: 1 });
    expect(first.categories['pre-contract']).toEqual({ ids: ['c-pre-contract'], count: 1 });

    mockProjectAgentRun.mockClear();
    const converged = await reconcileAgentRuns();
    expect(converged.source).toMatchObject({ scanned: 3, wrapped: true, cycle: 1, repaired: 0 });
    expect(converged.repairs).toMatchObject({ attempted: 0, applied: 0 });
    expect(converged.categories.exact).toEqual({
      ids: ['a-missing-node', 'b-missing-edge', 'c-pre-contract'],
      count: 3,
    });
    expect(mockProjectAgentRun).not.toHaveBeenCalled();
  });

  it('reports payload, owner, Episode, and topology conflicts without calling the projector', async () => {
    const payloadConflict = agentRun('a-payload');
    const ownerConflict = agentRun('b-owner');
    const missingEpisode = agentRun('c-missing-episode');
    const ambiguousEpisode = agentRun('d-ambiguous-episode');
    const topologyConflict = agentRun('e-topology');
    const duplicateEdges = agentRun('f-duplicate-edges');
    const wrongLabelTarget = agentRun('g-wrong-label-target');
    const episodeProvenanceConflict = agentRun('h-episode-provenance');
    setRows(
      'agentRuns',
      [
        payloadConflict,
        ownerConflict,
        missingEpisode,
        ambiguousEpisode,
        topologyConflict,
        duplicateEdges,
        wrongLabelTarget,
        episodeProvenanceConflict,
      ].map((data) => ({ id: data.id, data }))
    );

    const payloadState = exactAgentRunState(payloadConflict);
    payloadState.run = { ...payloadState.run, action: 'Conflicting action' };
    mockAgentRunStates.set(payloadConflict.id, payloadState);
    const ownerState = exactAgentRunState(ownerConflict);
    ownerState.run = { ...ownerState.run, correlationId: 'other-mission' };
    mockAgentRunStates.set(ownerConflict.id, ownerState);
    mockAgentRunStates.set(missingEpisode.id, { run: null, owners: [], candidates: [] });
    const ambiguousCandidates = exactAgentRunState(ambiguousEpisode).candidates;
    mockAgentRunStates.set(ambiguousEpisode.id, {
      run: null,
      owners: [],
      candidates: [ambiguousCandidates[0], { ...ambiguousCandidates[0], id: 'episode-duplicate' }],
    });
    const topologyState = exactAgentRunState(topologyConflict);
    topologyState.owners = [{
      id: 'episode-other',
      missionId: 'mission-other',
      userId: topologyConflict.userId,
      agentName: topologyConflict.agentName,
    }];
    mockAgentRunStates.set(topologyConflict.id, topologyState);
    const duplicateState = exactAgentRunState(duplicateEdges);
    duplicateState.owners = [duplicateState.owners[0], { ...duplicateState.owners[0] }];
    mockAgentRunStates.set(duplicateEdges.id, duplicateState);
    const wrongLabelState = exactAgentRunState(wrongLabelTarget);
    wrongLabelState.owners = [{ ...wrongLabelState.owners[0], labels: ['LegacyOwner'] }];
    mockAgentRunStates.set(wrongLabelTarget.id, wrongLabelState);
    const episodeProvenanceState = exactAgentRunState(episodeProvenanceConflict);
    episodeProvenanceState.run = null;
    episodeProvenanceState.owners = [];
    episodeProvenanceState.candidates = [
      {
        ...episodeProvenanceState.candidates[0],
        memoryLane: 'proactive-sweep',
        correlationId: 'other-mission',
      },
    ];
    mockAgentRunStates.set(episodeProvenanceConflict.id, episodeProvenanceState);
    setupGraph({
      AgentRun: [
        payloadConflict.id,
        ownerConflict.id,
        topologyConflict.id,
        duplicateEdges.id,
        wrongLabelTarget.id,
      ],
    });

    const result = await reconcileAgentRuns();

    expect(result.categories['payload-conflict'].ids).toEqual(['a-payload']);
    expect(result.categories['owner-conflict'].ids).toEqual([
      'b-owner',
      'h-episode-provenance',
    ]);
    expect(result.categories['topology-conflict'].ids).toEqual([
      'c-missing-episode',
      'd-ambiguous-episode',
      'e-topology',
      'f-duplicate-edges',
      'g-wrong-label-target',
    ]);
    expect(result.classifications).toContainEqual(
      expect.objectContaining({ id: 'c-missing-episode', reason: 'missing-episode' })
    );
    expect(result.classifications).toContainEqual(
      expect.objectContaining({ id: 'd-ambiguous-episode', reason: 'ambiguous-episode' })
    );
    expect(result.classifications).toContainEqual(
      expect.objectContaining({ id: 'h-episode-provenance', reason: 'owner-conflict' })
    );
    expect(result.repairs).toMatchObject({ attempted: 0, applied: 0 });
    expect(mockProjectAgentRun).not.toHaveBeenCalled();
  });

  it('reserves at most six AgentRun repairs and resumes from the durable source cursor', async () => {
    const runs = Array.from({ length: 8 }, (_, index) => agentRun(`run-0${index + 1}`));
    setRows('agentRuns', runs.map((data) => ({ id: data.id, data })));
    setupGraph();

    const first = await reconcileAgentRuns();
    expect(first.repairs).toMatchObject({ attempted: 6, applied: 6 });
    expect(first.source).toMatchObject({ scanned: 6, cursorAfter: 'run-06' });

    mockProjectAgentRun.mockClear();
    const second = await reconcileAgentRuns();
    expect(second.repairs).toMatchObject({ attempted: 2, applied: 2 });
    expect(second.source).toMatchObject({ scanned: 2, cursorBefore: 'run-06', cursorAfter: 'run-08' });
    expect(mockProjectAgentRun.mock.calls.map(([params]) => params.id)).toEqual(['run-07', 'run-08']);
  });

  it('keeps direct AgentRun repairs separate from queued sync counts in the scheduled report', async () => {
    const missing = agentRun('run-scheduled');
    setRows('agentRuns', [{ id: missing.id, data: missing }]);

    const result = await runProjectionReconciliationCycle();

    expect(result.syncsTriggered).toBe(0);
    expect(result.repairsApplied).toBe(1);
    expect(result.agentRuns.repairs).toMatchObject({ attempted: 1, applied: 1 });
    expect(result.cursors.agentRuns).toMatchObject({ scanned: 1, dispatched: 0 });
  });

  it('uses one bounded Firestore batch for fair graph-only evidence and increments on a full wrap', async () => {
    const source = agentRun('a-source');
    setRows('agentRuns', [{ id: source.id, data: source }]);
    mockAgentRunStates.set(source.id, exactAgentRunState(source));
    setupGraph({ AgentRun: [source.id, 'z-graph-only'] });

    const first = await reconcileAgentRuns();
    expect(first.reverse).toMatchObject({
      scanned: 2,
      cursorAfter: 'z-graph-only',
      cycle: 0,
      wrapped: false,
      graphOnlyIds: ['z-graph-only'],
    });
    expect(mockGetAll).toHaveBeenCalledTimes(1);
    expect(mockGetAll.mock.calls[0]).toHaveLength(2);

    const wrapped = await reconcileAgentRuns();
    expect(wrapped.reverse).toMatchObject({
      scanned: 2,
      cursorBefore: 'z-graph-only',
      cursorAfter: 'z-graph-only',
      cycle: 1,
      wrapped: true,
      graphOnlyIds: ['z-graph-only'],
    });
    expect(mockGetAll).toHaveBeenCalledTimes(2);
    expect(mockGetAll.mock.calls[1]).toHaveLength(2);
  });

  it('inventories malformed graph IDs independently without poisoning valid reverse progress', async () => {
    const source = agentRun('a-source');
    setRows('agentRuns', [{ id: source.id, data: source }]);
    mockAgentRunStates.set(source.id, exactAgentRunState(source));
    mockMalformedAgentRunRows = [
      { elementId: '4:graph040:1', reason: 'missing-id' },
      { elementId: '4:graph040:2', reason: 'non-string-id' },
    ];
    setupGraph({ AgentRun: [source.id, 'z-graph-only'] });

    const first = await reconcileAgentRuns();
    expect(first.reverse).toMatchObject({
      scanned: 2,
      cursorAfter: 'z-graph-only',
      graphOnlyIds: ['z-graph-only'],
      errors: [],
    });
    expect(first.malformedGraph).toMatchObject({
      scanned: 2,
      cursorAfter: '4:graph040:2',
      cycle: 0,
      wrapped: false,
      elementIds: ['4:graph040:1', '4:graph040:2'],
      errors: [],
    });
    expect(first.categories['malformed-graph']).toEqual({
      ids: ['neo4j-element:4:graph040:1', 'neo4j-element:4:graph040:2'],
      count: 2,
    });
    expect(first.classifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'neo4j-element:4:graph040:1', reason: 'missing-id' }),
        expect.objectContaining({ id: 'neo4j-element:4:graph040:2', reason: 'non-string-id' }),
      ])
    );
    expect(mockGetAll.mock.calls.at(-1)).toHaveLength(2);

    const wrapped = await reconcileAgentRuns();
    expect(wrapped.reverse).toMatchObject({
      cursorBefore: 'z-graph-only',
      cursorAfter: 'z-graph-only',
      cycle: 1,
      wrapped: true,
    });
    expect(wrapped.malformedGraph).toMatchObject({
      cursorBefore: '4:graph040:2',
      cursorAfter: '4:graph040:2',
      cycle: 1,
      wrapped: true,
      elementIds: ['4:graph040:1', '4:graph040:2'],
    });
  });

  it('increments the source cycle for a same-ID wrap and for an emptied collection', async () => {
    const only = agentRun('only-run');
    setRows('agentRuns', [{ id: only.id, data: only }]);
    mockAgentRunStates.set(only.id, exactAgentRunState(only));
    setupGraph({ AgentRun: [only.id] });

    const first = await reconcileAgentRuns();
    expect(first.source).toMatchObject({ cursorAfter: 'only-run', cycle: 0, wrapped: false });

    const sameIdWrap = await reconcileAgentRuns();
    expect(sameIdWrap.source).toMatchObject({
      scanned: 1,
      cursorBefore: 'only-run',
      cursorAfter: 'only-run',
      cycle: 1,
      wrapped: true,
    });

    setRows('agentRuns', []);
    const emptied = await reconcileAgentRuns();
    expect(emptied.source).toMatchObject({
      scanned: 0,
      cursorBefore: 'only-run',
      cursorAfter: null,
      cycle: 2,
      wrapped: true,
    });
  });

  it('does not advance beyond a strict projector transport failure', async () => {
    const first = agentRun('a-retry');
    const second = agentRun('b-later');
    setRows('agentRuns', [
      { id: first.id, data: first },
      { id: second.id, data: second },
    ]);
    mockProjectAgentRun.mockRejectedValueOnce(new Error('Neo4j unavailable'));

    const failed = await reconcileAgentRuns();
    expect(failed.source).toMatchObject({
      scanned: 0,
      cursorAfter: null,
      errors: [expect.stringContaining('agentRuns/a-retry')],
    });

    mockProjectAgentRun.mockClear();
    mockProjectAgentRun.mockResolvedValue({ status: 'created', reason: 'missing-node' });
    const retried = await reconcileAgentRuns();
    expect(retried.source).toMatchObject({ scanned: 2, cursorAfter: 'b-later', errors: [] });
    expect(mockProjectAgentRun.mock.calls.map(([params]) => params.id)).toEqual(['a-retry', 'b-later']);
  });

  it('fails the cycle when cursor persistence fails', async () => {
    mockCursorSet.mockRejectedValueOnce(new Error('cursor storage unavailable'));
    await expect(runProjectionReconciliationCycle()).rejects.toThrow('cursor storage unavailable');
  });
});
