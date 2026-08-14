export {};
/**
 * @jest-environment node
 *
 * generate-recommended-artifact — the execute-on-approve core. Switches on artifactKind:
 * report → execution mission + upsertReportBySlot; infographic → visualization; research → Document + dispatch
 * deep-research. Records the outputRef + generation status back on the proposal.
 */

const getProposedArtifactById = jest.fn();
const updateProposedArtifact = jest.fn(async (_id: string, u: Record<string, unknown>) => u);
const ensureExecutionMission = jest.fn(async () => 'mission-exec-1');
jest.mock('@/lib/proposed-artifacts-admin', () => ({
  getProposedArtifactById,
  updateProposedArtifact,
  ensureExecutionMission,
}));

const upsertReportBySlot = jest.fn(async () => ({ reportId: 'r1', reportUrl: '/reports/r1', isUpsert: false }));
const updateReport = jest.fn(async () => ({ id: 'rExisting' }));
const getReportOwnedBy = jest.fn<Promise<{ html: string } | null>, [string, string]>(async () => ({ html: '' })); // empty original → gate skipped by default
jest.mock('@/lib/reports', () => ({ upsertReportBySlot, updateReport, getReportOwnedBy }));

const updateMission = jest.fn(async () => undefined);
jest.mock('@/lib/missions', () => ({ updateMission }));

const adminCreateDocument = jest.fn(async () => ({ id: 'd1' }));
jest.mock('@/lib/document-admin', () => ({ adminCreateDocument }));

const safeSendEvent = jest.fn(async () => ({ ok: true }));
jest.mock('@/lib/inngest/client', () => ({
  inngest: { createFunction: (_c: unknown, _t: unknown, h: unknown) => h },
  safeSendEvent,
}));

const generateContent = jest.fn(async () => '<html><body>report</body></html>');
jest.mock('@/lib/ai/client', () => ({ generateContent }));

const generateInfographic = jest.fn(
  async (
    _req: Record<string, unknown>
  ): Promise<{
    success: boolean;
    url: string | null;
    mimeType?: string;
    width?: number;
    height?: number;
    sizeBytes?: number;
  }> => ({
    success: true,
    url: 'https://img/x.png',
    mimeType: 'image/png',
    width: 1376,
    height: 768,
    sizeBytes: 523568,
  })
);
jest.mock('@/lib/ai/image-client', () => ({ generateInfographic }));
const createVisualization = jest.fn(async (_input: Record<string, unknown>) => ({ id: 'viz1' }));
const buildLearnedStyleFragment = jest.fn(async () => undefined as string | undefined);
jest.mock('@/lib/visualizations', () => ({ createVisualization, buildLearnedStyleFragment }));
jest.mock('@/lib/logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));

const { runArtifactGeneration } = require('../generate-recommended-artifact');

function proposal(over: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    artifactKind: 'report',
    title: 'AI-agents cluster report',
    rationale: 'because it is hot',
    status: 'approved',
    generationStatus: 'generating',
    scope: { entityIds: ['t1'], query: '' },
    sourceUserId: 'user-1',
    ...over,
  };
}

beforeEach(() => jest.clearAllMocks());

