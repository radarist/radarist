export {};
/**
 * @jest-environment node
 *
 * proposed-assessments-admin — focuses on approve()'s system-of-record apply:
 * create-vs-update placement, never-overwrite a set TRL, soft no-radar, and
 * idempotency. db is a small collection-keyed mock so reads of
 * proposedAssessments vs technologies return distinct docs.
 */

// ── mutable store the db mock reads/writes ──────────────────────────────────
const store: {
  proposal: Record<string, unknown> | null;
  tech: Record<string, unknown> | null;
} = { proposal: null, tech: null };

const techUpdate = jest.fn();

const makeDoc = (collection: string) => ({
  get: async () => {
    if (collection === 'proposedAssessments') {
      return { exists: store.proposal !== null, data: () => store.proposal };
    }
    if (collection === 'technologies') {
      return { exists: store.tech !== null, data: () => store.tech };
    }
    return { exists: false, data: () => undefined };
  },
  set: async (d: Record<string, unknown>) => {
    if (collection === 'proposedAssessments') store.proposal = d;
  },
  update: async (d: Record<string, unknown>) => {
    if (collection === 'proposedAssessments') store.proposal = { ...store.proposal, ...d };
    if (collection === 'technologies') techUpdate(d);
  },
});
// BUILD-011: transaction support. tx.get/tx.update map onto the same store;
// set txnFailure to make the NEXT transaction reject (atomicity: no partial
// writes are applied because the facade buffers until the callback resolves).
let txnFailure: Error | null = null;
const db = {
  collection: (name: string) => ({ doc: () => makeDoc(name) }),
  runTransaction: async (fn: (tx: unknown) => Promise<void>) => {
    const buffered: Array<() => void> = [];
    const tx = {
      get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
      update: (ref: { update: (d: Record<string, unknown>) => void }, d: Record<string, unknown>) => {
        buffered.push(() => void ref.update(d));
      },
    };
    await fn(tx);
    if (txnFailure) {
      const err = txnFailure;
      txnFailure = null;
      throw err; // nothing buffered is applied — atomic
    }
    buffered.forEach((apply) => apply());
  },
};

