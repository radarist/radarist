export {};
/**
 * @jest-environment node
 *
 * P1a-T7 — getProposedAssessments honors the inbox `order` option: default
 * 'recency' (back-compat regression) and 'uncertainty' (near-50 first).
 */
let rows: Array<Record<string, unknown>> = [];
const makeQuery = (): Record<string, unknown> => ({
  where: () => makeQuery(),
  get: async () => ({ docs: rows.map((r) => ({ data: () => r })) }),
});
const db = { collection: () => makeQuery() };

jest.mock('@/lib/firebase-admin', () => ({ db }));
jest.mock('@/lib/logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));
jest.mock('@/lib/radar-placement-admin', () => ({
  adminGetPlacementForTechnologyOnRadar: jest.fn(),
  adminCreateRadarPlacement: jest.fn(),
  adminUpdateRadarPlacement: jest.fn(),
}));
jest.mock('@/lib/build-mission-radar-target', () => ({ resolveRadarTarget: jest.fn() }));

const { getProposedAssessments } = require('../proposed-assessments-admin');

function row(id: string, confidence: number, createdAt: number) {
  return {
    id,
    technologyId: 't',
    confidence,
    createdAt,
    updatedAt: createdAt,
    status: 'pending',
    recommendation: 'assess',
    proposedRing: 'Assess',
    sourceRunId: 'r',
  };
}

describe('getProposedAssessments ordering', () => {
  beforeEach(() => {
    rows = [row('a', 95, 1), row('b', 52, 4), row('c', 10, 2)];
  });

  it('defaults to recency (createdAt desc) — back-compat', async () => {
    const out = await getProposedAssessments();
    expect(out.map((r: { id: string }) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('orders near-50 first under "uncertainty"', async () => {
    const out = await getProposedAssessments({ order: 'uncertainty' });
    expect(out.map((r: { confidence: number }) => r.confidence)).toEqual([52, 10, 95]);
  });
});
