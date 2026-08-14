/**
 * @jest-environment node
 *
 * GRAPH-060 — the acknowledged graph handoff for placement mutations.
 *
 * These tests pin the core truth of GRAPH-060: a placement mutation commits to
 * Firestore and then AWAITS the Inngest graph-sync dispatch. When the dispatch
 * is acknowledged (Inngest returns event ids) the handoff is `acknowledged` and
 * needs no recovery; when the dispatch is NOT acknowledged (empty ids) or throws
 * AFTER a successful commit, the handoff must report `committed: true` with
 * `reconciliationRequired: true` — never a rollback, because the Firestore write
 * already landed and only the queue handoff is uncertain.
 */
export {};

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

jest.mock('@/lib/inngest/client', () => ({
  inngest: { send: jest.fn().mockResolvedValue({ ids: ['placement-sync-event'] }) },
}));

jest.mock('@/lib/relations-cascade-admin', () => ({
  adminDeleteRelationsForEntity: jest.fn().mockResolvedValue(0),
}));

const mockRunTransaction = jest.fn();
const mockDocGet = jest.fn();
const mockDocSet = jest.fn();
const mockDocUpdate = jest.fn();
const mockDocDelete = jest.fn();

jest.mock('@/lib/firebase-admin', () => {
  const docRef = {
    get: mockDocGet,
    set: mockDocSet,
    update: mockDocUpdate,
    delete: mockDocDelete,
  };
  const ref: Record<string, unknown> = { get: jest.fn(), doc: jest.fn(() => docRef) };
  ref.where = jest.fn(() => ref);
  ref.limit = jest.fn(() => ref);
  return { db: { collection: jest.fn(() => ref), runTransaction: mockRunTransaction } };
});

const {
  buildPlacementGraphHandoff,
  adminCreateRadarPlacementWithHandoff,
  adminUpdateRadarPlacementWithHandoff,
  adminDeleteRadarPlacementWithHandoff,
} = require('../radar-placement-admin');
const { inngest: mockedInngest } = jest.requireMock('@/lib/inngest/client') as {
  inngest: { send: jest.Mock };
};

const docSnap = (data: unknown) => ({ exists: data !== null, id: 'placement-1', data: () => data });

const RADAR = {
  id: 'radar-1',
  quadrants: [{ id: 'techniques', name: 'Techniques', order: 0 }],
  ringSystem: 'Standard',
};

/**
 * Wire a fresh-pair create transaction (GRAPH-066 read order): technology,
 * radar, absent pair lock, empty legacy query — then the placement + lock writes.
 */
function mockCreateTransaction() {
  mockRunTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
    const txGet = jest
      .fn()
      .mockResolvedValueOnce({ exists: true, data: () => ({ id: 'tech-1' }) }) // technology
      .mockResolvedValueOnce({ exists: true, data: () => RADAR }) // radar
      .mockResolvedValueOnce({ exists: false, data: () => undefined }) // radar deletion lease (inactive)
      .mockResolvedValueOnce({ exists: false, data: () => undefined }) // technology deletion lease (inactive)
      .mockResolvedValueOnce({ exists: false }) // pair lock absent
      .mockResolvedValueOnce({ empty: true, size: 0, docs: [] }); // no legacy placements
    const tx = { get: txGet, set: jest.fn(), delete: jest.fn() };
    return fn(tx);
  });
}

const CREATE_INPUT = {
  technologyId: 'tech-1',
  radarId: 'radar-1',
  quadrantId: 'techniques',
  ring: 'Trial',
  placedBy: 'user-1',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedInngest.send.mockResolvedValue({ ids: ['placement-sync-event'] });
});

describe('buildPlacementGraphHandoff', () => {
  it('reports an acknowledged committed handoff needing no recovery', () => {
    expect(buildPlacementGraphHandoff(true)).toEqual({
      committed: true,
      acknowledged: true,
      reconciliationRequired: false,
    });
  });

  it('reports committed-but-unacknowledged as reconciliation-required, never a rollback', () => {
    expect(buildPlacementGraphHandoff(false)).toEqual({
      committed: true,
      acknowledged: false,
      reconciliationRequired: true,
    });
  });
});

