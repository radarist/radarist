/** @jest-environment node */

/**
 * GRAPH-061 / GRAPH-063 / GRAPH-064 acceptance, against a real Firestore
 * emulator and a real, guarded disposable Neo4j. Every assertion drives the
 * production writers and Inngest handlers — nothing about the graph state here
 * is simulated.
 *
 * Proves, end to end:
 *   - a signal expansion's invented endpoints never reach Firestore or the
 *     graph, and the signal still converges (source fingerprint stamped)
 *   - mentions from an unreviewed machine-generated source never claim curated
 *     or confidence 100, reviewing promotes them, withdrawing demotes them
 *   - deleting the source removes its chunks and their mentions
 *   - no verifier result survives its entity or relation, and an unanchorable
 *     verdict is never written at all
 */

const TEST_PREFIX = 'graph-trust-int-';
const DISPOSABLE_PROJECT_ID = 'demo-graph-trust-boundaries';
const PROJECT_ID =
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? '';

const mockEvents: Array<{ id?: string; name: string; data: Record<string, unknown> }> = [];
const neo4jTargetGuard = require('../../../../scripts/testing/neo4j-integration-target.cjs') as {
  assertDisposableNeo4jIntegrationTarget(env?: NodeJS.ProcessEnv): unknown;
};

interface MockFunctionHandler {
  (context: {
    event: { data: Record<string, unknown>; id: string };
    step: {
      run: <T>(name: string, callback: () => T | Promise<T>) => Promise<T>;
      sleep: (name: string, duration: string) => Promise<void>;
    };
  }): Promise<unknown>;
}

jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));
// Cache-free by construction: every read in this suite must observe the real
// current graph, never a memoized answer from an earlier fixture state. The
// pass-through caches keep `traversal.ts`'s getOrFetch contract intact.
jest.mock('@/lib/graph/query-cache', () => {
  const passThrough = () => ({
    getOrFetch: async <T>(_key: string, fetch: () => Promise<T>) => fetch(),
    invalidate: () => false,
    invalidatePattern: () => 0,
    clear: () => undefined,
  });
  return {
    invalidateCachesForEntity: jest.fn(),
    invalidateAllGraphCaches: jest.fn(),
    neighborsCache: passThrough(),
    pathCache: passThrough(),
    businessQueryCache: passThrough(),
    buildNeighborsCacheKey: (nodeId: string) => `neighbors:${nodeId}`,
    buildPathCacheKey: (sourceId: string, targetId: string) => `path:${sourceId}:${targetId}`,
    buildBusinessQueryCacheKey: (queryType: string) => `biz:${queryType}`,
  };
});
jest.mock('@/lib/graph/embedding-sync', () => ({
  scheduleEntityEmbed: jest.fn(async () => ({ embedded: false, reason: 'integration-test' })),
}));
// No provider key in the acceptance lane; chunk embedding is an optional
// enrichment (H7) and its absence must not change any trust assertion below.
jest.mock('@/lib/ai/client', () => ({
  generateEmbeddings: jest.fn(async () => ({
    embeddings: new Map<number, number[]>(),
    failures: new Map<number, string>(),
    model: 'integration-fixture',
    durationMs: 0,
  })),
  generateEmbedding: jest.fn(async () => []),
  generateContent: jest.fn(async () => ''),
  generateGroundedContent: jest.fn(async () => ({ text: '', citations: [] })),
}));
jest.mock('@/lib/firebase-admin', () => {
  const { generateKeyPairSync } = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  const { cert, initializeApp } = jest.requireActual<typeof import('firebase-admin/app')>('firebase-admin/app');
  const { getFirestore } = jest.requireActual<typeof import('firebase-admin/firestore')>('firebase-admin/firestore');
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? 'demo-graph-trust-boundaries';
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const adminApp = initializeApp(
    {
      projectId,
      credential: cert({ projectId, clientEmail: `trust@${projectId}.iam.gserviceaccount.com`, privateKey }),
    },
    `graph-trust-boundaries-${process.pid}`
  );
  const firestore = getFirestore(adminApp);
  firestore.settings({ preferRest: true });
  return { adminApp, db: firestore, adminAuth: {} };
});
jest.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: unknown, trigger: unknown, handler: MockFunctionHandler) => ({
      config,
      trigger,
      execute: (data: Record<string, unknown>) =>
        handler({
          event: { data, id: 'graph-trust-int-event' },
          step: {
            run: async <T>(_name: string, callback: () => T | Promise<T>) => await callback(),
            sleep: async () => undefined,
          },
        }),
    }),
    send: async (event: { id?: string; name: string; data: Record<string, unknown> }) => {
      mockEvents.push(event);
      return { ids: [event.id ?? 'graph-trust-int-accepted'] };
    },
  },
  safeSendEvent: jest.fn(async () => true),
}));

