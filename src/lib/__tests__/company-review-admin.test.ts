/**
 * @jest-environment node
 *
 * AI-043 — the server-only review ledger repository. Atomic record (Company read
 * + projection re-derivation inside the write transaction), idempotent replay,
 * conflict refusal, stale-draft refusal, and owner isolation, over an in-memory
 * Admin-SDK fake (no emulator).
 */

jest.mock('@/lib/firebase-admin', () => {
  type Doc = Record<string, unknown>;
  const store = new Map<string, Map<string, Doc>>();
  const collectionMap = (name: string): Map<string, Doc> => {
    let map = store.get(name);
    if (!map) {
      map = new Map();
      store.set(name, map);
    }
    return map;
  };

  class FakeDocRef {
    constructor(
      private readonly col: Map<string, Doc>,
      public readonly id: string
    ) {}
    async get() {
      const value = this.col.get(this.id);
      return { exists: value !== undefined, id: this.id, data: () => value };
    }
    setSync(value: Doc) {
      this.col.set(this.id, value);
    }
    updateSync(value: Doc) {
      this.col.set(this.id, { ...(this.col.get(this.id) ?? {}), ...value });
    }
  }

  class FakeQuery {
    constructor(
      private readonly col: Map<string, Doc>,
      private readonly filters: Array<[string, unknown]>
    ) {}
    where(field: string, _op: '==', value: unknown) {
      return new FakeQuery(this.col, [...this.filters, [field, value]]);
    }
    async get() {
      const docs = [];
      for (const [id, value] of this.col) {
        if (this.filters.every(([field, expected]) => value[field] === expected)) {
          docs.push({ exists: true, id, data: () => value });
        }
      }
      return { docs };
    }
  }

  class FakeCollection {
    constructor(private readonly col: Map<string, Doc>) {}
    doc(id: string) {
      return new FakeDocRef(this.col, id);
    }
    where(field: string, op: '==', value: unknown) {
      return new FakeQuery(this.col, []).where(field, op, value);
    }
  }

  class FakeTx {
    async get(refOrQuery: FakeDocRef | FakeQuery) {
      return refOrQuery.get();
    }
    set(ref: FakeDocRef, value: Doc) {
      ref.setSync(value);
    }
    update(ref: FakeDocRef, value: Doc) {
      ref.updateSync(value);
    }
  }

  const db = {
    collection: (name: string) => new FakeCollection(collectionMap(name)),
    runTransaction: async <T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> => fn(new FakeTx()),
  };

  return {
    __esModule: true,
    db,
    __resetDb: () => store.clear(),
    __count: (name: string) => store.get(name)?.size ?? 0,
    __seed: (name: string, id: string, value: Doc) => collectionMap(name).set(id, value),
    __read: (name: string, id: string) => store.get(name)?.get(id),
  };
});

const mockGraphSync = jest.fn().mockResolvedValue({ acknowledged: true, anchorRecorded: false });
jest.mock('@/lib/entity-sync-server', () => ({
  __esModule: true,
  triggerEntityGraphSyncBestEffortServer: (...args: unknown[]) => mockGraphSync(...args),
}));

import {
  recordCompanyReviewDecision,
  listCompanyReviewEvents,
  getCompanyReviewEvent,
  promoteApprovedCompanyReviewClaims,
  CompanyReviewConflictError,
  CompanyReviewStaleDraftError,
  CompanyReviewCompanyNotFoundError,
  CompanyReviewNotReadyError,
  CompanyReviewNotPromotableError,
  COMPANY_REVIEW_EVENTS_COLLECTION,
} from '../company-review-admin';
import { buildCompanyReviewProjection } from '@/lib/company-review';
import type { CompanyReviewDecisionInput } from '@/lib/schemas/company-review';
import type { Company } from '@/lib/types';

const fakeAdmin = jest.requireMock('@/lib/firebase-admin') as {
  __resetDb: () => void;
  __count: (name: string) => number;
  __seed: (name: string, id: string, value: Record<string, unknown>) => void;
  __read: (name: string, id: string) => Record<string, unknown> | undefined;
};

/** Read the stored Company document from the fake Firestore. */
function readCompany(): Record<string, unknown> {
  return (fakeAdmin.__read('companies', 'c1') ?? {}) as Record<string, unknown>;
}

