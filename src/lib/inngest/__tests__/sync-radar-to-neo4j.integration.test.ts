/**
 * Disposable real-Neo4j proof for standalone Radar create/update projection.
 * Skipped unless the guarded graph integration lane is explicitly enabled.
 */

const PREFIX = `radar-sync-integration-${process.pid}-`;
const radarFixture: { current: Record<string, unknown> | null } = { current: null };
const placementFixture: { current: Record<string, unknown> | null } = { current: null };
const technologyFixture: { current: Record<string, unknown> | null } = { current: null };

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn((collectionName: string) => ({
      doc: jest.fn((id: string) => ({
        get: jest.fn(async () => {
          const fixture =
            collectionName === 'radars'
              ? radarFixture.current
              : collectionName === 'radarPlacements'
                ? placementFixture.current
                : collectionName === 'technologies'
                  ? technologyFixture.current
                  : null;
          return {
            exists: fixture !== null,
            id,
            data: () => fixture,
          };
        }),
      })),
    })),
  },
}));

jest.mock('../client', () => ({
  inngest: {
    createFunction: jest.fn((config, trigger, handler) => ({
      config,
      trigger,
      async execute(event: { id: string; data: Record<string, unknown> }) {
        const step = { run: async <T>(_name: string, fn: () => Promise<T>) => await fn() };
        return await handler({ event, step });
      },
    })),
    send: jest.fn().mockResolvedValue({ ids: ['integration-completion'] }),
  },
}));

// The graph barrel exposes a browser-Firebase fallback that is irrelevant to
// this proof. Keep it out of the Node integration process.
jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));

import { closeDriver, runReadTransaction, runWriteTransaction } from '@/lib/graph';
import { createRadarProjectionEvent } from '@/lib/radar-projection-sync';
import { syncPlacementToNeo4jJob } from '../functions/sync-placement-to-neo4j';
import { syncRadarToNeo4jJob } from '../functions/sync-radar-to-neo4j';

const describeIntegration =
  process.env.NEO4J_INTEGRATION_TESTS === '1' &&
  process.env.NEO4J_INTEGRATION_DISPOSABLE === 'true'
    ? describe
    : describe.skip;

async function cleanup(): Promise<void> {
  await runWriteTransaction(
    `MATCH (node)
     WHERE node.id STARTS WITH $prefix
     DETACH DELETE node`,
    { prefix: PREFIX }
  );
}

async function residueCount(): Promise<number> {
  const result = await runReadTransaction<{ count: number }>(
    `MATCH (node)
     WHERE node.id STARTS WITH $prefix
     RETURN count(node) AS count`,
    { prefix: PREFIX }
  );
  return result.records[0]?.count ?? 0;
}

