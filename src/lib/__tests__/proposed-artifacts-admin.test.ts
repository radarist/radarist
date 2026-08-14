export {};
/**
 * @jest-environment node
 *
 * proposed-artifacts-admin — the "recommendation" inbox kind whose approval EXECUTES
 * a generation job. Safety invariant: ALWAYS written `pending` + generationStatus
 * 'idle'; approve flips to approved + 'generating' (the route then dispatches the job).
 */

const store = new Map<string, Record<string, unknown>>();
const makeDoc = (collection: string, id: string) => ({
  get: async () => ({ exists: store.has(`${collection}/${id}`), data: () => store.get(`${collection}/${id}`) }),
  set: async (d: Record<string, unknown>) => void store.set(`${collection}/${id}`, d),
  update: async (d: Record<string, unknown>) =>
    void store.set(`${collection}/${id}`, { ...store.get(`${collection}/${id}`), ...d }),
});
const makeQuery = (collection: string, predicates: Array<[string, unknown]>) => ({
  where: (field: string, _op: string, val: unknown) => makeQuery(collection, [...predicates, [field, val]]),
  get: async () => {
    const docs = [...store.entries()]
      .filter(([k]) => k.startsWith(`${collection}/`))
      .map(([, v]) => v)
      .filter((v) => predicates.every(([f, val]) => (v as Record<string, unknown>)[f] === val));
    return { docs: docs.map((data) => ({ data: () => data })) };
  },
});
const db = {
  collection: (name: string) => ({
    doc: (id: string) => makeDoc(name, id),
    where: (field: string, op: string, val: unknown) => makeQuery(name, [[field, val]]),
  }),
  runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const tx = {
      get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
      set: (ref: { set: (d: Record<string, unknown>) => Promise<void> }, d: Record<string, unknown>) => void ref.set(d),
      update: (ref: { update: (d: Record<string, unknown>) => Promise<void> }, d: Record<string, unknown>) =>
        void ref.update(d),
    };
    return fn(tx);
  },
};
jest.mock('@/lib/firebase-admin', () => ({ db }));
jest.mock('@/lib/logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));

const {
  createProposedArtifactIfNotExists,
  getProposedArtifacts,
  approveProposedArtifact,
  rejectProposedArtifact,
  dismissProposedArtifact,
  updateProposedArtifact,
  ProposedArtifactNotFoundError,
  ensureExecutionMission,
} = require('../proposed-artifacts-admin');

function input(over: Record<string, unknown> = {}) {
  return {
    artifactKind: 'report',
    title: 'AI-agents cluster report',
    rationale: 'because X',
    sourceUserId: 'user-1',
    ...over,
  };
}

beforeEach(() => store.clear());

describe('createProposedArtifactIfNotExists', () => {
  it('creates a pending recommendation with generation idle (never auto-executes)', async () => {
    const { created, entity } = await createProposedArtifactIfNotExists(input());
    expect(created).toBe(true);
    expect(entity.status).toBe('pending');
    expect(entity.generationStatus).toBe('idle');
    expect(entity.artifactKind).toBe('report');
    expect(entity.sourceUserId).toBe('user-1');
  });

  it('SEC-011: refuses to create a recommendation without an owner', async () => {
    await expect(createProposedArtifactIfNotExists(input({ sourceUserId: undefined }))).rejects.toThrow(
      /sourceUserId is required/
    );
    await expect(createProposedArtifactIfNotExists(input({ sourceUserId: '  ' }))).rejects.toThrow(
      /sourceUserId is required/
    );
  });

  it('SEC-011: identical recommendations from two users create two separate docs', async () => {
    const a = await createProposedArtifactIfNotExists(input({ sourceUserId: 'user-a' }));
    const b = await createProposedArtifactIfNotExists(input({ sourceUserId: 'user-b' }));
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.entity.id).not.toBe(b.entity.id);
  });

  it('is idempotent — re-recommending the same artifact does not duplicate', async () => {
    const first = await createProposedArtifactIfNotExists(input());
    const second = await createProposedArtifactIfNotExists(input());
    expect(second.created).toBe(false);
    expect(second.reason).toBe('already_pending');
    expect(second.entity.id).toBe(first.entity.id);
  });
});

