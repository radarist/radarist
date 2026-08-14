/**
 * AI-043 — live Admin-SDK review-ledger contract against a REAL Firestore
 * emulator (no mocks), plus a real-rules client-deny proof. Static regex tests
 * over firestore.rules do not replace this. Proves end-to-end:
 *   - Alice records, reads back, and lists her decisions; Bob is denied (a
 *     foreign-owned event and an absent event are indistinguishable null);
 *   - exact replay is idempotent (same id, original createdAt, no second write);
 *   - a conflicting replay (same identity, different facts) throws;
 *   - a decision bound to a non-current area digest is refused as stale;
 *   - a research refresh BETWEEN the reviewer's load and the write is refused
 *     atomically (the projection is re-derived inside the transaction);
 *   - reload reconstructs identical events and readiness;
 *   - a claim-value change stales a prior approval (kept as history);
 *   - promotion writes only currently-approved claims onto the Company;
 *   - the Firebase Web SDK is DENIED direct read/write to companyReviewEvents by
 *     the real emulator rules.
 *
 * Runs via `npm run test:emulator` (which owns emulator lifecycle) or standalone
 * through `firebase emulators:exec --only firestore,auth`.
 *
 * @jest-environment node
 */

import { db as adminDb } from '@/lib/firebase-admin';
import {
  recordCompanyReviewDecision,
  listCompanyReviewEvents,
  getCompanyReviewEvent,
  promoteApprovedCompanyReviewClaims,
  CompanyReviewConflictError,
  CompanyReviewStaleDraftError,
  CompanyReviewNotReadyError,
  COMPANY_REVIEW_EVENTS_COLLECTION,
} from '@/lib/company-review-admin';
import {
  buildCompanyReviewProjection,
  currentDecisionForArea,
  deriveCompanyReviewReadiness,
  isStaleEvent,
} from '@/lib/company-review';
import type { CompanyReviewDecisionInput } from '@/lib/schemas/company-review';
import type { Company } from '@/lib/types';

const COMPANY_ID = 'rev-emu-co';
const ALICE = { ownerId: 'alice-emu', reviewerId: 'alice-emu' };
const BOB = { ownerId: 'bob-emu', reviewerId: 'bob-emu' };
const recordedIds = new Set<string>();

function companyDoc(overrides: Record<string, unknown> = {}): Company {
  return {
    id: COMPANY_ID,
    name: 'Acme Emulator',
    description: '',
    website: '',
    type: ['sme'],
    industry: [],
    location: { city: '', country: '' },
    status: 'Watching',
    tags: [],
    socialLinks: {},
    technologyStack: [],
    documents: [],
    createdAt: 1,
    updatedAt: 1,
    aiResearch: {
      lastResearched: 1_700_000_000,
      data: {
        citationsVerified: false,
        sourcingComplete: true,
        version: 7,
        receipts: {
          size: [{ url: 'https://reuters.com/acme', title: 'Reuters' }],
          website: [{ url: 'https://acme.example' }],
        },
        claimValues: { size: 'medium', website: 'https://acme.example' },
        ...overrides,
      },
    },
  } as unknown as Company;
}

async function seedCompany(company: Company): Promise<void> {
  await adminDb
    .collection('companies')
    .doc(COMPANY_ID)
    .set(company as unknown as Record<string, unknown>);
}

function projectionOf(company: Company) {
  const projection = buildCompanyReviewProjection(company);
  const size = projection.areas.find((a) => a.key === 'size')!;
  return { projection, size };
}

function input(company: Company, overrides: Partial<CompanyReviewDecisionInput> = {}): CompanyReviewDecisionInput {
  const { projection, size } = projectionOf(company);
  return {
    companyId: COMPANY_ID,
    artifactKind: 'structured',
    artifactVersion: projection.artifactVersion,
    area: 'size',
    areaDigest: size.areaDigest,
    draftDigest: projection.draftDigest,
    sourceIds: size.sourceIds,
    decision: 'approved',
    idempotencyKey: 'key-emulator-0001',
    ...overrides,
  };
}

async function record(actor: typeof ALICE, company: Company, overrides: Partial<CompanyReviewDecisionInput> = {}) {
  const result = await recordCompanyReviewDecision(input(company, overrides), actor);
  recordedIds.add(result.event.id);
  return result;
}

beforeEach(async () => {
  // Isolate tests: clear the ledger for this company (events accumulate otherwise).
  const existing = await adminDb
    .collection(COMPANY_REVIEW_EVENTS_COLLECTION)
    .where('companyId', '==', COMPANY_ID)
    .get();
  await Promise.all(existing.docs.map((docSnap) => docSnap.ref.delete()));
  await seedCompany(companyDoc());
});

afterAll(async () => {
  await Promise.all(
    [...recordedIds].map((id) =>
      adminDb
        .collection(COMPANY_REVIEW_EVENTS_COLLECTION)
        .doc(id)
        .delete()
        .catch(() => undefined)
    )
  );
  await adminDb
    .collection('companies')
    .doc(COMPANY_ID)
    .delete()
    .catch(() => undefined);
  await adminDb.terminate();
});