import { db } from '@/lib/firebase-admin';
import { closeDriver, runReadTransaction, runWriteTransaction } from '@/lib/graph/neo4j-client';
import { syncUnifiedEntityToNeo4jJob } from '@/lib/inngest/functions/sync-entity-to-neo4j';
import { syncDocumentToNeo4jJob } from '@/lib/inngest/functions/sync-document-to-neo4j';
import { syncTechnologyToNeo4jJob } from '@/lib/inngest/functions/sync-technology-to-neo4j';
import { markDocumentContentReviewed } from '@/lib/document-admin';
import { persistSignalExpansion, resolveSignalExpansionEndpoints } from '@/lib/signals/expand-signal';
import { deleteEntityFromGraph } from '@/lib/graph/assertions';
import {
  countOrphanedVerificationResults,
  createEdgeVerificationResult,
  createVerificationResult,
  deleteVerificationResultsForRelation,
  getVerificationForEntity,
  reconcileOrphanedVerificationResults,
} from '@/lib/graph/verification';
import { findTechnologiesForStrategy, recommendTechnologyInvestments } from '@/lib/graph/business-queries';
import { getGraphService } from '@/lib/graph/service-factory';
import { neighborsCache, pathCache } from '@/lib/graph/query-cache';
import { UNREVIEWED_MENTION_CONFIDENCE, REVIEWED_MENTION_CONFIDENCE } from '../mention-trust';
import type { ExpandedContent, TrustScore } from '@/lib/schemas/signal';

interface ExecutableJob {
  execute(data: Record<string, unknown>): Promise<unknown>;
}

const entityJob = syncUnifiedEntityToNeo4jJob as unknown as ExecutableJob;
const documentJob = syncDocumentToNeo4jJob as unknown as ExecutableJob;
// Technologies have their own sync function; the unified worker deliberately
// skips them (SKIP_REASONS.DEDICATED_SYNC_FUNCTION).
const technologyJob = syncTechnologyToNeo4jJob as unknown as ExecutableJob;

async function projectTechnology(technologyId: string, operation: 'create' | 'update' = 'create'): Promise<void> {
  await technologyJob.execute({ technologyId, operation });
}

const describeIntegration =
  process.env.NEO4J_INTEGRATION_TESTS === '1' && process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;

const IDS = {
  realTechnology: `${TEST_PREFIX}technology-real`,
  otherTechnology: `${TEST_PREFIX}technology-other`,
  approvedSignal: `${TEST_PREFIX}signal-approved`,
  relatedSignal: `${TEST_PREFIX}signal-related-approved`,
  inboxSignal: `${TEST_PREFIX}signal-inbox-only`,
  draftDocument: `${TEST_PREFIX}document-draft`,
  draftChunk: `${TEST_PREFIX}chunk-draft`,
  uploadedDocument: `${TEST_PREFIX}document-uploaded`,
  uploadedChunk: `${TEST_PREFIX}chunk-uploaded`,
  verifiedCompany: `${TEST_PREFIX}company-verified`,
  relation: `${TEST_PREFIX}relation`,
};

const FIRESTORE_FIXTURES = [
  ['technologies', IDS.realTechnology],
  ['technologies', IDS.otherTechnology],
  ['signals', IDS.approvedSignal],
  ['signals', IDS.relatedSignal],
  ['signals', IDS.inboxSignal],
  ['documents', IDS.draftDocument],
  ['documents', IDS.uploadedDocument],
  ['documentChunks', IDS.draftChunk],
  ['documentChunks', IDS.uploadedChunk],
] as const;

/** The name every fixture chunk mentions, so the text match is deterministic. */
const MENTIONED_NAME = 'Phasecraft Trust Probe';

function assertDisposableTargets(): void {
  const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(firestoreHost)) {
    throw new Error(`Graph trust acceptance requires a loopback Firestore emulator, got ${firestoreHost}`);
  }
  if (PROJECT_ID !== DISPOSABLE_PROJECT_ID) {
    throw new Error(`Graph trust acceptance requires Firebase project ${DISPOSABLE_PROJECT_ID}, got ${PROJECT_ID}`);
  }
  if (process.env.GRAPH_TRUST_BOUNDARIES_INTEGRATION_DISPOSABLE !== 'true') {
    throw new Error('Graph trust acceptance requires GRAPH_TRUST_BOUNDARIES_INTEGRATION_DISPOSABLE=true');
  }
  neo4jTargetGuard.assertDisposableNeo4jIntegrationTarget(process.env);
}

async function cleanupFirestore(): Promise<void> {
  const batch = db.batch();
  for (const [collection, id] of FIRESTORE_FIXTURES) batch.delete(db.collection(collection).doc(id));
  await batch.commit();
}

