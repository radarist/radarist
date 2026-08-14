/**
 * Disposable graph canary: Firestore write -> Inngest -> Neo4j -> delete.
 *
 * The command is intentionally pinned to the isolated selftest profile. It
 * refuses the normal local ports/project before importing server-only write
 * paths. Run through `npm run graph:canary`, which enables the react-server
 * export condition required by the Admin SDK modules.
 */
import './load-env-local';

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildRelationTripleKey, RELATION_TRIPLE_LOCK_COLLECTION } from '../src/lib/relations-triple-key';
import type { Relation } from '../src/lib/types';
import type { CreateRelationInput } from '../src/lib/relations-validation';

interface DisposableTargetGuard {
  assertDisposableNeo4jIntegrationTarget(env?: NodeJS.ProcessEnv): { uri: string; hostname: string; port: number };
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const targetGuard = require('./testing/neo4j-integration-target.cjs') as DisposableTargetGuard;

export const GRAPH_CANARY_PROJECT_ID = 'demo-radarist-selftest';
export const GENERIC_CANARY_TYPES = [
  'prototype',
  'signal',
  'company',
  'useCase',
  'strategy',
  'initiative',
  'painPoint',
  'orgUnit',
  'technology',
] as const;
export type GenericCanaryType = (typeof GENERIC_CANARY_TYPES)[number];

const EXPECTED_LABELS: Record<GenericCanaryType, string> = {
  prototype: 'Prototype',
  signal: 'Signal',
  company: 'Company',
  useCase: 'UseCase',
  strategy: 'Strategy',
  initiative: 'Initiative',
  painPoint: 'PainPoint',
  orgUnit: 'OrgUnit',
  technology: 'Technology',
};

interface EntityConfigLike {
  collection: string;
  nameField: string;
}

export interface GraphCanaryRuntime {
  projectId: string;
  firestoreHost: string;
  appUrl: string;
  inngestUrl: string;
  neo4jUri: string;
  pollTimeoutMs: number;
  pollIntervalMs: number;
}

export interface CanaryLegResult {
  leg: string;
  createdId: string | null;
  appeared: boolean;
  deleted: boolean;
  createMs: number;
  deleteMs: number;
  totalMs: number;
  cleanupVerified: boolean;
  error?: string;
  cleanupError?: string;
}

export interface GraphCanaryReport {
  projectId: string;
  appUrl: string;
  inngestUrl: string;
  neo4jUri: string;
  startedAt: string;
  durationMs: number;
  passed: boolean;
  results: CanaryLegResult[];
}

interface ReadResult<T> {
  records: T[];
}

export interface GraphCanaryDependencies {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  uniqueId: () => string;
  checkNeo4j: () => Promise<{ healthy: boolean; error?: string }>;
  read: <T>(cypher: string, params?: Record<string, unknown>) => Promise<ReadResult<T>>;
  write: (cypher: string, params?: Record<string, unknown>) => Promise<unknown>;
  getEntityConfig: (type: string) => EntityConfigLike | undefined;
  createEntity: (type: string, data: Record<string, unknown>) => Promise<{ id: string }>;
  deleteFirestoreDoc: (collection: string, id: string) => Promise<void>;
  putFirestoreDoc: (collection: string, id: string, data: Record<string, unknown>) => Promise<void>;
  triggerEntitySync: (type: string, id: string, operation: 'delete') => Promise<void>;
  createPlacement: (data: Record<string, unknown>) => Promise<{ id: string }>;
  deletePlacement: (id: string) => Promise<void>;
  createLink: (data: Record<string, unknown>) => Promise<{ id: string }>;
  deleteLink: (id: string) => Promise<void>;
  getLinkStatus: (id: string) => Promise<string | undefined>;
  createRelation: (input: CreateRelationInput) => Promise<Relation>;
  updateRelation: (id: string, updates: Partial<Omit<Relation, 'id' | 'createdAt'>>) => Promise<Relation>;
  deleteRelation: (id: string) => Promise<void>;
  getRelationLock: (key: string) => Promise<{ relationId?: string } | null>;
  close: () => Promise<void>;
}

function integerEnv(env: NodeJS.ProcessEnv, key: string, fallback: number, minimum: number, maximum: number): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function loopbackUrl(raw: string | undefined, label: string, protectedPort: number): URL {
  if (!raw) throw new Error(`${label} is required`);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use http or https`);
  }
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || !parsed.port) {
    throw new Error(`${label} must use loopback with an explicit port`);
  }
  if (Number(parsed.port) === protectedPort) {
    throw new Error(`${label} must not use protected normal-profile port ${protectedPort}`);
  }
  return parsed;
}

function loopbackHost(raw: string | undefined, label: string, protectedPort: number): string {
  if (!raw) throw new Error(`${label} is required`);
  const parsed = loopbackUrl(`http://${raw}`, label, protectedPort);
  return parsed.host;
}

export function assertDisposableGraphCanaryEnvironment(env: NodeJS.ProcessEnv = process.env): GraphCanaryRuntime {
  if (env.GRAPH_CANARY_DISPOSABLE !== 'true') {
    throw new Error('Set GRAPH_CANARY_DISPOSABLE=true only for the isolated selftest stack');
  }
  if (env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR !== 'true') {
    throw new Error('NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true is required');
  }
  if (env.INNGEST_ENABLED !== 'true') {
    throw new Error('INNGEST_ENABLED=true is required');
  }
  if (env.GRAPH_SYNC_ENABLED === 'false' || env.IMPULSE_GRAPH_SYNC_ENABLED === 'false') {
    throw new Error('Graph sync is disabled');
  }

  const projectId =
    env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || env.FIREBASE_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT;
  if (projectId !== GRAPH_CANARY_PROJECT_ID) {
    throw new Error(`Graph canary requires project ${GRAPH_CANARY_PROJECT_ID}; received ${projectId || '<unset>'}`);
  }

  const firestoreHost = loopbackHost(env.FIRESTORE_EMULATOR_HOST, 'FIRESTORE_EMULATOR_HOST', 8080);
  const appUrl = loopbackUrl(env.GRAPH_CANARY_APP_URL || env.NEXT_PUBLIC_APP_URL, 'graph canary app URL', 9002);
  const inngestUrl = loopbackUrl(
    env.GRAPH_CANARY_INNGEST_URL || env.INNGEST_DEV || env.INNGEST_DEV_SERVER_URL,
    'graph canary Inngest URL',
    8288
  );
  const neo4jTarget = targetGuard.assertDisposableNeo4jIntegrationTarget({
    ...env,
    NEO4J_INTEGRATION_DISPOSABLE: env.GRAPH_CANARY_DISPOSABLE,
  });

  return {
    projectId,
    firestoreHost,
    appUrl: appUrl.origin,
    inngestUrl: inngestUrl.origin,
    neo4jUri: neo4jTarget.uri,
    pollTimeoutMs: integerEnv(env, 'GRAPH_CANARY_POLL_TIMEOUT_MS', 45_000, 5_000, 120_000),
    pollIntervalMs: integerEnv(env, 'GRAPH_CANARY_POLL_INTERVAL_MS', 500, 100, 5_000),
  };
}

export function buildGenericCanaryPayload(
  type: GenericCanaryType,
  config: EntityConfigLike,
  uniqueName: string
): Record<string, unknown> {
  if (!config.nameField) throw new Error('Entity config has no nameField');
  return {
    [config.nameField]: uniqueName,
    createdBy: 'graph-canary',
    // Inbox-only Signals are intentionally excluded from Neo4j. Exercise the
    // reviewed lifecycle that production is expected to project instead.
    ...(type === 'signal' ? { status: 'Approved' } : {}),
  };
}

async function loadDefaultDependencies(): Promise<GraphCanaryDependencies> {
  const [{ adminCreateEntity }, { getEntityConfig }, { triggerEntitySync }, firebase, graph, placements, links, relations] =
    await Promise.all([
      import('../src/lib/entity-factory-admin'),
      import('../src/lib/entity-factory'),
      import('../src/lib/entity-sync'),
      import('../src/lib/firebase-admin'),
      import('../src/lib/graph/neo4j-client'),
      import('../src/lib/radar-placement-admin'),
      import('../src/lib/entity-document-link-admin'),
      import('../src/lib/relations-admin'),
    ]);

  return {
    fetch,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    uniqueId: randomUUID,
    checkNeo4j: graph.checkHealth,
    read: graph.runReadTransaction,
    write: graph.runWriteTransaction,
    getEntityConfig,
    async createEntity(type, data) {
      const created = await adminCreateEntity(type as never, data as never);
      return { id: (created.entity as { id: string }).id };
    },
    async deleteFirestoreDoc(collection, id) {
      await firebase.db.collection(collection).doc(id).delete();
    },
    async putFirestoreDoc(collection, id, data) {
      await firebase.db.collection(collection).doc(id).set(data);
    },
    async triggerEntitySync(type, id, operation) {
      await triggerEntitySync(type as never, id, operation);
    },
    async createPlacement(data) {
      return await placements.adminCreateRadarPlacement(data as never);
    },
    deletePlacement: placements.adminDeleteRadarPlacement,
    async createLink(data) {
      // GRAPH-069: the repository now returns the committed row alongside its
      // graph handoff outcome. The canary asserts convergence from the graph
      // itself, so it keeps taking the row.
      const { link } = await links.adminCreateEntityDocumentLink(data as never);
      return link;
    },
    deleteLink: links.adminDeleteEntityDocumentLink,
    async getLinkStatus(id) {
      return (await links.adminGetEntityDocumentLinkById(id))?.graphSyncStatus;
    },
    createRelation: relations.adminCreateRelationFromIds,
    updateRelation: relations.adminUpdateRelation,
    deleteRelation: relations.adminDeleteRelation,
    async getRelationLock(key) {
      const snapshot = await firebase.db.collection(RELATION_TRIPLE_LOCK_COLLECTION).doc(key).get();
      return snapshot.exists ? (snapshot.data() as { relationId?: string }) : null;
    },
    close: graph.closeDriver,
  };
}

async function requireOk(fetchImpl: typeof fetch, url: string, label: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new Error(`${label} unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  return response;
}

export async function preflightGraphCanary(runtime: GraphCanaryRuntime, deps: GraphCanaryDependencies): Promise<void> {
  await requireOk(
    deps.fetch,
    `http://${runtime.firestoreHost}/v1/projects/${runtime.projectId}/databases/(default)/documents/technologies?pageSize=1`,
    'Firestore emulator'
  );
  const appResponse = await requireOk(deps.fetch, `${runtime.appUrl}/api/inngest`, 'Next Inngest route');
  const appText = await appResponse.text();
  if (/inngest disabled/i.test(appText)) throw new Error('Next Inngest route reports that Inngest is disabled');
  await requireOk(deps.fetch, `${runtime.inngestUrl}/`, 'Inngest dev server');
  const neo4j = await deps.checkNeo4j();
  if (!neo4j.healthy) throw new Error(`Neo4j health check failed: ${neo4j.error || 'unknown error'}`);
}

async function poll(
  runtime: GraphCanaryRuntime,
  deps: GraphCanaryDependencies,
  readCount: () => Promise<number>,
  expectedPresent: boolean
): Promise<{ ok: boolean; ms: number; lastError?: string }> {
  const started = deps.now();
  let lastError: string | undefined;
  while (deps.now() - started <= runtime.pollTimeoutMs) {
    try {
      const count = await readCount();
      if ((count > 0) === expectedPresent) return { ok: true, ms: deps.now() - started };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await deps.sleep(runtime.pollIntervalMs);
  }
  return { ok: false, ms: deps.now() - started, lastError };
}

async function countById(deps: GraphCanaryDependencies, id: string): Promise<number> {
  const result = await deps.read<{ c: number }>('MATCH (n {id: $id}) RETURN count(n) AS c', { id });
  return result.records[0]?.c ?? 0;
}

async function forceCleanupEntity(
  deps: GraphCanaryDependencies,
  collection: string | undefined,
  id: string | null
): Promise<void> {
  if (!id) return;
  if (collection) await deps.deleteFirestoreDoc(collection, id);
  await deps.write('MATCH (n {id: $id}) DETACH DELETE n', { id });
  const residue = await countById(deps, id);
  if (residue !== 0) throw new Error(`node ${id} still exists after cleanup`);
}

export async function runGenericCanaryLeg(
  type: GenericCanaryType,
  runtime: GraphCanaryRuntime,
  deps: GraphCanaryDependencies
): Promise<CanaryLegResult> {
  const totalStarted = deps.now();
  const result: CanaryLegResult = {
    leg: type,
    createdId: null,
    appeared: false,
    deleted: false,
    createMs: 0,
    deleteMs: 0,
    totalMs: 0,
    cleanupVerified: false,
  };
  const config = deps.getEntityConfig(type);
  try {
    if (!config) throw new Error(`No entity factory config for ${type}`);
    const uniqueName = `graph-canary-${type}-${deps.now()}-${deps.uniqueId()}`;
    const created = await deps.createEntity(type, buildGenericCanaryPayload(type, config, uniqueName));
    result.createdId = created.id;
    const appeared = await poll(
      runtime,
      deps,
      async () => {
        const response = await deps.read<{ c: number }>(
          `MATCH (n:Entity:${EXPECTED_LABELS[type]} {id: $id})
           WHERE n.entityType = $entityType
           RETURN count(n) AS c`,
          { id: created.id, entityType: type }
        );
        return response.records[0]?.c ?? 0;
      },
      true
    );
    result.createMs = appeared.ms;
    result.appeared = appeared.ok;
    if (!appeared.ok) throw new Error(`exact ${EXPECTED_LABELS[type]} node never appeared${appeared.lastError ? `: ${appeared.lastError}` : ''}`);

    await deps.deleteFirestoreDoc(config.collection, created.id);
    await deps.triggerEntitySync(type, created.id, 'delete');
    const deleted = await poll(runtime, deps, () => countById(deps, created.id), false);
    result.deleteMs = deleted.ms;
    result.deleted = deleted.ok;
    if (!deleted.ok) throw new Error(`node was not removed by the production delete event${deleted.lastError ? `: ${deleted.lastError}` : ''}`);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await forceCleanupEntity(deps, config?.collection, result.createdId);
      result.cleanupVerified = true;
    } catch (error) {
      result.cleanupError = error instanceof Error ? error.message : String(error);
    }
    result.totalMs = deps.now() - totalStarted;
  }
  return result;
}

async function createTechnologyPrerequisite(
  runtime: GraphCanaryRuntime,
  deps: GraphCanaryDependencies,
  suffix: string
): Promise<{ id: string; collection: string; name: string }> {
  const config = deps.getEntityConfig('technology');
  if (!config) throw new Error('No entity factory config for technology');
  const name = `graph-canary-${suffix}-${deps.now()}-${deps.uniqueId()}`;
  const created = await deps.createEntity('technology', buildGenericCanaryPayload('technology', config, name));
  try {
    const appeared = await poll(
      runtime,
      deps,
      async () => {
        const response = await deps.read<{ c: number }>(
          'MATCH (n:Entity:Technology {id: $id}) RETURN count(n) AS c',
          { id: created.id }
        );
        return response.records[0]?.c ?? 0;
      },
      true
    );
    if (!appeared.ok) throw new Error(`Technology prerequisite ${created.id} never appeared`);
    return { id: created.id, collection: config.collection, name };
  } catch (error) {
    try {
      await forceCleanupEntity(deps, config.collection, created.id);
    } catch (cleanupError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; prerequisite cleanup failed: ${
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }`
      );
    }
    throw error;
  }
}

export async function runPlacementCanaryLeg(
  runtime: GraphCanaryRuntime,
  deps: GraphCanaryDependencies
): Promise<CanaryLegResult> {
  const started = deps.now();
  const result: CanaryLegResult = {
    leg: 'radarPlacement', createdId: null, appeared: false, deleted: false,
    createMs: 0, deleteMs: 0, totalMs: 0, cleanupVerified: false,
  };
  let technology: { id: string; collection: string; name: string } | null = null;
  const radarId = `graph-canary-radar-${deps.uniqueId()}`;
  try {
    // A placement may only reference an authoritative Firestore Radar. Keep
    // the graph projection absent so this leg also exercises the production
    // missing-Radar projection handoff and placement retry path.
    await deps.putFirestoreDoc('radars', radarId, {
      id: radarId,
      name: 'Graph Canary Radar',
      slug: radarId,
      description: 'Disposable graph canary Radar',
      quadrants: [{ id: 'graph-canary-quadrant', name: 'Canary', order: 0 }],
      entries: [],
      ringSystem: 'Standard',
      createdAt: started,
      updatedAt: started,
    });
    technology = await createTechnologyPrerequisite(runtime, deps, 'placement-tech');
    const technologyId = technology.id;
    const createStarted = deps.now();
    const placement = await deps.createPlacement({
      technologyId,
      radarId,
      quadrantId: 'graph-canary-quadrant',
      ring: 'Assess',
      rationale: 'Disposable graph canary',
      placedBy: 'graph-canary',
    });
    result.createdId = placement.id;
    const appeared = await poll(
      runtime,
      deps,
      async () => {
        const response = await deps.read<{ c: number }>(
          `MATCH (p:RadarPlacement {id: $placementId})-[:PLACES]->(:Technology {id: $technologyId})
           MATCH (p)-[:ON_RADAR]->(:Radar {id: $radarId})
           RETURN count(DISTINCT p) AS c`,
          { placementId: placement.id, technologyId, radarId }
        );
        return response.records[0]?.c ?? 0;
      },
      true
    );
    result.createMs = deps.now() - createStarted;
    result.appeared = appeared.ok;
    if (!appeared.ok) throw new Error('RadarPlacement topology never appeared');
    await deps.deletePlacement(placement.id);
    const deleted = await poll(runtime, deps, () => countById(deps, placement.id), false);
    result.deleteMs = deleted.ms;
    result.deleted = deleted.ok;
    if (!deleted.ok) throw new Error('RadarPlacement was not removed by the production delete event');
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      if (result.createdId) {
        await deps.deleteFirestoreDoc('radarPlacements', result.createdId);
        await deps.write('MATCH (n:RadarPlacement {id: $id}) DETACH DELETE n', { id: result.createdId });
      }
      await deps.deleteFirestoreDoc('radars', radarId);
      await deps.write('MATCH (n:Radar {id: $radarId}) DETACH DELETE n', { radarId });
      if (technology) await forceCleanupEntity(deps, technology.collection, technology.id);
      const residue = result.createdId ? await countById(deps, result.createdId) : 0;
      if (residue !== 0) throw new Error('RadarPlacement cleanup left residue');
      result.cleanupVerified = true;
    } catch (error) {
      result.cleanupError = error instanceof Error ? error.message : String(error);
    }
    result.totalMs = deps.now() - started;
  }
  return result;
}

export async function runLinkCanaryLeg(
  runtime: GraphCanaryRuntime,
  deps: GraphCanaryDependencies
): Promise<CanaryLegResult> {
  const started = deps.now();
  const result: CanaryLegResult = {
    leg: 'entityDocumentLink', createdId: null, appeared: false, deleted: false,
    createMs: 0, deleteMs: 0, totalMs: 0, cleanupVerified: false,
  };
  let technology: { id: string; collection: string; name: string } | null = null;
  const documentId = `graph-canary-document-${deps.uniqueId()}`;
  try {
    technology = await createTechnologyPrerequisite(runtime, deps, 'link-tech');
    const technologyId = technology.id;
    const now = deps.now();
    await deps.putFirestoreDoc('documents', documentId, {
      id: documentId,
      title: 'Graph Canary Document',
      type: 'url',
      originalUrl: 'https://example.invalid/graph-canary',
      linkedEntityCount: 0,
      createdAt: now,
      updatedAt: now,
      createdBy: 'graph-canary',
    });
    await deps.write(
      `MERGE (d:Entity:Document {id: $id})
       SET d.title = 'Graph Canary Document', d.entityType = 'document'`,
      { id: documentId }
    );
    const createStarted = deps.now();
    const link = await deps.createLink({
      workspaceId: 'graph-canary', entityType: 'technology', entityId: technologyId,
      documentId, relationshipType: 'documentation', tags: ['graph-canary'],
      relevance: 'high', createdBy: 'graph-canary', aiSuggested: false,
    });
    result.createdId = link.id;
    const appeared = await poll(
      runtime,
      deps,
      async () => {
        const response = await deps.read<{ c: number }>(
          `MATCH (:Technology {id: $entityId})-[r:DOCUMENTED_BY {linkId: $linkId}]->(:Document {id: $documentId})
           RETURN count(r) AS c`,
          { entityId: technologyId, linkId: link.id, documentId }
        );
        return response.records[0]?.c ?? 0;
      },
      true
    );
    const status = await poll(runtime, deps, async () => ((await deps.getLinkStatus(link.id)) === 'synced' ? 1 : 0), true);
    result.createMs = deps.now() - createStarted;
    result.appeared = appeared.ok && status.ok;
    if (!result.appeared) throw new Error('Entity-document link topology/status never reached synced');
    await deps.deleteLink(link.id);
    const deleted = await poll(
      runtime,
      deps,
      async () => {
        const response = await deps.read<{ c: number }>('MATCH ()-[r {linkId: $linkId}]->() RETURN count(r) AS c', {
          linkId: link.id,
        });
        return response.records[0]?.c ?? 0;
      },
      false
    );
    result.deleteMs = deleted.ms;
    result.deleted = deleted.ok;
    if (!deleted.ok) throw new Error('Entity-document link was not removed by the production delete event');
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      if (result.createdId) {
        await deps.deleteFirestoreDoc('entityDocumentLinks', result.createdId);
        await deps.write('MATCH ()-[r {linkId: $linkId}]->() DELETE r', { linkId: result.createdId });
      }
      await deps.deleteFirestoreDoc('documents', documentId);
      await deps.write('MATCH (n:Document {id: $documentId}) DETACH DELETE n', { documentId });
      if (technology) await forceCleanupEntity(deps, technology.collection, technology.id);
      result.cleanupVerified = true;
    } catch (error) {
      result.cleanupError = error instanceof Error ? error.message : String(error);
    }
    result.totalMs = deps.now() - started;
  }
  return result;
}

export async function runRelationCanaryLeg(
  runtime: GraphCanaryRuntime,
  deps: GraphCanaryDependencies
): Promise<CanaryLegResult> {
  const started = deps.now();
  const result: CanaryLegResult = {
    leg: 'relationLifecycle', createdId: null, appeared: false, deleted: false,
    createMs: 0, deleteMs: 0, totalMs: 0, cleanupVerified: false,
  };
  type TechnologyFixture = Awaited<ReturnType<typeof createTechnologyPrerequisite>>;
  let source: TechnologyFixture | null = null;
  let firstTarget: TechnologyFixture | null = null;
  let secondTarget: TechnologyFixture | null = null;
  let oldLockKey: string | null = null;
  let newLockKey: string | null = null;
  const evidenceKey = `graph-canary-evidence-${deps.uniqueId()}`;

  try {
    const sourceEntity = (source = await createTechnologyPrerequisite(runtime, deps, 'relation-source'));
    const firstTargetEntity = (firstTarget = await createTechnologyPrerequisite(runtime, deps, 'relation-target-a'));
    const secondTargetEntity = (secondTarget = await createTechnologyPrerequisite(runtime, deps, 'relation-target-b'));
    const createStarted = deps.now();
    const relation = await deps.createRelation({
      sourceId: sourceEntity.id,
      sourceType: 'technology',
      targetId: firstTargetEntity.id,
      targetType: 'technology',
      relationType: 'uses',
      confidence: 92,
      aiSuggested: true,
      agentName: 'graph-canary',
      claimStatus: 'curated',
      reasoningSummary: 'Disposable relation lifecycle canary',
      evidenceRefs: [
        {
          id: evidenceKey,
          sourceKey: evidenceKey,
          type: 'web_ref',
          snippet: 'Disposable relation lifecycle evidence.',
          url: 'https://example.invalid/radarist-relation-canary',
          capturedAt: deps.now(),
        },
      ],
    });
    result.createdId = relation.id;
    oldLockKey = buildRelationTripleKey(sourceEntity.id, firstTargetEntity.id, 'uses');
    newLockKey = buildRelationTripleKey(sourceEntity.id, secondTargetEntity.id, 'supports');

    const appeared = await poll(
      runtime,
      deps,
      async () => {
        const response = await deps.read<{ c: number }>(
          `MATCH (assertion:Assertion {relationId: $relationId})-[:SUPPORTED_BY]->(:Evidence {sourceKey: $evidenceKey})
           MATCH (:Technology {id: $sourceId})-[edge:USES {relationId: $relationId}]->(:Technology {id: $targetId})
           WHERE edge.claimId = assertion.id AND edge.t_invalidated IS NULL
             AND coalesce(edge.claimStatus, 'curated') <> 'rejected'
           RETURN count(DISTINCT assertion) AS c`,
          {
            relationId: relation.id,
            evidenceKey,
            sourceId: sourceEntity.id,
            targetId: firstTargetEntity.id,
          }
        );
        return response.records[0]?.c ?? 0;
      },
      true
    );
    if (!appeared.ok) throw new Error('Evidence-backed Relation never reached Assertion/Evidence/USES topology');
    if ((await deps.getRelationLock(oldLockKey))?.relationId !== relation.id) {
      throw new Error('Relation create did not acquire its deterministic triple lock');
    }

    await deps.updateRelation(relation.id, {
      targetSnapshot: {
        id: secondTargetEntity.id,
        type: 'technology',
        name: secondTargetEntity.name,
        snapshotAt: deps.now(),
      },
      relationType: 'supports',
    });
    const updated = await poll(
      runtime,
      deps,
      async () => {
        const response = await deps.read<{ c: number }>(
          `MATCH (assertion:Assertion {relationId: $relationId})
           WHERE assertion.subjectId = $sourceId AND assertion.objectId = $targetId
             AND assertion.predicate = 'SUPPORTS'
             AND size([(assertion)-[:ABOUT_SUBJECT]->(node) | node.id]) = 1
             AND head([(assertion)-[:ABOUT_SUBJECT]->(node) | node.id]) = $sourceId
             AND size([(assertion)-[:ABOUT_OBJECT]->(node) | node.id]) = 1
             AND head([(assertion)-[:ABOUT_OBJECT]->(node) | node.id]) = $targetId
             AND size([(assertion)-[:HAS_PREDICATE]->(type:RelationType) | type.name]) = 1
             AND head([(assertion)-[:HAS_PREDICATE]->(type:RelationType) | type.name]) = 'SUPPORTS'
             AND size([(assertion)-[:ASSERTED_BY]->(actor) | actor.id]) = 1
             AND head([(assertion)-[:ASSERTED_BY]->(actor) | actor.id]) = 'agent:graph-canary'
           OPTIONAL MATCH ()-[edge {relationId: $relationId}]->()
           WITH assertion, [candidate IN collect(edge) WHERE candidate.t_invalidated IS NULL] AS liveEdges
           WHERE size(liveEdges) = 1
             AND startNode(head(liveEdges)).id = $sourceId
             AND endNode(head(liveEdges)).id = $targetId
             AND type(head(liveEdges)) = 'SUPPORTS'
           RETURN count(assertion) AS c`,
          { relationId: relation.id, sourceId: sourceEntity.id, targetId: secondTargetEntity.id }
        );
        return response.records[0]?.c ?? 0;
      },
      true
    );
    result.createMs = deps.now() - createStarted;
    result.appeared = updated.ok;
    if (!updated.ok) throw new Error('Relation topology update did not converge to one exact SUPPORTS projection');
    if ((await deps.getRelationLock(oldLockKey)) !== null) throw new Error('Relation update retained the old triple lock');
    if ((await deps.getRelationLock(newLockKey))?.relationId !== relation.id) {
      throw new Error('Relation update did not acquire the new triple lock');
    }

    await deps.deleteRelation(relation.id);
    const removed = await poll(
      runtime,
      deps,
      async () => {
        const response = await deps.read<{ c: number }>(
          `OPTIONAL MATCH (assertion:Assertion {relationId: $relationId})
           OPTIONAL MATCH ()-[edge {relationId: $relationId}]->()
           RETURN count(DISTINCT assertion) + count(DISTINCT edge) AS c`,
          { relationId: relation.id }
        );
        return response.records[0]?.c ?? 0;
      },
      false
    );
    result.deleteMs = removed.ms;
    result.deleted = removed.ok && (await deps.getRelationLock(newLockKey)) === null;
    if (!result.deleted) throw new Error('Relation delete left graph or triple-lock residue');
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      if (result.createdId) {
        await deps.deleteFirestoreDoc('relations', result.createdId);
        if (oldLockKey) await deps.deleteFirestoreDoc(RELATION_TRIPLE_LOCK_COLLECTION, oldLockKey);
        if (newLockKey) await deps.deleteFirestoreDoc(RELATION_TRIPLE_LOCK_COLLECTION, newLockKey);
        await deps.write(
          `MATCH (assertion:Assertion {relationId: $relationId})
           OPTIONAL MATCH (assertion)-[:SUPPORTED_BY]->(evidence:Evidence)
           WITH assertion, collect(evidence) AS evidenceNodes
           FOREACH (evidence IN evidenceNodes | DETACH DELETE evidence)
           DETACH DELETE assertion`,
          { relationId: result.createdId }
        );
        await deps.write('MATCH ()-[edge {relationId: $relationId}]->() DELETE edge', {
          relationId: result.createdId,
        });
      }
      for (const entity of [source, firstTarget, secondTarget]) {
        if (entity) await forceCleanupEntity(deps, entity.collection, entity.id);
      }
      if (result.createdId) {
        const residue = await deps.read<{ c: number }>(
          `OPTIONAL MATCH (assertion:Assertion {relationId: $relationId})
           OPTIONAL MATCH ()-[edge {relationId: $relationId}]->()
           RETURN count(DISTINCT assertion) + count(DISTINCT edge) AS c`,
          { relationId: result.createdId }
        );
        if ((residue.records[0]?.c ?? 0) !== 0) throw new Error('Relation force-cleanup left graph residue');
      }
      result.cleanupVerified = true;
    } catch (error) {
      result.cleanupError = error instanceof Error ? error.message : String(error);
    }
    result.totalMs = deps.now() - started;
  }
  return result;
}

export async function runGraphCanary(options: {
  runtime: GraphCanaryRuntime;
  dependencies: GraphCanaryDependencies;
  types?: GenericCanaryType[];
  includeDedicated?: boolean;
}): Promise<GraphCanaryReport> {
  const { runtime, dependencies: deps } = options;
  const started = deps.now();
  const results: CanaryLegResult[] = [];
  try {
    await preflightGraphCanary(runtime, deps);
    for (const type of options.types ?? [...GENERIC_CANARY_TYPES]) {
      results.push(await runGenericCanaryLeg(type, runtime, deps));
    }
    if (options.includeDedicated) {
      results.push(await runPlacementCanaryLeg(runtime, deps));
      results.push(await runLinkCanaryLeg(runtime, deps));
      results.push(await runRelationCanaryLeg(runtime, deps));
    }
  } finally {
    await deps.close();
  }
  const passed = results.length > 0 && results.every(
    (result) => result.appeared && result.deleted && result.cleanupVerified && !result.error && !result.cleanupError
  );
  return {
    projectId: runtime.projectId,
    appUrl: runtime.appUrl,
    inngestUrl: runtime.inngestUrl,
    neo4jUri: runtime.neo4jUri,
    startedAt: new Date(started).toISOString(),
    durationMs: deps.now() - started,
    passed,
    results,
  };
}

function argumentValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

export async function main(args: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const supportedFlags = new Set(['--include-dedicated', '--json', '--types']);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!supportedFlags.has(arg)) throw new Error(`Unknown graph canary argument: ${arg}`);
    if (arg === '--json' || arg === '--types') index++;
  }
  const runtime = assertDisposableGraphCanaryEnvironment(env);
  const typesArg = argumentValue(args, '--types');
  const types = typesArg
    ? typesArg.split(',').map((type) => {
        if (!GENERIC_CANARY_TYPES.includes(type as GenericCanaryType)) {
          throw new Error(`Unsupported generic canary type: ${type}`);
        }
        return type as GenericCanaryType;
      })
    : undefined;
  if (types && types.length === 0) throw new Error('--types must not be empty');
  const report = await runGraphCanary({
    runtime,
    dependencies: await loadDefaultDependencies(),
    types,
    includeDedicated: args.includes('--include-dedicated'),
  });
  const jsonPath = argumentValue(args, '--json');
  if (jsonPath) {
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report, null, 2));
  return report.passed ? 0 : 1;
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error('graph canary failed:', error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  );
}