describe('adminCreateRadarPlacementWithHandoff', () => {
  it('returns the committed placement with an acknowledged handoff when Inngest accepts the event', async () => {
    mockCreateTransaction();
    mockedInngest.send.mockResolvedValueOnce({ ids: ['evt_1'] });

    const result = await adminCreateRadarPlacementWithHandoff(CREATE_INPUT);

    expect(result.placement.technologyId).toBe('tech-1');
    expect(result.placement.radarId).toBe('radar-1');
    expect(result.graphHandoff).toEqual({
      committed: true,
      acknowledged: true,
      reconciliationRequired: false,
    });
    expect(mockedInngest.send).toHaveBeenCalledTimes(1);
  });

  it('returns committed + reconciliation-required when Inngest acknowledges no event id', async () => {
    mockCreateTransaction();
    mockedInngest.send.mockResolvedValueOnce({ ids: [] });

    const result = await adminCreateRadarPlacementWithHandoff(CREATE_INPUT);

    // The Firestore write landed — the placement is real and returned.
    expect(result.placement.radarId).toBe('radar-1');
    expect(result.graphHandoff).toEqual({
      committed: true,
      acknowledged: false,
      reconciliationRequired: true,
    });
  });

  it('does not roll back a committed placement when the dispatch throws', async () => {
    mockCreateTransaction();
    mockedInngest.send.mockRejectedValueOnce(new Error('inngest unreachable'));

    const result = await adminCreateRadarPlacementWithHandoff(CREATE_INPUT);

    expect(result.placement.radarId).toBe('radar-1');
    expect(result.graphHandoff.committed).toBe(true);
    expect(result.graphHandoff.reconciliationRequired).toBe(true);
  });
});

describe('adminUpdateRadarPlacementWithHandoff', () => {
  it('returns the updated placement with an acknowledged handoff (transactional update)', async () => {
    const stored = {
      technologyId: 'tech-1',
      radarId: 'radar-1',
      quadrantId: 'techniques',
      ring: 'Assess',
      placedBy: 'user-1',
    };
    // #7: update is transactional — reads placement, radar, pair lock, then updates.
    const txUpdate = jest.fn();
    mockRunTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txGet = jest
        .fn()
        .mockResolvedValueOnce({ exists: true, id: 'placement-1', data: () => stored }) // placement
        .mockResolvedValueOnce({ exists: true, id: 'radar-1', data: () => RADAR }) // radar
        .mockResolvedValueOnce({ exists: true, data: () => ({ placementId: 'placement-1' }) }); // pair lock
      return fn({ get: txGet, update: txUpdate, set: jest.fn() });
    });
    mockedInngest.send.mockResolvedValueOnce({ ids: ['evt_2'] });

    const result = await adminUpdateRadarPlacementWithHandoff('placement-1', { ring: 'Trial' });

    expect(result.placement.ring).toBe('Trial');
    expect(result.graphHandoff.acknowledged).toBe(true);
    expect(result.graphHandoff.reconciliationRequired).toBe(false);
    expect(txUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('adminDeleteRadarPlacementWithHandoff', () => {
  it('returns a reconciliation-required handoff when the delete dispatch is unacknowledged', async () => {
    // pre-read placement, then the atomic delete+lock+tombstone transaction.
    mockDocGet.mockResolvedValueOnce(docSnap({ technologyId: 'tech-1', radarId: 'radar-1' }));
    const txDelete = jest.fn();
    const txSet = jest.fn();
    mockRunTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txGet = jest.fn().mockResolvedValueOnce({ exists: true, data: () => ({ placementId: 'placement-1' }) });
      return fn({ get: txGet, delete: txDelete, set: txSet });
    });
    mockedInngest.send.mockResolvedValueOnce({ ids: [] });

    const result = await adminDeleteRadarPlacementWithHandoff('placement-1');

    expect(result.graphHandoff).toEqual({
      committed: true,
      acknowledged: false,
      reconciliationRequired: true,
    });
    expect(txDelete).toHaveBeenCalledTimes(2); // placement doc + pair lock
    expect(txSet).toHaveBeenCalledTimes(1); // durable delete tombstone
  });
});
