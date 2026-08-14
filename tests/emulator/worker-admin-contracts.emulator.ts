/**
 * Worker Admin-SDK mutation contracts (TEST-002).
 *
 * Continues the release-contracts.emulator.ts pattern with focused contract
 * tests for the Inngest-worker / server-route mutation paths that the unit
 * suites can only exercise against Firestore doubles:
 *
 *  - proposed-relations-admin: idempotent create dedup branches, the 30-day
 *    rejection-retention window, and undefined-field stripping on a REAL
 *    Firestore write (the emulator rejects `undefined` values, mocks don't).
 *  - proposed-relations-admin: two CONCURRENT machine approvals of the same
 *    pending proposal — the triple-lock transaction plus the BUILD-021
 *    compare-and-set must produce exactly one relation and exactly one
 *    reviewedBy provenance stamp.
 *  - proposed-relations-admin: the BUILD-022 crash window — rejecting a
 *    pending proposal that already carries a relationId must also flip the
 *    materialized relation's claimStatus to 'rejected'.
 *  - proposed-assessments-admin: the BUILD-011 atomic TRL+status transaction,
 *    the only-if-unset canonical-TRL guard, the BUILD-005 re-approve retry
 *    fall-through, and the fully-applied idempotent short-circuit.
 *
 * This file deliberately does not match the root Jest `*.test.ts` pattern —
 * it needs a live Firestore emulator. Run through `npm run test:emulator`, or
 * standalone against an already-running emulator:
 *
 *   NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true \
 *   NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-radarist \
 *   FIRESTORE_EMULATOR_HOST=localhost:8080 \
 *   npx jest -c jest.emulator.config.js tests/emulator/worker-admin-contracts.emulator.ts
 *
 * No Firestore mocking; only the Firestore emulator is required (Auth/Storage
 * are untouched). The graph handoff is acknowledged by an explicit Inngest
 * mock; its real projection is covered by the disposable graph lanes.
 */

const PROJECT_ID = 'demo-radarist';
const RUN_COMMAND =
  'NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-radarist ' +
  'FIRESTORE_EMULATOR_HOST=localhost:8080 npx jest -c jest.emulator.config.js ' +
  'tests/emulator/worker-admin-contracts.emulator.ts';

if (process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR !== 'true') {
  throw new Error(
    `worker-admin-contracts.emulator.ts must run with NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true — ${RUN_COMMAND}`
  );
}
if (process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID !== PROJECT_ID) {
  throw new Error(`worker-admin-contracts.emulator.ts requires project ${PROJECT_ID} — ${RUN_COMMAND}`);
}
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(`FIRESTORE_EMULATOR_HOST must point at a running Firestore emulator — ${RUN_COMMAND}`);
}

jest.mock('@/lib/inngest/client', () => ({
  inngest: { send: jest.fn().mockResolvedValue({ ids: ['worker-emulator-graph-handoff'] }) },
}));
jest.mock('@/lib/inngest/send-client', () => ({
  inngest: { send: jest.fn().mockResolvedValue({ ids: ['worker-emulator-graph-handoff'] }) },
}));

import { db as adminDb } from '@/lib/firebase-admin';
import { buildRelationTripleKey, RELATION_TRIPLE_LOCK_COLLECTION } from '@/lib/relations-triple-key';
import { buildRadarPlacementPairKey, RADAR_PLACEMENT_PAIR_LOCK_COLLECTION } from '@/lib/radar-placement-pair-key';
import { proposedAssessmentSchema, generateAssessmentKey } from '@/lib/schemas/proposed-assessment';
import type { ProposedAssessment } from '@/lib/schemas/proposed-assessment';
import type { CreateProposedRelationInput, ProposedRelation, Relation } from '@/lib/types';
import type { CreateProposedAssessmentInput } from '@/lib/proposed-assessments-admin';

jest.setTimeout(30_000);

