export {};
/**
 * @jest-environment node
 *
 * REPORT-005 contract test — the approved CREATE-report path exercised against
 * the REAL report + mission + proposed-artifact modules (only the Firestore
 * admin db, the AI client, and Inngest transport are faked). The previous
 * generation of this coverage mocked `createReport` and green-lit a payload the
 * real `createReportSchema` rejected on every runtime execution (agent-created
 * report without missionId). Nothing from `@/lib/reports`, `@/lib/missions`,
 * or `@/lib/proposed-artifacts-admin` is mocked here.
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
    const entries = [...store.entries()]
      .filter(([k]) => k.startsWith(`${collection}/`))
      .filter(([, v]) => predicates.every(([f, val]) => (v as Record<string, unknown>)[f] === val));
    return {
      empty: entries.length === 0,
      docs: entries.map(([k, data]) => ({
        id: k.slice(collection.length + 1),
        ref: makeDoc(collection, k.slice(collection.length + 1)),
        data: () => data,
      })),
    };
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
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('@/lib/inngest/client', () => ({
  inngest: { createFunction: (_c: unknown, _t: unknown, h: unknown) => h },
  safeSendEvent: jest.fn(async () => ({ ok: true })),
}));
jest.mock('@/lib/deep-research-document-admin', () => ({ dispatchDeepResearchDocument: jest.fn() }));

const STATIC_HTML = '<!DOCTYPE html><html><body><h1>AI agents</h1><p>A static publishable report.</p></body></html>';
const generateContent = jest.fn(async () => STATIC_HTML);
jest.mock('@/lib/ai/client', () => ({ generateContent }));

const { createProposedArtifactIfNotExists } = require('@/lib/proposed-artifacts-admin');
const { runArtifactGeneration } = require('../generate-recommended-artifact');

const docsIn = (collection: string) =>
  [...store.entries()].filter(([k]) => k.startsWith(`${collection}/`)).map(([, v]) => v);

beforeEach(() => {
  store.clear();
  jest.clearAllMocks();
});

async function approvedProposal(): Promise<string> {
  const { entity } = await createProposedArtifactIfNotExists({
    artifactKind: 'report',
    title: 'AI-agents cluster report',
    rationale: 'because it is hot',
    scope: { entityIds: ['t1'] },
    sourceUserId: 'owner-a',
  });
  store.set(`proposedArtifacts/${entity.id}`, {
    ...(store.get(`proposedArtifacts/${entity.id}`) as Record<string, unknown>),
    status: 'approved',
    generationStatus: 'generating',
  });
  return entity.id;
}

describe('REPORT-005 real schema/service boundary', () => {
  it('an approved CREATE recommendation produces one schema-valid PRIVATE report under a real mission', async () => {
    const proposalId = await approvedProposal();
    await runArtifactGeneration(proposalId, 'owner-a');

    const missions = docsIn('missions');
    const reports = docsIn('reports');
    expect(missions).toHaveLength(1);
    expect(reports).toHaveLength(1);

    const mission = missions[0] as Record<string, unknown>;
    const report = reports[0] as Record<string, unknown>;
    // The report carries the REAL mission identity — not a synthetic filler.
    expect(report.missionId).toBe(mission.id);
    expect(mission.userId).toBe('owner-a');
    expect(mission.status).toBe('completed');
    expect(mission.reportId).toBe(report.id);
    expect(report.createdBy).toBe('agent');
    expect(report.ownerId).toBe('owner-a');
    expect(report.shared).toBe(false);

    // The proposal links the authenticated private route, never /share.
    const proposal = store.get(`proposedArtifacts/${proposalId}`) as {
      generationStatus: string;
      outputRef: { type: string; id: string; url: string };
      executionMissionId: string;
    };
    expect(proposal.generationStatus).toBe('ready');
    expect(proposal.outputRef.url).toBe(`/reports/${report.id}`);
    expect(proposal.executionMissionId).toBe(mission.id);
  });

  it('replaying the generation event converges on exactly one mission and one report', async () => {
    const proposalId = await approvedProposal();
    await runArtifactGeneration(proposalId, 'owner-a');
    await runArtifactGeneration(proposalId, 'owner-a');

    expect(docsIn('missions')).toHaveLength(1);
    expect(docsIn('reports')).toHaveLength(1);
    // The ready-guard means the replay costs zero AI spend.
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('a crash between publish and proposal update still converges by slot on the next replay', async () => {
    const proposalId = await approvedProposal();
    await runArtifactGeneration(proposalId, 'owner-a');
    // Simulate the crash window: proposal still says 'generating' although the
    // report exists — the replay must upsert the SAME slot, not add a report.
    store.set(`proposedArtifacts/${proposalId}`, {
      ...(store.get(`proposedArtifacts/${proposalId}`) as Record<string, unknown>),
      generationStatus: 'generating',
      outputRef: undefined,
    });
    await runArtifactGeneration(proposalId, 'owner-a');
    expect(docsIn('missions')).toHaveLength(1);
    expect(docsIn('reports')).toHaveLength(1);
  });

  it('the real publication gate still rejects executable HTML (failure truth, no report)', async () => {
    generateContent.mockResolvedValueOnce('<!DOCTYPE html><html><body><script>alert(1)</script></body></html>');
    const proposalId = await approvedProposal();
    await expect(runArtifactGeneration(proposalId, 'owner-a')).rejects.toThrow();

    expect(docsIn('reports')).toHaveLength(0);
    const proposal = store.get(`proposedArtifacts/${proposalId}`) as { generationStatus: string };
    expect(proposal.generationStatus).toBe('failed');
    // The minted mission is honestly failed, not stranded pending/running.
    const missions = docsIn('missions');
    expect(missions).toHaveLength(1);
    expect((missions[0] as { status: string }).status).toBe('failed');
  });
});
