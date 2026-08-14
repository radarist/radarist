/**
 * AI-046 — one human message naming several exact proposal IDs must durably
 * approve ALL of them, against a REAL Firestore emulator.
 *
 * Reproduces the retained 2026-07-27 transcript shape: four pending
 * pain-point -> document proposals, and the operator's literal turn
 * `Approve proposals <a>, <b>, <c>, and <d>`. Before AI-046 the decision grammar
 * bound the verb only to an optional SINGULAR noun plus ONE adjacent ID, so that
 * message approved NOTHING and the relations could never be materialized.
 *
 * The safety half matters as much as the fix: a malformed list, a machine
 * principal, a same-turn self-approval, and an ID sitting outside the approval
 * clause must all still approve nothing and leave every proposal pending.
 *
 * Runs via `npm run test:emulator`, or standalone through
 * `firebase emulators:exec --only firestore,auth`.
 *
 * @jest-environment node
 */

import { db as adminDb } from '@/lib/firebase-admin';
import { createProposedRelationIfNotExists, getProposedRelationById } from '@/lib/proposed-relations-admin';
import { executeApproveProposedRelation } from '@/lib/ai/tools/linker-tools';
import type { CreateProposedRelationInput } from '@/lib/types';

const OWNER = 'alice-multi-emu';

/** Four distinct pain-point -> document candidates, as the Assistant staged them. */
const CANDIDATES = [
  { pain: 'pp-climate-volatility', label: 'Climate-Driven Raw Material Volatility' },
  { pain: 'pp-scope3-decarb', label: 'Scope 3 Agricultural Decarbonization Execution' },
  { pain: 'pp-cost-performance', label: 'The Cost vs Performance Dilemma' },
  { pain: 'pp-supplier-engagement', label: 'Supplier Engagement and Smallholder Alignment' },
] as const;

const DOCUMENT_ID = 'doc-2026-sustainability-painpoints';

function proposalInput(pain: string, label: string): CreateProposedRelationInput {
  return {
    sourceType: 'painPoint',
    sourceId: pain,
    sourceSnapshot: { type: 'painPoint', id: pain, name: label, snapshotAt: Date.now() },
    targetType: 'document',
    targetId: DOCUMENT_ID,
    targetSnapshot: {
      type: 'document',
      id: DOCUMENT_ID,
      name: '2026 sustainability in manufacturing pain points',
      snapshotAt: Date.now(),
    },
    relationType: 'documented_in',
    confidence: 82,
    reasoning: 'The deep-research document evidences this pain point.',
    evidence: [
      {
        sourceType: 'document',
        sourceId: DOCUMENT_ID,
        location: { chunkId: `${pain}-chunk-1` },
        snippet: `Evidence for ${label}.`,
        snippetHash: `hash-${pain}`,
      },
    ],
    discoveredBy: 'ai-assistant',
    runId: 'chat:staging-turn',
    promptVersion: 'v1',
  } as unknown as CreateProposedRelationInput;
}

/**
 * Approval re-resolves BOTH endpoints from Firestore, so the real entities must
 * exist — a missing endpoint throws before any write (the pre-write failure mode
 * AI-047 tracks separately).
 */
async function seedEntities(): Promise<void> {
  await adminDb.collection('documents').doc(DOCUMENT_ID).set({
    id: DOCUMENT_ID,
    title: '2026 sustainability in manufacturing pain points',
    description: 'Deep research document.',
    status: 'processed',
    createdAt: 1,
    updatedAt: 1,
  });
  await Promise.all(
    CANDIDATES.map((candidate) =>
      adminDb
        .collection('painPoints')
        .doc(candidate.pain)
        .set({
          id: candidate.pain,
          title: candidate.label,
          description: `${candidate.label} description.`,
          status: 'Validated',
          createdAt: 1,
          updatedAt: 1,
        })
    )
  );
}

/** Recreate the four pending proposals so each test starts from the same state. */
async function seedProposals(): Promise<string[]> {
  await seedEntities();
  const ids: string[] = [];
  for (const candidate of CANDIDATES) {
    const { proposal } = await createProposedRelationIfNotExists(proposalInput(candidate.pain, candidate.label));
    ids.push(proposal.id);
  }
  return ids;
}

async function clearProposals(): Promise<void> {
  const snap = await adminDb.collection('proposedRelations').get();
  await Promise.all(snap.docs.map((doc) => doc.ref.delete()));
  const relations = await adminDb.collection('relations').where('targetSnapshot.id', '==', DOCUMENT_ID).get();
  await Promise.all(relations.docs.map((doc) => doc.ref.delete()));
  await adminDb
    .collection('documents')
    .doc(DOCUMENT_ID)
    .delete()
    .catch(() => undefined);
  await Promise.all(
    CANDIDATES.map((candidate) =>
      adminDb
        .collection('painPoints')
        .doc(candidate.pain)
        .delete()
        .catch(() => undefined)
    )
  );
}

/** Drive the real Assistant approve executor once per ID with ONE shared message. */
async function approveAll(ids: string[], confirmationText: string, principal: 'human' | 'machine' = 'human') {
  const results = [];
  for (const id of ids) {
    results.push(
      await executeApproveProposedRelation(
        { proposalId: id },
        { principal, confirmationText, userId: OWNER, requestId: 'approval-turn' }
      )
    );
  }
  return results;
}

async function statuses(ids: string[]): Promise<string[]> {
  const rows = await Promise.all(ids.map((id) => getProposedRelationById(id)));
  return rows.map((row) => row?.status ?? 'missing');
}

beforeEach(async () => {
  await clearProposals();
});

afterAll(async () => {
  await clearProposals();
  await adminDb.terminate();
});