async function cleanupNeo4j(): Promise<void> {
  await runWriteTransaction(
    `MATCH ()-[edge]->()
     WHERE edge.relationId STARTS WITH $prefix
     DELETE edge`,
    { prefix: TEST_PREFIX }
  );
  await runWriteTransaction(`MATCH (node) WHERE node.id STARTS WITH $prefix DETACH DELETE node`, {
    prefix: TEST_PREFIX,
  });
  // Verifier verdicts are keyed by UUID, so they need their own predicate.
  await runWriteTransaction(
    `MATCH (node)
     WHERE (node:VerificationResult AND node.entityId STARTS WITH $prefix)
        OR (node:EdgeVerificationResult AND (node.relationId STARTS WITH $prefix
             OR node.sourceEntityId STARTS WITH $prefix OR node.targetEntityId STARTS WITH $prefix))
     DETACH DELETE node`,
    { prefix: TEST_PREFIX }
  );
}

async function graphCount(cypher: string, params: Record<string, unknown> = {}): Promise<number> {
  const result = await runReadTransaction<{ count: number }>(cypher, params);
  return result.records[0]?.count ?? 0;
}

function chunkFixture(id: string, documentId: string, chunkIndex = 0): Record<string, unknown> {
  return {
    id,
    documentId,
    content: `A passage naming ${MENTIONED_NAME} and its quantum simulation work.`,
    chunkIndex,
    tokenCount: 12,
    documentVersion: 1,
    archived: false,
    createdAt: Date.now(),
  };
}

async function seedBaseFixtures(): Promise<void> {
  const now = Date.now();
  const batch = db.batch();

  batch.set(db.collection('technologies').doc(IDS.realTechnology), {
    name: MENTIONED_NAME,
    slug: `${TEST_PREFIX}technology-real-slug`,
    description: 'Fixture technology the mention matcher must find.',
    approvalStatus: 'approved',
    createdBy: 'user-fixture',
    tags: [],
    createdAt: now,
    updatedAt: now,
  });
  batch.set(db.collection('technologies').doc(IDS.otherTechnology), {
    name: `${TEST_PREFIX}Other Technology`,
    slug: `${TEST_PREFIX}technology-other-slug`,
    description: 'Second technology, used for name-based endpoint resolution.',
    approvalStatus: 'approved',
    createdBy: 'user-fixture',
    tags: [],
    createdAt: now,
    updatedAt: now,
  });
  batch.set(db.collection('signals').doc(IDS.approvedSignal), {
    title: `${TEST_PREFIX}approved signal`,
    description: 'Signal under expansion.',
    status: 'Approved',
    type: 'news',
    source: 'fixture',
    url: 'https://example.com/fixture',
    date: new Date(now).toISOString(),
    tags: [],
    createdAt: now,
    updatedAt: now,
  });
  batch.set(db.collection('signals').doc(IDS.relatedSignal), {
    title: `${TEST_PREFIX}related approved signal`,
    description: 'Projectable related signal.',
    status: 'Approved',
    type: 'news',
    source: 'fixture',
    url: 'https://example.com/related',
    date: new Date(now).toISOString(),
    tags: [],
    createdAt: now,
    updatedAt: now,
  });
  batch.set(db.collection('signals').doc(IDS.inboxSignal), {
    title: `${TEST_PREFIX}inbox only signal`,
    description: 'Detected-only signal the graph never projects on its own.',
    status: 'Detected',
    type: 'news',
    source: 'fixture',
    url: 'https://example.com/inbox',
    date: new Date(now).toISOString(),
    tags: [],
    createdAt: now,
    updatedAt: now,
  });

  await batch.commit();
}

const TRUST_SCORE: TrustScore = {
  overall: 40,
  breakdown: { sourceReliability: 40, dataCompleteness: 40, corroboration: 40, aiConfidence: 40 },
  factors: ['fixture'],
};

function expansionWithInventedEndpoints(): ExpandedContent {
  return {
    relatedItems: {
      technologies: [
        // Real, by exact ID.
        { id: IDS.realTechnology, name: MENTIONED_NAME, relevance: 'subject' },
        // Wrong handle, right subject — resolvable by name.
        { id: 'tech-hallucinated-handle', name: `${TEST_PREFIX}Other Technology`, relevance: 'adjacent' },
        // Pure invention.
        { id: 'tech-id', name: 'Nonexistent Simulator', relevance: 'related' },
        { id: 'tech-phasecraft-stack', name: 'Nonexistent Stack', relevance: 'related' },
      ],
      companies: [{ id: 'company-id', name: 'Nonexistent Holdings', relevance: 'related' }],
      signals: [
        { id: IDS.relatedSignal, title: `${TEST_PREFIX}related approved signal`, relevance: 'related' },
        // Exists, but is inbox-only: its edge could never match.
        { id: IDS.inboxSignal, title: `${TEST_PREFIX}inbox only signal`, relevance: 'related' },
      ],
    },
    expandedAt: Date.now(),
    expansionModel: 'integration-fixture',
    expansionDuration: 1,
  } as unknown as ExpandedContent;
}