describe('company review ledger (live emulator)', () => {
  it('records, reads back for the owner, and denies a foreign owner identically to absent', async () => {
    const { event } = await record(ALICE, companyDoc(), { idempotencyKey: 'key-emulator-read' });
    expect((await getCompanyReviewEvent(event.id, 'alice-emu'))?.id).toBe(event.id);
    expect(await getCompanyReviewEvent(event.id, 'bob-emu')).toBeNull();
    expect(await getCompanyReviewEvent('rev-does-not-exist', 'bob-emu')).toBeNull();
  });

  it('is idempotent on exact replay and conflicts on different facts', async () => {
    const first = await record(ALICE, companyDoc(), { idempotencyKey: 'key-emulator-idem' });
    const replay = await record(ALICE, companyDoc(), { idempotencyKey: 'key-emulator-idem' });
    expect(replay.outcome).toBe('replayed');
    expect(replay.event.createdAt).toBe(first.event.createdAt);

    await expect(
      recordCompanyReviewDecision(
        input(companyDoc(), { idempotencyKey: 'key-emulator-idem', decision: 'rejected' }),
        ALICE
      )
    ).rejects.toBeInstanceOf(CompanyReviewConflictError);
    expect((await getCompanyReviewEvent(first.event.id, 'alice-emu'))?.decision).toBe('approved');
  });

  it('refuses a decision bound to a non-current area digest', async () => {
    await expect(
      recordCompanyReviewDecision(
        input(companyDoc(), { areaDigest: 'v2-stale', idempotencyKey: 'key-emulator-stale' }),
        ALICE
      )
    ).rejects.toBeInstanceOf(CompanyReviewStaleDraftError);
  });

  it('refuses atomically when the company draft was refreshed between load and write', async () => {
    // The reviewer's input is bound to the current draft; a refresh replaces the
    // company with a new version before the write lands.
    const stale = input(companyDoc(), { idempotencyKey: 'key-emulator-refresh' });
    await seedCompany(companyDoc({ claimValues: { size: 'enterprise', website: 'https://acme.example' }, version: 8 }));
    await expect(recordCompanyReviewDecision(stale, ALICE)).rejects.toBeInstanceOf(CompanyReviewStaleDraftError);
  });

  it('reload reconstructs identical events and readiness; a value change stales the approval', async () => {
    await record(ALICE, companyDoc(), { area: 'size', idempotencyKey: 'key-emulator-s' });
    const websiteArea = projectionOf(companyDoc()).projection.areas.find((a) => a.key === 'website')!;
    await record(ALICE, companyDoc(), {
      area: 'website',
      areaDigest: websiteArea.areaDigest,
      sourceIds: websiteArea.sourceIds,
      idempotencyKey: 'key-emulator-w',
    });

    const events = await listCompanyReviewEvents(COMPANY_ID, 'alice-emu');
    const current = buildCompanyReviewProjection(companyDoc());
    const readiness = deriveCompanyReviewReadiness(current, events);
    expect(readiness.ready).toBe(true);

    // A new research pass changes `size`'s value → the size approval is stale.
    const refreshed = buildCompanyReviewProjection(
      companyDoc({ claimValues: { size: 'enterprise', website: 'https://acme.example' }, version: 8 })
    );
    const sizeEvent = events.find((e) => e.area === 'size')!;
    expect(isStaleEvent(sizeEvent, refreshed)).toBe(true);
    expect(deriveCompanyReviewReadiness(refreshed, events).ready).toBe(false);
  });

  it('promotes only a fully-approved (ready) draft, atomically; refuses a partial one', async () => {
    const { projection } = projectionOf(companyDoc());
    const website = projection.areas.find((a) => a.key === 'website')!;

    // Partial: only `size` approved → promotion refuses, Company untouched.
    await record(ALICE, companyDoc(), { area: 'size', idempotencyKey: 'key-emulator-size' });
    await expect(promoteApprovedCompanyReviewClaims(COMPANY_ID, 'alice-emu')).rejects.toBeInstanceOf(
      CompanyReviewNotReadyError
    );
    expect(((await adminDb.collection('companies').doc(COMPANY_ID).get()).data() as Company).size).toBeUndefined();

    // Approve `website` too → the whole draft is ready → promote once.
    await recordCompanyReviewDecision(
      {
        ...input(companyDoc()),
        area: 'website',
        areaDigest: website.areaDigest,
        sourceIds: website.sourceIds,
        idempotencyKey: 'key-emulator-web',
      },
      ALICE
    );
    const result = await promoteApprovedCompanyReviewClaims(COMPANY_ID, 'alice-emu');
    expect(result.promoted).toEqual(['size', 'website']);

    const snap = await adminDb.collection('companies').doc(COMPANY_ID).get();
    expect((snap.data() as Company).size).toBe('medium');
    expect((snap.data() as Company).website).toBe('https://acme.example');
  });

  it('denies the Firebase Web SDK direct read/write to companyReviewEvents', async () => {
    const host = process.env.FIRESTORE_EMULATOR_HOST;
    if (!host) throw new Error('FIRESTORE_EMULATOR_HOST is required for the client-rules deny proof');
    const [hostname, portText] = host.split(':');

    const { initializeApp, deleteApp } = await import('firebase/app');
    const { getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc } = await import('firebase/firestore');

    const app = initializeApp({ projectId: 'demo-radarist' }, `client-deny-${Date.now()}`);
    try {
      const clientDb = getFirestore(app);
      connectFirestoreEmulator(clientDb, hostname, Number(portText));
      const ref = doc(clientDb, COMPANY_REVIEW_EVENTS_COLLECTION, 'any-id');
      // The emulator's rules-denial surfaces as a FirebaseError with
      // code 'permission-denied' (message text varies, e.g. "false for 'get' @ L..").
      await expect(getDoc(ref)).rejects.toMatchObject({ code: 'permission-denied' });
      await expect(setDoc(ref, { hijack: true })).rejects.toMatchObject({ code: 'permission-denied' });
    } finally {
      await deleteApp(app);
    }
  });
});