const ALICE = { ownerId: 'alice', reviewerId: 'alice' };
const BOB = { ownerId: 'bob', reviewerId: 'bob' };

function company(overrides: Record<string, unknown> = {}): Company {
  return {
    id: 'c1',
    aiResearch: {
      lastResearched: 1_700_000_000,
      data: {
        citationsVerified: false,
        sourcingComplete: true,
        version: 7,
        receipts: {
          size: [{ url: 'https://reuters.com/a', title: 'A', publisher: 'Reuters' }],
          website: [{ url: 'https://acme.example' }],
        },
        claimValues: { size: 'medium', website: 'https://acme.example' },
        ...overrides,
      },
    },
  } as unknown as Company;
}

const projection = buildCompanyReviewProjection(company());
const sizeArea = projection.areas.find((a) => a.key === 'size')!;
const websiteArea = projection.areas.find((a) => a.key === 'website')!;

function input(overrides: Partial<CompanyReviewDecisionInput> = {}): CompanyReviewDecisionInput {
  return {
    companyId: 'c1',
    artifactKind: 'structured',
    artifactVersion: projection.artifactVersion,
    area: 'size',
    areaDigest: sizeArea.areaDigest,
    draftDigest: projection.draftDigest,
    sourceIds: sizeArea.sourceIds,
    decision: 'approved',
    idempotencyKey: 'key-00000001',
    ...overrides,
  };
}

/** A decision bound to the website area (the other reviewable area). */
function websiteInput(overrides: Partial<CompanyReviewDecisionInput> = {}): CompanyReviewDecisionInput {
  return input({
    area: 'website',
    areaDigest: websiteArea.areaDigest,
    sourceIds: websiteArea.sourceIds,
    idempotencyKey: 'key-website-001',
    ...overrides,
  });
}

/** Approve BOTH reviewable areas so the draft reaches overall readiness. */
async function approveWholeDraft(actor = ALICE): Promise<void> {
  await recordCompanyReviewDecision(input({ idempotencyKey: 'key-size-approve' }), actor);
  await recordCompanyReviewDecision(websiteInput({ idempotencyKey: 'key-website-approve' }), actor);
}

let clock = 1_700_000_000_000;
beforeEach(() => {
  fakeAdmin.__resetDb();
  fakeAdmin.__seed('companies', 'c1', company() as unknown as Record<string, unknown>);
  mockGraphSync.mockClear();
  clock = 1_700_000_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => (clock += 1));
});
afterEach(() => jest.restoreAllMocks());

