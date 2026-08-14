/** @jest-environment node */

import {
  GRAPH_CANARY_PROJECT_ID,
  assertDisposableGraphCanaryEnvironment,
  buildGenericCanaryPayload,
  preflightGraphCanary,
  runGenericCanaryLeg,
  runGraphCanary,
  runPlacementCanaryLeg,
  runRelationCanaryLeg,
  type GraphCanaryDependencies,
  type GraphCanaryRuntime,
} from '../graph-canary';
import { buildRelationTripleKey } from '../../src/lib/relations-triple-key';

const SAFE_ENV: NodeJS.ProcessEnv = {
  GRAPH_CANARY_DISPOSABLE: 'true',
  NEXT_PUBLIC_USE_FIREBASE_EMULATOR: 'true',
  INNGEST_ENABLED: 'true',
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: GRAPH_CANARY_PROJECT_ID,
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:18080',
  GRAPH_CANARY_APP_URL: 'http://127.0.0.1:9012',
  GRAPH_CANARY_INNGEST_URL: 'http://127.0.0.1:18288',
  NEO4J_URI: 'bolt://127.0.0.1:17687',
};

const RUNTIME: GraphCanaryRuntime = {
  projectId: GRAPH_CANARY_PROJECT_ID,
  firestoreHost: '127.0.0.1:18080',
  appUrl: 'http://127.0.0.1:9012',
  inngestUrl: 'http://127.0.0.1:18288',
  neo4jUri: 'bolt://127.0.0.1:17687',
  pollTimeoutMs: 5_000,
  pollIntervalMs: 100,
};

function dependencyStub(overrides: Partial<GraphCanaryDependencies> = {}): GraphCanaryDependencies {
  return {
    fetch: jest.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    now: Date.now,
    sleep: async () => undefined,
    uniqueId: () => 'fixed-id',
    checkNeo4j: async () => ({ healthy: true }),
    read: (async () => ({ records: [{ c: 0 }] })) as GraphCanaryDependencies['read'],
    write: async () => undefined,
    getEntityConfig: () => ({ collection: 'technologies', nameField: 'name' }),
    createEntity: async () => ({ id: 'created-id' }),
    deleteFirestoreDoc: async () => undefined,
    putFirestoreDoc: async () => undefined,
    triggerEntitySync: async () => undefined,
    createPlacement: async () => ({ id: 'placement-id' }),
    deletePlacement: async () => undefined,
    createLink: async () => ({ id: 'link-id' }),
    deleteLink: async () => undefined,
    getLinkStatus: async () => 'synced',
    createRelation: async () => ({ id: 'relation-id' }) as never,
    updateRelation: async () => ({ id: 'relation-id' }) as never,
    deleteRelation: async () => undefined,
    getRelationLock: async () => null,
    close: async () => undefined,
    ...overrides,
  };
}

