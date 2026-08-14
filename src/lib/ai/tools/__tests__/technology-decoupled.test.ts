/**
 * Unit Tests for Decoupled Technology AI Tools
 *
 * Tests all execution functions for the decoupled technology model:
 * - executeCreateDecoupledTechnology
 * - executeUpdateDecoupledTechnology
 * - executePlaceTechnologyOnRadar
 * - executeMoveDecoupledTechnologyRing
 * - executeSearchDecoupledTechnologies
 * - executeGetDecoupledTechnologyDetails
 * - executeDeleteDecoupledTechnology
 * - executeRemoveTechnologyFromRadar
 * - executeResearchTechnologyComprehensive
 * - executeConfirmPlacement
 * - TECHNOLOGY_DECOUPLED_TOOLS definitions
 *
 * @jest-environment node
 */

// ============================================================================
// Mocks (BEFORE any imports)
// ============================================================================

jest.mock('@/lib/firebase', () => {
  throw new Error('technology tools must not import the Firebase client runtime');
});
jest.mock('firebase/firestore', () => {
  throw new Error('technology tools must not import firebase/firestore');
});

// The source migrated its data access from the client service modules onto
// admin helpers (`@/lib/technology-admin`, `@/lib/radar-placement-admin`,
// `@/lib/radars-admin`). The mock-fn variable names are kept identical to the
// pre-migration test so all downstream assertions stay intact — only the
// jest.mock() targets and exported names are retargeted.
const mockCreateTechnology = jest.fn();
const mockUpdateTechnology = jest.fn();
const mockGetTechnologies = jest.fn();
const mockGetTechnologyById = jest.fn();
const mockDeleteTechnologyCompletely = jest.fn();

jest.mock('@/lib/technology-admin', () => ({
  __esModule: true,
  adminCreateTechnology: (...args: unknown[]) => mockCreateTechnology(...args),
  adminUpdateTechnology: (...args: unknown[]) => mockUpdateTechnology(...args),
  adminGetTechnologies: (...args: unknown[]) => mockGetTechnologies(...args),
  adminGetTechnologyById: (...args: unknown[]) => mockGetTechnologyById(...args),
  adminDeleteTechnologyCompletely: (...args: unknown[]) => mockDeleteTechnologyCompletely(...args),
}));

const mockCreateRadarPlacement = jest.fn();
const mockCreateRadarPlacementWithHandoff = jest.fn(async (...args: unknown[]) => ({
  placement: await mockCreateRadarPlacement(...args),
  graphHandoff: { acknowledged: true, reconciliationRequired: false },
}));
// The source no longer calls a moveTechnologyRing helper — ring moves now go
// through adminUpdateRadarPlacementWithHandoff(placementId, { ring, rationale }, { requireOwnerId }).
const mockUpdateRadarPlacement = jest.fn();
const mockUpdateRadarPlacementWithHandoff = jest.fn(async (...args: unknown[]) => ({
  placement: await mockUpdateRadarPlacement(...args),
  graphHandoff: { acknowledged: true, reconciliationRequired: false },
}));
const mockGetPlacementsForTechnology = jest.fn();
const mockGetPlacementForTechnologyOnRadar = jest.fn();
const mockDeleteRadarPlacement = jest.fn();

jest.mock('@/lib/radar-placement-admin', () => ({
  __esModule: true,
  adminCreateRadarPlacementWithHandoff: (...args: unknown[]) => mockCreateRadarPlacementWithHandoff(...args),
  adminUpdateRadarPlacementWithHandoff: (...args: unknown[]) => mockUpdateRadarPlacementWithHandoff(...args),
  adminGetRadarPlacements: (...args: unknown[]) => mockGetPlacementsForTechnology(...args),
  adminGetPlacementForTechnologyOnRadar: (...args: unknown[]) => mockGetPlacementForTechnologyOnRadar(...args),
  // Placement removal migrated onto the admin twin, then onto the acknowledged
  // GRAPH-060 handoff variant so removal reports committed-vs-pending truth.
  adminDeleteRadarPlacementWithHandoff: async (...args: unknown[]) => {
    await mockDeleteRadarPlacement(...args);
    return { graphHandoff: { committed: true, acknowledged: true, reconciliationRequired: false } };
  },
  PlacementAuthorizationError: class PlacementAuthorizationError extends Error {},
}));

// adminListRadars + adminGetRadarById + adminGetOwnedRadarById all live in @/lib/radars-admin. The
// source uses adminListRadars for default-radar resolution and
// adminGetRadarById for quadrant name→id resolution and adminGetOwnedRadarById for authorization.
const mockGetRadars = jest.fn();
const mockGetRadarById = jest.fn();
const mockGetOwnedRadarById = jest.fn();
jest.mock('@/lib/radars-admin', () => ({
  __esModule: true,
  adminListRadars: (...args: unknown[]) => mockGetRadars(...args),
  adminGetRadarById: (...args: unknown[]) => mockGetRadarById(...args),
  adminGetOwnedRadarById: (...args: unknown[]) => mockGetOwnedRadarById(...args),
  RadarAuthorizationError: class RadarAuthorizationError extends Error {},
}));

// Default radar fixture with the standard 4 quadrants — tests can override per-case
const DEFAULT_RADAR_FIXTURE = {
  id: 'radar-1',
  name: 'Test Radar',
  quadrants: [
    { id: 'q_techniques', name: 'Techniques', order: 0 },
    { id: 'q_tools', name: 'Tools', order: 1 },
    { id: 'q_platforms', name: 'Platforms', order: 2 },
    { id: 'q_languages_frameworks', name: 'Languages & Frameworks', order: 3 },
  ],
};

const mockEmitDataRefresh = jest.fn();
jest.mock('@/lib/events/data-refresh', () => ({
  __esModule: true,
  emitDataRefresh: (...args: unknown[]) => mockEmitDataRefresh(...args),
}));

jest.mock('@/lib/ai/signal-evaluation', () => ({
  __esModule: true,
  cleanMarkdownFromText: (text: string) => text,
}));

// Reality-check verifiers make REAL network calls in `executeCreateDecoupledTechnology`
// (verifyUrlsReachable runs whenever URLs are provided). Left unmocked they hit
// the live web and flake under parallel load — mock them deterministically.
jest.mock('@/lib/scout-url-verifier', () => ({
  __esModule: true,
  verifyUrlsReachable: jest.fn(async () => ({ ok: true })),
}));
jest.mock('@/lib/entity-reality-check', () => ({
  __esModule: true,
  verifyEntityReality: jest.fn(async () => ({ ok: true })),
}));

jest.mock('@/lib/entity-factory', () => {
  throw new Error('technology tools must not import the Firebase client entity factory');
});

const mockInngestSend = jest.fn();
jest.mock('@/lib/inngest/client', () => ({
  __esModule: true,
  inngest: {
    send: (...args: unknown[]) => mockInngestSend(...args),
  },
}));

const mockClaimResearchDispatch = jest.fn();
const mockReleaseResearchPending = jest.fn();
jest.mock('@/lib/technology-research-admin', () => ({
  __esModule: true,
  claimResearchDispatch: (...args: unknown[]) => mockClaimResearchDispatch(...args),
  releaseResearchPending: (...args: unknown[]) => mockReleaseResearchPending(...args),
}));

