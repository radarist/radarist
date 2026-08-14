/**
 * @jest-environment node
 *
 * AI-043 — the Assistant source-review tools. list/prepare are read-only; record
 * requires a human principal and an exact two-turn, request-id-separated
 * confirmation. The pure derivation and the confirmation gate are REAL; the
 * company read and the ledger repository are mocked.
 */

const mockGetCompanyById = jest.fn();
jest.mock('@/lib/companies-admin', () => ({
  __esModule: true,
  adminGetCompanyById: (...args: unknown[]) => mockGetCompanyById(...args),
}));

const mockRecord = jest.fn();
const mockList = jest.fn();
const mockFindRecorded = jest.fn();
jest.mock('@/lib/company-review-admin', () => {
  class CompanyReviewConflictError extends Error {}
  class CompanyReviewStaleDraftError extends Error {}
  class CompanyReviewCompanyNotFoundError extends Error {}
  return {
    __esModule: true,
    CompanyReviewConflictError,
    CompanyReviewStaleDraftError,
    CompanyReviewCompanyNotFoundError,
    recordCompanyReviewDecision: (...args: unknown[]) => mockRecord(...args),
    listCompanyReviewEvents: (...args: unknown[]) => mockList(...args),
    findRecordedReviewDecision: (...args: unknown[]) => mockFindRecorded(...args),
  };
});

import {
  COMPANY_REVIEW_TOOLS,
  executeListCompanyReviewItems,
  executePrepareCompanyReviewDecision,
  executeRecordCompanyReviewDecision,
  type ReviewToolContext,
} from '../company-review-tools';
import { _resetConfirmationStore } from '@/lib/ai/destructive-confirmation';

const COMPANY = {
  id: 'c1',
  name: 'Acme',
  aiResearch: {
    lastResearched: 1,
    data: {
      citationsVerified: false,
      sourcingComplete: true,
      version: 7,
      receipts: { size: [{ url: 'https://reuters.com/a' }], website: [{ url: 'https://acme.example' }] },
      claimValues: { size: 'medium', website: 'https://acme.example' },
    },
  },
};

const human = (over: Partial<ReviewToolContext> = {}): ReviewToolContext => ({
  principal: 'human',
  userId: 'alice',
  requestId: 'req-1',
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  _resetConfirmationStore();
  mockGetCompanyById.mockResolvedValue(COMPANY);
  mockList.mockResolvedValue([]);
  mockFindRecorded.mockResolvedValue(null); // by default nothing was recorded yet
});

describe('listCompanyReviewItems', () => {
  it('requires authentication', async () => {
    const res = await executeListCompanyReviewItems({ companyId: 'c1' }, { principal: 'human' });
    expect(res.success).toBe(false);
  });

  it('returns areas, readiness and blockers without source content', async () => {
    const res = await executeListCompanyReviewItems({ companyId: 'c1' }, human());
    expect(res.success).toBe(true);
    const data = res.data as { areas: { area: string }[]; readiness: { ready: boolean } };
    expect(data.areas.map((a) => a.area)).toEqual(['size', 'website']);
    // No source URLs/receipts are exposed.
    expect(JSON.stringify(res.data)).not.toContain('reuters.com');
  });
});

describe('prepareCompanyReviewDecision', () => {
  it('returns an exact confirmation phrase and the record fields', async () => {
    const res = await executePrepareCompanyReviewDecision(
      { companyId: 'c1', area: 'size', decision: 'approved' },
      human()
    );
    expect(res.success).toBe(true);
    const data = res.data as { confirmationPhrase: string; record: { area: string } };
    expect(data.confirmationPhrase).toMatch(/^CONFIRM REVIEW /);
    expect(data.record.area).toBe('size');
  });

  it('rejects an unreviewable / unknown area', async () => {
    const res = await executePrepareCompanyReviewDecision(
      { companyId: 'c1', area: 'nope', decision: 'approved' },
      human()
    );
    expect(res.success).toBe(false);
  });

  it('fails (emits no phrase) when there is no request/turn boundary to arm against', async () => {
    // Inspecting the arm result: with no requestId the gate fails closed, so prepare
    // must NOT report success or hand back a phrase it never actually armed.
    const res = await executePrepareCompanyReviewDecision(
      { companyId: 'c1', area: 'size', decision: 'approved' },
      { principal: 'human', userId: 'alice' } // no requestId
    );
    expect(res.success).toBe(false);
  });

  it('never redeems: a prepare whose message equals the phrase only re-arms (records nothing)', async () => {
    const prep = await executePrepareCompanyReviewDecision(
      { companyId: 'c1', area: 'size', decision: 'approved' },
      human({ requestId: 'req-1' })
    );
    const { confirmationPhrase } = prep.data as { confirmationPhrase: string };
    // A later-turn prepare carrying the exact phrase as its raw message must NOT
    // consume the pending — preparing only stages, it never records.
    const prep2 = await executePrepareCompanyReviewDecision(
      { companyId: 'c1', area: 'size', decision: 'approved' },
      human({ requestId: 'req-2', confirmationText: confirmationPhrase })
    );
    expect(prep2.success).toBe(true);
    expect(mockRecord).not.toHaveBeenCalled();
    // The re-armed pending is still redeemable on a genuinely later turn.
    mockRecord.mockResolvedValue({
      event: {
        id: 'rev-x',
        companyId: 'c1',
        artifactKind: 'structured',
        artifactVersion: '7',
        area: 'size',
        decision: 'approved',
      },
      outcome: 'recorded',
    });
    const { record } = prep2.data as { record: Record<string, unknown> };
    const rec = await executeRecordCompanyReviewDecision(
      record,
      human({ requestId: 'req-3', confirmationText: confirmationPhrase })
    );
    expect(rec.success).toBe(true);
  });
});