describe('disposable graph canary guard', () => {
  it('accepts the isolated selftest stack and rejects protected defaults', () => {
    expect(assertDisposableGraphCanaryEnvironment(SAFE_ENV)).toEqual(
      expect.objectContaining({
        projectId: GRAPH_CANARY_PROJECT_ID,
        firestoreHost: '127.0.0.1:18080',
        appUrl: 'http://127.0.0.1:9012',
        inngestUrl: 'http://127.0.0.1:18288',
        neo4jUri: 'bolt://127.0.0.1:17687',
      })
    );

    expect(() => assertDisposableGraphCanaryEnvironment({ ...SAFE_ENV, GRAPH_CANARY_DISPOSABLE: undefined })).toThrow(
      'GRAPH_CANARY_DISPOSABLE=true'
    );
    expect(() =>
      assertDisposableGraphCanaryEnvironment({ ...SAFE_ENV, NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-radarist' })
    ).toThrow(GRAPH_CANARY_PROJECT_ID);
    expect(() =>
      assertDisposableGraphCanaryEnvironment({ ...SAFE_ENV, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' })
    ).toThrow('protected normal-profile port 8080');
    expect(() =>
      assertDisposableGraphCanaryEnvironment({ ...SAFE_ENV, GRAPH_CANARY_APP_URL: 'http://127.0.0.1:9002' })
    ).toThrow('protected normal-profile port 9002');
    expect(() =>
      assertDisposableGraphCanaryEnvironment({ ...SAFE_ENV, NEO4J_URI: 'bolt://127.0.0.1:7687' })
    ).toThrow('protected default Bolt port 7687');
  });

  it('builds payloads from each entity config name field', () => {
    expect(buildGenericCanaryPayload('signal', { collection: 'signals', nameField: 'title' }, 'Unique Signal')).toEqual({
      title: 'Unique Signal',
      createdBy: 'graph-canary',
      status: 'Approved',
    });
    expect(
      buildGenericCanaryPayload('technology', { collection: 'technologies', nameField: 'name' }, 'Unique Tech')
    ).toEqual({ name: 'Unique Tech', createdBy: 'graph-canary' });
  });
});

describe('graph canary legs', () => {
  it('preflights Firestore through a valid collection-list endpoint', async () => {
    const fetchMock = jest.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const deps = dependencyStub({ fetch: fetchMock });

    await expect(preflightGraphCanary(RUNTIME, deps)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('/documents/technologies?pageSize=1'),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('verifies an exact typed node and the production delete event', async () => {
    let clock = 1_700_000_000_000;
    const createEntity = jest.fn(async () => ({ id: 'signal-id' }));
    const deleteFirestoreDoc = jest.fn(async () => undefined);
    const triggerEntitySync = jest.fn(async () => undefined);
    const read = jest.fn(async (cypher: string) => ({
      records: [{ c: cypher.includes(':Entity:Signal') ? 1 : 0 }],
    })) as unknown as GraphCanaryDependencies['read'];
    const deps = dependencyStub({
      now: () => (clock += 10),
      getEntityConfig: () => ({ collection: 'signals', nameField: 'title' }),
      createEntity,
      deleteFirestoreDoc,
      triggerEntitySync,
      read,
    });

    const result = await runGenericCanaryLeg('signal', RUNTIME, deps);

    expect(result).toEqual(expect.objectContaining({ appeared: true, deleted: true, cleanupVerified: true }));
    expect(createEntity).toHaveBeenCalledWith(
      'signal',
      expect.objectContaining({
        title: expect.stringContaining('graph-canary-signal-'),
        status: 'Approved',
      })
    );
    expect(triggerEntitySync).toHaveBeenCalledWith('signal', 'signal-id', 'delete');
    expect(deleteFirestoreDoc).toHaveBeenCalledWith('signals', 'signal-id');
  });

  it('cleans a prerequisite that never reaches Neo4j', async () => {
    let clock = 0;
    const deleteFirestoreDoc = jest.fn(async () => undefined);
    const write = jest.fn(async () => undefined);
    const deps = dependencyStub({
      now: () => (clock += 3_000),
      deleteFirestoreDoc,
      write,
    });

    const result = await runPlacementCanaryLeg(RUNTIME, deps);

    expect(result.error).toContain('Technology prerequisite created-id never appeared');
    expect(deleteFirestoreDoc).toHaveBeenCalledWith('technologies', 'created-id');
    expect(deleteFirestoreDoc).toHaveBeenCalledWith('radars', 'graph-canary-radar-fixed-id');
    expect(write).toHaveBeenCalledWith('MATCH (n {id: $id}) DETACH DELETE n', { id: 'created-id' });
    expect(result.cleanupVerified).toBe(true);
  });

  it('stages an authoritative Radar before creating a placement and removes it during cleanup', async () => {
    let clock = 1_700_000_000_000;
    const putFirestoreDoc = jest.fn(async () => undefined);
    const deleteFirestoreDoc = jest.fn(async () => undefined);
    const createPlacement = jest.fn(async () => ({ id: 'placement-id' }));
    const read = jest.fn(async (cypher: string) => ({
      records: [{ c: cypher.includes(':Entity:Technology') || cypher.includes(':RadarPlacement') ? 1 : 0 }],
    })) as unknown as GraphCanaryDependencies['read'];
    const deps = dependencyStub({
      now: () => (clock += 10),
      putFirestoreDoc,
      deleteFirestoreDoc,
      createPlacement,
      read,
    });

    const result = await runPlacementCanaryLeg(RUNTIME, deps);

    expect(result).toEqual(expect.objectContaining({ appeared: true, deleted: true, cleanupVerified: true }));
    expect(putFirestoreDoc).toHaveBeenCalledWith(
      'radars',
      'graph-canary-radar-fixed-id',
      expect.objectContaining({
        id: 'graph-canary-radar-fixed-id',
        quadrants: [{ id: 'graph-canary-quadrant', name: 'Canary', order: 0 }],
      })
    );
    expect(putFirestoreDoc.mock.invocationCallOrder[0]).toBeLessThan(createPlacement.mock.invocationCallOrder[0]);
    expect(createPlacement).toHaveBeenCalledWith(
      expect.objectContaining({
        radarId: 'graph-canary-radar-fixed-id',
        quadrantId: 'graph-canary-quadrant',
        ring: 'Assess',
      })
    );
    expect(deleteFirestoreDoc).toHaveBeenCalledWith('radars', 'graph-canary-radar-fixed-id');
  });

  it('closes Neo4j dependencies when preflight fails', async () => {
    const close = jest.fn(async () => undefined);
    const deps = dependencyStub({ checkNeo4j: async () => ({ healthy: false, error: 'offline' }), close });

    await expect(runGraphCanary({ runtime: RUNTIME, dependencies: deps, types: ['technology'] })).rejects.toThrow(
      'Neo4j health check failed: offline'
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('proves evidence-backed Relation create, topology/lock move, and delete', async () => {
    let clock = 1_700_000_000_000;
    let relationState: 'missing' | 'created' | 'updated' | 'deleted' = 'missing';
    const ids = ['source-id', 'target-a-id', 'target-b-id'];
    const createdLockKey = buildRelationTripleKey('source-id', 'target-a-id', 'uses');
    const updatedLockKey = buildRelationTripleKey('source-id', 'target-b-id', 'supports');
    const createRelation = jest.fn(async () => {
      relationState = 'created';
      return { id: 'relation-id' } as never;
    });
    const updateRelation = jest.fn(async () => {
      relationState = 'updated';
      return { id: 'relation-id' } as never;
    });
    const deleteRelation = jest.fn(async () => {
      relationState = 'deleted';
    });
    const getRelationLock = jest.fn(async (key: string) => {
      if (key === createdLockKey) return relationState === 'created' ? { relationId: 'relation-id' } : null;
      if (key === updatedLockKey) return relationState === 'updated' ? { relationId: 'relation-id' } : null;
      return null;
    });
    const read = jest.fn(async (cypher: string) => {
      if (cypher.includes('MATCH (n:Entity:Technology')) return { records: [{ c: 1 }] };
      if (cypher.includes('edge:USES')) return { records: [{ c: relationState === 'created' ? 1 : 0 }] };
      if (cypher.includes("assertion.predicate = 'SUPPORTS'")) {
        return { records: [{ c: relationState === 'updated' ? 1 : 0 }] };
      }
      if (cypher.includes('count(DISTINCT assertion) + count(DISTINCT edge)')) {
        return { records: [{ c: relationState === 'deleted' ? 0 : 1 }] };
      }
      return { records: [{ c: 0 }] };
    }) as unknown as GraphCanaryDependencies['read'];
    const deps = dependencyStub({
      now: () => (clock += 10),
      uniqueId: () => `fixed-${clock}`,
      createEntity: jest.fn(async () => ({ id: ids.shift()! })),
      createRelation,
      updateRelation,
      deleteRelation,
      getRelationLock,
      read,
    });

    const result = await runRelationCanaryLeg(RUNTIME, deps);

    expect(result).toEqual(expect.objectContaining({ appeared: true, deleted: true, cleanupVerified: true }));
    expect(createRelation).toHaveBeenCalledWith(
      expect.objectContaining({ relationType: 'uses', claimStatus: 'curated', evidenceRefs: [expect.any(Object)] })
    );
    expect(updateRelation).toHaveBeenCalledWith(
      'relation-id',
      expect.objectContaining({ relationType: 'supports', targetSnapshot: expect.objectContaining({ id: 'target-b-id' }) })
    );
    expect(getRelationLock).toHaveBeenCalledWith(createdLockKey);
    expect(getRelationLock).toHaveBeenCalledWith(updatedLockKey);
    expect(deleteRelation).toHaveBeenCalledWith('relation-id');
  });
});