describe('recordCompanyReviewDecision', () => {
  it('records with server-resolved owner, reviewer, timestamp and artifact binding', async () => {
    const { event, outcome } = await recordCompanyReviewDecision(input(), ALICE);
    expect(outcome).toBe('recorded');
    expect(event.ownerId).toBe('alice');
    expect(event.reviewerId).toBe('alice');
    expect(event.artifactKind).toBe('structured');
    expect(event.artifactVersion).toBe(projection.artifactVersion);
    expect(fakeAdmin.__count(COMPANY_REVIEW_EVENTS_COLLECTION)).toBe(1);
  });

  it('is idempotent for an exact replay', async () => {
    const first = await recordCompanyReviewDecision(input(), ALICE);
    const replay = await recordCompanyReviewDecision(input(), ALICE);
    expect(replay.outcome).toBe('replayed');
    expect(replay.event.createdAt).toBe(first.event.createdAt);
    expect(fakeAdmin.__count(COMPANY_REVIEW_EVENTS_COLLECTION)).toBe(1);
  });

  it('refuses a conflicting replay and preserves the original', async () => {
    const first = await recordCompanyReviewDecision(input({ decision: 'approved' }), ALICE);
    await expect(recordCompanyReviewDecision(input({ decision: 'rejected' }), ALICE)).rejects.toBeInstanceOf(
      CompanyReviewConflictError
    );
    expect((await getCompanyReviewEvent(first.event.id, 'alice'))?.decision).toBe('approved');
  });

  it('refuses a decision whose area digest does not match the current draft', async () => {
    await expect(recordCompanyReviewDecision(input({ areaDigest: 'v2-staleaaaa' }), ALICE)).rejects.toBeInstanceOf(
      CompanyReviewStaleDraftError
    );
    expect(fakeAdmin.__count(COMPANY_REVIEW_EVENTS_COLLECTION)).toBe(0);
  });

  it('refuses atomically when the company draft was refreshed between load and write', async () => {
    // The reviewer's input is bound to the CURRENT draft; a research refresh then
    // replaces the company with a new version before the write lands.
    const refreshed = company({ claimValues: { size: 'enterprise', website: 'https://acme.example' }, version: 8 });
    fakeAdmin.__seed('companies', 'c1', refreshed as unknown as Record<string, unknown>);

    await expect(recordCompanyReviewDecision(input(), ALICE)).rejects.toBeInstanceOf(CompanyReviewStaleDraftError);
    expect(fakeAdmin.__count(COMPANY_REVIEW_EVENTS_COLLECTION)).toBe(0);
  });

  it('replays an ALREADY-recorded decision even after a later draft refresh (idempotency before staleness)', async () => {
    // Record vs version 7, then a research refresh moves the draft to version 8.
    const first = await recordCompanyReviewDecision(input(), ALICE);
    fakeAdmin.__seed(
      'companies',
      'c1',
      company({
        claimValues: { size: 'enterprise', website: 'https://acme.example' },
        version: 8,
      }) as unknown as Record<string, unknown>
    );
    // A retry of the SAME committed decision (same idempotencyKey + original facts)
    // must REPLAY the durable event, not be wrongly refused as stale.
    const replay = await recordCompanyReviewDecision(input(), ALICE);
    expect(replay.outcome).toBe('replayed');
    expect(replay.event.id).toBe(first.event.id);
    expect(fakeAdmin.__count(COMPANY_REVIEW_EVENTS_COLLECTION)).toBe(1);
  });

  it('an identical retry reaches the durable idempotency record even if the company is GONE', async () => {
    // Contract 3: after an ambiguous-but-committed response, an identical retry must
    // reach the durable idempotency record — the idempotency check precedes (and does
    // not depend on) the company/draft, so a company deleted post-commit still replays.
    const first = await recordCompanyReviewDecision(input(), ALICE);
    fakeAdmin.__resetDb(); // the company (and everything else) is gone; the event lives in a fresh store...
    fakeAdmin.__seed(
      COMPANY_REVIEW_EVENTS_COLLECTION,
      first.event.id,
      first.event as unknown as Record<string, unknown>
    );

    const replay = await recordCompanyReviewDecision(input(), ALICE);
    expect(replay.outcome).toBe('replayed');
    expect(replay.event.id).toBe(first.event.id);
    // Reached the durable record without a NotFound / stale rejection and wrote nothing new.
    expect(fakeAdmin.__count(COMPANY_REVIEW_EVENTS_COLLECTION)).toBe(1);
  });

  it('throws when the company does not exist', async () => {
    fakeAdmin.__resetDb();
    await expect(recordCompanyReviewDecision(input(), ALICE)).rejects.toBeInstanceOf(CompanyReviewCompanyNotFoundError);
  });

  it('does not collide two owners using the same idempotencyKey', async () => {
    await recordCompanyReviewDecision(input(), ALICE);
    const bob = await recordCompanyReviewDecision(input(), BOB);
    expect(bob.outcome).toBe('recorded');
    expect(fakeAdmin.__count(COMPANY_REVIEW_EVENTS_COLLECTION)).toBe(2);
  });

  it('normalizes and stores a note, omitting an empty one', async () => {
    const withNote = await recordCompanyReviewDecision(
      input({ note: '  looks off  ', idempotencyKey: 'key-note-1' }),
      ALICE
    );
    expect(withNote.event.note).toBe('looks off');
    const noNote = await recordCompanyReviewDecision(input({ note: '   ', idempotencyKey: 'key-note-2' }), ALICE);
    expect('note' in noNote.event).toBe(false);
  });
});