describe('recordCompanyReviewDecision — human confirmation gate', () => {
  async function prepared(ctx: ReviewToolContext) {
    const prep = await executePrepareCompanyReviewDecision(
      { companyId: 'c1', area: 'size', decision: 'approved' },
      ctx
    );
    return prep.data as { confirmationPhrase: string; record: Record<string, unknown> };
  }

  it('refuses a machine principal outright', async () => {
    const { record } = await prepared(human());
    const res = await executeRecordCompanyReviewDecision(record, { principal: 'machine', userId: 'svc' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/human confirmation/i);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('refuses when the user has not sent the exact phrase (first ask)', async () => {
    const { record } = await prepared(human({ requestId: 'req-1' }));
    // A later turn but with generic text, not the phrase.
    const res = await executeRecordCompanyReviewDecision(
      record,
      human({ requestId: 'req-2', confirmationText: 'looks good' })
    );
    expect(res.success).toBe(false);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('refuses a same-turn record (model self-confirmation)', async () => {
    const { record, confirmationPhrase } = await prepared(human({ requestId: 'req-1' }));
    // Same requestId as the prepare that armed it → not a real user turn.
    const res = await executeRecordCompanyReviewDecision(
      record,
      human({ requestId: 'req-1', confirmationText: confirmationPhrase })
    );
    expect(res.success).toBe(false);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('records on the exact phrase on a later turn', async () => {
    mockRecord.mockResolvedValue({
      event: {
        id: 'rev-1',
        companyId: 'c1',
        artifactKind: 'structured',
        artifactVersion: '7',
        area: 'size',
        decision: 'approved',
      },
      outcome: 'recorded',
    });
    const { record, confirmationPhrase } = await prepared(human({ requestId: 'req-1' }));

    const res = await executeRecordCompanyReviewDecision(
      record,
      human({ requestId: 'req-2', confirmationText: confirmationPhrase })
    );

    expect(res.success).toBe(true);
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'c1', area: 'size', decision: 'approved' }),
      { ownerId: 'alice', reviewerId: 'alice' }
    );
    const data = res.data as { eventId: string; outcome: string };
    expect(data.eventId).toBe('rev-1');
    // The receipt carries IDs/status, never source content.
    expect(JSON.stringify(res.data)).not.toContain('reuters.com');
  });

  it('gives each independently-prepared decision a distinct server-staged key (approve → reject → approve)', async () => {
    mockRecord.mockResolvedValue({
      event: {
        id: 'e',
        companyId: 'c1',
        artifactKind: 'structured',
        artifactVersion: '7',
        area: 'size',
        decision: 'approved',
      },
      outcome: 'recorded',
    });

    const prepareThenRecord = async (decision: 'approved' | 'rejected', armTurn: string, redeemTurn: string) => {
      const prep = await executePrepareCompanyReviewDecision(
        { companyId: 'c1', area: 'size', decision },
        human({ requestId: armTurn })
      );
      const { record, confirmationPhrase } = prep.data as {
        record: Record<string, unknown>;
        confirmationPhrase: string;
      };
      mockRecord.mockClear();
      await executeRecordCompanyReviewDecision(
        record,
        human({ requestId: redeemTurn, confirmationText: confirmationPhrase })
      );
      return (mockRecord.mock.calls[0]?.[0] as { idempotencyKey: string }).idempotencyKey;
    };

    const key1 = await prepareThenRecord('approved', 'req-1', 'req-2');
    const key2 = await prepareThenRecord('rejected', 'req-3', 'req-4');
    const key3 = await prepareThenRecord('approved', 'req-5', 'req-6');

    // The third approval, though identical in facts to the first, gets a NEW
    // idempotency key — so it creates a NEW event and remains current, rather than
    // replaying the first approval while the rejection stays latest.
    expect(new Set([key1, key2, key3]).size).toBe(3);
  });

  it('does not honor a confirmation phrase minted for a DIFFERENT decision', async () => {
    // Arm an "approved" decision, then try to record a "rejected" one with that phrase.
    const { confirmationPhrase } = await prepared(human({ requestId: 'req-1' }));
    const rejectPrep = await executePrepareCompanyReviewDecision(
      { companyId: 'c1', area: 'size', decision: 'rejected' },
      human({ requestId: 'req-1' })
    );
    const rejectRecord = (rejectPrep.data as { record: Record<string, unknown> }).record;

    const res = await executeRecordCompanyReviewDecision(
      rejectRecord,
      human({ requestId: 'req-2', confirmationText: confirmationPhrase })
    );
    expect(res.success).toBe(false);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('prepare mints a server-controlled attempt id the caller carries into record', async () => {
    const { record } = await prepared(human({ requestId: 'req-1' }));
    // Server-issued (not model-chosen), url-safe, present in the record payload.
    expect(typeof record.idempotencyKey).toBe('string');
    expect(record.idempotencyKey as string).toMatch(/^att-[a-f0-9]{32}$/);
  });

  // Contract 3, through the PUBLIC tool path: an exact retry after a committed-but-lost
  // response, on a NEW request id, with the process-local confirmation state CLEARED,
  // reaches the durable record via the ORIGINAL attempt id and replays ONE event
  // without reconfirmation.
  it('replays an exact retry (committed-but-lost, new turn, cleared state) WITHOUT reconfirmation', async () => {
    const prep = await executePrepareCompanyReviewDecision(
      { companyId: 'c1', area: 'size', decision: 'approved' },
      human({ requestId: 'req-1' })
    );
    const { record, confirmationPhrase } = prep.data as {
      record: Record<string, unknown>;
      confirmationPhrase: string;
    };
    const attemptId = record.idempotencyKey as string;

    const committedEvent = {
      id: 'rev-committed',
      companyId: 'c1',
      artifactKind: 'structured',
      artifactVersion: '7',
      area: 'size',
      decision: 'approved',
    };

    // First confirmed record: gate runs (nothing recorded yet), repository commits.
    mockRecord.mockResolvedValueOnce({ event: committedEvent, outcome: 'recorded' });
    const first = await executeRecordCompanyReviewDecision(
      record,
      human({ requestId: 'req-2', confirmationText: confirmationPhrase })
    );
    expect(first.success).toBe(true);
    expect((mockRecord.mock.calls[0][0] as { idempotencyKey: string }).idempotencyKey).toBe(attemptId);

    // The response was LOST. Clear the process-local confirmation; the assistant
    // re-issues the IDENTICAL record call on a NEW turn (no valid phrase this time) —
    // but the durable idempotency record for this attempt id now exists.
    _resetConfirmationStore();
    mockRecord.mockReset();
    mockFindRecorded.mockResolvedValueOnce(committedEvent);
    mockRecord.mockResolvedValueOnce({ event: committedEvent, outcome: 'replayed' });

    const retry = await executeRecordCompanyReviewDecision(
      record,
      human({ requestId: 'req-99-new', confirmationText: 'no phrase here' })
    );

    expect(retry.success).toBe(true);
    const data = retry.data as { outcome: string; eventId: string };
    expect(data.outcome).toBe('replayed'); // one event replayed, not re-recorded
    expect(data.eventId).toBe('rev-committed');
    // Reached the repository using the ORIGINAL server-controlled attempt identity,
    // with no fresh confirmation required.
    expect(mockFindRecorded).toHaveBeenCalledWith('alice', attemptId);
    expect((mockRecord.mock.calls[0][0] as { idempotencyKey: string }).idempotencyKey).toBe(attemptId);
  });

  it('a fresh (never-recorded) attempt id STILL requires confirmation — carrying a key never bypasses the gate', async () => {
    const prep = await executePrepareCompanyReviewDecision(
      { companyId: 'c1', area: 'size', decision: 'approved' },
      human({ requestId: 'req-1' })
    );
    const record = (prep.data as { record: Record<string, unknown> }).record;
    // findRecorded => null (default): the gate must run. A machine caller is refused
    // even though it carries a valid attempt id.
    const res = await executeRecordCompanyReviewDecision(record, { principal: 'machine', userId: 'svc' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/human confirmation/i);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

describe('recordCompanyReviewDecision tool declaration', () => {
  const decl = COMPANY_REVIEW_TOOLS.find((t) => t.name === 'recordCompanyReviewDecision');

  it('exposes idempotencyKey as a required property described as the value returned by prepare', () => {
    expect(decl).toBeDefined();
    const params = decl!.parameters as {
      properties?: Record<string, { type?: unknown; description?: string }>;
      required?: string[];
    };
    // Exposed in the schema the model is sent...
    expect(params.properties?.idempotencyKey).toBeDefined();
    // ...and required, so the function-calling layer cannot strip it.
    expect(params.required).toContain('idempotencyKey');
    // ...described as the exact server-issued value from prepare, re-sent verbatim.
    const description = params.properties?.idempotencyKey?.description ?? '';
    expect(description).toMatch(/prepareCompanyReviewDecision/);
    expect(description).toMatch(/server-issued/i);
    expect(description).toMatch(/unchanged/i);
  });
});
