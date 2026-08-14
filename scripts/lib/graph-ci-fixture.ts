import { runReadTransaction, runWriteTransaction } from '@/lib/graph/neo4j-client';
import {
  buildRelationTripleLockEntry,
  RELATION_TRIPLE_LOCK_COLLECTION,
} from '@/lib/relations-triple-key';
import { DEMO_PROFILES } from './local-demo';
import { syncSeedToNeo4j, type SeedEntity, type SeedRelation } from './seed-graph-sync';

interface DisposableTargetGuard {
  assertDisposableNeo4jIntegrationTarget(env?: NodeJS.ProcessEnv): { uri: string; hostname: string; port: number };
}

// CommonJS keeps the same fail-closed guard shared with the real-Neo4j Jest lane.
const targetGuard = require('../testing/neo4j-integration-target.cjs') as DisposableTargetGuard;

export const GRAPH_CI_FIXTURE = {
  entityIds: {
    technologyA: 'graph-ci-fixture-technology-a',
    technologyB: 'graph-ci-fixture-technology-b',
    company: 'graph-ci-fixture-company',
  },
  relationIds: {
    direct: 'graph-ci-fixture-relation-direct',
    asserted: 'graph-ci-fixture-relation-asserted',
  },
  actorId: 'agent:graph-ci-fixture',
} as const;

export const GRAPH_CANARY_RESIDUE_PREDICATE = `
  coalesce(node.id, '') STARTS WITH 'graph-canary-'
  OR coalesce(node.name, '') STARTS WITH 'graph-canary-'
  OR coalesce(node.title, '') STARTS WITH 'graph-canary-'
  OR coalesce(node.createdBy, '') = 'graph-canary'
  OR coalesce(node.placedBy, '') = 'graph-canary'
`;

export interface GraphCiFixtureVerification {
  entities: number;
  directEdges: number;
  assertions: number;
  assertedEdges: number;
  evidence: number;
  asserterLinks: number;
  actorNodes: number;
}

export interface GraphCiFirestoreFixtureVerification {
  relations: number;
  locks: number;
  ownerMatches: boolean;
}

export function assertGraphCiFixtureTarget(env: NodeJS.ProcessEnv = process.env) {
  return targetGuard.assertDisposableNeo4jIntegrationTarget(env);
}

export function assertGraphCiFirestoreFixtureTarget(env: NodeJS.ProcessEnv = process.env): void {
  const expectedHost = `127.0.0.1:${DEMO_PROFILES.selftest.firebase.firestore}`;
  const projectId = env.FIREBASE_PROJECT_ID ?? env.GOOGLE_CLOUD_PROJECT ?? env.GCLOUD_PROJECT;
  if (env.FIRESTORE_EMULATOR_HOST !== expectedHost) {
    throw new Error(`Graph CI Firestore fixture requires selftest emulator ${expectedHost}`);
  }
  if (projectId !== DEMO_PROFILES.selftest.projectId) {
    throw new Error(`Graph CI Firestore fixture requires project ${DEMO_PROFILES.selftest.projectId}`);
  }
}

export function buildGraphCiFixtureInput(): { entities: SeedEntity[]; relations: SeedRelation[] } {
  const { entityIds, relationIds } = GRAPH_CI_FIXTURE;
  const entities: SeedEntity[] = [
    { id: entityIds.technologyA, type: 'technology', name: 'Graph CI Technology A' },
    { id: entityIds.technologyB, type: 'technology', name: 'Graph CI Technology B' },
    { id: entityIds.company, type: 'company', name: 'Graph CI Company' },
  ];
  const relations: SeedRelation[] = [
    {
      id: relationIds.direct,
      relationType: 'vendor',
      sourceSnapshot: { id: entityIds.company, type: 'company', name: 'Graph CI Company' },
      targetSnapshot: { id: entityIds.technologyA, type: 'technology', name: 'Graph CI Technology A' },
      confidence: 95,
      claimStatus: 'curated',
    },
    {
      id: relationIds.asserted,
      relationType: 'evaluates',
      sourceSnapshot: { id: entityIds.technologyA, type: 'technology', name: 'Graph CI Technology A' },
      targetSnapshot: { id: entityIds.technologyB, type: 'technology', name: 'Graph CI Technology B' },
      confidence: 90,
      aiSuggested: true,
      assertedBy: GRAPH_CI_FIXTURE.actorId,
      notes: 'Deterministic graph CI evidence',
      evidence: [
        {
          sourceType: 'web_ref',
          snippet: 'Deterministic fixture evidence for the graph operational gate.',
          sourceUrl: 'https://example.invalid/radarist-graph-ci-fixture',
        },
      ],
    },
  ];
  return { entities, relations };
}