describeIntegration('standalone Radar projection (disposable Neo4j)', () => {
  // A cold disposable driver can spend more than Jest's default five seconds
  // establishing its first Bolt session before the prefixed cleanup runs.
  jest.setTimeout(30_000);

  beforeEach(async () => {
    radarFixture.current = null;
    placementFixture.current = null;
    technologyFixture.current = null;
    await cleanup();
  });
  afterEach(async () => {
    await cleanup();
    radarFixture.current = null;
    placementFixture.current = null;
    technologyFixture.current = null;
  });
  afterAll(closeDriver);

  it('converges create, duplicate delivery, and update before any placement, then cleans up exactly', async () => {
    const radarId = `${PREFIX}radar`;
    radarFixture.current = {
      id: radarId,
      name: 'Disposable Assistant Radar',
      slug: 'disposable-assistant-radar',
      description: 'No placements yet',
      ringSystem: 'Standard',
      quadrants: [
        { id: 'q_now', name: 'Now', order: 0 },
        { id: 'q_next', name: 'Next', order: 1 },
      ],
      entries: [],
      createdAt: 100,
      updatedAt: 100,
    };

    const job = syncRadarToNeo4jJob as unknown as {
      execute: (event: ReturnType<typeof createRadarProjectionEvent>) => Promise<unknown>;
    };
    const createEvent = createRadarProjectionEvent({ id: radarId, updatedAt: 100 });

    await job.execute(createEvent);
    await job.execute(createEvent);

    let census = await runReadTransaction<{
      radarNodes: number;
      placementNodes: number;
      name: string;
      updatedAt: number;
    }>(
      `MATCH (radar:Radar {id: $radarId})
       RETURN count(radar) AS radarNodes,
              count { MATCH (:RadarPlacement)-[:ON_RADAR]->(radar) } AS placementNodes,
              head(collect(radar.name)) AS name,
              head(collect(radar.updatedAt)) AS updatedAt`,
      { radarId }
    );

    expect(census.records[0]).toEqual({
      radarNodes: 1,
      placementNodes: 0,
      name: 'Disposable Assistant Radar',
      updatedAt: 100,
    });

    radarFixture.current = {
      ...radarFixture.current,
      name: 'Updated Disposable Radar',
      slug: 'updated-disposable-radar',
      ringSystem: 'TRL',
      updatedAt: 200,
    };
    await job.execute(createRadarProjectionEvent({ id: radarId, updatedAt: 200 }));

    census = await runReadTransaction(
      `MATCH (radar:Radar {id: $radarId})
       RETURN count(radar) AS radarNodes,
              count { MATCH (:RadarPlacement)-[:ON_RADAR]->(radar) } AS placementNodes,
              head(collect(radar.name)) AS name,
              head(collect(radar.updatedAt)) AS updatedAt`,
      { radarId }
    );
    expect(census.records[0]).toEqual({
      radarNodes: 1,
      placementNodes: 0,
      name: 'Updated Disposable Radar',
      updatedAt: 200,
    });

    const technologyId = `${PREFIX}technology`;
    const placementId = `${PREFIX}placement`;
    await runWriteTransaction(
      'CREATE (:Entity:Technology {id: $technologyId, name: $name})',
      { technologyId, name: 'Disposable Technology' }
    );
    placementFixture.current = {
      technologyId,
      radarId,
      quadrantId: 'q_now',
      quadrantName: 'Now',
      ring: 'Adopt',
      placedBy: 'integration-test',
      createdAt: 300,
      updatedAt: 300,
    };
    const placementJob = syncPlacementToNeo4jJob as unknown as {
      execute: (event: { id: string; data: Record<string, unknown> }) => Promise<unknown>;
    };
    await placementJob.execute({
      id: `${PREFIX}placement-event`,
      data: {
        operation: 'create',
        placementId,
        placementData: {
          technologyId,
          radarId,
          quadrantId: 'q_now',
          quadrantName: 'Now',
          ring: 'Adopt',
          placedBy: 'integration-test',
          createdAt: 300,
          updatedAt: 300,
        },
      },
    });

    const afterPlacement = await runReadTransaction<{
      radarNodes: number;
      placementEdges: number;
      technologyId: string;
      quadrantId: string;
      ring: string;
      placedBy: string;
    }>(
      `MATCH (radar:Radar {id: $radarId})
       MATCH (placement:RadarPlacement {id: $placementId})
       RETURN count(radar) AS radarNodes,
              count { (placement)-[:ON_RADAR]->(radar) } AS placementEdges,
              head(collect(placement.technologyId)) AS technologyId,
              head(collect(placement.quadrantId)) AS quadrantId,
              head(collect(placement.ring)) AS ring,
              head(collect(placement.placedBy)) AS placedBy`,
      { radarId, placementId }
    );
    expect(afterPlacement.records[0]).toEqual({
      radarNodes: 1,
      placementEdges: 1,
      technologyId,
      quadrantId: 'q_now',
      ring: 'Adopt',
      placedBy: 'integration-test',
    });

    await cleanup();
    expect(await residueCount()).toBe(0);
  });

  it('converges dependency races, retries, moves, source deletion, and explicit delete exactly once', async () => {
    const radarId = `${PREFIX}dependency-radar`;
    const technologyId = `${PREFIX}dependency-technology`;
    const placementId = `${PREFIX}dependency-placement`;
    const placementEventId = `${PREFIX}dependency-event`;
    radarFixture.current = {
      id: radarId,
      name: 'Dependency Radar',
      slug: 'dependency-radar',
      ringSystem: 'Standard',
      quadrants: [
        { id: 'q_now', name: 'Now', order: 0 },
        { id: 'q_next', name: 'Next', order: 1 },
      ],
      entries: [],
      createdAt: 100,
      updatedAt: 100,
    };
    technologyFixture.current = {
      id: technologyId,
      name: 'Dependency Technology',
      createdAt: 100,
      updatedAt: 100,
    };
    placementFixture.current = {
      technologyId,
      radarId,
      quadrantId: 'q_now',
      quadrantName: 'Now',
      ring: 'Adopt',
      placedBy: 'integration-test',
      createdAt: 200,
      updatedAt: 200,
    };

    const placementJob = syncPlacementToNeo4jJob as unknown as {
      execute: (event: { id: string; data: Record<string, unknown> }) => Promise<unknown>;
    };
    const radarJob = syncRadarToNeo4jJob as unknown as {
      execute: (event: ReturnType<typeof createRadarProjectionEvent>) => Promise<unknown>;
    };
    const executePlacement = (operation: 'create' | 'update' | 'delete') =>
      placementJob.execute({
        id: placementEventId,
        data: {
          operation,
          placementId,
          // Deliberately stale after the move below. The worker must always
          // re-read the authoritative Firestore fixture at the write boundary.
          placementData: {
            technologyId,
            radarId,
            quadrantId: 'q_now',
            quadrantName: 'Now',
            ring: 'Adopt',
            placedBy: 'integration-test',
            createdAt: 200,
            updatedAt: 200,
          },
        },
      });

    // Neither endpoint has reached Neo4j. The placement node may be staged,
    // but a zero-row PLACES write must fail instead of reporting success.
    await expect(executePlacement('create')).rejects.toThrow(
      `Technology ${technologyId} is not projected yet; retry placement ${placementId}`
    );
    let projection = await runReadTransaction<{
      nodes: number;
      places: number;
      onRadar: number;
    }>(
      `MATCH (placement:RadarPlacement {id: $placementId})
       RETURN count(placement) AS nodes,
              count { (placement)-[:PLACES]->(:Technology) } AS places,
              count { (placement)-[:ON_RADAR]->(:Radar) } AS onRadar`,
      { placementId }
    );
    expect(projection.records[0]).toEqual({ nodes: 1, places: 0, onRadar: 0 });

    // Once Technology exists, the same event progresses to the next missing
    // dependency and fails honestly on the zero-row ON_RADAR write.
    await runWriteTransaction(
      'CREATE (:Entity:Technology {id: $technologyId, name: $name})',
      { technologyId, name: 'Dependency Technology' }
    );
    await expect(executePlacement('update')).rejects.toThrow(
      `Radar ${radarId} is not projected yet; retry placement ${placementId}`
    );
    projection = await runReadTransaction(
      `MATCH (placement:RadarPlacement {id: $placementId})
       RETURN count(placement) AS nodes,
              count { (placement)-[:PLACES]->(:Technology) } AS places,
              count { (placement)-[:ON_RADAR]->(:Radar) } AS onRadar`,
      { placementId }
    );
    expect(projection.records[0]).toEqual({ nodes: 1, places: 1, onRadar: 0 });

    await radarJob.execute(createRadarProjectionEvent({ id: radarId, updatedAt: 100 }));
    await executePlacement('update');
    await executePlacement('update');

    let converged = await runReadTransaction<{
      nodes: number;
      places: number;
      onRadar: number;
      quadrantId: string;
      ring: string;
    }>(
      `MATCH (placement:RadarPlacement {id: $placementId})
       RETURN count(placement) AS nodes,
              count { (placement)-[:PLACES]->(:Technology) } AS places,
              count { (placement)-[:ON_RADAR]->(:Radar) } AS onRadar,
              head(collect(placement.quadrantId)) AS quadrantId,
              head(collect(placement.ring)) AS ring`,
      { placementId }
    );
    expect(converged.records[0]).toEqual({
      nodes: 1,
      places: 1,
      onRadar: 1,
      quadrantId: 'q_now',
      ring: 'Adopt',
    });

    placementFixture.current = {
      ...placementFixture.current,
      quadrantId: 'q_next',
      quadrantName: 'Next',
      ring: 'Assess',
      updatedAt: 300,
    };
    await executePlacement('update');
    converged = await runReadTransaction(
      `MATCH (placement:RadarPlacement {id: $placementId})
       RETURN count(placement) AS nodes,
              count { (placement)-[:PLACES]->(:Technology) } AS places,
              count { (placement)-[:ON_RADAR]->(:Radar) } AS onRadar,
              head(collect(placement.quadrantId)) AS quadrantId,
              head(collect(placement.ring)) AS ring`,
      { placementId }
    );
    expect(converged.records[0]).toEqual({
      nodes: 1,
      places: 1,
      onRadar: 1,
      quadrantId: 'q_next',
      ring: 'Assess',
    });

    // A source deleted between a memoized preflight and retry wins over the
    // stale inline event and removes every partial graph artifact.
    placementFixture.current = null;
    await executePlacement('update');
    let absent = await runReadTransaction<{ nodes: number }>(
      'OPTIONAL MATCH (placement:RadarPlacement {id: $placementId}) RETURN count(placement) AS nodes',
      { placementId }
    );
    expect(absent.records[0]).toEqual({ nodes: 0 });

    // Explicit deletion remains idempotent after a later recreation.
    placementFixture.current = {
      technologyId,
      radarId,
      quadrantId: 'q_now',
      quadrantName: 'Now',
      ring: 'Adopt',
      placedBy: 'integration-test',
      createdAt: 400,
      updatedAt: 400,
    };
    await executePlacement('create');
    placementFixture.current = null;
    await executePlacement('delete');
    await executePlacement('delete');
    absent = await runReadTransaction(
      'OPTIONAL MATCH (placement:RadarPlacement {id: $placementId}) RETURN count(placement) AS nodes',
      { placementId }
    );
    expect(absent.records[0]).toEqual({ nodes: 0 });

    await cleanup();
    expect(await residueCount()).toBe(0);
  });
});
