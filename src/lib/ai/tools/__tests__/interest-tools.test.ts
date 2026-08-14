/**
 * @jest-environment node
 *
 * A3 — the refreshInterestFromActivity AI tool: declares a no-arg tool and routes the
 * signed-in user to deriveInterestFromBehavior, surfacing failures as tool errors
 * (never throwing into the chat loop).
 */
export {};

const mockDerive = jest.fn();
const mockDiscoverNetNew = jest.fn();
jest.mock('@/lib/discovery/derive-interest', () => ({
  __esModule: true,
  deriveInterestFromBehavior: (...a: unknown[]) => mockDerive(...a),
}));
jest.mock('@/lib/discovery/net-new-discovery', () => ({
  __esModule: true,
  discoverNetNewTechnologies: (...a: unknown[]) => mockDiscoverNetNew(...a),
}));
const mockCreateArtifact = jest.fn();
jest.mock('@/lib/proposed-artifacts-admin', () => ({
  __esModule: true,
  createProposedArtifactIfNotExists: (...a: unknown[]) => mockCreateArtifact(...a),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const mockGetEntity = jest.fn();
jest.mock('@/lib/graph', () => ({
  __esModule: true,
  getEntity: (...a: unknown[]) => mockGetEntity(...a),
}));

const mockRecordAgentObservation = jest.fn();
class MockObservationTargetNotFoundError extends Error {
  entityId: string;
  constructor(entityId: string) {
    super(`Cannot record agent observation: entity not found: ${entityId}`);
    this.name = 'ObservationTargetNotFoundError';
    this.entityId = entityId;
  }
}
jest.mock('@/lib/graph/proactive-insights', () => ({
  __esModule: true,
  recordAgentObservation: (...a: unknown[]) => mockRecordAgentObservation(...a),
  ObservationTargetNotFoundError: MockObservationTargetNotFoundError,
}));

const {
  INTEREST_TOOLS,
  executeRefreshInterestFromActivity,
  executeDiscoverNetNewTechnologies,
  executeRecommendArtifact,
  executeRecordAgentObservation,
} = require('../interest-tools');

describe('refreshInterestFromActivity tool', () => {
  beforeEach(() => jest.clearAllMocks());

  it('declares the tool with no required params', () => {
    const tool = INTEREST_TOOLS.find((t: { name: string }) => t.name === 'refreshInterestFromActivity');
    expect(tool).toBeDefined();
    expect(tool.parameters.properties).toEqual({});
  });

  it('derives interest for the authenticated user and returns the topics', async () => {
    mockDerive.mockResolvedValue({ topics: ['vector-database', 'llm'], seeded: 2 });
    const res = await executeRefreshInterestFromActivity({ userId: 'u1' });
    expect(mockDerive).toHaveBeenCalledWith('u1');
    expect(res.success).toBe(true);
    expect(res.data.topics).toEqual(['vector-database', 'llm']);
    expect(res.data.seeded).toBe(2);
  });

  it('handles the no-activity case gracefully (success, empty topics)', async () => {
    mockDerive.mockResolvedValue({ topics: [], seeded: 0 });
    const res = await executeRefreshInterestFromActivity({ userId: 'u1' });
    expect(res.success).toBe(true);
    expect(res.data.topics).toEqual([]);
  });

  it('errors without an authenticated user (no derive call)', async () => {
    const res = await executeRefreshInterestFromActivity({});
    expect(res.success).toBe(false);
    expect(mockDerive).not.toHaveBeenCalled();
  });

  it('surfaces a derive failure as a tool error, never throwing', async () => {
    mockDerive.mockRejectedValue(new Error('neo4j down'));
    const res = await executeRefreshInterestFromActivity({ userId: 'u1' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('neo4j down');
  });
});

describe('discoverNetNewTechnologies tool', () => {
  beforeEach(() => jest.clearAllMocks());

  it('declares the tool with an optional limit param', () => {
    const tool = INTEREST_TOOLS.find((t: { name: string }) => t.name === 'discoverNetNewTechnologies');
    expect(tool).toBeDefined();
    expect(tool.parameters.properties.limit).toBeDefined();
  });

  it('discovers net-new tech for the authenticated user (default limit 5)', async () => {
    mockDiscoverNetNew.mockResolvedValue({
      proposed: 2,
      proposedNames: ['Pinecone', 'Weaviate'],
      topics: ['vector-database'],
      ok: true,
    });
    const res = await executeDiscoverNetNewTechnologies({}, { userId: 'u1' });
    expect(mockDiscoverNetNew).toHaveBeenCalledWith('u1', { limit: 5 });
    expect(res.success).toBe(true);
    expect(res.data.proposed).toBe(2);
    expect(res.data.message).toContain('Discovered 2 new');
  });

  it('DISC-015: returns a sanitized tool failure for an unusable model response', async () => {
    mockDiscoverNetNew.mockResolvedValue({
      proposed: 0,
      proposedNames: [],
      topics: ['vector-database'],
      ok: false,
      error: 'Schema validation failed: candidates: Required',
    });
    const res = await executeDiscoverNetNewTechnologies({}, { userId: 'u1' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/could not complete/i);
    expect(res.error).not.toContain('Schema validation failed');
    expect(res.error).not.toContain('candidates: Required');
    expect(res.data).toBeUndefined();
  });

  it('caps the limit at 10', async () => {
    mockDiscoverNetNew.mockResolvedValue({ proposed: 0, proposedNames: [], topics: [] });
    await executeDiscoverNetNewTechnologies({ limit: 99 }, { userId: 'u1' });
    expect(mockDiscoverNetNew).toHaveBeenCalledWith('u1', { limit: 10 });
  });

  it('errors without an authenticated user', async () => {
    const res = await executeDiscoverNetNewTechnologies({ limit: 5 }, {});
    expect(res.success).toBe(false);
    expect(mockDiscoverNetNew).not.toHaveBeenCalled();
  });

  it('surfaces a discovery failure as a tool error, never throwing', async () => {
    mockDiscoverNetNew.mockRejectedValue(new Error('gemini down'));
    const res = await executeDiscoverNetNewTechnologies({ limit: 5 }, { userId: 'u1' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('gemini down');
  });
});

describe('recommendArtifact tool', () => {
  beforeEach(() => jest.clearAllMocks());

  it('declares the tool with the required fields', () => {
    const decl = (
      INTEREST_TOOLS as Array<{ name: string; description?: string; parameters?: { required?: string[] } }>
    ).find((t) => t.name === 'recommendArtifact');
    expect(decl).toBeTruthy();
    expect(decl?.parameters?.required).toEqual(['artifactKind', 'title']);
    expect(decl?.description).toContain('Only when you proactively spot');
    expect(decl?.description).toContain('Do NOT use this when the user explicitly asks');
  });

  it('stages a recommendation for the signed-in user', async () => {
    mockCreateArtifact.mockResolvedValue({ created: true, entity: { id: 'a1' } });
    const res = await executeRecommendArtifact(
      { artifactKind: 'report', title: 'AI agents report', rationale: 'hot', query: 'AI agents' },
      { userId: 'u1' }
    );
    expect(res.success).toBe(true);
    expect(res.data.id).toBe('a1');
    expect(mockCreateArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ artifactKind: 'report', title: 'AI agents report', sourceUserId: 'u1' })
    );
  });

  it('rejects an invalid artifactKind without staging anything', async () => {
    const res = await executeRecommendArtifact({ artifactKind: 'podcast', title: 'x' }, { userId: 'u1' });
    expect(res.success).toBe(false);
    expect(mockCreateArtifact).not.toHaveBeenCalled();
  });

  it('requires an authenticated user', async () => {
    const res = await executeRecommendArtifact({ artifactKind: 'report', title: 'x' }, {});
    expect(res.success).toBe(false);
  });
});

describe('recordAgentObservation tool', () => {
  beforeEach(() => jest.clearAllMocks());

  it('declares the tool with the required fields', () => {
    const decl = (
      INTEREST_TOOLS as Array<{
        name: string;
        parameters?: { properties?: Record<string, { enum?: string[] }>; required?: string[] };
      }>
    ).find((t) => t.name === 'recordAgentObservation');
    expect(decl).toBeTruthy();
    expect(decl?.parameters?.properties?.observationType).toBeDefined();
    expect(decl?.parameters?.properties?.title).toBeDefined();
    expect(decl?.parameters?.properties?.summary).toBeDefined();
    expect(decl?.parameters?.properties?.confidence).toBeDefined();
    expect(decl?.parameters?.properties?.entityId).toBeDefined();
    expect(decl?.parameters?.properties?.agentType).toBeDefined();
    expect(decl?.parameters?.required).toEqual(['observationType', 'title', 'summary', 'confidence', 'entityId']);
    expect(decl?.parameters?.properties?.observationType.enum).toEqual([
      'discovery',
      'connection',
      'scoring_change',
      'pattern',
    ]);
    // 'update' is deliberately excluded — reserved for the interest-watch lane.
    expect(decl?.parameters?.properties?.observationType.enum).not.toContain('update');
  });

  it('converts 0-100 tool confidence to the 0-1 store scale and derives entityName/entityType from the graph', async () => {
    mockGetEntity.mockResolvedValue({
      id: 'tech-qdrant',
      labels: ['Technology'],
      properties: { name: 'Qdrant', entityType: 'technology' },
    });
    mockRecordAgentObservation.mockResolvedValue({
      id: 'obs-1',
      agentType: 'ai-assistant',
      observationType: 'discovery',
      title: 'New release',
      summary: 'Qdrant shipped a new feature.',
      confidence: 0.8,
      entityId: 'tech-qdrant',
      entityName: 'Qdrant',
      entityType: 'technology',
      timestamp: '2026-07-05T00:00:00.000Z',
    });

    const res = await executeRecordAgentObservation({
      observationType: 'discovery',
      title: 'New release',
      summary: 'Qdrant shipped a new feature.',
      confidence: 80,
      entityId: 'tech-qdrant',
    });

    expect(mockGetEntity).toHaveBeenCalledWith('tech-qdrant');
    expect(mockRecordAgentObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        agentType: 'ai-assistant',
        observationType: 'discovery',
        confidence: 0.8,
        entityId: 'tech-qdrant',
        entityName: 'Qdrant',
        entityType: 'technology',
      })
    );
    expect(res.success).toBe(true);
  });

  it('refuses to write when the entity does not exist (orphan guard)', async () => {
    mockGetEntity.mockResolvedValue(null);

    const res = await executeRecordAgentObservation({
      observationType: 'discovery',
      title: 'x',
      summary: 'y',
      confidence: 50,
      entityId: 'missing-entity',
    });

    expect(res.success).toBe(false);
    expect(mockRecordAgentObservation).not.toHaveBeenCalled();
  });

  it('rejects invalid arguments via Zod', async () => {
    const res = await executeRecordAgentObservation({
      observationType: 'update', // deliberately excluded
      title: '',
      summary: 'y',
      confidence: 150,
      entityId: 'tech-qdrant',
    });

    expect(res.success).toBe(false);
    expect(mockGetEntity).not.toHaveBeenCalled();
    expect(mockRecordAgentObservation).not.toHaveBeenCalled();
  });

  it('surfaces a service failure as a tool error, never throwing', async () => {
    mockGetEntity.mockResolvedValue({
      id: 'tech-qdrant',
      labels: ['Technology'],
      properties: { name: 'Qdrant', entityType: 'technology' },
    });
    mockRecordAgentObservation.mockRejectedValue(new Error('neo4j down'));

    const res = await executeRecordAgentObservation({
      observationType: 'discovery',
      title: 'x',
      summary: 'y',
      confidence: 50,
      entityId: 'tech-qdrant',
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain('neo4j down');
  });
});

// ---------------------------------------------------------------------------
// AI-007 — chat working-style memory tool trio (consent-by-construction)
// ---------------------------------------------------------------------------

const mockAddStyleNote = jest.fn();
const mockGetChatPreferences = jest.fn();
const mockClearStyleNotes = jest.fn();
jest.mock('@/lib/chat-preferences-admin', () => ({
  __esModule: true,
  addStyleNote: (...a: unknown[]) => mockAddStyleNote(...a),
  getChatPreferences: (...a: unknown[]) => mockGetChatPreferences(...a),
  clearStyleNotes: (...a: unknown[]) => mockClearStyleNotes(...a),
}));

const {
  executeSaveWorkingStylePreference,
  executeListWorkingStylePreferences,
  executeClearWorkingStylePreferences,
} = require('../interest-tools');

describe('working-style tool declarations (AI-007)', () => {
  const byName = (n: string) =>
    (INTEREST_TOOLS as Array<{ name: string; description?: string }>).find((t) => t.name === n);

  it('declares the trio', () => {
    expect(byName('saveWorkingStylePreference')).toBeDefined();
    expect(byName('listWorkingStylePreferences')).toBeDefined();
    expect(byName('clearWorkingStylePreferences')).toBeDefined();
  });

  it('save/clear descriptions make explicit consent a hard precondition (never infer)', () => {
    expect(byName('saveWorkingStylePreference')!.description).toMatch(/ONLY when the USER explicitly asks/i);
    expect(byName('saveWorkingStylePreference')!.description).toMatch(/NEVER infer/i);
    expect(byName('clearWorkingStylePreferences')!.description).toMatch(/explicitly asks/i);
  });
});

describe('executeSaveWorkingStylePreference', () => {
  beforeEach(() => jest.clearAllMocks());

  it('requires an authenticated user', async () => {
    const res = await executeSaveWorkingStylePreference({ note: 'x' }, {});
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/authenticated/i);
    expect(mockAddStyleNote).not.toHaveBeenCalled();
  });

  it('rejects an empty note without touching the store', async () => {
    const res = await executeSaveWorkingStylePreference({ note: '   ' }, { userId: 'u1' });
    expect(res.success).toBe(false);
    expect(mockAddStyleNote).not.toHaveBeenCalled();
  });

  it('saves the note and reports total + eviction', async () => {
    mockAddStyleNote.mockResolvedValue({
      note: { id: 'n1', note: 'Keep answers short.', createdAt: 'now' },
      total: 10,
      evicted: 1,
    });
    const res = await executeSaveWorkingStylePreference({ note: 'Keep answers short.' }, { userId: 'u1' });
    expect(res.success).toBe(true);
    expect(mockAddStyleNote).toHaveBeenCalledWith('u1', 'Keep answers short.');
    expect(res.data.total).toBe(10);
    expect(res.data.message).toMatch(/evicted/);
  });

  it('surfaces store failures (e.g. the cap error) as tool errors, never throws', async () => {
    mockAddStyleNote.mockRejectedValue(new Error('A working-style note must be at most 240 characters.'));
    const res = await executeSaveWorkingStylePreference({ note: 'x'.repeat(10) }, { userId: 'u1' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/240 characters/);
  });
});

describe('executeListWorkingStylePreferences', () => {
  beforeEach(() => jest.clearAllMocks());

  it('requires an authenticated user', async () => {
    const res = await executeListWorkingStylePreferences({});
    expect(res.success).toBe(false);
  });

  it('returns the stored notes', async () => {
    mockGetChatPreferences.mockResolvedValue({
      userId: 'u1',
      updatedAt: 'now',
      styleNotes: [{ id: 'n1', note: 'Always show sources.', createdAt: 't1' }],
    });
    const res = await executeListWorkingStylePreferences({ userId: 'u1' });
    expect(res.success).toBe(true);
    expect(res.data.count).toBe(1);
    expect(res.data.notes).toEqual([{ note: 'Always show sources.', savedAt: 't1' }]);
  });

  it('reports an empty store as zero notes (not an error)', async () => {
    mockGetChatPreferences.mockResolvedValue(null);
    const res = await executeListWorkingStylePreferences({ userId: 'u1' });
    expect(res.success).toBe(true);
    expect(res.data.count).toBe(0);
  });
});

describe('executeClearWorkingStylePreferences', () => {
  beforeEach(() => jest.clearAllMocks());

  it('requires an authenticated user', async () => {
    const res = await executeClearWorkingStylePreferences({});
    expect(res.success).toBe(false);
    expect(mockClearStyleNotes).not.toHaveBeenCalled();
  });

  it('clears and reports the count', async () => {
    mockClearStyleNotes.mockResolvedValue({ cleared: 3 });
    const res = await executeClearWorkingStylePreferences({ userId: 'u1' });
    expect(res.success).toBe(true);
    expect(mockClearStyleNotes).toHaveBeenCalledWith('u1');
    expect(res.data.cleared).toBe(3);
  });

  it('surfaces store failures as tool errors', async () => {
    mockClearStyleNotes.mockRejectedValue(new Error('firestore down'));
    const res = await executeClearWorkingStylePreferences({ userId: 'u1' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/firestore down/);
  });
});