describe('owner-scoped reads', () => {
  it('lists only the calling owner’s events, oldest first', async () => {
    await recordCompanyReviewDecision(input({ area: 'size', idempotencyKey: 'key-a-1' }), ALICE);
    await recordCompanyReviewDecision(
      input({
        area: 'website',
        idempotencyKey: 'key-a-2',
        areaDigest: projection.areas.find((a) => a.key === 'website')!.areaDigest,
        sourceIds: projection.areas.find((a) => a.key === 'website')!.sourceIds,
      }),
      ALICE
    );
    await recordCompanyReviewDecision(input({ area: 'size', idempotencyKey: 'key-b-1' }), BOB);

    const aliceEvents = await listCompanyReviewEvents('c1', 'alice');
    expect(aliceEvents.map((e) => e.area)).toEqual(['size', 'website']);
    expect(aliceEvents.every((e) => e.ownerId === 'alice')).toBe(true);
    expect(await listCompanyReviewEvents('c1', 'bob')).toHaveLength(1);
  });

  it('returns null identically for a foreign-owned and an absent event', async () => {
    const alice = await recordCompanyReviewDecision(input(), ALICE);
    expect(await getCompanyReviewEvent(alice.event.id, 'bob')).toBeNull();
    expect(await getCompanyReviewEvent('rev-does-not-exist', 'bob')).toBeNull();
    expect(await getCompanyReviewEvent(alice.event.id, 'alice')).not.toBeNull();
  });
});