export function buildGraphCiFirestoreFixture() {
  const relation = buildGraphCiFixtureInput().relations[0];
  const createdAt = 1_700_000_000_000;
  const relationDocument = {
    ...relation,
    sourceId: relation.sourceSnapshot.id,
    targetId: relation.targetSnapshot.id,
    sourceType: relation.sourceSnapshot.type,
    targetType: relation.targetSnapshot.type,
    createdAt,
    updatedAt: createdAt,
  };
  const lock = buildRelationTripleLockEntry(
    relation.id,
    relation.sourceSnapshot.id,
    relation.targetSnapshot.id,
    relation.relationType,
    createdAt
  );
  return { relation: relationDocument, lock };
}

async function getGraphCiFixtureFirestore(env: NodeJS.ProcessEnv = process.env) {
  assertGraphCiFirestoreFixtureTarget(env);
  const { getApps, initializeApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const appName = 'radarist-graph-ci-fixture';
  const app = getApps().find((candidate) => candidate.name === appName)
    ?? initializeApp({ projectId: DEMO_PROFILES.selftest.projectId }, appName);
  return getFirestore(app);
}

export async function seedGraphCiFirestoreFixture(
  env: NodeJS.ProcessEnv = process.env
): Promise<GraphCiFirestoreFixtureVerification> {
  const db = await getGraphCiFixtureFirestore(env);
  const { relation, lock } = buildGraphCiFirestoreFixture();
  const batch = db.batch();
  batch.set(db.collection('relations').doc(relation.id), relation);
  batch.set(db.collection(RELATION_TRIPLE_LOCK_COLLECTION).doc(lock.id), lock.data);
  await batch.commit();
  return assertGraphCiFirestoreFixturePresent(env);
}

export async function verifyGraphCiFirestoreFixture(
  env: NodeJS.ProcessEnv = process.env
): Promise<GraphCiFirestoreFixtureVerification> {
  const db = await getGraphCiFixtureFirestore(env);
  const { relation, lock } = buildGraphCiFirestoreFixture();
  const [relationSnap, lockSnap] = await Promise.all([
    db.collection('relations').doc(relation.id).get(),
    db.collection(RELATION_TRIPLE_LOCK_COLLECTION).doc(lock.id).get(),
  ]);
  return {
    relations: relationSnap.exists ? 1 : 0,
    locks: lockSnap.exists ? 1 : 0,
    ownerMatches: lockSnap.exists && lockSnap.get('relationId') === relation.id,
  };
}

export async function assertGraphCiFirestoreFixturePresent(
  env: NodeJS.ProcessEnv = process.env
): Promise<GraphCiFirestoreFixtureVerification> {
  const verification = await verifyGraphCiFirestoreFixture(env);
  if (verification.relations !== 1 || verification.locks !== 1 || !verification.ownerMatches) {
    throw new Error(`Graph CI Firestore fixture invalid: ${JSON.stringify(verification)}`);
  }
  return verification;
}

export async function cleanupGraphCiFirestoreFixture(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const db = await getGraphCiFixtureFirestore(env);
  const { relation, lock } = buildGraphCiFirestoreFixture();
  const batch = db.batch();
  batch.delete(db.collection('relations').doc(relation.id));
  batch.delete(db.collection(RELATION_TRIPLE_LOCK_COLLECTION).doc(lock.id));
  await batch.commit();
}

export async function cleanupGraphCiFixture(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  assertGraphCiFixtureTarget(env);
  if (env.GRAPH_HEALTH_RELATION_LOCKS === '1') await cleanupGraphCiFirestoreFixture(env);
  const { entityIds, relationIds, actorId } = GRAPH_CI_FIXTURE;
  const relationIdValues = Object.values(relationIds);
  const entityIdValues = Object.values(entityIds);

  await runWriteTransaction(
    `MATCH (a:Assertion)-[:SUPPORTED_BY]->(e:Evidence)
     WHERE a.relationId IN $relationIds
     DETACH DELETE e`,
    { relationIds: relationIdValues }
  );
  await runWriteTransaction(
    `MATCH (a:Assertion)
     WHERE a.relationId IN $relationIds
     DETACH DELETE a`,
    { relationIds: relationIdValues }
  );
  await runWriteTransaction(
    `MATCH ()-[r]->()
     WHERE r.relationId IN $relationIds
     DELETE r`,
    { relationIds: relationIdValues }
  );
  await runWriteTransaction(
    `MATCH (n:Entity)
     WHERE n.id IN $entityIds
     DETACH DELETE n`,
    { entityIds: entityIdValues }
  );
  await runWriteTransaction(
    `MATCH (actor:Agent {id: $actorId})
     WHERE NOT (actor)--()
     DELETE actor`,
    { actorId }
  );
  // A hard process timeout can interrupt a random-ID canary leg before its
  // local finally runs. This broad cleanup remains safe because the target is
  // already guarded as disposable and every canary node carries a namespaced
  // id/name/title or graph-canary ownership marker.
  await runWriteTransaction(
    `MATCH (node)
     WHERE ${GRAPH_CANARY_RESIDUE_PREDICATE}
     DETACH DELETE node`
  );
}

export async function verifyGraphCiFixture(): Promise<GraphCiFixtureVerification> {
  const { entityIds, relationIds } = GRAPH_CI_FIXTURE;
  const entities = await runReadTransaction<{ c: number }>(
    `MATCH (n:Entity)
     WHERE n.id IN $entityIds
     RETURN count(n) AS c`,
    { entityIds: Object.values(entityIds) }
  );
  const directEdges = await runReadTransaction<{ c: number }>(
    `MATCH (:Company {id: $companyId})-[r:VENDOR {relationId: $relationId}]->(:Technology {id: $technologyId})
     WHERE r.t_invalidated IS NULL AND r.t_observed IS NOT NULL
       AND coalesce(r.effectiveConfidence, r.confidence) IS NOT NULL
     RETURN count(r) AS c`,
    {
      companyId: entityIds.company,
      technologyId: entityIds.technologyA,
      relationId: relationIds.direct,
    }
  );
  const assertionProjection = await runReadTransaction<{
    assertions: number;
    assertedEdges: number;
    evidence: number;
    asserterLinks: number;
  }>(
    `MATCH (a:Assertion {relationId: $relationId, assertedBy: $actorId})
     OPTIONAL MATCH (a)-[:SUPPORTED_BY]->(e:Evidence)
     OPTIONAL MATCH (a)-[assertedBy:ASSERTED_BY]->(:Agent {id: $actorId})
     WITH a, count(DISTINCT e) AS evidence, count(DISTINCT assertedBy) AS asserterLinks
     OPTIONAL MATCH (:Technology {id: $subjectId})-[r:EVALUATES]->(:Technology {id: $objectId})
     WHERE r.claimId = a.id AND r.t_invalidated IS NULL
       AND r.t_observed IS NOT NULL
       AND coalesce(r.effectiveConfidence, r.confidence) IS NOT NULL
     RETURN count(DISTINCT a) AS assertions, count(DISTINCT r) AS assertedEdges,
            evidence, asserterLinks`,
    {
      relationId: relationIds.asserted,
      subjectId: entityIds.technologyA,
      objectId: entityIds.technologyB,
      actorId: GRAPH_CI_FIXTURE.actorId,
    }
  );
  const actors = await runReadTransaction<{ c: number }>(
    'MATCH (actor:Agent {id: $actorId}) RETURN count(actor) AS c',
    { actorId: GRAPH_CI_FIXTURE.actorId }
  );
  const projection = assertionProjection.records[0];
  return {
    entities: entities.records[0]?.c ?? 0,
    directEdges: directEdges.records[0]?.c ?? 0,
    assertions: projection?.assertions ?? 0,
    assertedEdges: projection?.assertedEdges ?? 0,
    evidence: projection?.evidence ?? 0,
    asserterLinks: projection?.asserterLinks ?? 0,
    actorNodes: actors.records[0]?.c ?? 0,
  };
}

export async function assertGraphCiFixturePresent(): Promise<GraphCiFixtureVerification> {
  const verification = await verifyGraphCiFixture();
  const expected: GraphCiFixtureVerification = {
    entities: 3,
    directEdges: 1,
    assertions: 1,
    assertedEdges: 1,
    evidence: 1,
    asserterLinks: 1,
    actorNodes: 1,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actual = verification[key as keyof GraphCiFixtureVerification];
    if (actual !== expectedValue) {
      throw new Error(`Graph CI fixture ${key} expected ${expectedValue}, found ${actual}`);
    }
  }
  return verification;
}

export async function assertGraphCiFixtureAbsent(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const verification = await verifyGraphCiFixture();
  const residue = Object.entries(verification).filter(([, count]) => count !== 0);
  if (residue.length > 0) {
    throw new Error(`Graph CI fixture cleanup left residue: ${JSON.stringify(Object.fromEntries(residue))}`);
  }
  const canaryResidue = await runReadTransaction<{ c: number }>(
    `MATCH (node)
     WHERE ${GRAPH_CANARY_RESIDUE_PREDICATE}
     RETURN count(node) AS c`
  );
  const residueCount = canaryResidue.records[0]?.c ?? 0;
  if (residueCount !== 0) throw new Error(`Graph canary cleanup left ${residueCount} residue node(s)`);
  if (env.GRAPH_HEALTH_RELATION_LOCKS === '1') {
    const firestore = await verifyGraphCiFirestoreFixture(env);
    if (firestore.relations !== 0 || firestore.locks !== 0) {
      throw new Error(`Graph CI Firestore fixture cleanup left residue: ${JSON.stringify(firestore)}`);
    }
  }
}

export async function seedGraphCiFixture(env: NodeJS.ProcessEnv = process.env): Promise<GraphCiFixtureVerification> {
  assertGraphCiFixtureTarget(env);
  await cleanupGraphCiFixture(env);
  if (env.GRAPH_HEALTH_RELATION_LOCKS === '1') await seedGraphCiFirestoreFixture(env);
  const result = await syncSeedToNeo4j(buildGraphCiFixtureInput());
  if (result.entities.failed > 0 || result.relations.failed > 0) {
    throw new Error(`Graph CI fixture seed failed: ${JSON.stringify(result)}`);
  }
  return assertGraphCiFixturePresent();
}
