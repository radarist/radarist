export {};
/**
 * @jest-environment node
 *
 * Admin-SDK signal-feedback reads for the AI tool (P2). These MUST be admin SDK — the
 * existing signals/feedback.ts analytics use the client SDK in a 'use server' module and
 * would a540/unavailable when reached from the server-side AI executor.
 */

type Doc = { source?: string; title?: string; feedback?: { vote?: 'up' | 'down'; reason?: string } };
const docs: Array<{ id: string; data: Doc }> = [];
const get = (field: string, d: Doc): unknown =>
  field === 'feedback.vote' ? d.feedback?.vote : (d as Record<string, unknown>)[field];
const makeQuery = (preds: Array<[string, string, unknown]>, cap?: number) => ({
  where: (f: string, op: string, v: unknown) => makeQuery([...preds, [f, op, v]], cap),
  limit: (n: number) => makeQuery(preds, n),
  get: async () => {
    let rows = docs.filter((row) =>
      preds.every(([f, op, v]) => {
        const val = get(f, row.data);
        return op === 'in' ? (v as unknown[]).includes(val) : val === v;
      })
    );
    if (cap != null) rows = rows.slice(0, cap);
    return { docs: rows.map((r) => ({ id: r.id, data: () => r.data })) };
  },
});
const db = { collection: () => makeQuery([]) };
jest.mock('@/lib/firebase-admin', () => ({ db }));
jest.mock('@/lib/firebase', () => ({ removeUndefinedFields: (x: unknown) => x }));
jest.mock('@/lib/entity-factory-admin', () => ({ adminCreateEntity: jest.fn() }));
jest.mock('@/lib/logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));

const {
  getSourceFeedbackBreakdown,
  adminGetFeedbackStats,
  adminGetSignalsWithNegativeFeedback,
} = require('../signals-admin');

beforeEach(() => {
  docs.length = 0;
  docs.push(
    { id: 's1', data: { source: 'TechCrunch', title: 'A', feedback: { vote: 'up' } } },
    { id: 's2', data: { source: 'TechCrunch', title: 'B', feedback: { vote: 'down', reason: 'off-topic' } } },
    { id: 's3', data: { source: 'Google News', title: 'C', feedback: { vote: 'down' } } },
    { id: 's4', data: { source: 'arXiv', title: 'D', feedback: { vote: 'up' } } },
    { id: 's5', data: { source: 'arXiv', title: 'E' } } // no feedback — excluded
  );
});

describe('getSourceFeedbackBreakdown', () => {
  it('groups voted signals by source with an approval rate (no divide-by-zero)', async () => {
    const rows = await getSourceFeedbackBreakdown();
    const tc = rows.find((r: { source: string }) => r.source === 'TechCrunch');
    expect(tc).toMatchObject({ total: 2, upvotes: 1, downvotes: 1, approvalRate: 50 });
    const gn = rows.find((r: { source: string }) => r.source === 'Google News');
    expect(gn).toMatchObject({ total: 1, upvotes: 0, downvotes: 1, approvalRate: 0 });
    // un-voted signal excluded; sorted by volume desc
    expect(rows.reduce((n: number, r: { total: number }) => n + r.total, 0)).toBe(4);
    expect(rows[0].total).toBeGreaterThanOrEqual(rows[rows.length - 1].total);
  });
});

describe('adminGetFeedbackStats', () => {
  it('aggregates up/down + approval rate over voted signals only', async () => {
    const s = await adminGetFeedbackStats();
    expect(s).toMatchObject({ total: 4, upvotes: 2, downvotes: 2, approvalRate: 50 });
  });
});

describe('adminGetSignalsWithNegativeFeedback', () => {
  it('returns down-voted signals with their reason', async () => {
    const neg = await adminGetSignalsWithNegativeFeedback(10);
    expect(neg).toHaveLength(2);
    expect(neg.map((n: { id: string }) => n.id).sort()).toEqual(['s2', 's3']);
    expect(neg.find((n: { id: string }) => n.id === 's2')?.reason).toBe('off-topic');
  });
});