// Unique per-invocation prefix so runs are isolated and re-runnable even if a
// previous run's cleanup was interrupted.
const RUN = `wac-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let relationsTriage: typeof import('@/lib/proposed-relations-admin');
let assessmentsTriage: typeof import('@/lib/proposed-assessments-admin');

const firestoreCleanup = new Set<string>();

beforeAll(async () => {
  relationsTriage = await import('@/lib/proposed-relations-admin');
  assessmentsTriage = await import('@/lib/proposed-assessments-admin');
});

afterAll(async () => {
  await Promise.all(
    [...firestoreCleanup].map((path) =>
      adminDb
        .doc(path)
        .delete()
        .catch(() => undefined)
    )
  );
  await adminDb.terminate();
});

async function seedTechnology(id: string, name: string, extra: Record<string, unknown> = {}): Promise<void> {
  const now = Date.now();
  firestoreCleanup.add(`technologies/${id}`);
  await adminDb.doc(`technologies/${id}`).set({
    id,
    name,
    description: `Emulator contract technology ${name}`,
    approvalStatus: 'approved',
    createdAt: now,
    updatedAt: now,
    ...extra,
  });
}

function relationProposalInput(
  sourceId: string,
  targetId: string,
  overrides: Partial<CreateProposedRelationInput> = {}
): CreateProposedRelationInput {
  const now = Date.now();
  return {
    sourceType: 'technology',
    sourceId,
    sourceSnapshot: { id: sourceId, type: 'technology', name: `Source ${sourceId}`, snapshotAt: now },
    targetType: 'technology',
    targetId,
    targetSnapshot: { id: targetId, type: 'technology', name: `Target ${targetId}`, snapshotAt: now },
    relationType: 'uses',
    confidence: 90,
    reasoning: 'Emulator worker-contract rationale',
    evidence: [
      {
        sourceType: 'web',
        sourceId: `web-${RUN}`,
        location: { url: 'https://example.test/worker-contract', fetchedAt: now },
        snippet: 'Worker contract evidence snippet',
        snippetHash: `hash-${RUN}`,
        extractedAt: now,
      },
    ],
    discoveredBy: 'linker-agent',
    ...overrides,
  };
}

function trackRelationArtifacts(sourceId: string, targetId: string): void {
  firestoreCleanup.add(`${RELATION_TRIPLE_LOCK_COLLECTION}/${buildRelationTripleKey(sourceId, targetId, 'uses')}`);
}

async function readProposal(id: string): Promise<ProposedRelation | undefined> {
  return (await adminDb.doc(`proposedRelations/${id}`).get()).data() as ProposedRelation | undefined;
}

describe('proposed-relations-admin: idempotent create + rejection retention + undefined stripping', () => {
  const sourceId = `tech-${RUN}-dedup-src`;
  const targetId = `tech-${RUN}-dedup-tgt`;

  it('strips undefined fields on the real write, dedups pending/rejected, and re-opens after retention', async () => {
    const key = relationsTriage.generateProposalKey(sourceId, targetId, 'uses');
    firestoreCleanup.add(`proposedRelations/${key}`);

    // Explicit `undefined` optionals must be STRIPPED before the write — the
    // real Firestore emulator rejects undefined values outright, so this only
    // passes if removeUndefinedFields runs against the actual payload.
    const first = await relationsTriage.createProposedRelationIfNotExists(
      relationProposalInput(sourceId, targetId, { runId: undefined, promptVersion: undefined })
    );
    expect(first.created).toBe(true);
    expect(first.proposal.id).toBe(key);

    const rawDoc = (await adminDb.doc(`proposedRelations/${key}`).get()).data() as Record<string, unknown>;
    expect(rawDoc.status).toBe('pending');
    expect(rawDoc).not.toHaveProperty('runId');
    expect(rawDoc).not.toHaveProperty('promptVersion');

    // Pending → dedup.
    const second = await relationsTriage.createProposedRelationIfNotExists(relationProposalInput(sourceId, targetId));
    expect(second).toMatchObject({ created: false, reason: 'already_pending' });

    // Rejected inside the 30-day retention window → dedup.
    const rejected = await relationsTriage.rejectProposedRelation(key, `reviewer-${RUN}`, 'not accurate');
    expect(rejected.status).toBe('rejected');
    expect((await readProposal(key))?.feedbackReason).toBe('not accurate');

    const third = await relationsTriage.createProposedRelationIfNotExists(relationProposalInput(sourceId, targetId));
    expect(third).toMatchObject({ created: false, reason: 'recently_rejected' });

    // Backdate the rejection past the retention window → re-proposal allowed
    // and the doc is overwritten back to a fresh pending proposal.
    await adminDb.doc(`proposedRelations/${key}`).update({ updatedAt: Date.now() - 31 * 24 * 60 * 60 * 1000 });
    const fourth = await relationsTriage.createProposedRelationIfNotExists(relationProposalInput(sourceId, targetId));
    expect(fourth.created).toBe(true);
    expect((await readProposal(key))?.status).toBe('pending');
  });
});

describe('proposed-relations-admin: concurrent machine approval CAS (BUILD-021)', () => {
  const sourceId = `tech-${RUN}-race-src`;
  const targetId = `tech-${RUN}-race-tgt`;

  it('lets exactly one of two concurrent machine approvals win the terminal flip against one shared relation', async () => {
    await Promise.all([seedTechnology(sourceId, `Race Source ${RUN}`), seedTechnology(targetId, `Race Target ${RUN}`)]);
    trackRelationArtifacts(sourceId, targetId);

    const key = relationsTriage.generateProposalKey(sourceId, targetId, 'uses');
    firestoreCleanup.add(`proposedRelations/${key}`);
    const created = await relationsTriage.createProposedRelationIfNotExists(
      relationProposalInput(sourceId, targetId, { confidence: 90 })
    );
    expect(created.created).toBe(true);

    const reviewers = [`autopilot-one-${RUN}`, `autopilot-two-${RUN}`];
    const [resultOne, resultTwo] = await Promise.all([
      relationsTriage.approveProposedRelationAsMachine(key, reviewers[0]),
      relationsTriage.approveProposedRelationAsMachine(key, reviewers[1]),
    ]);

    // Both callers converge on idempotent success — neither sees an error.
    expect(resultOne.applied).toBe(true);
    expect(resultTwo.applied).toBe(true);

    // Exactly one relation exists for the triple (triple-lock transaction).
    const relationSnap = await adminDb
      .collection('relations')
      .where('sourceSnapshot.id', '==', sourceId)
      .where('targetSnapshot.id', '==', targetId)
      .where('relationType', '==', 'uses')
      .get();
    expect(relationSnap.size).toBe(1);
    const relation = relationSnap.docs[0].data() as Relation;
    firestoreCleanup.add(`relations/${relation.id}`);

    // Machine approval keeps machine provenance: proposed claim, aiSuggested,
    // the mapped linker agent name, and durable proposal provenance refs.
    expect(relation.claimStatus).toBe('proposed');
    expect(relation.aiSuggested).toBe(true);
    expect(relation.agentName).toBe('linker');
    expect((relation.evidenceRefs ?? []).map((ref) => ref.id)).toEqual(
      expect.arrayContaining([`proposal:${key}:reasoning`])
    );

    // Exactly ONE writer won the compare-and-set: the terminal doc carries a
    // single reviewedBy from the racing pair, and both return values report
    // the winner's provenance (the loser must not overwrite it).
    const terminal = await readProposal(key);
    expect(terminal?.status).toBe('approved');
    expect(terminal?.relationId).toBe(relation.id);
    expect(reviewers).toContain(terminal?.reviewedBy);
    expect(resultOne.proposal.status).toBe('approved');
    expect(resultTwo.proposal.status).toBe('approved');
    expect(resultOne.proposal.reviewedBy).toBe(terminal?.reviewedBy);
    expect(resultTwo.proposal.reviewedBy).toBe(terminal?.reviewedBy);
  });

  it('defers a machine approval below the materialization floor without touching the proposal or graph', async () => {
    const lowSourceId = `tech-${RUN}-floor-src`;
    const lowTargetId = `tech-${RUN}-floor-tgt`;
    await Promise.all([
      seedTechnology(lowSourceId, `Floor Source ${RUN}`),
      seedTechnology(lowTargetId, `Floor Target ${RUN}`),
    ]);

    const key = relationsTriage.generateProposalKey(lowSourceId, lowTargetId, 'uses');
    firestoreCleanup.add(`proposedRelations/${key}`);
    await relationsTriage.createProposedRelationIfNotExists(
      relationProposalInput(lowSourceId, lowTargetId, { confidence: 60 })
    );

    const result = await relationsTriage.approveProposedRelationAsMachine(key, `autopilot-${RUN}`);
    expect(result).toMatchObject({ applied: false, reason: 'below-materialization-floor' });

    const persisted = await readProposal(key);
    expect(persisted?.status).toBe('pending');
    expect(persisted?.relationId).toBeUndefined();

    const relationSnap = await adminDb
      .collection('relations')
      .where('sourceSnapshot.id', '==', lowSourceId)
      .where('targetSnapshot.id', '==', lowTargetId)
      .where('relationType', '==', 'uses')
      .get();
    expect(relationSnap.size).toBe(0);
  });
});

describe('proposed-relations-admin: crash-window reject invalidates the materialized claim (BUILD-022)', () => {
  const sourceId = `tech-${RUN}-crash-src`;
  const targetId = `tech-${RUN}-crash-tgt`;
  const relationId = `rel-${RUN}-crash`;

  it('rejects a pending proposal carrying a relationId and flips the relation claimStatus to rejected', async () => {
    const now = Date.now();
    const key = relationsTriage.generateProposalKey(sourceId, targetId, 'uses');
    firestoreCleanup.add(`proposedRelations/${key}`);
    firestoreCleanup.add(`relations/${relationId}`);

    const relation: Relation = {
      id: relationId,
      relationType: 'uses',
      sourceSnapshot: { id: sourceId, type: 'technology', name: `Crash Source ${RUN}`, snapshotAt: now },
      targetSnapshot: { id: targetId, type: 'technology', name: `Crash Target ${RUN}`, snapshotAt: now },
      notes: '',
      confidence: 80,
      aiSuggested: true,
      claimStatus: 'proposed',
      createdAt: now,
      updatedAt: now,
    };
    await adminDb.doc(`relations/${relationId}`).set(relation);

    // The BUILD-022 crash window: the pointer write landed, the terminal
    // status flip never did — the proposal is still pending WITH relationId.
    await adminDb.doc(`proposedRelations/${key}`).set({
      ...relationProposalInput(sourceId, targetId, { confidence: 80 }),
      id: key,
      status: 'pending',
      relationId,
      createdAt: now,
      updatedAt: now,
    });

    const rejected = await relationsTriage.rejectProposedRelation(key, `reviewer-${RUN}`, 'claim declined');
    expect(rejected.status).toBe('rejected');

    const persistedProposal = await readProposal(key);
    expect(persistedProposal).toMatchObject({
      status: 'rejected',
      reviewedBy: `reviewer-${RUN}`,
      feedbackReason: 'claim declined',
      relationId,
    });

    // The materialized claim must not survive as a zombie edge: the sync
    // contract keys edge invalidation off claimStatus 'rejected'.
    const persistedRelation = (await adminDb.doc(`relations/${relationId}`).get()).data() as Relation;
    expect(persistedRelation.claimStatus).toBe('rejected');
    expect(persistedRelation.updatedAt).toBeGreaterThanOrEqual(now);

    // Idempotent re-reject; approving a rejected proposal stays forbidden.
    await expect(relationsTriage.rejectProposedRelation(key, `reviewer-${RUN}`)).resolves.toMatchObject({
      status: 'rejected',
    });
    await expect(relationsTriage.approveProposedRelation(key, `reviewer-${RUN}`)).rejects.toThrow(
      'Proposal is not pending: rejected'
    );
  });
});

describe('proposed-assessments-admin: TRL+status transaction, retry fall-through, idempotent short-circuit', () => {
  const radarId = `radar-${RUN}`;
  const quadrantId = `quadrant-${RUN}`;
  const radarOwnerId = `reviewer-${RUN}`;

  beforeAll(async () => {
    const now = Date.now();
    firestoreCleanup.add(`radars/${radarId}`);
    await adminDb.doc(`radars/${radarId}`).set({
      id: radarId,
      name: `Assessment Radar ${RUN}`,
      quadrants: [{ id: quadrantId, name: 'Assessment', order: 0 }],
      entries: [],
      ringSystem: 'Standard',
      createdBy: radarOwnerId,
      createdAt: now,
      updatedAt: now,
    });
  });

  function trackPlacementPair(technologyId: string): void {
    firestoreCleanup.add(
      `${RADAR_PLACEMENT_PAIR_LOCK_COLLECTION}/${buildRadarPlacementPairKey(radarId, technologyId)}`
    );
  }

  function assessmentInput(technologyId: string, sourceRunId: string): CreateProposedAssessmentInput {
    return {
      technologyId,
      technologyName: `Assessment Tech ${technologyId}`,
      recommendation: 'trial',
      trl: 6,
      confidence: 80,
      evidence: {
        metrics: [{ name: 'build', value: 'pass' }],
        findings: [{ title: 'runs clean', detail: 'emulator contract', kind: 'observation' }],
      },
      proposedRing: 'Trial',
      sourceRunId,
    };
  }

  async function placementsFor(technologyId: string): Promise<FirebaseFirestore.QuerySnapshot> {
    return adminDb
      .collection('radarPlacements')
      .where('technologyId', '==', technologyId)
      .where('radarId', '==', radarId)
      .get();
  }

  it('applies placement + TRL + status atomically on approve, then short-circuits an idempotent re-approve', async () => {
    const technologyId = `tech-${RUN}-assess-fresh`;
    const sourceRunId = `run-${RUN}-fresh`;
    await seedTechnology(technologyId, `Assess Fresh ${RUN}`); // no trl set
    trackPlacementPair(technologyId);

    const key = generateAssessmentKey(technologyId, sourceRunId);
    firestoreCleanup.add(`proposedAssessments/${key}`);

    const created = await assessmentsTriage.createProposedAssessmentIfNotExists(
      assessmentInput(technologyId, sourceRunId)
    );
    expect(created.created).toBe(true);
    expect(created.assessment.id).toBe(key);

    const duplicate = await assessmentsTriage.createProposedAssessmentIfNotExists(
      assessmentInput(technologyId, sourceRunId)
    );
    expect(duplicate).toMatchObject({ created: false, reason: 'already_pending' });

    const approved = await assessmentsTriage.approveProposedAssessment(key, radarOwnerId, {
      radarId,
      quadrantId,
    });
    expect(approved.status).toBe('approved');
    expect(approved.appliedPlacementId).toBeDefined();

    const placements = await placementsFor(technologyId);
    expect(placements.size).toBe(1);
    firestoreCleanup.add(`radarPlacements/${placements.docs[0].id}`);
    expect(placements.docs[0].data()).toMatchObject({
      technologyId,
      radarId,
      quadrantId,
      ring: 'Trial',
      trlScore: 6,
      status: 'New',
    });

    // BUILD-011: canonical TRL was unset → set in the same transaction as the
    // status flip.
    const techAfterApprove = (await adminDb.doc(`technologies/${technologyId}`).get()).data();
    expect(techAfterApprove?.trl).toBe(6);

    const persistedBefore = (await adminDb.doc(`proposedAssessments/${key}`).get()).data() as ProposedAssessment;
    expect(persistedBefore).toMatchObject({
      status: 'approved',
      appliedPlacementId: placements.docs[0].id,
      radarId,
      quadrantId,
    });

    // Fully-applied approvals short-circuit: no second placement, no
    // bookkeeping churn.
    const reApproved = await assessmentsTriage.approveProposedAssessment(key, `second-reviewer-${RUN}`, {
      radarId,
      quadrantId,
    });
    expect(reApproved.appliedPlacementId).toBe(placements.docs[0].id);

    const persistedAfter = (await adminDb.doc(`proposedAssessments/${key}`).get()).data() as ProposedAssessment;
    expect(persistedAfter.appliedAt).toBe(persistedBefore.appliedAt);
    expect(persistedAfter.reviewedBy).toBe(`reviewer-${RUN}`);
    expect((await placementsFor(technologyId)).size).toBe(1);
  });

  it('re-approving an approved-without-placement assessment lands the placement but keeps canonical TRL (BUILD-005)', async () => {
    const technologyId = `tech-${RUN}-assess-retry`;
    const sourceRunId = `run-${RUN}-retry`;
    await seedTechnology(technologyId, `Assess Retry ${RUN}`, { trl: 3 }); // canonical TRL already set
    trackPlacementPair(technologyId);

    const key = generateAssessmentKey(technologyId, sourceRunId);
    firestoreCleanup.add(`proposedAssessments/${key}`);

    // BUILD-005 recovery state: approved, but the placement never landed —
    // no appliedPlacementId on the doc.
    const now = Date.now();
    const staged = proposedAssessmentSchema.parse({
      id: key,
      technologyId,
      technologyName: `Assess Retry ${RUN}`,
      recommendation: 'assess',
      trl: 7,
      confidence: 70,
      evidence: { metrics: [], findings: [] },
      proposedRing: 'Assess',
      sourceRunId,
      status: 'approved',
      createdAt: now,
      updatedAt: now,
      reviewedBy: `initial-reviewer-${RUN}`,
      reviewedAt: now,
      appliedBy: `initial-reviewer-${RUN}`,
      appliedAt: now,
    });
    await adminDb.doc(`proposedAssessments/${key}`).set(staged);

    const retried = await assessmentsTriage.approveProposedAssessment(key, radarOwnerId, {
      radarId,
      quadrantId,
    });
    expect(retried.status).toBe('approved');
    expect(retried.appliedPlacementId).toBeDefined();

    const placements = await placementsFor(technologyId);
    expect(placements.size).toBe(1);
    firestoreCleanup.add(`radarPlacements/${placements.docs[0].id}`);
    expect(placements.docs[0].data()).toMatchObject({ ring: 'Assess', trlScore: 7 });

    // Canonical TRL is only set when unset: the pre-existing value survives;
    // the evaluation's TRL lives on the placement only.
    const tech = (await adminDb.doc(`technologies/${technologyId}`).get()).data();
    expect(tech?.trl).toBe(3);

    const persisted = (await adminDb.doc(`proposedAssessments/${key}`).get()).data() as ProposedAssessment;
    expect(persisted).toMatchObject({
      status: 'approved',
      appliedPlacementId: placements.docs[0].id,
      appliedBy: radarOwnerId,
    });
  });

  it('refuses a foreign reviewer before placement, proposal, or canonical TRL mutation', async () => {
    const technologyId = `tech-${RUN}-assess-foreign`;
    const sourceRunId = `run-${RUN}-foreign`;
    await seedTechnology(technologyId, `Assess Foreign ${RUN}`);
    trackPlacementPair(technologyId);

    const key = generateAssessmentKey(technologyId, sourceRunId);
    firestoreCleanup.add(`proposedAssessments/${key}`);
    await assessmentsTriage.createProposedAssessmentIfNotExists(
      assessmentInput(technologyId, sourceRunId)
    );

    await expect(
      assessmentsTriage.approveProposedAssessment(key, `foreign-reviewer-${RUN}`, {
        radarId,
        quadrantId,
      })
    ).rejects.toThrow('Not authorized to mutate radar');

    const persisted = (await adminDb.doc(`proposedAssessments/${key}`).get()).data() as ProposedAssessment;
    expect(persisted.status).toBe('pending');
    expect(persisted.appliedPlacementId).toBeUndefined();
    expect((await adminDb.doc(`technologies/${technologyId}`).get()).data()?.trl).toBeUndefined();
    expect((await placementsFor(technologyId)).size).toBe(0);
    expect(
      (
        await adminDb
          .doc(
            `${RADAR_PLACEMENT_PAIR_LOCK_COLLECTION}/${buildRadarPlacementPairKey(radarId, technologyId)}`
          )
          .get()
      ).exists
    ).toBe(false);
  });
});