describe('runArtifactGeneration', () => {
  it('report → mints the execution mission BEFORE generating, publishes one slot-keyed report, records ready', async () => {
    getProposedArtifactById.mockResolvedValue(proposal());
    await runArtifactGeneration('p1', 'user-1');

    // REPORT-005: durable owned identity exists before any AI spend.
    expect(ensureExecutionMission).toHaveBeenCalledWith('p1', {
      prompt: expect.stringContaining('AI-agents cluster report'),
      agent: 'artifact-recommender',
    });
    expect(ensureExecutionMission.mock.invocationCallOrder[0]).toBeLessThan(
      generateContent.mock.invocationCallOrder[0]
    );
    expect(upsertReportBySlot).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: 'mission-exec-1',
        slotName: 'main',
        title: 'AI-agents cluster report',
        html: expect.stringContaining('report'),
        createdBy: 'agent',
        agentType: 'artifact-recommender',
        ownerId: 'user-1',
        savedBy: 'agent:artifact-recommender',
      })
    );
    // The mission terminalizes as delivered with the durable run→report link.
    expect(updateMission).toHaveBeenCalledWith(
      'mission-exec-1',
      expect.objectContaining({ status: 'completed', reportId: 'r1', reportIds: ['r1'], outcome: 'delivered' })
    );
    expect(updateProposedArtifact).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        generationStatus: 'ready',
        // REPORT-002: the owner gets the private route — a generated report
        // is stored `shared: false`, so a /share link would render
        // "Report Not Shared".
        outputRef: { type: 'report', id: 'r1', url: '/reports/r1' },
      })
    );
  });

  it('SEC-011: execution ownership comes from the persisted proposal, never the event userId', async () => {
    getProposedArtifactById.mockResolvedValue(proposal({ sourceUserId: 'owner-a' }));
    await runArtifactGeneration('p1', 'attacker-b');
    expect(upsertReportBySlot).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'owner-a' }));
  });

  it('SEC-011: an ownerless proposal fails loudly — no mission, no generation, no report', async () => {
    getProposedArtifactById.mockResolvedValue(proposal({ sourceUserId: undefined }));
    await runArtifactGeneration('p1', 'user-1');
    expect(ensureExecutionMission).not.toHaveBeenCalled();
    expect(generateContent).not.toHaveBeenCalled();
    expect(upsertReportBySlot).not.toHaveBeenCalled();
    expect(updateProposedArtifact).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ generationStatus: 'failed', generationError: expect.stringContaining('no owner') })
    );
  });

  it('REPORT-005: a replayed event for an already-ready proposal is a no-op (no second report, no AI spend)', async () => {
    getProposedArtifactById.mockResolvedValue(
      proposal({ generationStatus: 'ready', outputRef: { type: 'report', id: 'r1', url: '/reports/r1' } })
    );
    await runArtifactGeneration('p1', 'user-1');
    expect(ensureExecutionMission).not.toHaveBeenCalled();
    expect(generateContent).not.toHaveBeenCalled();
    expect(upsertReportBySlot).not.toHaveBeenCalled();
    expect(updateProposedArtifact).not.toHaveBeenCalled();
  });

  it('a replayed event during the deep-research window is a no-op (no duplicate document dispatch)', async () => {
    getProposedArtifactById.mockResolvedValue(
      proposal({
        artifactKind: 'research',
        generationStatus: 'generating',
        outputRef: { type: 'document', id: 'd1', url: '/library/documents?document=d1' },
      })
    );
    await runArtifactGeneration('p1', 'user-1');
    expect(adminCreateDocument).not.toHaveBeenCalled();
    expect(safeSendEvent).not.toHaveBeenCalled();
    expect(updateProposedArtifact).not.toHaveBeenCalled();
  });

  it('skips the slot upsert when a concurrent execution recorded output during generation — and re-terminalizes the shared mission', async () => {
    getProposedArtifactById
      .mockResolvedValueOnce(proposal()) // initial read: still generating
      .mockResolvedValueOnce(
        proposal({ generationStatus: 'ready', outputRef: { type: 'report', id: 'r1', url: '/reports/r1' } })
      ); // pre-upsert recheck: the concurrent run finished
    await runArtifactGeneration('p1', 'user-1');
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(upsertReportBySlot).not.toHaveBeenCalled();
    expect(updateProposedArtifact).not.toHaveBeenCalled();
    // This run wrote 'running' onto the SHARED mission before generating; the
    // skip branch must not strand the delivered mission there.
    expect(updateMission).toHaveBeenLastCalledWith(
      'mission-exec-1',
      expect.objectContaining({ status: 'completed', reportId: 'r1', outcome: 'delivered' })
    );
  });

  it('infographic → generates a REAL image and saves a visualization (not an HTML report)', async () => {
    getProposedArtifactById.mockResolvedValue(proposal({ artifactKind: 'infographic' }));
    await runArtifactGeneration('p1', 'user-1');
    expect(generateInfographic).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        pathPrefix: 'visualizations',
        filename: 'artifact-p1',
      })
    );
    expect(createVisualization).toHaveBeenCalledWith(
      expect.objectContaining({
        storageObjectPath: 'visualizations/user-1/artifact-p1',
        metadata: {
          model: expect.any(String),
          width: 1376,
          height: 768,
          sizeBytes: 523568,
        },
      })
    );
    expect(upsertReportBySlot).not.toHaveBeenCalled();
    expect(updateProposedArtifact).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        generationStatus: 'ready',
        outputRef: { type: 'visualization', id: 'viz1', url: '/infographics/viz1' },
      })
    );
  });

  it('infographic metadata remains backward-compatible when dimensions are unavailable', async () => {
    generateInfographic.mockResolvedValueOnce({
      success: true,
      url: 'https://img/x.png',
      mimeType: 'image/png',
    });
    getProposedArtifactById.mockResolvedValue(proposal({ artifactKind: 'infographic' }));

    await runArtifactGeneration('p1', '');

    expect(createVisualization).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        storageObjectPath: 'visualizations/user-1/artifact-p1',
        metadata: expect.objectContaining({ width: 0, height: 0, sizeBytes: 0 }),
      })
    );
  });

  it('bounds recommended infographic titles and snapshot descriptions before persistence', async () => {
    getProposedArtifactById.mockResolvedValue(
      proposal({
        artifactKind: 'infographic',
        title: 'T'.repeat(400),
        rationale: 'R'.repeat(1_500),
      })
    );

    await runArtifactGeneration('p1', 'user-1');

    expect(createVisualization).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'T'.repeat(200),
        dataSnapshot: {
          entities: [],
          description: 'R'.repeat(1_000),
        },
      })
    );
  });

  it('recommended-artifact infographics carry the learned fragment instead of bare professional', async () => {
    buildLearnedStyleFragment.mockResolvedValueOnce(
      'Match the visual language of these previously liked designs: "Growth Curve" (professional)'
    );
    getProposedArtifactById.mockResolvedValue(proposal({ artifactKind: 'infographic' }));

    await runArtifactGeneration('p1', 'user-1');

    expect(generateInfographic).toHaveBeenCalledWith(
      expect.objectContaining({
        style: 'professional',
        brandStyle: expect.stringContaining('Growth Curve'),
      })
    );
    expect(createVisualization).toHaveBeenCalledWith(
      expect.objectContaining({ appliedStyleFragment: expect.stringContaining('Growth Curve') })
    );
  });

  it('infographic generation proceeds with bare professional style when the fragment lookup fails', async () => {
    buildLearnedStyleFragment.mockRejectedValueOnce(new Error('Firestore unavailable'));
    getProposedArtifactById.mockResolvedValue(proposal({ artifactKind: 'infographic' }));

    await runArtifactGeneration('p1', 'user-1');

    expect(generateInfographic).toHaveBeenCalledWith(expect.objectContaining({ style: 'professional' }));
    const call = createVisualization.mock.calls[0][0];
    expect('appliedStyleFragment' in call).toBe(false);
  });

  it('research → creates a document, dispatches deep-research, stays generating', async () => {
    getProposedArtifactById.mockResolvedValue(
      proposal({ artifactKind: 'research', scope: { entityIds: [], query: 'vector DBs' } })
    );
    await runArtifactGeneration('p1', 'user-1');

    expect(adminCreateDocument).toHaveBeenCalled();
    expect(safeSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app/document.deep-research.requested',
        // proposedArtifactId is threaded so the research job can flip the proposal to 'ready'.
        data: expect.objectContaining({ documentId: 'd1', proposedArtifactId: 'p1' }),
      }),
      expect.anything()
    );
    expect(upsertReportBySlot).not.toHaveBeenCalled();
    expect(updateProposedArtifact).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        generationStatus: 'generating',
        // /documents/[id] does not exist as a route — the link must open the library
        // sheet via its page-specific param (?document=, per ENTITY_SHEET_PARAMS).
        outputRef: { type: 'document', id: 'd1', url: '/library/documents?document=d1' },
      })
    );
  });

  // SEC-009 regression guard: the refresh path reads the target's FULL html
  // (and ships it to Gemini) before rewriting it in place. A proposal naming a
  // report the acting user does not own — or an ownerless legacy one — must
  // read nothing, generate nothing, and write nothing.
  it('refuses to read or rewrite a report the acting user does not own', async () => {
    getProposedArtifactById.mockResolvedValue(
      proposal({ updateOf: { type: 'report', id: 'rForeign', url: '/reports/rForeign' } })
    );
    // The owner boundary returns null for absent, foreign, and ownerless alike.
    getReportOwnedBy.mockResolvedValueOnce(null);

    await runArtifactGeneration('p1', 'user-1');

    expect(getReportOwnedBy).toHaveBeenCalledWith('rForeign', 'user-1');
    expect(generateContent).not.toHaveBeenCalled(); // no foreign html reaches the model
    expect(updateReport).not.toHaveBeenCalled(); // and nothing is overwritten
    expect(upsertReportBySlot).not.toHaveBeenCalled();
    expect(updateProposedArtifact).toHaveBeenCalledWith('p1', expect.objectContaining({ generationStatus: 'failed' }));
  });

  it('update recommendation → regenerates and UPDATES the existing report (no new report)', async () => {
    getProposedArtifactById.mockResolvedValue(
      proposal({ updateOf: { type: 'report', id: 'rExisting', url: '/share/report/rExisting' } })
    );
    await runArtifactGeneration('p1', 'user-1');
    // SEC-009: ownership is re-enforced inside the update transaction, so an
    // approval can never rewrite a report the acting user does not own.
    expect(updateReport).toHaveBeenCalledWith('rExisting', expect.objectContaining({ html: expect.any(String) }), {
      savedBy: 'agent:artifact-recommender',
      requireOwnerId: 'user-1',
    });
    expect(upsertReportBySlot).not.toHaveBeenCalled();
    expect(updateProposedArtifact).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        generationStatus: 'ready',
        // REPORT-002: a stale stored /share URL is normalized to the private route.
        outputRef: { type: 'report', id: 'rExisting', url: '/reports/rExisting' },
      })
    );
  });

  it('refresh quality gate: KEEPS the original when the regenerated report is thinner', async () => {
    getProposedArtifactById.mockResolvedValue(
      proposal({ updateOf: { type: 'report', id: 'rExisting', url: '/share/report/rExisting' } })
    );
    // A rich original vs a thin regeneration → the gate must reject and preserve the original.
    getReportOwnedBy.mockResolvedValueOnce({
      html: '<html>' + '<h2>S</h2><p>para</p><li>i</li>'.repeat(80) + '</html>',
    });
    generateContent.mockResolvedValueOnce('<html><body>thin</body></html>');
    await runArtifactGeneration('p1', 'user-1');
    expect(updateReport).not.toHaveBeenCalled();
    expect(updateProposedArtifact).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        generationStatus: 'failed',
        generationError: expect.stringContaining('Kept the original'),
      })
    );
  });

  it('records failed status on BOTH the proposal and the execution mission when the publish throws', async () => {
    getProposedArtifactById.mockResolvedValue(proposal());
    upsertReportBySlot.mockRejectedValueOnce(new Error('gemini down'));
    await expect(runArtifactGeneration('p1', 'user-1')).rejects.toThrow('gemini down');
    expect(updateProposedArtifact).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ generationStatus: 'failed', generationError: expect.stringContaining('gemini down') })
    );
    expect(updateMission).toHaveBeenCalledWith('mission-exec-1', expect.objectContaining({ status: 'failed' }));
  });

  it('skips a proposal that is not approved (no generation)', async () => {
    getProposedArtifactById.mockResolvedValue(proposal({ status: 'pending', generationStatus: 'idle' }));
    await runArtifactGeneration('p1', 'user-1');
    expect(upsertReportBySlot).not.toHaveBeenCalled();
    expect(generateContent).not.toHaveBeenCalled();
  });
});