describe('approve / reject / dismiss', () => {
  it('approve flips to approved + generating (execution is dispatched by the route, not here)', async () => {
    const { entity } = await createProposedArtifactIfNotExists(input());
    const { artifact: approved, transitioned } = await approveProposedArtifact(entity.id, 'user-1');
    expect(transitioned).toBe(true);
    expect(approved.status).toBe('approved');
    expect(approved.generationStatus).toBe('generating');
    expect(approved.reviewedBy).toBe('user-1');
    expect(approved.appliedAt).toBeGreaterThan(0);
  });

  it('approve is idempotent — and the replay reports transitioned:false so the route never re-dispatches', async () => {
    const { entity } = await createProposedArtifactIfNotExists(input());
    const first = await approveProposedArtifact(entity.id, 'user-1');
    const again = await approveProposedArtifact(entity.id, 'user-1');
    expect(first.transitioned).toBe(true);
    expect(again.transitioned).toBe(false);
    expect(again.artifact.status).toBe('approved');
  });

  it('reject records the reason and never generates', async () => {
    const { entity } = await createProposedArtifactIfNotExists(input());
    const rejected = await rejectProposedArtifact(entity.id, 'user-1', 'not_relevant');
    expect(rejected.status).toBe('rejected');
    expect(rejected.generationStatus).toBe('idle');
    expect(rejected.feedbackReason).toBe('not_relevant');
  });

  it('dismiss marks dismissed', async () => {
    const { entity } = await createProposedArtifactIfNotExists(input());
    const dismissed = await dismissProposedArtifact(entity.id, 'user-1');
    expect(dismissed.status).toBe('dismissed');
  });
});

describe('updateProposedArtifact (used by the generation job)', () => {
  it('records the output + ready status when generation completes', async () => {
    const { entity } = await createProposedArtifactIfNotExists(input());
    const done = await updateProposedArtifact(entity.id, {
      generationStatus: 'ready',
      outputRef: { type: 'report', id: 'r1', url: '/share/report/r1' },
    });
    expect(done.generationStatus).toBe('ready');
    expect(done.outputRef.id).toBe('r1');
  });
});

describe('getProposedArtifacts', () => {
  it('filters by status (archive = non-pending)', async () => {
    const a = await createProposedArtifactIfNotExists(input({ title: 'A' }));
    await createProposedArtifactIfNotExists(input({ title: 'B' }));
    await approveProposedArtifact(a.entity.id, 'user-1');

    const pending = await getProposedArtifacts('user-1', { status: 'pending' });
    const approved = await getProposedArtifacts('user-1', { status: 'approved' });
    expect(pending.map((p: { title: string }) => p.title)).toEqual(['B']);
    expect(approved.map((p: { title: string }) => p.title)).toEqual(['A']);
  });

  it('SEC-011: lists only the caller-owned rows, never another user’s or ownerless docs', async () => {
    await createProposedArtifactIfNotExists(input({ title: 'Mine' }));
    await createProposedArtifactIfNotExists(input({ title: 'Theirs', sourceUserId: 'user-2' }));
    // Ownerless legacy doc written before SEC-011 (direct store write bypasses the create guard).
    store.set('proposedArtifacts/legacy-1', {
      id: 'legacy-1',
      artifactKind: 'report',
      title: 'Legacy',
      status: 'pending',
      generationStatus: 'idle',
      createdAt: 1,
      updatedAt: 1,
    });

    const mine = await getProposedArtifacts('user-1', { status: 'pending' });
    expect(mine.map((p: { title: string }) => p.title)).toEqual(['Mine']);
  });
});