jest.mock('@/lib/firebase-admin', () => ({ db }));
jest.mock('@/lib/logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));

const adminGetPlacement = jest.fn();
const adminCreatePlacement = jest.fn();
const adminUpdatePlacement = jest.fn();
jest.mock('@/lib/radar-placement-admin', () => ({
  PlacementAuthorizationError: class PlacementAuthorizationError extends Error {},
  adminGetPlacementForTechnologyOnRadar: (...a: unknown[]) => adminGetPlacement(...a),
  adminCreateRadarPlacement: (...a: unknown[]) => adminCreatePlacement(...a),
  adminUpdateRadarPlacement: (...a: unknown[]) => adminUpdatePlacement(...a),
}));

const adminGetOwnedRadar = jest.fn();
jest.mock('@/lib/radars-admin', () => ({
  RadarAuthorizationError: class RadarAuthorizationError extends Error {},
  adminGetOwnedRadarById: (...a: unknown[]) => adminGetOwnedRadar(...a),
}));

const resolveRadarTarget = jest.fn();
jest.mock('@/lib/build-mission-radar-target', () => ({
  resolveRadarTarget: (...a: unknown[]) => resolveRadarTarget(...a),
}));

const {
  approveProposedAssessment,
  approveProposedAssessmentWithOutcome,
  approveProposedAssessmentWithRequiredPlacement,
  createProposedAssessmentIfNotExists,
} = require('../proposed-assessments-admin');

function pendingProposal(over: Record<string, unknown> = {}) {
  return {
    id: 'pa-1',
    technologyId: 'tech-1',
    recommendation: 'trial',
    trl: 8,
    confidence: 90,
    evidence: { metrics: [], findings: [] },
    proposedRing: 'Trial',
    sourceRunId: 'mission-1',
    status: 'pending',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe('approveProposedAssessment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    store.proposal = null;
    store.tech = null;
    adminCreatePlacement.mockResolvedValue({ id: 'placement-new' });
    adminUpdatePlacement.mockResolvedValue({ id: 'placement-existing' });
    adminGetOwnedRadar.mockResolvedValue({ id: 'radar-1', createdBy: 'user-x' });
    resolveRadarTarget.mockResolvedValue({ radarId: 'radar-1', quadrantId: 'q-1' });
  });

  it('creates a placement when none exists and sets TRL when unset', async () => {
    store.proposal = pendingProposal();
    store.tech = { name: 'Tech', trl: undefined };
    adminGetPlacement.mockResolvedValue(null);

    const result = await approveProposedAssessment('pa-1', 'user-x', { radarId: 'radar-1', quadrantId: 'q-1' });

    expect(adminCreatePlacement).toHaveBeenCalledWith(
      expect.objectContaining({
        technologyId: 'tech-1',
        radarId: 'radar-1',
        quadrantId: 'q-1',
        ring: 'Trial',
        trlScore: 8,
        placedBy: 'user-x',
      }),
      { requireOwnerId: 'user-x' }
    );
    expect(techUpdate).toHaveBeenCalledWith(expect.objectContaining({ trl: 8 }));
    expect(result.status).toBe('approved');
    expect(result.appliedPlacementId).toBe('placement-new');
  });

  it('updates the existing placement and does NOT overwrite a set TRL', async () => {
    store.proposal = pendingProposal();
    store.tech = { name: 'Tech', trl: 5 }; // already set, differs from proposed 8
    adminGetPlacement.mockResolvedValue({ id: 'placement-existing', ring: 'Assess' });

    await approveProposedAssessment('pa-1', 'user-x', { radarId: 'radar-1', quadrantId: 'q-1' });

    expect(adminUpdatePlacement).toHaveBeenCalledWith(
      'placement-existing',
      expect.objectContaining({ ring: 'Trial', trlScore: 8 }),
      { requireOwnerId: 'user-x' }
    );
    expect(adminCreatePlacement).not.toHaveBeenCalled();
    expect(techUpdate).not.toHaveBeenCalled(); // canonical TRL preserved
  });

  it("prefers the tech's current placement over a stale baked proposal target (BUILD-005)", async () => {
    // Proposal was baked with radar-C at creation (tech was unplaced then); the
    // tech has since been placed on radar-A. Approve (no opts) must apply to the
    // CURRENT placement (A), not create a duplicate on the stale baked radar-C.
    store.proposal = pendingProposal({ radarId: 'radar-C', quadrantId: 'q-C' });
    store.tech = { name: 'Tech', trl: undefined };
    resolveRadarTarget.mockResolvedValue({ radarId: 'radar-A', quadrantId: 'q-A' });
    adminGetPlacement.mockImplementation((_techId: string, radarId: string) =>
      Promise.resolve(radarId === 'radar-A' ? { id: 'placement-A', ring: 'Assess' } : null)
    );

    await approveProposedAssessment('pa-1', 'user-x'); // no opts → re-resolve fresh

    expect(adminUpdatePlacement).toHaveBeenCalledWith(
      'placement-A',
      expect.objectContaining({ ring: 'Trial' }),
      { requireOwnerId: 'user-x' }
    );
    expect(adminCreatePlacement).not.toHaveBeenCalled(); // no duplicate on radar-C
  });

  it('with requirePlacement, leaves the assessment PENDING when the placement fails (BUILD-006 autopilot)', async () => {
    store.proposal = pendingProposal();
    store.tech = { name: 'Tech', trl: undefined };
    adminGetPlacement.mockResolvedValue(null);
    adminCreatePlacement.mockRejectedValue(new Error('tech-missing race')); // placement write fails

    const result = await approveProposedAssessmentWithRequiredPlacement(
      'pa-1',
      'assessment-autopilot',
      {
        radarId: 'radar-1',
        quadrantId: 'q-1',
      },
      'user-x'
    );

    expect(result).toMatchObject({ applied: false, reason: 'failed' });
    expect(result.assessment.status).toBe('pending');
    expect(result.assessment.appliedPlacementId).toBeUndefined();
    expect(techUpdate).not.toHaveBeenCalled();
  });

  it('with requirePlacement, still APPROVES when the placement lands', async () => {
    store.proposal = pendingProposal();
    store.tech = { name: 'Tech', trl: undefined };
    adminGetPlacement.mockResolvedValue(null); // create path

    const result = await approveProposedAssessmentWithRequiredPlacement(
      'pa-1',
      'assessment-autopilot',
      {
        radarId: 'radar-1',
        quadrantId: 'q-1',
      },
      'user-x'
    );

    expect(result.applied).toBe(true);
    expect(result.assessment.status).toBe('approved');
    expect(result.assessment.appliedPlacementId).toBe('placement-new');
    expect(techUpdate).toHaveBeenCalledWith(expect.objectContaining({ trl: 8 }));
  });

  it('BUILD-005: an approved proposal with NO placement retries and completes on machine re-approval', async () => {
    // Old contract short-circuited with 'already-approved-without-placement',
    // stranding the placement forever. New contract: re-approval IS the retry.
    store.proposal = pendingProposal({ status: 'approved' });
    adminGetPlacement.mockResolvedValue(null);
    adminCreatePlacement.mockResolvedValue({ id: 'placement-retry' });

    const result = await approveProposedAssessmentWithRequiredPlacement(
      'pa-1',
      'assessment-autopilot',
      {
        radarId: 'radar-1',
        quadrantId: 'q-1',
      },
      'user-x'
    );

    expect(result.applied).toBe(true);
    expect(adminCreatePlacement).toHaveBeenCalledTimes(1);
    expect(result.assessment.appliedPlacementId).toBe('placement-retry');
  });

  it('approves without a placement when no radar target resolves (soft)', async () => {
    store.proposal = pendingProposal();
    store.tech = { name: 'Tech', trl: undefined };
    resolveRadarTarget.mockResolvedValue({}); // no radar

    const result = await approveProposedAssessment('pa-1', 'user-x');

    expect(adminCreatePlacement).not.toHaveBeenCalled();
    expect(result.status).toBe('approved');
    expect(result.appliedPlacementId).toBeUndefined();
  });

  it('is idempotent when already approved WITH a landed placement (no re-writes)', async () => {
    store.proposal = pendingProposal({ status: 'approved', appliedPlacementId: 'placement-done' });
    const result = await approveProposedAssessment('pa-1', 'user-x');
    expect(result.status).toBe('approved');
    expect(adminCreatePlacement).not.toHaveBeenCalled();
    expect(adminUpdatePlacement).not.toHaveBeenCalled();
  });

  it('BUILD-005: human re-approval after a failed placement actually retries — the "try approving again" toast is now true', async () => {
    // First approval ended approved-without-placement (write failed then).
    store.proposal = pendingProposal({ status: 'approved' });
    resolveRadarTarget.mockResolvedValue({ radarId: 'radar-1', quadrantId: 'q-1' });
    adminGetPlacement.mockResolvedValue(null);
    adminCreatePlacement.mockResolvedValue({ id: 'placement-second-try' });

    const result = await approveProposedAssessment('pa-1', 'user-x');

    expect(adminCreatePlacement).toHaveBeenCalledTimes(1);
    expect(result.appliedPlacementId).toBe('placement-second-try');
    expect(result.status).toBe('approved');
  });

  it('BUILD-005: re-approval after adding the tech to a radar applies the placement (unresolved-recovery)', async () => {
    // First approval had NO radar target (toast: "add it to a radar…"). The
    // user placed the tech, then clicked approve again — the fresh resolve now
    // finds the target and the placement must land.
    store.proposal = pendingProposal({ status: 'approved' });
    resolveRadarTarget.mockResolvedValue({ radarId: 'radar-9', quadrantId: 'q-2' });
    adminGetPlacement.mockResolvedValue(null);
    adminCreatePlacement.mockResolvedValue({ id: 'placement-after-add' });

    const result = await approveProposedAssessment('pa-1', 'user-x');

    expect(adminCreatePlacement).toHaveBeenCalledWith(
      expect.objectContaining({ radarId: 'radar-9' }),
      { requireOwnerId: 'user-x' }
    );
    expect(result.appliedPlacementId).toBe('placement-after-add');
  });

  it('refuses a foreign or missing radar before reading placements or changing proposal truth', async () => {
    store.proposal = pendingProposal();
    store.tech = { name: 'Tech', trl: undefined };
    adminGetOwnedRadar.mockRejectedValueOnce(new Error('uniform owner denial'));

    await expect(
      approveProposedAssessment('pa-1', 'user-x', { radarId: 'radar-foreign', quadrantId: 'q-1' })
    ).rejects.toThrow('uniform owner denial');

    expect(adminGetOwnedRadar).toHaveBeenCalledWith('radar-foreign', 'user-x');
    expect(adminGetPlacement).not.toHaveBeenCalled();
    expect(adminCreatePlacement).not.toHaveBeenCalled();
    expect(adminUpdatePlacement).not.toHaveBeenCalled();
    expect((store.proposal as { status?: string }).status).toBe('pending');
    expect(techUpdate).not.toHaveBeenCalled();
  });

  it('does not approve when radar ownership changes inside the placement transaction', async () => {
    store.proposal = pendingProposal();
    store.tech = { name: 'Tech', trl: undefined };
    adminGetPlacement.mockResolvedValue(null);
    const { PlacementAuthorizationError } = jest.requireMock('@/lib/radar-placement-admin') as {
      PlacementAuthorizationError: new () => Error;
    };
    adminCreatePlacement.mockRejectedValueOnce(new PlacementAuthorizationError());

    await expect(
      approveProposedAssessment('pa-1', 'user-x', { radarId: 'radar-1', quadrantId: 'q-1' })
    ).rejects.toThrow();

    expect((store.proposal as { status?: string }).status).toBe('pending');
    expect(techUpdate).not.toHaveBeenCalled();
  });

  it('BUILD-011 order 1: status txn fails AFTER placement landed → proposal stays pending, TRL untouched, retry converges', async () => {
    store.proposal = pendingProposal();
    store.tech = { name: 'Tech', trl: undefined };
    resolveRadarTarget.mockResolvedValue({ radarId: 'radar-1', quadrantId: 'q-1' });
    adminGetPlacement.mockResolvedValue(null);
    adminCreatePlacement.mockResolvedValue({ id: 'placement-live' });
    txnFailure = new Error('status txn write failed');

    await expect(approveProposedAssessment('pa-1', 'user-x')).rejects.toThrow('status txn write failed');

    // Placement is live (outside the txn by design) but the ATOMIC pair did
    // not partially apply: proposal still pending, canonical TRL untouched.
    expect((store.proposal as { status?: string }).status).toBe('pending');
    expect(techUpdate).not.toHaveBeenCalled();

    // Retry converges: existing placement re-applied idempotently, txn lands.
    adminGetPlacement.mockResolvedValue({ id: 'placement-live' });
    adminUpdatePlacement.mockResolvedValue({ id: 'placement-live' });
    const result = await approveProposedAssessment('pa-1', 'user-x');
    expect(result.status).toBe('approved');
    expect(result.appliedPlacementId).toBe('placement-live');
    expect(techUpdate).toHaveBeenCalledWith(expect.objectContaining({ trl: 8 }));
  });

  it('BUILD-011 order 2: TRL and status commit together — a txn failure applies NEITHER', async () => {
    store.proposal = pendingProposal();
    store.tech = { name: 'Tech', trl: undefined };
    resolveRadarTarget.mockResolvedValue({ radarId: 'radar-1', quadrantId: 'q-1' });
    adminGetPlacement.mockResolvedValue(null);
    adminCreatePlacement.mockResolvedValue({ id: 'placement-live' });
    txnFailure = new Error('trl write conflict');

    await expect(approveProposedAssessment('pa-1', 'user-x')).rejects.toThrow('trl write conflict');

    // Neither half of the atomic pair applied — no TRL mutation with a
    // pending proposal, no approved proposal with a missing TRL.
    expect(techUpdate).not.toHaveBeenCalled();
    expect((store.proposal as { status?: string }).status).toBe('pending');
  });

  // BUILD-005: the outcome-bearing sibling — same behavior as the wrapper,
  // plus the honest placementOutcome the approveAssessment AI tool relays.
  describe('approveProposedAssessmentWithOutcome', () => {
    it("returns 'applied' with the assessment when the placement lands", async () => {
      store.proposal = pendingProposal();
      store.tech = { name: 'Tech', trl: undefined };
      adminGetPlacement.mockResolvedValue(null);

      const result = await approveProposedAssessmentWithOutcome('pa-1', 'user-x', {
        radarId: 'radar-1',
        quadrantId: 'q-1',
      });

      expect(result.placementOutcome).toBe('applied');
      expect(result.assessment.status).toBe('approved');
      expect(result.assessment.appliedPlacementId).toBe('placement-new');
    });

    it("returns 'unresolved' when no radar target resolves (verdict still approved)", async () => {
      store.proposal = pendingProposal();
      store.tech = { name: 'Tech', trl: undefined };
      resolveRadarTarget.mockResolvedValue({}); // no radar

      const result = await approveProposedAssessmentWithOutcome('pa-1', 'user-x');

      expect(result.placementOutcome).toBe('unresolved');
      expect(result.assessment.status).toBe('approved');
      expect(result.assessment.appliedPlacementId).toBeUndefined();
    });

    it("returns 'failed' when the placement write throws (verdict still approved, retryable)", async () => {
      store.proposal = pendingProposal();
      store.tech = { name: 'Tech', trl: undefined };
      adminGetPlacement.mockResolvedValue(null);
      adminCreatePlacement.mockRejectedValue(new Error('placement write down'));

      const result = await approveProposedAssessmentWithOutcome('pa-1', 'user-x', {
        radarId: 'radar-1',
        quadrantId: 'q-1',
      });

      expect(result.placementOutcome).toBe('failed');
      expect(result.assessment.status).toBe('approved');
      expect(result.assessment.appliedPlacementId).toBeUndefined();
    });

    it('the legacy wrapper delegates here — identical assessment, outcome dropped', async () => {
      store.proposal = pendingProposal();
      store.tech = { name: 'Tech', trl: undefined };
      adminGetPlacement.mockResolvedValue(null);

      const viaWrapper = await approveProposedAssessment('pa-1', 'user-x', { radarId: 'radar-1', quadrantId: 'q-1' });

      expect(viaWrapper.status).toBe('approved');
      expect(viaWrapper.appliedPlacementId).toBe('placement-new');
    });
  });
});

describe('createProposedAssessmentIfNotExists', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    store.proposal = null;
  });

  const input = {
    technologyId: 'tech-1',
    recommendation: 'trial' as const,
    trl: 8,
    confidence: 90,
    evidence: { metrics: [], findings: [] },
    proposedRing: 'Trial',
    sourceRunId: 'mission-1',
  };

  it('creates a new pending proposal', async () => {
    const { created, assessment } = await createProposedAssessmentIfNotExists(input);
    expect(created).toBe(true);
    expect(assessment.status).toBe('pending');
    expect(assessment.id).toHaveLength(32);
  });

  it('does not recreate when one is already pending (idempotent)', async () => {
    store.proposal = pendingProposal();
    const { created, reason } = await createProposedAssessmentIfNotExists(input);
    expect(created).toBe(false);
    expect(reason).toBe('already_pending');
  });

  it('does not recreate when already approved', async () => {
    store.proposal = pendingProposal({ status: 'approved' });
    const { created, reason } = await createProposedAssessmentIfNotExists(input);
    expect(created).toBe(false);
    expect(reason).toBe('already_approved');
  });
});