describeIntegration('graph trust boundaries (disposable Firestore + Neo4j)', () => {
  beforeAll(() => {
    assertDisposableTargets();
  });

  beforeEach(async () => {
    mockEvents.length = 0;
    await cleanupFirestore();
    await cleanupNeo4j();
    await seedBaseFixtures();
  });

  afterEach(async () => {
    await cleanupFirestore();
    await cleanupNeo4j();
  });

  afterAll(async () => {
    await closeDriver();
  });

  // ==========================================================================
  // GRAPH-063 — invented expansion endpoints
  // ==========================================================================

  it('drops invented expansion endpoints and still converges the signal', async () => {
    const generated = expansionWithInventedEndpoints();
    const resolution = await resolveSignalExpansionEndpoints(IDS.approvedSignal, generated);

    // Two invented technologies + one invented company + one inbox-only signal.
    expect(resolution.rejectedCount).toBe(4);
    expect(resolution.resolvedCount).toBe(1);
    expect(resolution.relatedItems?.technologies.map((t) => t.id).sort()).toEqual(
      [IDS.otherTechnology, IDS.realTechnology].sort()
    );
    expect(resolution.relatedItems?.companies).toEqual([]);
    expect(resolution.relatedItems?.signals.map((s) => s.id)).toEqual([IDS.relatedSignal]);

    await persistSignalExpansion(
      IDS.approvedSignal,
      { ...generated, relatedItems: resolution.relatedItems } as ExpandedContent,
      TRUST_SCORE,
      resolution
    );

    // The stored document must not carry a single invented endpoint — every
    // downstream reader (graph sync, extraction, UI) reads from here.
    const stored = (await db.collection('signals').doc(IDS.approvedSignal).get()).data() ?? {};
    const storedIds = [
      ...(stored.expandedContent?.relatedItems?.technologies ?? []),
      ...(stored.expandedContent?.relatedItems?.companies ?? []),
      ...(stored.expandedContent?.relatedItems?.signals ?? []),
    ].map((item: { id: string }) => item.id);
    expect(storedIds.every((id: string) => id.startsWith(TEST_PREFIX))).toBe(true);
    expect(stored.expansionRejectedEndpointCount).toBe(4);
    expect(stored.expansionRejectedEndpoints).toHaveLength(4);

    // Project every endpoint the survivors point at, then the signal itself.
    for (const technologyId of [IDS.realTechnology, IDS.otherTechnology]) {
      await projectTechnology(technologyId);
    }
    await entityJob.execute({ entityId: IDS.relatedSignal, entityType: 'signal', operation: 'create' });

    const result = (await entityJob.execute({
      entityId: IDS.approvedSignal,
      entityType: 'signal',
      operation: 'update',
    })) as { implicitRelationshipFailures?: number; sourceFingerprint?: string; unresolvedImplicitTargets?: unknown[] };

    // The heart of GRAPH-063: with no phantom endpoints left, the projection is
    // complete and the source fingerprint is stamped — the signal converges
    // instead of being replayed by the reconciler forever.
    expect(result.implicitRelationshipFailures).toBe(0);
    expect(result.unresolvedImplicitTargets).toBeUndefined();
    expect(result.sourceFingerprint).toEqual(expect.any(String));

    const stamped = await graphCount(
      `MATCH (s:Signal {id: $id}) WHERE s.sourceFingerprint IS NOT NULL RETURN count(s) AS count`,
      { id: IDS.approvedSignal }
    );
    expect(stamped).toBe(1);

    // Exactly the surviving endpoints are wired, and nothing else.
    expect(
      await graphCount(`MATCH (:Signal {id: $id})-[r:DISCOVERED]->() RETURN count(r) AS count`, {
        id: IDS.approvedSignal,
      })
    ).toBe(2);
    expect(
      await graphCount(`MATCH (:Signal {id: $id})-[r:RELATED_SIGNAL]->() RETURN count(r) AS count`, {
        id: IDS.approvedSignal,
      })
    ).toBe(1);
  }, 120_000);

  // Non-vacuity guard for the test above. Persisting the RAW expansion is
  // exactly what the code did before GRAPH-063, so this reproduces the reported
  // failure on the current tree: the phantom endpoints match nothing, the
  // projection is incomplete, and the source fingerprint is never stamped —
  // which is what made the reconciler replay the signal every cycle forever.
  it('reproduces the permanent non-convergence when unresolved endpoints are persisted', async () => {
    const generated = expansionWithInventedEndpoints();
    await persistSignalExpansion(IDS.approvedSignal, generated, TRUST_SCORE);

    for (const technologyId of [IDS.realTechnology, IDS.otherTechnology]) {
      await projectTechnology(technologyId);
    }
    await entityJob.execute({ entityId: IDS.relatedSignal, entityType: 'signal', operation: 'create' });

    const result = (await entityJob.execute({
      entityId: IDS.approvedSignal,
      entityType: 'signal',
      operation: 'update',
    })) as {
      implicitRelationshipFailures?: number;
      sourceFingerprint?: string;
      unresolvedImplicitTargets?: Array<{ predicate: string; targetIds: string[] }>;
    };

    // Two invented technologies + one invented company + one inbox-only signal
    // (the hallucinated handle for the second technology also fails, since
    // nothing resolved it to the canonical ID).
    expect(result.implicitRelationshipFailures).toBeGreaterThan(0);
    expect(result.sourceFingerprint).toBeUndefined();

    // And the failure is now legible rather than a bare counter.
    expect(result.unresolvedImplicitTargets?.length).toBeGreaterThan(0);
    expect(result.unresolvedImplicitTargets?.map((target) => target.predicate)).toEqual(
      expect.arrayContaining(['DISCOVERED'])
    );

    const stamped = await graphCount(
      `MATCH (s:Signal {id: $id}) WHERE s.sourceFingerprint IS NOT NULL RETURN count(s) AS count`,
      { id: IDS.approvedSignal }
    );
    expect(stamped).toBe(0);
  }, 120_000);

  // ==========================================================================
  // GRAPH-064 — mention trust, promotion, and source deletion
  // ==========================================================================

  it('keeps unreviewed research mentions out of curated confidence, then promotes and demotes them with the review', async () => {
    const now = Date.now();
    await db
      .collection('documents')
      .doc(IDS.draftDocument)
      .set({
        title: `${TEST_PREFIX}deep research draft`,
        type: 'markdown',
        tags: ['deep-research'],
        storageUrl: `documents/${IDS.draftDocument}.md`,
        status: 'processed',
        uploadedBy: 'user-fixture',
        workspaceId: 'default',
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    await db.collection('documentChunks').doc(IDS.draftChunk).set(chunkFixture(IDS.draftChunk, IDS.draftDocument));

    await db
      .collection('documents')
      .doc(IDS.uploadedDocument)
      .set({
        title: `${TEST_PREFIX}uploaded pdf`,
        type: 'pdf',
        tags: [],
        storageUrl: `documents/${IDS.uploadedDocument}.pdf`,
        status: 'processed',
        uploadedBy: 'user-fixture',
        workspaceId: 'default',
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    await db
      .collection('documentChunks')
      .doc(IDS.uploadedChunk)
      .set(chunkFixture(IDS.uploadedChunk, IDS.uploadedDocument));

    await projectTechnology(IDS.realTechnology);
    await documentJob.execute({ documentId: IDS.draftDocument, operation: 'create' });
    await documentJob.execute({ documentId: IDS.uploadedDocument, operation: 'create' });

    const readMention = async (chunkId: string) => {
      const result = await runReadTransaction<{
        claimStatus: string;
        confidence: number;
        effectiveConfidence: number;
        assertedConfidence: number;
        sourceProvenance: string;
        sourceReviewState: string;
      }>(
        `MATCH (:Chunk {id: $chunkId})-[r:MENTIONS]->(:Entity {id: $entityId})
         RETURN r.claimStatus AS claimStatus, r.confidence AS confidence,
                r.effectiveConfidence AS effectiveConfidence,
                r.assertedConfidence AS assertedConfidence,
                r.sourceProvenance AS sourceProvenance, r.sourceReviewState AS sourceReviewState`,
        { chunkId, entityId: IDS.realTechnology }
      );
      return result.records[0] ?? null;
    };

    // The reported defect: a weak deep-research draft minted curated/100.
    const draftMention = await readMention(IDS.draftChunk);
    expect(draftMention).toMatchObject({
      claimStatus: 'unverified',
      confidence: UNREVIEWED_MENTION_CONFIDENCE,
      effectiveConfidence: UNREVIEWED_MENTION_CONFIDENCE,
      assertedConfidence: UNREVIEWED_MENTION_CONFIDENCE,
      sourceProvenance: 'machine-generated',
      sourceReviewState: 'unreviewed',
    });

    // A real-world artifact a human brought in keeps curated-grade mentions.
    expect(await readMention(IDS.uploadedChunk)).toMatchObject({
      claimStatus: 'curated',
      confidence: REVIEWED_MENTION_CONFIDENCE,
      sourceProvenance: 'external',
    });

    // Duplicate mention: re-syncing must not add an edge or re-inflate trust.
    await documentJob.execute({ documentId: IDS.draftDocument, operation: 'update' });
    expect(
      await graphCount(
        `MATCH (:Chunk {id: $chunkId})-[r:MENTIONS]->(:Entity {id: $entityId}) RETURN count(r) AS count`,
        { chunkId: IDS.draftChunk, entityId: IDS.realTechnology }
      )
    ).toBe(1);
    expect(await readMention(IDS.draftChunk)).toMatchObject({ claimStatus: 'unverified' });

    // Reviewed promotion — the service performs the Firestore write and the
    // durable graph handoff; the handoff is executed here in place of a worker.
    const review = await markDocumentContentReviewed(IDS.draftDocument, 'user-fixture');
    expect(review).toMatchObject({ reviewed: true, graphSyncDispatched: true });
    await documentJob.execute({ documentId: IDS.draftDocument, operation: 'update' });

    expect(await readMention(IDS.draftChunk)).toMatchObject({
      claimStatus: 'curated',
      confidence: REVIEWED_MENTION_CONFIDENCE,
      effectiveConfidence: REVIEWED_MENTION_CONFIDENCE,
      sourceProvenance: 'machine-generated',
      sourceReviewState: 'reviewed',
    });

    // Withdrawing the review demotes by the same derivation — including
    // effectiveConfidence, which every confidence-ordered reader consults.
    await markDocumentContentReviewed(IDS.draftDocument, 'user-fixture', { reviewed: false });
    await documentJob.execute({ documentId: IDS.draftDocument, operation: 'update' });
    expect(await readMention(IDS.draftChunk)).toMatchObject({
      claimStatus: 'unverified',
      confidence: UNREVIEWED_MENTION_CONFIDENCE,
      effectiveConfidence: UNREVIEWED_MENTION_CONFIDENCE,
      sourceReviewState: 'unreviewed',
    });

    // Source deletion removes the chunks and, with them, every mention.
    await db.collection('documents').doc(IDS.draftDocument).delete();
    await documentJob.execute({ documentId: IDS.draftDocument, operation: 'delete' });

    expect(await graphCount(`MATCH (c:Chunk {id: $id}) RETURN count(c) AS count`, { id: IDS.draftChunk })).toBe(0);
    expect(
      await graphCount(`MATCH (:Chunk {id: $id})-[r:MENTIONS]->() RETURN count(r) AS count`, { id: IDS.draftChunk })
    ).toBe(0);
    // The unrelated document's mention is untouched.
    expect(await readMention(IDS.uploadedChunk)).toMatchObject({ claimStatus: 'curated' });
  }, 180_000);

  // ==========================================================================
  // GRAPH-061 — verifier results never outlive their target
  // ==========================================================================

  it('never writes an unanchorable verdict and never leaves one behind', async () => {
    await projectTechnology(IDS.realTechnology);

    // 1. Fail-closed: an entity that is not in the graph gets no verdict node.
    await expect(
      createVerificationResult({
        entityId: `${TEST_PREFIX}entity-that-does-not-exist`,
        status: 'verified',
        score: 90,
        sourcesChecked: 3,
        sourcesConfirming: 3,
        sourcesContradicting: 0,
        verifierModel: 'integration-fixture',
        reasoning: 'fixture',
        strictnessLevel: 'standard',
      })
    ).rejects.toMatchObject({ name: 'VerificationTargetMissingError' });
    expect(
      await graphCount(`MATCH (vr:VerificationResult {entityId: $id}) RETURN count(vr) AS count`, {
        id: `${TEST_PREFIX}entity-that-does-not-exist`,
      })
    ).toBe(0);

    // 2. Fail-closed: a relation with no projected edge gets no verdict node.
    await expect(
      createEdgeVerificationResult({
        relationId: IDS.relation,
        sourceEntityId: IDS.realTechnology,
        targetEntityId: IDS.verifiedCompany,
        status: 'verified',
        score: 80,
        sourcesChecked: 2,
        sourcesConfirming: 2,
        sourcesContradicting: 0,
        verifierModel: 'integration-fixture',
        reasoning: 'fixture',
      })
    ).rejects.toMatchObject({ name: 'VerificationTargetMissingError' });
    expect(
      await graphCount(`MATCH (evr:EdgeVerificationResult {relationId: $id}) RETURN count(evr) AS count`, {
        id: IDS.relation,
      })
    ).toBe(0);

    // 3. A real verdict is bound to the generation it verified.
    const entityVerdict = await createVerificationResult({
      entityId: IDS.realTechnology,
      status: 'verified',
      score: 88,
      sourcesChecked: 2,
      sourcesConfirming: 2,
      sourcesContradicting: 0,
      verifierModel: 'integration-fixture',
      reasoning: 'fixture',
      strictnessLevel: 'standard',
    });
    expect(entityVerdict.targetGeneration).toEqual(expect.any(String));
    expect(await getVerificationForEntity(IDS.realTechnology)).toMatchObject({ status: 'verified', stale: false });

    // Editing the entity moves its generation on; the verdict is reported as
    // describing content that has since changed, not as current truth.
    await db.collection('technologies').doc(IDS.realTechnology).update({
      description: 'Edited after verification.',
      updatedAt: Date.now(),
    });
    await projectTechnology(IDS.realTechnology, 'update');
    expect(await getVerificationForEntity(IDS.realTechnology)).toMatchObject({ stale: true });

    // 4. A projected relation edge anchors an edge verdict, which the relation
    // teardown removes.
    await runWriteTransaction(
      `MATCH (t:Technology {id: $techId})
       MERGE (c:Entity:Company {id: $companyId})
         ON CREATE SET c.entityType = 'company', c.name = $companyName
       MERGE (t)-[r:USES {relationId: $relationId}]->(c)
         ON CREATE SET r.sourceFingerprint = 'integration-generation-1'`,
      {
        techId: IDS.realTechnology,
        companyId: IDS.verifiedCompany,
        companyName: `${TEST_PREFIX}verified company`,
        relationId: IDS.relation,
      }
    );
    const edgeVerdict = await createEdgeVerificationResult({
      relationId: IDS.relation,
      sourceEntityId: IDS.realTechnology,
      targetEntityId: IDS.verifiedCompany,
      status: 'verified',
      score: 80,
      sourcesChecked: 2,
      sourcesConfirming: 2,
      sourcesContradicting: 0,
      verifierModel: 'integration-fixture',
      reasoning: 'fixture',
    });
    expect(edgeVerdict.targetGeneration).toBe('integration-generation-1');

    await deleteVerificationResultsForRelation(IDS.relation);
    expect(
      await graphCount(`MATCH (evr:EdgeVerificationResult {id: $id}) RETURN count(evr) AS count`, {
        id: edgeVerdict.id,
      })
    ).toBe(0);

    // 5. Deleting the entity takes its own verdict AND every edge verdict that
    // named it as an endpoint.
    const survivingEdgeVerdict = await createEdgeVerificationResult({
      relationId: IDS.relation,
      sourceEntityId: IDS.realTechnology,
      targetEntityId: IDS.verifiedCompany,
      status: 'unverified',
      score: 55,
      sourcesChecked: 1,
      sourcesConfirming: 1,
      sourcesContradicting: 0,
      verifierModel: 'integration-fixture',
      reasoning: 'fixture',
    });
    const deletion = await deleteEntityFromGraph(IDS.realTechnology, 'technology');
    expect(deletion.verificationResultsDeleted).toBeGreaterThanOrEqual(1);
    expect(deletion.edgeVerificationResultsDeleted).toBeGreaterThanOrEqual(1);

    expect(
      await graphCount(`MATCH (vr:VerificationResult {id: $id}) RETURN count(vr) AS count`, { id: entityVerdict.id })
    ).toBe(0);
    expect(
      await graphCount(`MATCH (evr:EdgeVerificationResult {id: $id}) RETURN count(evr) AS count`, {
        id: survivingEdgeVerdict.id,
      })
    ).toBe(0);
    expect(await getVerificationForEntity(IDS.realTechnology)).toBeNull();

    // 6. Nothing this suite created is left dangling for the sweep to find.
    const census = await countOrphanedVerificationResults();
    const swept = await reconcileOrphanedVerificationResults();
    expect(census.entityResults + census.edgeResults).toBe(swept.entityResultsDeleted + swept.edgeResultsDeleted);
    expect(await countOrphanedVerificationResults()).toEqual({ entityResults: 0, edgeResults: 0 });
  }, 180_000);

  // ==========================================================================
  // GRAPH-061 — an ID is not an identity: delete/recreate must not revive a verdict
  // ==========================================================================

  it('cannot revive a verdict by recreating the same entity ID', async () => {
    await projectTechnology(IDS.realTechnology);
    const original = await createVerificationResult({
      entityId: IDS.realTechnology,
      status: 'verified',
      score: 91,
      sourcesChecked: 3,
      sourcesConfirming: 3,
      sourcesContradicting: 0,
      verifierModel: 'integration-fixture',
      reasoning: 'verdict about the ORIGINAL entity',
      strictnessLevel: 'standard',
    });
    expect(await getVerificationForEntity(IDS.realTechnology)).toMatchObject({ id: original.id, stale: false });

    // Remove the entity the way the delete worker does.
    const deletion = await deleteEntityFromGraph(IDS.realTechnology, 'technology');
    expect(deletion.verificationResultsDeleted).toBeGreaterThanOrEqual(1);

    // Recreate the SAME id with different content and re-project it. This is the
    // dangerous case: scalar `vr.entityId` would match again, so a verdict that
    // survived the delete would present as the new entity's current status.
    await db
      .collection('technologies')
      .doc(IDS.realTechnology)
      .set({
        name: `${MENTIONED_NAME} (recreated)`,
        slug: `${TEST_PREFIX}technology-real-slug`,
        description: 'A different technology that happens to reuse the retired ID.',
        approvalStatus: 'approved',
        createdBy: 'user-fixture',
        tags: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    await projectTechnology(IDS.realTechnology, 'update');

    expect(
      await graphCount(`MATCH (t:Technology {id: $id}) RETURN count(t) AS count`, { id: IDS.realTechnology })
    ).toBe(1);
    // The recreated entity has NO verification status — not the old verdict, and
    // not the old verdict relabelled stale.
    expect(await getVerificationForEntity(IDS.realTechnology)).toBeNull();
    expect(
      await graphCount(`MATCH (vr:VerificationResult {id: $id}) RETURN count(vr) AS count`, { id: original.id })
    ).toBe(0);

    // A fresh verdict binds to the recreated generation and is current.
    const reverified = await createVerificationResult({
      entityId: IDS.realTechnology,
      status: 'disputed',
      score: 42,
      sourcesChecked: 1,
      sourcesConfirming: 0,
      sourcesContradicting: 1,
      verifierModel: 'integration-fixture',
      reasoning: 'verdict about the RECREATED entity',
      strictnessLevel: 'standard',
    });
    expect(reverified.targetGeneration).toEqual(expect.any(String));
    expect(reverified.targetGeneration).not.toBe(original.targetGeneration);
    expect(await getVerificationForEntity(IDS.realTechnology)).toMatchObject({
      id: reverified.id,
      status: 'disputed',
      stale: false,
    });

    expect(await countOrphanedVerificationResults()).toEqual({ entityResults: 0, edgeResults: 0 });
  }, 180_000);

  // ==========================================================================
  // GRAPH-062 — curated business path vs session co-view
  // ==========================================================================

  it('scores a curated business path as alignment and a session co-view as nothing', async () => {
    // Both technologies are canonical, approved, projected entities. The ONLY
    // difference is how each reaches the strategy.
    const strategyId = `${TEST_PREFIX}strategy-alignment`;
    const alignedTechId = `${TEST_PREFIX}technology-aligned`;
    const coviewTechId = `${TEST_PREFIX}technology-coviewed`;
    const sessionId = `${TEST_PREFIX}session-coview`;

    await runWriteTransaction(
      `MERGE (s:Entity:Strategy {id: $strategyId})
         ON CREATE SET s.entityType = 'strategy', s.name = $strategyName
       MERGE (aligned:Entity:Technology {id: $alignedTechId})
         ON CREATE SET aligned.entityType = 'technology', aligned.name = $alignedName
       MERGE (coviewed:Entity:Technology {id: $coviewTechId})
         ON CREATE SET coviewed.entityType = 'technology', coviewed.name = $coviewName
       MERGE (session:Session {id: $sessionId})
         ON CREATE SET session.userId = $sessionId
       // Curated, evidence-bearing business claim.
       MERGE (aligned)-[curated:ALIGNS_WITH {relationId: $alignedRelationId}]->(s)
         ON CREATE SET curated.claimStatus = 'curated',
                       curated.assertedBy = 'user:fixture',
                       curated.confidence = 100,
                       curated.assertedConfidence = 100,
                       curated.effectiveConfidence = 100,
                       curated.t_observed = datetime(),
                       curated.t_invalidated = NULL
       // Behavioral proximity only: one session viewed both.
       MERGE (session)-[:EXPLORED]->(s)
       MERGE (session)-[:EXPLORED]->(coviewed)`,
      {
        strategyId,
        strategyName: `${TEST_PREFIX}Grow the platform`,
        alignedTechId,
        alignedName: `${TEST_PREFIX}Aligned Technology`,
        coviewTechId,
        coviewName: `${TEST_PREFIX}Co-viewed Technology`,
        sessionId,
        alignedRelationId: `${TEST_PREFIX}relation-aligned`,
      }
    );

    // The fixture is non-vacuous: the co-view path really is a 2-hop connection
    // an unconstrained traversal would walk. This is the exact shape the live
    // TEST-027 run scored as strategic alignment.
    expect(
      await graphCount(
        `MATCH (s:Strategy {id: $strategyId})<-[:EXPLORED]-(:Session)-[:EXPLORED]->(t:Technology {id: $coviewTechId})
         RETURN count(*) AS count`,
        { strategyId, coviewTechId }
      )
    ).toBe(1);

    pathCache.clear();
    neighborsCache.clear();
    const service = await getGraphService();
    const unconstrained = await service.findConnected(strategyId, 'technology', { maxDepth: 3 });
    expect(unconstrained.map((node) => node.id).sort()).toEqual([alignedTechId, coviewTechId].sort());

    // Under the business envelope, only the curated claim survives.
    const aligned = await findTechnologiesForStrategy(strategyId);
    expect(aligned.map((entry) => entry.technology.id)).toEqual([alignedTechId]);
    expect(aligned[0].admittedPath).toEqual(['ALIGNS_WITH']);
    expect(aligned[0].alignmentScore).toBe(100);

    // And the recommendation receipt names the admitted path rather than an
    // unexplained percentage.
    const recommendations = await recommendTechnologyInvestments({ strategyId });
    expect(recommendations.map((entry) => entry.technology.id)).toEqual([alignedTechId]);
    expect(recommendations[0].strategyAlignmentPath).toEqual(['ALIGNS_WITH']);
    expect(recommendations[0].reasons).toEqual(['Aligns with strategy (100%) via ALIGNS_WITH']);

    // The proximity data is preserved, not deleted — it is simply not evidence
    // of strategy.
    expect(
      await graphCount(`MATCH (:Session {id: $sessionId})-[:EXPLORED]->() RETURN count(*) AS count`, { sessionId })
    ).toBe(2);

    await runWriteTransaction(
      `MATCH (node) WHERE node.id IN [$strategyId, $alignedTechId, $coviewTechId, $sessionId] DETACH DELETE node`,
      { strategyId, alignedTechId, coviewTechId, sessionId }
    );
    pathCache.clear();
    neighborsCache.clear();
  }, 180_000);
});