describe('SEC-011 ownership preconditions on mutations', () => {
  it.each([
    ['approve', (id: string) => approveProposedArtifact(id, 'user-2')],
    ['reject', (id: string) => rejectProposedArtifact(id, 'user-2')],
    ['dismiss', (id: string) => dismissProposedArtifact(id, 'user-2')],
  ])('%s by a non-owner throws ProposedArtifactNotFoundError and leaves the doc untouched', async (_name, act) => {
    const { entity } = await createProposedArtifactIfNotExists(input());
    await expect(act(entity.id)).rejects.toThrow(ProposedArtifactNotFoundError);
    expect((store.get(`proposedArtifacts/${entity.id}`) as { status: string }).status).toBe('pending');
  });

  it.each([
    ['approve', (id: string) => approveProposedArtifact(id, 'user-1')],
    ['reject', (id: string) => rejectProposedArtifact(id, 'user-1')],
    ['dismiss', (id: string) => dismissProposedArtifact(id, 'user-1')],
  ])('%s on an absent id throws the same ProposedArtifactNotFoundError', async (_name, act) => {
    await expect(act('nope')).rejects.toThrow(ProposedArtifactNotFoundError);
  });

  it('an ownerless legacy doc is denied identically (indistinguishable from absent)', async () => {
    store.set('proposedArtifacts/legacy-1', {
      id: 'legacy-1',
      artifactKind: 'report',
      title: 'Legacy',
      status: 'pending',
      generationStatus: 'idle',
      createdAt: 1,
      updatedAt: 1,
    });
    let foreignErr: Error | null = null;
    let legacyErr: Error | null = null;
    await approveProposedArtifact('absent-id', 'user-1').catch((e: Error) => (foreignErr = e));
    await approveProposedArtifact('legacy-1', 'user-1').catch((e: Error) => (legacyErr = e));
    expect(foreignErr).toBeInstanceOf(ProposedArtifactNotFoundError);
    expect(legacyErr).toBeInstanceOf(ProposedArtifactNotFoundError);
  });

  it('the owner still approves with the original status rules intact', async () => {
    const { entity } = await createProposedArtifactIfNotExists(input());
    const { artifact: approved } = await approveProposedArtifact(entity.id, 'user-1');
    expect(approved.status).toBe('approved');
    const { artifact: again } = await approveProposedArtifact(entity.id, 'user-1');
    expect(again.status).toBe('approved'); // idempotent
    await expect(rejectProposedArtifact(entity.id, 'user-1')).resolves.toMatchObject({ status: 'rejected' });
  });
});

describe('ensureExecutionMission (REPORT-005)', () => {
  const missionDocs = () => [...store.keys()].filter((k) => k.startsWith('missions/'));

  it('mints ONE mission owned by the proposal owner and stamps executionMissionId atomically', async () => {
    const { entity } = await createProposedArtifactIfNotExists(input());
    const missionId = await ensureExecutionMission(entity.id, {
      prompt: 'Generate the report',
      agent: 'artifact-recommender',
    });
    expect(missionId).toMatch(/^mission-/);
    const proposal = store.get(`proposedArtifacts/${entity.id}`) as { executionMissionId?: string };
    expect(proposal.executionMissionId).toBe(missionId);
    const mission = store.get(`missions/${missionId}`) as Record<string, unknown>;
    expect(mission).toMatchObject({
      id: missionId,
      userId: 'user-1',
      agent: 'artifact-recommender',
      status: 'pending',
      prompt: 'Generate the report',
    });
  });

  it('replay converges: a second call returns the SAME mission and creates no second doc', async () => {
    const { entity } = await createProposedArtifactIfNotExists(input());
    const first = await ensureExecutionMission(entity.id, { prompt: 'p', agent: 'artifact-recommender' });
    const second = await ensureExecutionMission(entity.id, { prompt: 'p', agent: 'artifact-recommender' });
    expect(second).toBe(first);
    expect(missionDocs()).toHaveLength(1);
  });

  it('refuses an ownerless proposal (no owner → no execution identity)', async () => {
    store.set('proposedArtifacts/legacy-1', {
      id: 'legacy-1',
      artifactKind: 'report',
      title: 'Legacy',
      status: 'approved',
      generationStatus: 'generating',
      createdAt: 1,
      updatedAt: 1,
    });
    await expect(ensureExecutionMission('legacy-1', { prompt: 'p', agent: 'a' })).rejects.toThrow(
      ProposedArtifactNotFoundError
    );
    expect(missionDocs()).toHaveLength(0);
  });
});