// ============================================================================
// Import module under test (AFTER mocks)
// ============================================================================

const {
  TECHNOLOGY_DECOUPLED_TOOLS,
  executeCreateDecoupledTechnology,
  executeUpdateDecoupledTechnology,
  executePlaceTechnologyOnRadar,
  executeMoveDecoupledTechnologyRing,
  executeSearchDecoupledTechnologies,
  executeGetDecoupledTechnologyDetails,
  executeDeleteDecoupledTechnology,
  executeRemoveTechnologyFromRadar,
  executeResearchTechnologyComprehensive,
  executeConfirmPlacement,
} = require('../technology-decoupled');
import {
  _resetConfirmationStore,
  destructiveActionFingerprint,
  destructiveConfirmationPhrase,
} from '@/lib/ai/destructive-confirmation';

// ============================================================================
// Tests
// ============================================================================

describe('Technology Decoupled Tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetConfirmationStore();
    // Default: every radar lookup returns the standard 4-quadrant fixture so
    // name→id resolution succeeds. Individual tests can override.
    mockGetRadarById.mockResolvedValue(DEFAULT_RADAR_FIXTURE);
    mockGetOwnedRadarById.mockResolvedValue({ id: DEFAULT_RADAR_FIXTURE.id, ownerId: 'user-1' });
    mockClaimResearchDispatch.mockImplementation(async (_id: string, startedAt: number) => ({
      claimed: true,
      reason: 'idle',
      startedAt,
    }));
    mockReleaseResearchPending.mockResolvedValue({ released: true });
  });

  // ========================================================================
  // Tool Definitions
  // ========================================================================

  describe('TECHNOLOGY_DECOUPLED_TOOLS definitions', () => {
    it('should export an array of tool declarations', () => {
      expect(Array.isArray(TECHNOLOGY_DECOUPLED_TOOLS)).toBe(true);
      expect(TECHNOLOGY_DECOUPLED_TOOLS.length).toBeGreaterThan(0);
    });

    it('should include all expected tool names', () => {
      const toolNames = TECHNOLOGY_DECOUPLED_TOOLS.map((t: { name: string }) => t.name);
      expect(toolNames).toContain('createDecoupledTechnology');
      expect(toolNames).toContain('updateDecoupledTechnology');
      expect(toolNames).toContain('placeTechnologyOnRadar');
      expect(toolNames).toContain('moveDecoupledTechnologyRing');
      expect(toolNames).toContain('searchDecoupledTechnologies');
      expect(toolNames).toContain('getDecoupledTechnologyDetails');
      expect(toolNames).toContain('deleteDecoupledTechnology');
      expect(toolNames).toContain('removeTechnologyFromRadar');
      expect(toolNames).toContain('researchTechnologyComprehensive');
      expect(toolNames).toContain('confirmPlacement');
    });

    it('should have name, description, and parameters for each tool', () => {
      for (const tool of TECHNOLOGY_DECOUPLED_TOOLS) {
        expect(tool.name).toBeDefined();
        expect(typeof tool.name).toBe('string');
        expect(tool.description).toBeDefined();
        expect(typeof tool.description).toBe('string');
        expect(tool.parameters).toBeDefined();
        expect(tool.parameters.type).toBeDefined();
      }
    });

    it('should have required fields for createDecoupledTechnology', () => {
      const tool = TECHNOLOGY_DECOUPLED_TOOLS.find((t: { name: string }) => t.name === 'createDecoupledTechnology');
      expect(tool.parameters.required).toContain('name');
      expect(tool.parameters.required).toContain('description');
    });

    it('should have required fields for placeTechnologyOnRadar', () => {
      const tool = TECHNOLOGY_DECOUPLED_TOOLS.find((t: { name: string }) => t.name === 'placeTechnologyOnRadar');
      expect(tool.parameters.required).toContain('technologyId');
      expect(tool.parameters.required).toContain('quadrant');
      expect(tool.parameters.required).toContain('ring');
    });
  });

  // ========================================================================
  // executeCreateDecoupledTechnology
  // ========================================================================

  describe('executeCreateDecoupledTechnology', () => {
    it('should create a technology with name and description', async () => {
      mockCreateTechnology.mockResolvedValue({
        id: 'tech-1',
        name: 'LangChain',
        slug: 'langchain',
      });

      const result = await executeCreateDecoupledTechnology({
        name: 'LangChain',
        description: 'Framework for building LLM-powered applications',
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.id).toBe('tech-1');
      expect(result.data.name).toBe('LangChain');
      expect(result.data.slug).toBe('langchain');
      expect(mockCreateTechnology).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'LangChain',
          description: 'Framework for building LLM-powered applications',
          createdBy: 'ai-assistant',
        })
      );
    });

    it('should pass optional fields (tags, URLs, category)', async () => {
      mockCreateTechnology.mockResolvedValue({
        id: 'tech-2',
        name: 'React',
        slug: 'react',
      });

      await executeCreateDecoupledTechnology({
        name: 'React',
        description: 'UI library',
        category: 'framework',
        tags: ['frontend', 'javascript'],
        websiteUrl: 'https://react.dev',
        githubUrl: 'https://github.com/facebook/react',
        documentationUrl: 'https://react.dev/docs',
      });

      expect(mockCreateTechnology).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'framework',
          tags: ['frontend', 'javascript'],
          websiteUrl: 'https://react.dev',
          githubUrl: 'https://github.com/facebook/react',
          documentationUrl: 'https://react.dev/docs',
        })
      );
    });

    it('should return error on failure', async () => {
      mockCreateTechnology.mockRejectedValue(new Error('Firestore write failed'));

      const result = await executeCreateDecoupledTechnology({
        name: 'BadTech',
        description: 'Will fail',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Firestore write failed');
    });

    it('should handle non-Error exceptions gracefully', async () => {
      mockCreateTechnology.mockRejectedValue('string error');

      const result = await executeCreateDecoupledTechnology({
        name: 'Broken',
        description: 'Fails with string',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to create technology');
    });

    it('should generate slug from name', async () => {
      mockCreateTechnology.mockResolvedValue({
        id: 'tech-3',
        name: 'Apache Kafka',
        slug: 'apache-kafka',
      });

      await executeCreateDecoupledTechnology({
        name: 'Apache Kafka',
        description: 'Streaming platform',
      });

      // Slug generation is now inlined in the source (no longer imported from
      // technology-service), so we assert on the computed value passed to the
      // admin create call rather than on a slug-helper spy.
      expect(mockCreateTechnology).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'apache-kafka',
        })
      );
    });
  });

  // ========================================================================
  // executeUpdateDecoupledTechnology
  // ========================================================================

  describe('executeUpdateDecoupledTechnology', () => {
    it('should require confirmation before updating', async () => {
      const result = await executeUpdateDecoupledTechnology({
        technologyId: 'tech-1',
        updates: { description: 'Updated desc' },
        confirmed: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('confirmation');
      expect(mockUpdateTechnology).not.toHaveBeenCalled();
    });

    it('should update technology when confirmed', async () => {
      mockUpdateTechnology.mockResolvedValue({
        id: 'tech-1',
        name: 'React',
      });

      const result = await executeUpdateDecoupledTechnology({
        technologyId: 'tech-1',
        updates: { description: 'Updated description' },
        confirmed: true,
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.id).toBe('tech-1');
      expect(result.data.updated).toEqual(['description']);
      expect(mockUpdateTechnology).toHaveBeenCalledWith('tech-1', {
        description: 'Updated description',
      });
    });

    it('should return list of updated fields even when unconfirmed', async () => {
      const result = await executeUpdateDecoupledTechnology({
        technologyId: 'tech-1',
        updates: { description: 'New', tags: ['a', 'b'] },
        confirmed: false,
      });

      expect(result.data.updated).toEqual(expect.arrayContaining(['description', 'tags']));
    });

    it('should handle update errors', async () => {
      mockUpdateTechnology.mockRejectedValue(new Error('Update failed'));

      const result = await executeUpdateDecoupledTechnology({
        technologyId: 'tech-bad',
        updates: { name: 'X' },
        confirmed: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Update failed');
    });
  });

  // ========================================================================
  // executePlaceTechnologyOnRadar
  // ========================================================================

  describe('executePlaceTechnologyOnRadar', () => {
    it('should place technology on a specified radar', async () => {
      mockGetTechnologyById.mockResolvedValue({ id: 'tech-1', name: 'React' });
      mockCreateRadarPlacement.mockResolvedValue({
        id: 'pl-1',
        ring: 'Adopt',
        quadrant: 'Languages & Frameworks',
      });

      const result = await executePlaceTechnologyOnRadar(
        {
          technologyId: 'tech-1',
          radarId: 'radar-1',
          quadrant: 'Languages & Frameworks',
          ring: 'Adopt',
          rationale: 'Battle-tested',
          status: 'Stable',
        },
        { userId: 'user-1' }
      );

      expect(result.success).toBe(true);
      expect(result.data.placementId).toBe('pl-1');
      expect(result.data.technologyId).toBe('tech-1');
      expect(result.data.radarId).toBe('radar-1');
      // The tool now resolves display name → stable quadrantId before writing
      expect(mockCreateRadarPlacement).toHaveBeenCalledWith(
        expect.objectContaining({
          technologyId: 'tech-1',
          radarId: 'radar-1',
          quadrantId: 'q_languages_frameworks',
          ring: 'Adopt',
          status: 'Stable',
          placedBy: 'user-1',
        }),
        { requireOwnerId: 'user-1' }
      );
    });

    it('AI-022: resolves quadrant collisions name-first (same contract as bulk placement) and does not trim quadrant names', async () => {
      mockGetTechnologyById.mockResolvedValue({ id: 'tech-1', name: 'React' });
      mockGetRadarById.mockResolvedValue({
        ...DEFAULT_RADAR_FIXTURE,
        quadrants: [
          { id: 'q_name_target', name: 'collision', order: 0 },
          { id: 'collision', name: 'ID target', order: 1 },
        ],
      });
      mockCreateRadarPlacement.mockResolvedValue({ id: 'pl-collision', ring: 'Adopt' });

      const collision = await executePlaceTechnologyOnRadar(
        {
          technologyId: 'tech-1',
          radarId: 'radar-1',
          quadrant: 'collision',
          ring: 'Adopt',
        },
        { userId: 'user-1' }
      );
      const spaced = await executePlaceTechnologyOnRadar(
        {
          technologyId: 'tech-1',
          radarId: 'radar-1',
          quadrant: ' collision ',
          ring: 'Adopt',
        },
        { userId: 'user-1' }
      );

      expect(collision.success).toBe(true);
      // Display-name input wins the cross-collision, exactly like
      // executeAddTechnologiesToRadar's name-first quadrant contract.
      expect(mockCreateRadarPlacement).toHaveBeenCalledWith(expect.objectContaining({ quadrantId: 'q_name_target' }), {
        requireOwnerId: 'user-1',
      });
      expect(spaced.success).toBe(false);
      expect(spaced.error).toContain('not found');
      expect(mockCreateRadarPlacement).toHaveBeenCalledTimes(1);
    });

    it('should use the ONLY existing radar when radarId not provided (deterministic, not a guess)', async () => {
      mockGetTechnologyById.mockResolvedValue({ id: 'tech-1', name: 'React' });
      // The resolver consumes the listed radar directly (adminListRadars
      // returns full docs in production, quadrants included).
      mockGetRadars.mockResolvedValue([{ ...DEFAULT_RADAR_FIXTURE, id: 'default-radar', name: 'Default' }]);
      mockCreateRadarPlacement.mockResolvedValue({
        id: 'pl-2',
        ring: 'Trial',
        quadrant: 'Tools',
      });

      const result = await executePlaceTechnologyOnRadar(
        {
          technologyId: 'tech-1',
          quadrant: 'Tools',
          ring: 'Trial',
        },
        { userId: 'user-1' }
      );

      expect(result.success).toBe(true);
      expect(result.data.radarId).toBe('default-radar');
    });

    it('should return error when technology not found', async () => {
      mockGetTechnologyById.mockResolvedValue(null);

      const result = await executePlaceTechnologyOnRadar(
        {
          technologyId: 'tech-missing',
          quadrant: 'Tools',
          ring: 'Adopt',
        },
        { userId: 'user-1' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    // ------------------------------------------------------------------------
    // AI-022 — shared exact resolver + idempotent convergence
    // ------------------------------------------------------------------------
    it('AI-022: resolves an exact radar NAME with custom quadrants (parity with bulk placement)', async () => {
      const customRadar = {
        id: 'radar-custom',
        name: 'Emerging Tech Radar',
        quadrants: [
          { id: 'q_sense', name: 'Sense', order: 0 },
          { id: 'q_shape', name: 'Shape', order: 1 },
          { id: 'q_scale', name: 'Scale', order: 2 },
          { id: 'q_sustain', name: 'Sustain', order: 3 },
        ],
      };
      mockGetTechnologyById.mockResolvedValue({ id: 'tech-1', name: 'React' });
      mockGetRadarById.mockResolvedValue(null); // name is not a document ID
      mockGetRadars.mockResolvedValue([DEFAULT_RADAR_FIXTURE, customRadar]);
      mockGetPlacementForTechnologyOnRadar.mockResolvedValueOnce(null);
      mockCreateRadarPlacement.mockResolvedValue({ id: 'pl-custom', ring: 'Assess' });

      const result = await executePlaceTechnologyOnRadar(
        {
          technologyId: 'tech-1',
          radarId: 'emerging tech radar',
          quadrant: 'Shape',
          ring: 'Assess',
        },
        { userId: 'user-1' }
      );

      expect(result.success).toBe(true);
      expect(result.data.radarId).toBe('radar-custom');
      expect(result.data.quadrant).toBe('Shape');
      expect(mockCreateRadarPlacement).toHaveBeenCalledWith(
        expect.objectContaining({ radarId: 'radar-custom', quadrantId: 'q_shape' }),
        { requireOwnerId: 'user-1' }
      );
    });

    it('AI-022: an ambiguous radar name asks for clarification and writes nothing', async () => {
      mockGetTechnologyById.mockResolvedValue({ id: 'tech-1', name: 'React' });
      mockGetRadarById.mockResolvedValue(null);
      mockGetRadars.mockResolvedValue([
        { id: 'radar-x', name: 'Tech Radar', quadrants: [] },
        { id: 'radar-y', name: 'tech radar', quadrants: [] },
      ]);

      const result = await executePlaceTechnologyOnRadar(
        {
          technologyId: 'tech-1',
          radarId: 'Tech Radar',
          quadrant: 'Tools',
          ring: 'Adopt',
        },
        { userId: 'user-1' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('matches 2 radars');
      expect(result.error).toContain('radar-x');
      expect(result.error).toContain('radar-y');
      expect(mockCreateRadarPlacement).not.toHaveBeenCalled();
      expect(mockUpdateRadarPlacement).not.toHaveBeenCalled();
    });

    it('AI-022: a repeated identical placement converges by updating, never duplicating or failing', async () => {
      mockGetTechnologyById.mockResolvedValue({ id: 'tech-1', name: 'React' });
      mockGetRadarById.mockResolvedValue(DEFAULT_RADAR_FIXTURE);
      mockGetPlacementForTechnologyOnRadar.mockResolvedValueOnce({
        id: 'pl-existing',
        ring: 'Trial',
        quadrantId: 'q_tools',
      });
      mockUpdateRadarPlacement.mockResolvedValue({ id: 'pl-existing' });

      const result = await executePlaceTechnologyOnRadar(
        {
          technologyId: 'tech-1',
          radarId: 'radar-1',
          quadrant: 'Tools',
          ring: 'Trial',
        },
        { userId: 'user-1' }
      );

      expect(result.success).toBe(true);
      expect(result.data.placementId).toBe('pl-existing');
      expect(mockUpdateRadarPlacement).toHaveBeenCalledWith(
        'pl-existing',
        expect.objectContaining({ quadrantId: 'q_tools', ring: 'Trial' }),
        { requireOwnerId: 'user-1' }
      );
      expect(mockCreateRadarPlacement).not.toHaveBeenCalled();
    });

    it('should return error when no radars exist and no radarId provided', async () => {
      mockGetTechnologyById.mockResolvedValue({ id: 'tech-1', name: 'React' });
      mockGetRadars.mockResolvedValue([]);

      const result = await executePlaceTechnologyOnRadar(
        {
          technologyId: 'tech-1',
          quadrant: 'Tools',
          ring: 'Adopt',
        },
        { userId: 'user-1' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('No radars exist yet');
    });

    it('should default to "New" status when not specified', async () => {
      mockGetTechnologyById.mockResolvedValue({ id: 'tech-1', name: 'React' });
      mockCreateRadarPlacement.mockResolvedValue({
        id: 'pl-3',
        ring: 'Assess',
        quadrant: 'Techniques',
      });

      await executePlaceTechnologyOnRadar(
        {
          technologyId: 'tech-1',
          radarId: 'radar-1',
          quadrant: 'Techniques',
          ring: 'Assess',
        },
        { userId: 'user-1' }
      );

      expect(mockCreateRadarPlacement).toHaveBeenCalledWith(expect.objectContaining({ status: 'New' }), {
        requireOwnerId: 'user-1',
      });
    });

    it('should forward trlScore and timeToImpact to the placement when provided', async () => {
      // Regression test: when the agent provides TRL and timeToImpact, those
      // values must reach the Firestore placement doc so the entry list
      // renders complete metadata instead of a literal "-".
      mockGetTechnologyById.mockResolvedValue({ id: 'tech-1', name: 'React' });
      mockCreateRadarPlacement.mockResolvedValue({ id: 'pl-annotated', ring: 'Trial' });

      await executePlaceTechnologyOnRadar(
        {
          technologyId: 'tech-1',
          radarId: 'radar-1',
          quadrant: 'Techniques',
          ring: 'Trial',
          trlScore: 7,
          timeToImpact: 'H2',
        },
        { userId: 'user-1' }
      );

      expect(mockCreateRadarPlacement).toHaveBeenCalledWith(
        expect.objectContaining({
          technologyId: 'tech-1',
          ring: 'Trial',
          trlScore: 7,
          timeToImpact: 'H2',
        }),
        { requireOwnerId: 'user-1' }
      );
    });

    it('should OMIT trlScore and timeToImpact from the write when not provided', async () => {
      // Firestore rejects undefined field values — the executor must strip
      // these keys entirely when the agent leaves them out.
      mockGetTechnologyById.mockResolvedValue({ id: 'tech-1', name: 'React' });
      mockCreateRadarPlacement.mockResolvedValue({ id: 'pl-bare', ring: 'Adopt' });

      await executePlaceTechnologyOnRadar(
        {
          technologyId: 'tech-1',
          radarId: 'radar-1',
          quadrant: 'Techniques',
          ring: 'Adopt',
        },
        { userId: 'user-1' }
      );

      const callArgs = mockCreateRadarPlacement.mock.calls[0][0] as Record<string, unknown>;
      expect(callArgs).not.toHaveProperty('trlScore');
      expect(callArgs).not.toHaveProperty('timeToImpact');
      expect(callArgs.ring).toBe('Adopt');
    });

    it('should handle placement creation errors', async () => {
      mockGetTechnologyById.mockResolvedValue({ id: 'tech-1', name: 'React' });
      mockCreateRadarPlacement.mockRejectedValue(new Error('Placement already exists'));

      const result = await executePlaceTechnologyOnRadar(
        {
          technologyId: 'tech-1',
          radarId: 'radar-1',
          quadrant: 'Tools',
          ring: 'Adopt',
        },
        { userId: 'user-1' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Placement already exists');
    });
  });

  // ========================================================================
  // executeMoveDecoupledTechnologyRing
  // ========================================================================

  describe('executeMoveDecoupledTechnologyRing', () => {
    it('should require confirmation before moving', async () => {
      const result = await executeMoveDecoupledTechnologyRing(
        {
          technologyId: 'tech-1',
          radarId: 'radar-1',
          newRing: 'Adopt',
          confirmed: false,
        },
        { userId: 'user-1' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('confirmation');
      expect(mockUpdateRadarPlacement).not.toHaveBeenCalled();
    });

    it('should move technology ring when confirmed', async () => {
      mockGetPlacementForTechnologyOnRadar.mockResolvedValue({
        id: 'pl-1',
        ring: 'Trial',
      });
      mockUpdateRadarPlacement.mockResolvedValue({ id: 'pl-1', ring: 'Adopt' });

      const result = await executeMoveDecoupledTechnologyRing(
        {
          technologyId: 'tech-1',
          radarId: 'radar-1',
          newRing: 'Adopt',
          rationale: 'Proven in production',
          confirmed: true,
        },
        { userId: 'user-1' }
      );

      expect(result.success).toBe(true);
      expect(result.data.oldRing).toBe('Trial');
      expect(result.data.newRing).toBe('Adopt');
      // Ring moves now go through adminUpdateRadarPlacement(placementId, { ring, rationale }).
      expect(mockUpdateRadarPlacement).toHaveBeenCalledWith(
        'pl-1',
        {
          ring: 'Adopt',
          rationale: 'Proven in production',
        },
        { requireOwnerId: 'user-1' }
      );
    });

    it('should return error when placement not found', async () => {
      mockGetPlacementForTechnologyOnRadar.mockResolvedValue(null);

      const result = await executeMoveDecoupledTechnologyRing(
        {
          technologyId: 'tech-1',
          radarId: 'radar-1',
          newRing: 'Hold',
          confirmed: true,
        },
        { userId: 'user-1' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not placed on radar');
    });

    it('should handle move errors', async () => {
      mockGetPlacementForTechnologyOnRadar.mockResolvedValue({
        id: 'pl-1',
        ring: 'Trial',
      });
      mockUpdateRadarPlacement.mockRejectedValue(new Error('Move failed'));

      const result = await executeMoveDecoupledTechnologyRing(
        {
          technologyId: 'tech-1',
          radarId: 'radar-1',
          newRing: 'Adopt',
          confirmed: true,
        },
        { userId: 'user-1' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Move failed');
    });
  });

  // ========================================================================
  // executeSearchDecoupledTechnologies
  // ========================================================================

  describe('executeSearchDecoupledTechnologies', () => {
    it('should search technologies by query', async () => {
      mockGetTechnologies.mockResolvedValue([
        { id: 'tech-1', name: 'React', description: 'UI library', tags: ['frontend'] },
        { id: 'tech-2', name: 'React Native', description: 'Mobile framework', tags: ['mobile'] },
      ]);
      mockGetPlacementsForTechnology.mockResolvedValue([]);

      const result = await executeSearchDecoupledTechnologies({
        query: 'react',
      });

      expect(result.success).toBe(true);
      expect(result.data.count).toBe(2);
      expect(result.data.results).toHaveLength(2);
      expect(result.data.results[0].name).toBe('React');
      // T1-4: navigable entity type on every result item (entity-chip contract)
      expect(result.data.results.every((r: { type: string }) => r.type === 'technology')).toBe(true);
    });

    it('should include placement counts for each technology', async () => {
      mockGetTechnologies.mockResolvedValue([{ id: 'tech-1', name: 'React', description: 'UI lib', tags: [] }]);
      mockGetPlacementsForTechnology.mockResolvedValue([
        { id: 'pl-1', ring: 'Adopt' },
        { id: 'pl-2', ring: 'Trial' },
      ]);

      const result = await executeSearchDecoupledTechnologies({ query: 'react' });

      expect(result.data.results[0].placementsCount).toBe(2);
    });

    it('should pass category and tags filters', async () => {
      mockGetTechnologies.mockResolvedValue([]);

      await executeSearchDecoupledTechnologies({
        query: 'ml',
        category: 'library',
        tags: ['AI', 'python'],
        limit: 5,
      });

      expect(mockGetTechnologies).toHaveBeenCalledWith({
        search: 'ml',
        category: 'library',
        tags: ['AI', 'python'],
        limit: 5,
      });
    });

    it('should cap limit at 50', async () => {
      mockGetTechnologies.mockResolvedValue([]);

      await executeSearchDecoupledTechnologies({
        query: 'test',
        limit: 100,
      });

      expect(mockGetTechnologies).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
    });

    it('should default limit to 10', async () => {
      mockGetTechnologies.mockResolvedValue([]);

      await executeSearchDecoupledTechnologies({ query: 'test' });

      expect(mockGetTechnologies).toHaveBeenCalledWith(expect.objectContaining({ limit: 10 }));
    });

    it('should handle search errors', async () => {
      mockGetTechnologies.mockRejectedValue(new Error('Search failed'));

      const result = await executeSearchDecoupledTechnologies({ query: 'fail' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Search failed');
    });
  });

  // ========================================================================
  // executeGetDecoupledTechnologyDetails
  // ========================================================================

  describe('executeGetDecoupledTechnologyDetails', () => {
    it('should return technology details with placements', async () => {
      mockGetTechnologyById.mockResolvedValue({
        id: 'tech-1',
        name: 'React',
        slug: 'react',
        description: 'UI library',
        category: 'framework',
        tags: ['frontend'],
        websiteUrl: 'https://react.dev',
        githubUrl: 'https://github.com/facebook/react',
        documentationUrl: 'https://react.dev/docs',
        linkedCompanies: [],
        linkedUseCases: [],
        createdAt: 1000,
        updatedAt: 2000,
      });
      mockGetPlacementsForTechnology.mockResolvedValue([
        {
          id: 'pl-1',
          radarId: 'radar-1',
          quadrant: 'Languages & Frameworks',
          ring: 'Adopt',
          status: 'Stable',
          rationale: 'Battle-tested',
          movedFrom: 'Trial',
          movedAt: 1500,
        },
      ]);

      const result = await executeGetDecoupledTechnologyDetails({
        technologyId: 'tech-1',
      });

      expect(result.success).toBe(true);
      expect(result.data.technology.name).toBe('React');
      expect(result.data.technology.slug).toBe('react');
      expect(result.data.placements).toHaveLength(1);
      expect(result.data.placements[0].ring).toBe('Adopt');
      expect(result.data.placementsCount).toBe(1);
    });

    it('should return error when technology not found', async () => {
      mockGetTechnologyById.mockResolvedValue(null);

      const result = await executeGetDecoupledTechnologyDetails({
        technologyId: 'tech-missing',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should handle fetch errors', async () => {
      mockGetTechnologyById.mockRejectedValue(new Error('Fetch error'));

      const result = await executeGetDecoupledTechnologyDetails({
        technologyId: 'tech-err',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Fetch error');
    });
  });

  // ========================================================================
  // executeDeleteDecoupledTechnology
  // ========================================================================

  describe('executeDeleteDecoupledTechnology', () => {
    it.each([undefined, '', '   ', 42, '\ud800'])(
      'rejects an invalid technology ID before confirmation or deletion (%p)',
      async (technologyId) => {
        const result = await executeDeleteDecoupledTechnology({ technologyId, confirmed: true });

        expect(result.success).toBe(false);
        expect(result.error).toContain('non-empty technology ID');
        expect(result.data).toBeUndefined();
        expect(mockDeleteTechnologyCompletely).not.toHaveBeenCalled();
        expect(mockEmitDataRefresh).not.toHaveBeenCalled();
      }
    );

    it('should require confirmation before deleting', async () => {
      const result = await executeDeleteDecoupledTechnology({
        technologyId: 'tech-1',
        confirmed: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('confirmation');
      expect(mockDeleteTechnologyCompletely).not.toHaveBeenCalled();
      expect(mockEmitDataRefresh).not.toHaveBeenCalled();
    });

    it('should report the complete cascade counts and refresh when deletion succeeds', async () => {
      mockDeleteTechnologyCompletely.mockResolvedValue({
        success: true,
        placementsDeleted: 3,
        relationsDeleted: 2,
        neo4jDeleted: true,
      });

      const result = await executeDeleteDecoupledTechnology({
        technologyId: 'tech-1',
        confirmed: true,
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        placementsDeleted: 3,
        relationsDeleted: 2,
        neo4jDeleted: true,
        mutatedEntityTypes: [
          'technology',
          'radarPlacement',
          'relation',
          'document',
          'entityDocumentLink',
          'prototype',
          'useCase',
          'painPoint',
        ],
      });
      expect(result.data.message).toContain('3 radar placement(s)');
      expect(mockDeleteTechnologyCompletely).toHaveBeenCalledWith('tech-1');
      expect(mockEmitDataRefresh).toHaveBeenCalledWith('technologies', 'ai-assistant');
    });

    it('should fail closed with partial counts when the complete cascade resolves a failure', async () => {
      mockDeleteTechnologyCompletely.mockResolvedValue({
        success: false,
        placementsDeleted: 3,
        relationsDeleted: 0,
        neo4jDeleted: false,
        error: 'Relation cleanup failed',
      });

      const result = await executeDeleteDecoupledTechnology({
        technologyId: 'tech-1',
        confirmed: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Relation cleanup failed');
      expect(result.data).toMatchObject({
        placementsDeleted: 3,
        relationsDeleted: 0,
        neo4jDeleted: false,
        mutatedEntityTypes: [
          'technology',
          'radarPlacement',
          'relation',
          'document',
          'entityDocumentLink',
          'prototype',
          'useCase',
          'painPoint',
        ],
      });
      expect(mockEmitDataRefresh).not.toHaveBeenCalled();
    });

    it('should handle deletion errors', async () => {
      mockDeleteTechnologyCompletely.mockRejectedValue(new Error('Delete failed'));

      const result = await executeDeleteDecoupledTechnology({
        technologyId: 'tech-1',
        confirmed: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Delete failed');
      expect(result.data).toMatchObject({
        mutatedEntityTypes: [
          'technology',
          'radarPlacement',
          'relation',
          'document',
          'entityDocumentLink',
          'prototype',
          'useCase',
          'painPoint',
        ],
      });
      expect(mockEmitDataRefresh).not.toHaveBeenCalled();
    });

    it('requires and consumes the exact raw-user phrase on a later human turn', async () => {
      const fingerprint = destructiveActionFingerprint('deleteDecoupledTechnology', 'tech-phrase');
      const phrase = destructiveConfirmationPhrase(fingerprint);
      mockDeleteTechnologyCompletely.mockResolvedValue({
        success: true,
        placementsDeleted: 1,
        relationsDeleted: 2,
        neo4jDeleted: true,
      });

      const first = await executeDeleteDecoupledTechnology(
        { technologyId: 'tech-phrase', confirmed: true },
        {
          principal: 'human',
          userId: 'u1',
          requestId: 'req-1',
          confirmationText: phrase,
        }
      );
      expect(first.success).toBe(false);
      expect(mockDeleteTechnologyCompletely).not.toHaveBeenCalled();

      const second = await executeDeleteDecoupledTechnology(
        { technologyId: 'tech-phrase', confirmed: true },
        {
          principal: 'human',
          userId: 'u1',
          requestId: 'req-2',
          confirmationText: phrase,
        }
      );
      expect(second.success).toBe(true);
      expect(mockDeleteTechnologyCompletely).toHaveBeenCalledWith('tech-phrase');
    });
  });

  // ========================================================================
  // executeRemoveTechnologyFromRadar
  // ========================================================================

  describe('executeRemoveTechnologyFromRadar', () => {
    it.each([
      { technologyId: undefined, radarId: 'radar-1' },
      { technologyId: '', radarId: 'radar-1' },
      { technologyId: '   ', radarId: 'radar-1' },
      { technologyId: 42, radarId: 'radar-1' },
      { technologyId: '\ud800', radarId: 'radar-1' },
      { technologyId: 'tech-1', radarId: undefined },
      { technologyId: 'tech-1', radarId: '' },
      { technologyId: 'tech-1', radarId: '   ' },
      { technologyId: 'tech-1', radarId: 42 },
      { technologyId: 'tech-1', radarId: '\ud800' },
    ])('rejects invalid placement identifiers before confirmation or lookup: %p', async (args) => {
      // Authenticated on purpose: this case is about identifier validation, so
      // the acting user must be present or the owner check refuses first.
      const result = await executeRemoveTechnologyFromRadar({ ...args, confirmed: true }, { userId: 'u1' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Non-empty technology and radar IDs');
      expect(result.data).toBeUndefined();
      expect(mockGetPlacementForTechnologyOnRadar).not.toHaveBeenCalled();
      expect(mockDeleteRadarPlacement).not.toHaveBeenCalled();
    });

    it('should require confirmation before removing', async () => {
      const result = await executeRemoveTechnologyFromRadar(
        {
          technologyId: 'tech-1',
          radarId: 'radar-1',
          confirmed: false,
        },
        { userId: 'u1' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('confirmation');
    });

    it('should remove placement when confirmed and found', async () => {
      mockGetPlacementForTechnologyOnRadar.mockResolvedValue({ id: 'pl-1' });
      mockDeleteRadarPlacement.mockResolvedValue(undefined);

      const result = await executeRemoveTechnologyFromRadar(
        {
          technologyId: 'tech-1',
          radarId: 'radar-1',
          confirmed: true,
        },
        { userId: 'u1' }
      );

      expect(result.success).toBe(true);
      expect(result.data.message).toContain('radar-1');
      expect(result.data.mutatedEntityTypes).toEqual(['radarPlacement', 'technology', 'relation']);
      expect(mockDeleteRadarPlacement).toHaveBeenCalledWith('pl-1', { requireOwnerId: 'u1' });
      // GRAPH-060 — removal reports committed-vs-pending reconciliation truth.
      expect(result.data.graphHandoff).toEqual({
        committed: true,
        acknowledged: true,
        reconciliationRequired: false,
      });
    });

    it('should return error when placement not found', async () => {
      mockGetPlacementForTechnologyOnRadar.mockResolvedValue(null);

      const result = await executeRemoveTechnologyFromRadar(
        {
          technologyId: 'tech-1',
          radarId: 'radar-1',
          confirmed: true,
        },
        { userId: 'u1' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not placed on radar');
    });

    it('should handle removal errors', async () => {
      mockGetPlacementForTechnologyOnRadar.mockResolvedValue({ id: 'pl-1' });
      mockDeleteRadarPlacement.mockRejectedValue(new Error('Delete failed'));

      const result = await executeRemoveTechnologyFromRadar(
        {
          technologyId: 'tech-1',
          radarId: 'radar-1',
          confirmed: true,
        },
        { userId: 'u1' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Delete failed');
      expect(result.data.mutatedEntityTypes).toEqual(['radarPlacement', 'technology', 'relation']);
    });

    it('refuses to remove a placement when the acting user is not signed in', async () => {
      // GRAPH-060 — every sibling Assistant placement writer fails closed on an
      // absent acting user. Removal must too, or an unauthenticated caller can
      // delete placements.
      mockGetPlacementForTechnologyOnRadar.mockResolvedValue({ id: 'pl-anon' });
      mockDeleteRadarPlacement.mockResolvedValue(undefined);

      const result = await executeRemoveTechnologyFromRadar(
        { technologyId: 'tech-1', radarId: 'radar-1', confirmed: true },
        { principal: 'agent', requestId: 'req-anon' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/signed in/i);
      expect(mockDeleteRadarPlacement).not.toHaveBeenCalled();
    });

    it('binds the removal to the acting user so a non-owner cannot delete from another radar', async () => {
      // GRAPH-060 — the owner check must happen inside the placement mutation,
      // not merely as a destructive-confirmation prompt. Bob confirming a removal
      // on Alice's radar must still be refused by the admin boundary.
      mockGetPlacementForTechnologyOnRadar.mockResolvedValue({ id: 'pl-foreign' });
      mockDeleteRadarPlacement.mockResolvedValue(undefined);

      await executeRemoveTechnologyFromRadar(
        { technologyId: 'tech-1', radarId: 'alice-radar', confirmed: true },
        { principal: 'agent', userId: 'bob', requestId: 'req-bob' }
      );

      expect(mockDeleteRadarPlacement).toHaveBeenCalledWith('pl-foreign', { requireOwnerId: 'bob' });
    });

    it('requires the exact raw-user phrase before removing a placement for a human', async () => {
      const fingerprint = destructiveActionFingerprint('removeTechnologyFromRadar', 'tech-phrase', 'radar-phrase');
      const phrase = destructiveConfirmationPhrase(fingerprint);
      mockGetPlacementForTechnologyOnRadar.mockResolvedValue({ id: 'placement-phrase' });
      mockDeleteRadarPlacement.mockResolvedValue(undefined);

      const first = await executeRemoveTechnologyFromRadar(
        { technologyId: 'tech-phrase', radarId: 'radar-phrase', confirmed: true },
        {
          principal: 'human',
          userId: 'u1',
          requestId: 'req-1',
          confirmationText: phrase,
        }
      );
      expect(first.success).toBe(false);
      expect(mockGetPlacementForTechnologyOnRadar).not.toHaveBeenCalled();
      expect(mockDeleteRadarPlacement).not.toHaveBeenCalled();

      const second = await executeRemoveTechnologyFromRadar(
        { technologyId: 'tech-phrase', radarId: 'radar-phrase', confirmed: true },
        {
          principal: 'human',
          userId: 'u1',
          requestId: 'req-2',
          confirmationText: phrase,
        }
      );
      expect(second.success).toBe(true);
      expect(mockDeleteRadarPlacement).toHaveBeenCalledWith('placement-phrase', { requireOwnerId: 'u1' });
    });

    it('does not redeem a confirmation across colon-containing target boundaries', async () => {
      const firstTarget = { technologyId: 'a:b', radarId: 'c' };
      const secondTarget = { technologyId: 'a', radarId: 'b:c' };
      const firstFingerprint = destructiveActionFingerprint(
        'removeTechnologyFromRadar',
        firstTarget.technologyId,
        firstTarget.radarId
      );
      const firstPhrase = destructiveConfirmationPhrase(firstFingerprint);
      mockGetPlacementForTechnologyOnRadar.mockResolvedValue({ id: 'placement-first' });
      mockDeleteRadarPlacement.mockResolvedValue(undefined);

      await executeRemoveTechnologyFromRadar(firstTarget, {
        principal: 'human',
        userId: 'u1',
        requestId: 'req-1',
      });

      const collisionAttempt = await executeRemoveTechnologyFromRadar(secondTarget, {
        principal: 'human',
        userId: 'u1',
        requestId: 'req-2',
        confirmationText: firstPhrase,
      });
      expect(collisionAttempt.success).toBe(false);
      expect(mockGetPlacementForTechnologyOnRadar).not.toHaveBeenCalled();
      expect(mockDeleteRadarPlacement).not.toHaveBeenCalled();

      const exactTarget = await executeRemoveTechnologyFromRadar(firstTarget, {
        principal: 'human',
        userId: 'u1',
        requestId: 'req-2',
        confirmationText: firstPhrase,
      });
      expect(exactTarget.success).toBe(true);
      expect(mockGetPlacementForTechnologyOnRadar).toHaveBeenCalledWith('a:b', 'c');
      expect(mockDeleteRadarPlacement).toHaveBeenCalledWith('placement-first', { requireOwnerId: 'u1' });
    });
  });

  // ========================================================================
  // executeResearchTechnologyComprehensive
  // ========================================================================

  describe('executeResearchTechnologyComprehensive', () => {
    it('should return error when technologyId is empty', async () => {
      const result = await executeResearchTechnologyComprehensive({
        technologyId: '',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('Missing technologyId');
    });

    it('should return error when technology not found', async () => {
      mockGetTechnologyById.mockResolvedValue(null);

      const result = await executeResearchTechnologyComprehensive({
        technologyId: 'tech-missing',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe('failed');
      expect(result.error).toBe('Technology not found');
    });

    it('should return error when research is already pending', async () => {
      mockGetTechnologyById.mockResolvedValue({
        id: 'tech-1',
        name: 'React',
        researchStatus: 'pending',
        researchStartedAt: Date.now() - 1000, // recently started
      });
      mockClaimResearchDispatch.mockResolvedValue({
        claimed: false,
        reason: 'already-running',
        startedAt: Date.now() - 1000,
      });

      const result = await executeResearchTechnologyComprehensive({
        technologyId: 'tech-1',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe('pending');
      expect(result.error).toContain('already in progress');
    });

    // TEST-022: the old window was 10 minutes against a 15-minute job budget,
    // so a HEALTHY run became re-triggerable five minutes before it could
    // finish — the duplicate dispatch the guard exists to prevent.
    it('refuses a pending run that is still inside the job budget', async () => {
      mockGetTechnologyById.mockResolvedValue({
        id: 'tech-1',
        name: 'React',
        description: 'UI lib',
        researchStatus: 'pending',
        researchStartedAt: Date.now() - 14 * 60 * 1000,
      });
      mockUpdateTechnology.mockResolvedValue({});
      mockInngestSend.mockResolvedValue({});
      mockClaimResearchDispatch.mockResolvedValue({
        claimed: false,
        reason: 'already-running',
        startedAt: Date.now() - 14 * 60 * 1000,
      });

      const result = await executeResearchTechnologyComprehensive({ technologyId: 'tech-1' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('already in progress');
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('allows re-triggering once a pending run is genuinely abandoned', async () => {
      mockGetTechnologyById.mockResolvedValue({
        id: 'tech-1',
        name: 'React',
        description: 'UI lib',
        researchStatus: 'pending',
        researchStartedAt: Date.now() - 25 * 60 * 1000,
      });
      mockUpdateTechnology.mockResolvedValue({});
      mockInngestSend.mockResolvedValue({});

      const result = await executeResearchTechnologyComprehensive({ technologyId: 'tech-1' });

      expect(result.success).toBe(true);
      expect(result.status).toBe('pending');
      expect(mockInngestSend).toHaveBeenCalled();
    });

    // TEST-022: pending is written BEFORE dispatch. Without the release the
    // Assistant told the model "failed" while Firestore still said "pending".
    it('releases the technology from pending when dispatch fails', async () => {
      mockGetTechnologyById.mockResolvedValue({
        id: 'tech-1',
        name: 'React',
        description: 'UI lib',
      });
      mockUpdateTechnology.mockResolvedValue({});
      mockInngestSend.mockRejectedValue(new Error('inngest unreachable'));

      const result = await executeResearchTechnologyComprehensive({ technologyId: 'tech-1' });

      expect(result.success).toBe(false);
      expect(result.status).toBe('failed');
      expect(mockReleaseResearchPending).toHaveBeenCalledWith('tech-1', 'dispatch-failed', expect.any(Number));
    });

    it('should start research and send Inngest event on success', async () => {
      mockGetTechnologyById.mockResolvedValue({
        id: 'tech-1',
        name: 'React',
        description: 'UI library',
        category: 'framework',
        websiteUrl: 'https://react.dev',
      });
      mockUpdateTechnology.mockResolvedValue({});
      mockInngestSend.mockResolvedValue({});

      const result = await executeResearchTechnologyComprehensive({
        technologyId: 'tech-1',
        technologyName: 'React',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('pending');
      expect(result.technologyName).toBe('React');
      expect(result.message).toContain('Started comprehensive research');

      // The shared transaction owns the pending transition.
      expect(mockClaimResearchDispatch).toHaveBeenCalledWith('tech-1', expect.any(Number));

      // Should send Inngest event
      expect(mockInngestSend).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'app/technology.comprehensive-research.requested',
          data: expect.objectContaining({
            technologyId: 'tech-1',
            technologyName: 'React',
          }),
        })
      );
    });

    it('uses the canonical technology name even when the model supplies a conflicting name', async () => {
      mockGetTechnologyById.mockResolvedValue({
        id: 'tech-1',
        name: 'React',
        description: 'UI library',
        category: 'framework',
      });

      const result = await executeResearchTechnologyComprehensive({
        technologyId: 'tech-1',
        technologyName: 'Quantum Computing',
      });

      expect(result.technologyName).toBe('React');
      expect(mockInngestSend).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            technologyId: 'tech-1',
            technologyName: 'React',
            technologyDescription: 'UI library',
          }),
        })
      );
    });

    it('should use technology name when technologyName not provided', async () => {
      mockGetTechnologyById.mockResolvedValue({
        id: 'tech-1',
        name: 'Django',
        description: 'Python web framework',
      });
      mockUpdateTechnology.mockResolvedValue({});
      mockInngestSend.mockResolvedValue({});

      const result = await executeResearchTechnologyComprehensive({
        technologyId: 'tech-1',
      });

      expect(result.technologyName).toBe('Django');
    });

    it('should handle errors during research start', async () => {
      mockGetTechnologyById.mockRejectedValue(new Error('Service down'));

      const result = await executeResearchTechnologyComprehensive({
        technologyId: 'tech-1',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe('failed');
      expect(result.error).toBe('Service down');
    });
  });

  // ========================================================================
  // executeConfirmPlacement
  // ========================================================================

  describe('executeConfirmPlacement', () => {
    const baseProposal = {
      technologyId: 'tech-1',
      technologyName: 'React',
      proposedQuadrant: 'Languages & Frameworks',
      proposedRing: 'Adopt',
      rationale: 'Battle-tested for 3 years',
    };

    it('should return pending status when no userDecision provided', async () => {
      const result = await executeConfirmPlacement(baseProposal);

      expect(result.success).toBe(true);
      expect(result.status).toBe('pending');
      expect(result.proposal.technologyName).toBe('React');
      expect(result.proposal.quadrant).toBe('Languages & Frameworks');
      expect(result.proposal.ring).toBe('Adopt');
      expect(result.message).toContain('Proposed Placement');
    });

    it('should include evidence and alternatives in proposal message', async () => {
      const result = await executeConfirmPlacement({
        ...baseProposal,
        evidencePoints: ['3 years in production', 'Strong ecosystem'],
        alternatives: [{ ring: 'Trial', reason: 'Still evaluating performance' }],
        radarName: 'Frontend Radar',
      });

      expect(result.message).toContain('3 years in production');
      expect(result.message).toContain('Strong ecosystem');
      expect(result.message).toContain('Trial');
      expect(result.message).toContain('Still evaluating performance');
      expect(result.message).toContain('Frontend Radar');
    });

    it('should handle "approved" decision', async () => {
      const result = await executeConfirmPlacement({
        ...baseProposal,
        userDecision: 'approved',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('approved');
      expect(result.userDecision).toBe('approved');
    });

    it('should handle "approve" (variant) decision', async () => {
      const result = await executeConfirmPlacement({
        ...baseProposal,
        userDecision: 'approve',
      });

      expect(result.status).toBe('approved');
    });

    it('should handle "yes" (variant) decision', async () => {
      const result = await executeConfirmPlacement({
        ...baseProposal,
        userDecision: 'yes',
      });

      expect(result.status).toBe('approved');
    });

    it('should handle "rejected" decision', async () => {
      const result = await executeConfirmPlacement({
        ...baseProposal,
        userDecision: 'rejected',
        userFeedback: 'Not ready for production',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('rejected');
      expect(result.userDecision).toBe('rejected');
      expect(result.userFeedback).toBe('Not ready for production');
    });

    it('should handle "reject" (variant) decision', async () => {
      const result = await executeConfirmPlacement({
        ...baseProposal,
        userDecision: 'reject',
      });

      expect(result.status).toBe('rejected');
    });

    it('should handle "no" (variant) decision', async () => {
      const result = await executeConfirmPlacement({
        ...baseProposal,
        userDecision: 'no',
      });

      expect(result.status).toBe('rejected');
    });

    it('should handle "modify" decision', async () => {
      const result = await executeConfirmPlacement({
        ...baseProposal,
        userDecision: 'modify',
        userFeedback: 'Should be Trial instead',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('modified');
      expect(result.userDecision).toBe('modify');
      expect(result.userFeedback).toBe('Should be Trial instead');
    });

    it('should handle "modified" (variant) decision', async () => {
      const result = await executeConfirmPlacement({
        ...baseProposal,
        userDecision: 'modified',
      });

      expect(result.status).toBe('modified');
    });

    it('should handle "change" (variant) decision', async () => {
      const result = await executeConfirmPlacement({
        ...baseProposal,
        userDecision: 'change',
      });

      expect(result.status).toBe('modified');
    });

    it('should return pending with error message for unknown decision', async () => {
      const result = await executeConfirmPlacement({
        ...baseProposal,
        userDecision: 'maybe',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe('pending');
      expect(result.message).toContain('Unknown decision');
    });
  });

  // ========================================================================
  // DuplicateEntityError handling
  // ========================================================================
  describe('DuplicateEntityError handling', () => {
    const { DuplicateEntityError } = jest.requireActual(
      '@/lib/entity-factory-shared'
    ) as typeof import('@/lib/entity-factory-shared');

    it('should return alreadyExists for duplicate technology', async () => {
      mockCreateTechnology.mockRejectedValue(
        new DuplicateEntityError('technologies', 'slug', 'react', 'existing-tech-1')
      );

      const result = await executeCreateDecoupledTechnology({
        name: 'React',
        description: 'A JavaScript library for building UIs',
      });

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.alreadyExists).toBe(true);
      expect(data.existingId).toBe('existing-tech-1');
      expect(data.message).toContain('already exists');
    });

    it('should still propagate non-duplicate errors', async () => {
      mockCreateTechnology.mockRejectedValue(new Error('Network timeout'));

      const result = await executeCreateDecoupledTechnology({
        name: 'React',
        description: 'desc',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network timeout');
    });
  });
});