describe('promoteApprovedCompanyReviewClaims (atomic, ready-only)', () => {
  it('promotes the fully-approved current draft once (atomic write)', async () => {
    await approveWholeDraft(ALICE);
    const res = await promoteApprovedCompanyReviewClaims('c1', 'alice');
    expect(res.promoted).toEqual(['size', 'website']);
    expect(res.graphSync).toBe('delivered');
    // The canonical Company document was updated inside the transaction.
    const companyAfter = readCompany();
    expect(companyAfter.size).toBe('medium');
    expect(companyAfter.website).toBe('https://acme.example');
    expect(mockGraphSync).toHaveBeenCalledWith('company', 'c1', 'update');
  });

  // Contract 4: graph status distinguishes delivered / deferred / suppressed / failed.
  it('reports the graph handoff truthfully across every distinct outcome', async () => {
    // deferred — not delivered, but a durable recovery anchor was written.
    mockGraphSync.mockResolvedValueOnce({ acknowledged: false, anchorRecorded: true });
    await approveWholeDraft(ALICE);
    expect((await promoteApprovedCompanyReviewClaims('c1', 'alice')).graphSync).toBe('deferred');
    expect(readCompany().size).toBe('medium'); // committed regardless

    // failed — not delivered AND no durable anchor (unanchored, surfaced not swallowed).
    mockGraphSync.mockResolvedValueOnce({ acknowledged: false, anchorRecorded: false });
    expect((await promoteApprovedCompanyReviewClaims('c1', 'alice')).graphSync).toBe('failed');

    // suppressed — operator policy switched sync off; not attempted, not a debt.
    process.env.GRAPH_SYNC_ENABLED = 'false';
    try {
      mockGraphSync.mockClear();
      expect((await promoteApprovedCompanyReviewClaims('c1', 'alice')).graphSync).toBe('suppressed');
      expect(mockGraphSync).not.toHaveBeenCalled(); // never attempted when suppressed
    } finally {
      delete process.env.GRAPH_SYNC_ENABLED;
    }
  });

  it('refuses to promote a narrative draft (reviewed for trust, not promoted)', async () => {
    // A narrative draft: the review tab shows company.research, projection is
    // narrative, its single `narrative` area is approvable but not promotable.
    const narrativeCompany = {
      id: 'c1',
      research: {
        lastResearched: 1,
        version: 2,
        executiveSummary: { overview: 'Acme does X', keyHighlights: ['a'] },
        metadata: { sources: ['https://news.example/acme'], confidenceScore: 80, model: 'm' },
      },
    } as unknown as Company;
    fakeAdmin.__seed('companies', 'c1', narrativeCompany as unknown as Record<string, unknown>);

    const np = buildCompanyReviewProjection(narrativeCompany);
    const area = np.areas.find((a) => a.key === 'narrative')!;
    await recordCompanyReviewDecision(
      {
        companyId: 'c1',
        artifactKind: 'narrative',
        artifactVersion: np.artifactVersion,
        area: 'narrative',
        areaDigest: area.areaDigest,
        draftDigest: np.draftDigest,
        sourceIds: area.sourceIds,
        decision: 'approved',
        idempotencyKey: 'key-narrative-ok',
      },
      ALICE
    );

    await expect(promoteApprovedCompanyReviewClaims('c1', 'alice')).rejects.toBeInstanceOf(
      CompanyReviewNotPromotableError
    );
    expect(mockGraphSync).not.toHaveBeenCalled();
  });

  it('refuses (writes nothing) when the draft is only partially reviewed', async () => {
    await recordCompanyReviewDecision(input({ idempotencyKey: 'key-size-only' }), ALICE);
    await expect(promoteApprovedCompanyReviewClaims('c1', 'alice')).rejects.toBeInstanceOf(CompanyReviewNotReadyError);
    expect(readCompany().size).toBeUndefined();
    expect(mockGraphSync).not.toHaveBeenCalled();
  });

  it('refuses when any area is rejected or needs changes', async () => {
    await recordCompanyReviewDecision(input({ idempotencyKey: 'key-size-ok' }), ALICE);
    await recordCompanyReviewDecision(websiteInput({ decision: 'rejected', idempotencyKey: 'key-web-rej' }), ALICE);
    await expect(promoteApprovedCompanyReviewClaims('c1', 'alice')).rejects.toBeInstanceOf(CompanyReviewNotReadyError);
  });

  it('refuses when a hard blocker is present even with all claims approved', async () => {
    // Re-seed the company with a missing-evidence gap → never ready.
    fakeAdmin.__seed(
      'companies',
      'c1',
      company({ missingEvidence: ['pricing'], sourcingComplete: false }) as unknown as Record<string, unknown>
    );
    // Approve against THIS draft's digests.
    const blocked = buildCompanyReviewProjection(company({ missingEvidence: ['pricing'], sourcingComplete: false }));
    const s = blocked.areas.find((a) => a.key === 'size')!;
    const w = blocked.areas.find((a) => a.key === 'website')!;
    await recordCompanyReviewDecision(
      {
        ...input(),
        areaDigest: s.areaDigest,
        draftDigest: blocked.draftDigest,
        sourceIds: s.sourceIds,
        idempotencyKey: 'kb-s',
      },
      ALICE
    );
    await recordCompanyReviewDecision(
      {
        ...websiteInput(),
        areaDigest: w.areaDigest,
        draftDigest: blocked.draftDigest,
        sourceIds: w.sourceIds,
        idempotencyKey: 'kb-w',
      },
      ALICE
    );
    await expect(promoteApprovedCompanyReviewClaims('c1', 'alice')).rejects.toBeInstanceOf(CompanyReviewNotReadyError);
  });

  it('refuses atomically when the company draft was refreshed between approval and promotion', async () => {
    await approveWholeDraft(ALICE); // approvals bound to version 7
    // A research refresh replaces the company with a new version before promotion.
    fakeAdmin.__seed(
      'companies',
      'c1',
      company({
        claimValues: { size: 'enterprise', website: 'https://acme.example' },
        version: 8,
      }) as unknown as Record<string, unknown>
    );
    await expect(promoteApprovedCompanyReviewClaims('c1', 'alice')).rejects.toBeInstanceOf(CompanyReviewNotReadyError);
    expect(readCompany().size).toBeUndefined();
  });

  it('is idempotent: re-promoting a ready draft re-writes the same values', async () => {
    await approveWholeDraft(ALICE);
    const first = await promoteApprovedCompanyReviewClaims('c1', 'alice');
    const second = await promoteApprovedCompanyReviewClaims('c1', 'alice');
    expect(second.promoted).toEqual(first.promoted);
    expect(readCompany().size).toBe('medium');
  });

  it('is owner-scoped: Bob cannot promote via Alice’s approval', async () => {
    await approveWholeDraft(ALICE);
    await expect(promoteApprovedCompanyReviewClaims('c1', 'bob')).rejects.toBeInstanceOf(CompanyReviewNotReadyError);
    expect(readCompany().size).toBeUndefined();
  });

  it('throws when the company is absent', async () => {
    fakeAdmin.__resetDb();
    await expect(promoteApprovedCompanyReviewClaims('c1', 'alice')).rejects.toBeInstanceOf(
      CompanyReviewCompanyNotFoundError
    );
  });
});