/** Every relation persisted for the shared target document, keyed by source. */
async function persistedRelations(): Promise<Array<{ sourceId: string; relationType: string }>> {
  const snap = await adminDb.collection('relations').where('targetSnapshot.id', '==', DOCUMENT_ID).get();
  return snap.docs
    .map((doc) => doc.data() as { sourceSnapshot: { id: string }; relationType: string })
    .map((r) => ({ sourceId: r.sourceSnapshot.id, relationType: r.relationType }))
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}

describe('AI-046 — multi-ID Assistant approval (live Firestore)', () => {
  /**
   * The change under test is PURELY authorization. This asserts outcome PARITY
   * against the single-ID form that was already accepted before AI-046: one
   * multi-ID turn must act on every listed ID exactly as four separate single-ID
   * turns would. Parity isolates the grammar from the environment — the durable
   * write reached afterwards (and the GRAPH-056 sync-acknowledgement contract
   * that follows it) is identical for both forms and is not what this fixes.
   */
  it('acts on every listed ID exactly as four separate single-ID turns would', async () => {
    const ids = await seedProposals();
    const batched = await approveAll(ids, `Approve proposals ${ids[0]}, ${ids[1]}, ${ids[2]}, and ${ids[3]}`);
    const batchedOutcome = batched.map((r) => (r.success ? 'ok' : (r.error ?? '').replace(/rel-[\w-]+/g, '<rel>')));
    const batchedRelations = await persistedRelations();

    await clearProposals();
    const singleIds = await seedProposals();
    const single = [];
    for (const id of singleIds) {
      single.push(...(await approveAll([id], `approve proposal ${id}`)));
    }
    const singleOutcome = single.map((r) => (r.success ? 'ok' : (r.error ?? '').replace(/rel-[\w-]+/g, '<rel>')));

    // Identical per-ID outcome, and the same four durable relations.
    expect(batchedOutcome).toEqual(singleOutcome);
    expect(batchedRelations).toEqual(await persistedRelations());
    expect(batchedRelations.map((r) => r.sourceId)).toEqual(CANDIDATES.map((c) => c.pain).sort());
    expect(batchedRelations.every((r) => r.relationType === 'documented_in')).toBe(true);
  });

  it('reaches the durable write for all four listed IDs, not just the first', async () => {
    const ids = await seedProposals();

    await approveAll(ids, `Approve proposals ${ids[0]}, ${ids[1]}, ${ids[2]}, and ${ids[3]}`);

    // Before AI-046 this message authorized NOTHING, so no relation existed. The
    // fix is proven by all four pain points reaching a persisted relation.
    expect((await persistedRelations()).map((r) => r.sourceId)).toEqual(CANDIDATES.map((c) => c.pain).sort());
  });

  it('does not duplicate relations when the same authorized turn is replayed', async () => {
    const ids = await seedProposals();
    const message = `Approve proposals ${ids[0]}, ${ids[1]}, ${ids[2]}, and ${ids[3]}`;

    await approveAll(ids, message);
    const afterFirst = await persistedRelations();
    await approveAll(ids, message);

    expect(await persistedRelations()).toEqual(afterFirst);
    expect(afterFirst).toHaveLength(4);
  });

  it.each([
    [
      'a malformed list (trailing negation)',
      (ids: string[]) => `Approve proposals ${ids[0]} and ${ids[1]}, but not ${ids[2]}`,
    ],
    ['an exclusion clause', (ids: string[]) => `Approve proposals ${ids[0]} and ${ids[1]} except ${ids[2]}`],
    ['a read clause', (ids: string[]) => `Approve proposals ${ids[0]} and ${ids[1]} and show ${ids[2]}`],
    ['a negated list', (ids: string[]) => `Do not approve proposals ${ids[0]}, ${ids[1]}, and ${ids[2]}`],
    ['a conditional list', (ids: string[]) => `If you are sure, approve proposals ${ids[0]}, ${ids[1]}`],
    ['a generic request naming no ID', () => 'can you approve the relations we have'],
  ])('approves nothing and leaves every proposal pending for %s', async (_case, build) => {
    const ids = await seedProposals();

    const results = await approveAll(ids, build(ids));

    expect(results.some((r) => r.success)).toBe(false);
    expect(await statuses(ids)).toEqual(['pending', 'pending', 'pending', 'pending']);
    const relations = await adminDb.collection('relations').where('targetSnapshot.id', '==', DOCUMENT_ID).get();
    expect(relations.empty).toBe(true);
  });

  it('refuses a machine principal presenting a well-formed multi-ID list', async () => {
    const ids = await seedProposals();
    const message = `Approve proposals ${ids[0]}, ${ids[1]}, ${ids[2]}, and ${ids[3]}`;

    const results = await approveAll(ids, message, 'machine');

    expect(results.some((r) => r.success)).toBe(false);
    expect(await statuses(ids)).toEqual(['pending', 'pending', 'pending', 'pending']);
  });

  it('refuses same-turn self-approval even when the list grammar is valid', async () => {
    const ids = await seedProposals();
    const message = `Approve proposals ${ids[0]}, ${ids[1]}, ${ids[2]}, and ${ids[3]}`;

    // The proposals were staged by `chat:staging-turn`; approving inside that same
    // turn must fail closed regardless of how the IDs are phrased.
    const results = [];
    for (const id of ids) {
      results.push(
        await executeApproveProposedRelation(
          { proposalId: id },
          { principal: 'human', confirmationText: message, userId: OWNER, requestId: 'staging-turn' }
        )
      );
    }

    expect(results.some((r) => r.success)).toBe(false);
    expect(await statuses(ids)).toEqual(['pending', 'pending', 'pending', 'pending']);
  });
});
