export {};
/**
 * @jest-environment node
 *
 * proposed-entities-admin — net-new entity triage twin. Load-bearing safety
 * invariant (replaces the cut calibration gate, SD-3): a net-new entity is
 * ALWAYS written `pending` and never auto-applied at creation; adminCreateEntity
 * runs ONLY on approve.
 */

const store: { entity: Record<string, unknown> | null } = { entity: null };
const makeDoc = (collection: string) => ({
  get: async () => ({ exists: collection === 'proposedEntities' && store.entity !== null, data: () => store.entity }),
  set: async (d: Record<string, unknown>) => {
    if (collection === 'proposedEntities') store.entity = d;
  },
  update: async (d: Record<string, unknown>) => {
    if (collection === 'proposedEntities') store.entity = { ...store.entity, ...d };
  },
});
const db = { collection: (name: string) => ({ doc: () => makeDoc(name) }) };
jest.mock('@/lib/firebase-admin', () => ({ db }));
jest.mock('@/lib/logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));

const adminCreateEntity = jest.fn();
jest.mock('@/lib/entity-factory-admin', () => ({ adminCreateEntity: (...a: unknown[]) => adminCreateEntity(...a) }));

jest.mock('@/lib/entity-factory', () => {
  throw new Error('proposed-entities-admin must not import the Firebase client entity factory');
});
jest.mock('@/lib/firebase', () => {
  throw new Error('proposed-entities-admin must not import the Firebase client runtime');
});
jest.mock('firebase/firestore', () => {
  throw new Error('proposed-entities-admin must not import firebase/firestore');
});

const { DuplicateEntityError } = jest.requireActual(
  '@/lib/entity-factory-shared'
) as typeof import('../entity-factory-shared');

const {
  createProposedEntityIfNotExists,
  approveProposedEntity,
  rejectProposedEntity,
} = require('../proposed-entities-admin');

function inputData(over: Record<string, unknown> = {}) {
  return {
    entityType: 'company',
    name: 'Acme AI',
    confidence: 80,
    evidence: { metrics: [], findings: [] },
    data: {},
    ...over,
  };
}
function pending(over: Record<string, unknown> = {}) {
  return {
    id: 'pe-1',
    entityType: 'company',
    name: 'Acme AI',
    confidence: 80,
    status: 'pending',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe('proposed-entities-admin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    store.entity = null;
    adminCreateEntity.mockResolvedValue({ entity: { id: 'company-new-1' }, created: true });
  });

  it('SAFETY: createProposedEntityIfNotExists writes pending and NEVER auto-applies', async () => {
    const res = await createProposedEntityIfNotExists(inputData());
    expect(res.created).toBe(true);
    expect(res.entity.status).toBe('pending');
    expect(store.entity?.status).toBe('pending');
    expect(adminCreateEntity).not.toHaveBeenCalled(); // load-bearing: no autopilot path
  });

  it('is idempotent — an existing pending proposal returns already_pending', async () => {
    store.entity = pending();
    const res = await createProposedEntityIfNotExists(inputData());
    expect(res.created).toBe(false);
    expect(res.reason).toBe('already_pending');
  });

  it('does not re-create a recently rejected proposal', async () => {
    store.entity = pending({ status: 'rejected', updatedAt: Date.now() });
    const res = await createProposedEntityIfNotExists(inputData());
    expect(res.created).toBe(false);
    expect(res.reason).toBe('recently_rejected');
  });

  it('approve applies via adminCreateEntity and records appliedEntityId', async () => {
    store.entity = pending();
    const res = await approveProposedEntity('pe-1', 'user-x');
    expect(adminCreateEntity).toHaveBeenCalledWith(
      'company',
      expect.objectContaining({ name: 'Acme AI' }),
      expect.anything()
    );
    expect(res.status).toBe('approved');
    expect(res.appliedEntityId).toBe('company-new-1');
  });

  it('approve resolves already_known on DuplicateEntityError and still marks approved', async () => {
    store.entity = pending();
    adminCreateEntity.mockRejectedValue(
      new DuplicateEntityError('company', 'slug', 'acme-ai', 'company-existing-9')
    );
    const res = await approveProposedEntity('pe-1', 'user-x');
    expect(res.status).toBe('approved');
    expect(res.appliedEntityId).toBe('company-existing-9');
  });

  it('reject persists the feedback reason and status', async () => {
    store.entity = pending();
    const res = await rejectProposedEntity('pe-1', 'user-x', 'out-of-scope');
    expect(res.status).toBe('rejected');
    expect(res.feedbackReason).toBe('out-of-scope');
  });

  // UX-059 — a sparse scout painPoint proposal must mint a library-safe
  // canonical PainPoint (all required arrays + enums) so it never crashes
  // readers.
  describe('painPoint approval coalescing (UX-059)', () => {
    function pendingPainPoint(over: Record<string, unknown> = {}) {
      return pending({
        id: 'pe-pain-1',
        entityType: 'painPoint',
        name: 'Scout Discovered Pain',
        description: 'A pain surfaced by the scout',
        // data mirrors net-new-discovery: tags only, no required arrays/enums.
        data: { tags: ['ai', 'ops'], sourceUrl: 'https://example.com', relevance: 80 },
        ...over,
      });
    }

    it('approves a sparse painPoint with all required arrays and canonical enum defaults', async () => {
      store.entity = pendingPainPoint();
      const res = await approveProposedEntity('pe-pain-1', 'user-x');

      expect(res.status).toBe('approved');
      expect(adminCreateEntity).toHaveBeenCalledWith(
        'painPoint',
        expect.objectContaining({
          title: 'Scout Discovered Pain',
          description: 'A pain surfaced by the scout',
          affectedOrgUnitIds: [],
          linkedPrototypeIds: [],
          linkedTechnologyIds: [],
          linkedInitiativeIds: [],
          tags: ['ai', 'ops'],
          severity: 'medium',
          status: 'identified',
          category: 'operational',
        }),
        expect.anything()
      );
    });

    it('honors a valid severity/category provided in the proposal and does not override', async () => {
      store.entity = pendingPainPoint({
        data: { tags: [], severity: 'critical', category: 'customer', status: 'validated' },
      });
      await approveProposedEntity('pe-pain-1', 'user-x');

      expect(adminCreateEntity).toHaveBeenCalledWith(
        'painPoint',
        expect.objectContaining({
          severity: 'critical',
          category: 'customer',
          status: 'validated',
        }),
        expect.anything()
      );
    });

    it('drops malformed enum values to the canonical default instead of coercing', async () => {
      store.entity = pendingPainPoint({
        data: { tags: [], severity: 'super-high', status: 7, category: 'weird' },
      });
      await approveProposedEntity('pe-pain-1', 'user-x');

      const call = adminCreateEntity.mock.calls[0];
      const data = call[1] as Record<string, unknown>;
      expect(data.severity).toBe('medium');
      expect(data.status).toBe('identified');
      expect(data.category).toBe('operational');
    });

    it('does not fabricate impact or link values for the minted painPoint', async () => {
      store.entity = pendingPainPoint();
      await approveProposedEntity('pe-pain-1', 'user-x');

      const call = adminCreateEntity.mock.calls[0];
      const data = call[1] as Record<string, unknown>;
      expect(data.estimatedImpact).toBeUndefined();
      expect(data.actualImpact).toBeUndefined();
      expect(data.impactDescription).toBeUndefined();
      expect(data.affectedOrgUnitIds).toEqual([]);
    });
  });
});
