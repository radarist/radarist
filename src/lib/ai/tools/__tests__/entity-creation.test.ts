/**
 * @jest-environment node
 */

// ============================================================================
// Mocks (MUST be before imports)
// ============================================================================

jest.mock('@/lib/firebase', () => {
  throw new Error('entity-creation tools must not import the Firebase client runtime');
});
jest.mock('firebase/firestore', () => {
  throw new Error('entity-creation tools must not import firebase/firestore');
});

const mockCreateCompany = jest.fn();
const mockUpdateCompany = jest.fn();
const mockGetCompanies = jest.fn();
const mockDeleteCompany = jest.fn();
// Entity mutations run through Admin SDK services in this server-side executor.
jest.mock('@/lib/companies-admin', () => ({
  __esModule: true,
  adminCreateCompany: (...args: unknown[]) => mockCreateCompany(...args),
  adminUpdateCompany: (...args: unknown[]) => mockUpdateCompany(...args),
  adminGetCompanies: (...args: unknown[]) => mockGetCompanies(...args),
  adminDeleteCompany: (...args: unknown[]) => mockDeleteCompany(...args),
}));

const mockResolveLinkedEntityNames = jest.fn();
jest.mock('@/lib/ai/tools/helpers/resolve-linked-entities', () => ({
  __esModule: true,
  LINKED_ENTITY_NAME_CAP: 10,
  resolveLinkedEntityNames: (...args: unknown[]) => mockResolveLinkedEntityNames(...args),
}));

const mockCreateUseCase = jest.fn();
const mockGetUseCases = jest.fn();
const mockDeleteUseCase = jest.fn();
jest.mock('@/lib/use-cases-admin', () => ({
  __esModule: true,
  adminCreateUseCase: (...args: unknown[]) => mockCreateUseCase(...args),
  adminGetUseCases: (...args: unknown[]) => mockGetUseCases(...args),
  adminDeleteUseCase: (...args: unknown[]) => mockDeleteUseCase(...args),
}));

const mockCreatePrototype = jest.fn();
const mockGetPrototypes = jest.fn();
const mockDeletePrototype = jest.fn();
jest.mock('@/lib/prototypes-admin', () => ({
  __esModule: true,
  adminCreatePrototype: (...args: unknown[]) => mockCreatePrototype(...args),
  adminGetPrototypes: (...args: unknown[]) => mockGetPrototypes(...args),
  adminDeletePrototype: (...args: unknown[]) => mockDeletePrototype(...args),
}));

const mockCreateStrategy = jest.fn();
const mockGetStrategies = jest.fn();
const mockDeleteStrategy = jest.fn();
jest.mock('@/lib/strategies-admin', () => ({
  __esModule: true,
  adminCreateStrategy: (...args: unknown[]) => mockCreateStrategy(...args),
  adminGetStrategies: (...args: unknown[]) => mockGetStrategies(...args),
  adminDeleteStrategy: (...args: unknown[]) => mockDeleteStrategy(...args),
}));

const mockCreateSignal = jest.fn();
const mockGetSignals = jest.fn();
const mockAdminDeleteSignals = jest.fn();
const mockClientDeleteSignal = jest.fn();
jest.mock('@/lib/signals-admin', () => ({
  __esModule: true,
  adminCreateSignal: (...args: unknown[]) => mockCreateSignal(...args),
  adminGetSignals: (...args: unknown[]) => mockGetSignals(...args),
  adminDeleteSignals: (...args: unknown[]) => mockAdminDeleteSignals(...args),
}));
jest.mock('@/lib/signals', () => ({
  __esModule: true,
  // Regression sentinel: the Node executor must never cross into the client service.
  deleteSignal: (...args: unknown[]) => mockClientDeleteSignal(...args),
}));

const mockGetRadars = jest.fn();
const mockGetRadarById = jest.fn();
const mockAdminGetOwnedRadarById = jest.fn();
// Migrated to the admin SDK path: source imports adminListRadars + adminGetRadarById
// from @/lib/radars-admin (was getRadars from @/lib/technologies and getRadarById from @/lib/radars).
jest.mock('@/lib/radars-admin', () => ({
  __esModule: true,
  adminListRadars: (...args: unknown[]) => mockGetRadars(...args),
  adminGetRadarById: (...args: unknown[]) => mockGetRadarById(...args),
  adminGetOwnedRadarById: (...args: unknown[]) => mockAdminGetOwnedRadarById(...args),
  RadarAuthorizationError: class RadarAuthorizationError extends Error {},
}));

const mockCreateDecoupledTech = jest.fn();
const mockGetDecoupledTechnologies = jest.fn();
const mockDeleteTechnologyCompletely = jest.fn();
// Technology create/get/delete all use the Admin SDK service.
jest.mock('@/lib/technology-admin', () => ({
  __esModule: true,
  adminCreateTechnology: (...args: unknown[]) => mockCreateDecoupledTech(...args),
  adminGetTechnologies: (...args: unknown[]) => mockGetDecoupledTechnologies(...args),
  adminDeleteTechnologyCompletely: (...args: unknown[]) => mockDeleteTechnologyCompletely(...args),
}));

const mockGetOrgUnits = jest.fn();
const mockDeleteOrgUnit = jest.fn();
jest.mock('@/lib/org-units-admin', () => ({
  __esModule: true,
  adminGetOrgUnits: (...args: unknown[]) => mockGetOrgUnits(...args),
  adminDeleteOrgUnit: (...args: unknown[]) => mockDeleteOrgUnit(...args),
}));

const mockGetInitiatives = jest.fn();
const mockDeleteInitiative = jest.fn();
jest.mock('@/lib/initiatives-admin', () => ({
  __esModule: true,
  adminGetInitiatives: (...args: unknown[]) => mockGetInitiatives(...args),
  adminDeleteInitiative: (...args: unknown[]) => mockDeleteInitiative(...args),
}));

const mockGetPainPoints = jest.fn();
const mockDeletePainPoint = jest.fn();
jest.mock('@/lib/pain-points-admin', () => ({
  __esModule: true,
  adminGetPainPoints: (...args: unknown[]) => mockGetPainPoints(...args),
  adminDeletePainPoint: (...args: unknown[]) => mockDeletePainPoint(...args),
}));

const mockCreateRadarPlacement = jest.fn();
const mockCreateRadarPlacementWithHandoff = jest.fn(async (...args: unknown[]) => ({
  placement: await mockCreateRadarPlacement(...args),
  graphHandoff: { acknowledged: true, reconciliationRequired: false },
}));
// Migrated to the admin SDK path: source imports adminCreateRadarPlacementWithHandoff from @/lib/radar-placement-admin.
jest.mock('@/lib/radar-placement-admin', () => ({
  __esModule: true,
  adminCreateRadarPlacementWithHandoff: (...args: unknown[]) => mockCreateRadarPlacementWithHandoff(...args),
  PlacementAuthorizationError: class PlacementAuthorizationError extends Error {},
}));

const mockEmitDataRefresh = jest.fn();
jest.mock('@/lib/events/data-refresh', () => ({
  __esModule: true,
  emitDataRefresh: (...args: unknown[]) => mockEmitDataRefresh(...args),
}));

jest.mock('@/lib/schemas/technology-schema', () => ({
  __esModule: true,
  normalizeTechnologyCategory: jest.fn((val: unknown) => val),
}));

jest.mock('@/lib/ai/signal-evaluation', () => ({
  __esModule: true,
  cleanMarkdownFromText: jest.fn((text: string) => (text ? text.replace(/[*#_]/g, '') : text)),
}));

jest.mock('@/lib/entity-factory', () => {
  throw new Error('entity-creation tools must not import the Firebase client entity factory');
});

const mockResearchCompanyComprehensive = jest.fn();
jest.mock('@/ai/flows/research-company-comprehensive', () => ({
  __esModule: true,
  researchCompanyComprehensive: (...args: unknown[]) => mockResearchCompanyComprehensive(...args),
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import {
  executeCreateCompany,
  executeCreateTechnology,
  executeCreateUseCase,
  executeCreatePrototype,
  executeCreateStrategy,
  executeCreateSignal,
  executeDeleteEntity,
  executeCreateCompanyWithResearch,
  searchEntityCandidatesByName,
  parseHeadquarters,
} from '../entity-creation';
import type { ComprehensiveCompanyResearchResult } from '../web-research';
import {
  _resetConfirmationStore,
  destructiveActionFingerprint,
  destructiveConfirmationPhrase,
  type DestructiveGateRefusal,
} from '@/lib/ai/destructive-confirmation';
import { EntityDeletionBlockedError } from '@/lib/entity-deletion-reference-policy';

// ============================================================================
// Tests
// ============================================================================

describe('Entity Creation Tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetConfirmationStore();
    // Set up default resolved values for delete mocks
    mockDeleteCompany.mockResolvedValue(undefined);
    mockDeleteUseCase.mockResolvedValue(undefined);
    mockDeletePrototype.mockResolvedValue(undefined);
    mockDeleteStrategy.mockResolvedValue(undefined);
    mockAdminDeleteSignals.mockResolvedValue({ deleted: 1, failed: [], relationsDeleted: 0 });
    mockDeleteOrgUnit.mockResolvedValue(undefined);
    mockDeleteInitiative.mockResolvedValue(undefined);
    mockDeletePainPoint.mockResolvedValue(undefined);
    mockDeleteTechnologyCompletely.mockResolvedValue({
      success: true,
      placementsDeleted: 2,
      relationsDeleted: 3,
      neo4jDeleted: true,
    });
    // Default: background research resolves silently
    mockResearchCompanyComprehensive.mockResolvedValue({});
    mockUpdateCompany.mockResolvedValue(undefined);
    mockResolveLinkedEntityNames.mockResolvedValue({ companies: [], technologies: [] });
    mockGetDecoupledTechnologies.mockResolvedValue([]);
    // Default: owned-radar authorization succeeds; tests can override to reject.
    mockAdminGetOwnedRadarById.mockResolvedValue({ id: 'radar-1', ownerId: 'user-1' });
    // Default: placement create returns an OK handoff.
    mockCreateRadarPlacement.mockResolvedValue({ id: 'placement-default' });
  });

  describe('searchEntityCandidatesByName', () => {
    it('preserves the existing bounded fuzzy technology query for default deletion callers', async () => {
      mockGetDecoupledTechnologies.mockResolvedValue([{ id: 'tech-1', name: 'React' }]);

      const candidates = await searchEntityCandidatesByName('technology', 'Recat');

      expect(mockGetDecoupledTechnologies).toHaveBeenCalledWith({ search: 'Recat' });
      expect(candidates).toEqual([{ id: 'tech-1', name: 'React' }]);
    });

    it('prioritizes every normalized exact match before applying the five-candidate display cap', async () => {
      mockGetCompanies.mockResolvedValue([
        ...Array.from({ length: 6 }, (_, index) => ({
          id: `partial-${index}`,
          name: `Acme Corp Division ${index}`,
        })),
        { id: 'exact-1', name: 'Acme Corp' },
        { id: 'exact-2', name: 'ＡCME   CORP' },
      ]);

      const candidates = await searchEntityCandidatesByName('company', '  acme corp  ', {
        prioritizeNormalizedExact: true,
      });

      expect(candidates?.slice(0, 2)).toEqual([
        { id: 'exact-1', name: 'Acme Corp' },
        { id: 'exact-2', name: 'ＡCME   CORP' },
      ]);
      expect(candidates).toHaveLength(5);
    });

    it('reads all technologies before ranking exact duplicates ahead of fuzzy hints', async () => {
      mockGetDecoupledTechnologies.mockResolvedValue([
        ...Array.from({ length: 6 }, (_, index) => ({
          id: `tech-partial-${index}`,
          name: `Quantum Computing Toolkit ${index}`,
        })),
        { id: 'tech-exact-1', name: 'Quantum Computing' },
        { id: 'tech-exact-2', name: 'QUANTUM   COMPUTING' },
      ]);

      const candidates = await searchEntityCandidatesByName('technology', 'quantum computing', {
        prioritizeNormalizedExact: true,
      });

      expect(mockGetDecoupledTechnologies).toHaveBeenCalledWith({});
      expect(candidates?.slice(0, 2)).toEqual([
        { id: 'tech-exact-1', name: 'Quantum Computing' },
        { id: 'tech-exact-2', name: 'QUANTUM   COMPUTING' },
      ]);
      expect(candidates).toHaveLength(5);
    });
  });

  // --------------------------------------------------------------------------
  // executeCreateCompany
  // --------------------------------------------------------------------------
  describe('executeCreateCompany', () => {
    it('should create a company with minimal required fields', async () => {
      mockCreateCompany.mockResolvedValue({ id: 'company-1', name: 'Acme Corp' });

      const result = await executeCreateCompany({
        name: 'Acme Corp',
        description: 'A technology company',
      });

      expect(result.success).toBe(true);
      expect(result.data?.id).toBe('company-1');
      expect(result.data?.name).toBe('Acme Corp');
      expect(mockCreateCompany).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Acme Corp',
          description: 'A technology company',
        })
      );
      expect(mockEmitDataRefresh).toHaveBeenCalledWith('companies', 'ai-assistant');
    });

    it('should parse headquarters into city/country location', async () => {
      mockCreateCompany.mockResolvedValue({ id: 'c1', name: 'Corp' });

      await executeCreateCompany({
        name: 'Corp',
        description: 'desc',
        headquarters: 'San Francisco, US',
      });

      expect(mockCreateCompany).toHaveBeenCalledWith(
        expect.objectContaining({
          location: { city: 'San Francisco', country: 'US' },
        })
      );
    });

    it('should handle headquarters with no comma', async () => {
      mockCreateCompany.mockResolvedValue({ id: 'c1', name: 'Corp' });

      await executeCreateCompany({
        name: 'Corp',
        description: 'desc',
        headquarters: 'London',
      });

      expect(mockCreateCompany).toHaveBeenCalledWith(
        expect.objectContaining({
          location: { city: 'London', country: '' },
        })
      );
    });

    it('abstains on size/stage when not supplied (never fabricates a default)', async () => {
      mockCreateCompany.mockResolvedValue({ id: 'c1', name: 'Corp' });

      await executeCreateCompany({ name: 'Corp', description: 'desc' });

      const created = mockCreateCompany.mock.calls[0][0] as {
        type?: unknown;
        status?: unknown;
        size?: unknown;
        stage?: unknown;
      };
      expect(created.type).toEqual(['sme']);
      expect(created.status).toBe('Watching');
      expect('size' in created).toBe(false);
      expect('stage' in created).toBe(false);
    });

    it('should forward provided type and industry arrays', async () => {
      mockCreateCompany.mockResolvedValue({ id: 'c1', name: 'StartupCo' });

      await executeCreateCompany({
        name: 'StartupCo',
        description: 'desc',
        type: ['startup', 'scaleup'],
        industry: ['technology'],
        size: 'small',
      });

      expect(mockCreateCompany).toHaveBeenCalledWith(
        expect.objectContaining({
          type: ['startup', 'scaleup'],
          industry: ['technology'],
          size: 'small',
        })
      );
    });

    it('should return error when service throws', async () => {
      mockCreateCompany.mockRejectedValue(new Error('Firestore quota exceeded'));

      const result = await executeCreateCompany({ name: 'Corp', description: 'desc' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Firestore quota exceeded');
    });

    it('should clean markdown from name and description', async () => {
      mockCreateCompany.mockResolvedValue({ id: 'c1', name: 'Acme Corp' });

      await executeCreateCompany({
        name: '**Acme Corp**',
        description: '# Tech company',
      });

      expect(mockCreateCompany).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Acme Corp',
          description: ' Tech company',
        })
      );
    });
  });

  // --------------------------------------------------------------------------
  // executeCreateTechnology
  // --------------------------------------------------------------------------
  describe('executeCreateTechnology', () => {
    it('should require authentication when placement is requested', async () => {
      mockCreateDecoupledTech.mockResolvedValue({ id: 'tech-1', name: 'LangChain' });

      const result = await executeCreateTechnology({
        name: 'LangChain',
        description: 'LLM framework',
        quadrant: 'Tools',
        ring: 'Trial',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('signed in');
      expect(mockCreateRadarPlacementWithHandoff).not.toHaveBeenCalled();
    });

    it('should create library-only technology without radar placement', async () => {
      mockCreateDecoupledTech.mockResolvedValue({ id: 'tech-1', name: 'LangChain' });

      const result = await executeCreateTechnology(
        {
          name: 'LangChain',
          description: 'LLM framework',
        },
        { userId: 'user-1' }
      );

      expect(result.success).toBe(true);
      expect(result.data?.id).toBe('tech-1');
      expect(result.data?.placedOnRadar).toBe(false);
      expect(mockCreateRadarPlacementWithHandoff).not.toHaveBeenCalled();
      expect(mockEmitDataRefresh).toHaveBeenCalledWith('technologies', 'ai-assistant');
    });

    it('converges an exact repeated create on the one canonical existing technology', async () => {
      mockCreateDecoupledTech.mockRejectedValue(
        new Error('Failed to create technology: A technology with slug "assistant-release-node" already exists')
      );
      mockGetDecoupledTechnologies.mockResolvedValue([
        {
          id: 'tech-existing',
          name: 'Assistant   Release Node',
          slug: 'assistant-release-node',
        },
      ]);

      const result = await executeCreateTechnology({
        name: ' assistant release node ',
        description: 'Repeated user command',
        skipRealityCheck: true,
      });

      expect(result).toMatchObject({
        success: true,
        data: {
          id: 'tech-existing',
          name: 'Assistant   Release Node',
          created: false,
          alreadyExists: true,
          placedOnRadar: false,
        },
      });
      expect(mockGetDecoupledTechnologies).toHaveBeenCalledWith();
      expect(mockCreateRadarPlacement).not.toHaveBeenCalled();
    });

    it.each([
      [
        'the same slug belongs to a different normalized name',
        [{ id: 'tech-other', name: 'Assistant + Release Node', slug: 'assistant-release-node' }],
      ],
      [
        'more than one exact legacy identity remains',
        [
          { id: 'tech-a', name: 'Assistant Release Node', slug: 'assistant-release-node' },
          { id: 'tech-b', name: 'assistant release node', slug: 'assistant-release-node' },
        ],
      ],
    ])('fails closed when %s', async (_label, existing) => {
      mockCreateDecoupledTech.mockRejectedValue(
        new Error('Failed to create technology: A technology with slug "assistant-release-node" already exists')
      );
      mockGetDecoupledTechnologies.mockResolvedValue(existing);

      const result = await executeCreateTechnology({
        name: 'Assistant Release Node',
        description: 'Repeated user command',
        skipRealityCheck: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });

    it('should create technology AND radar placement when quadrant/ring provided', async () => {
      mockCreateDecoupledTech.mockResolvedValue({ id: 'tech-2', name: 'LangChain' });
      mockGetRadars.mockResolvedValue([{ id: 'radar-1', name: 'Tech Radar' }]);
      mockGetRadarById.mockResolvedValue({
        id: 'radar-1',
        name: 'Tech Radar',
        quadrants: [
          { id: 'q_techniques', name: 'Techniques', order: 0 },
          { id: 'q_tools', name: 'Tools', order: 1 },
          { id: 'q_platforms', name: 'Platforms', order: 2 },
          { id: 'q_languages_frameworks', name: 'Languages & Frameworks', order: 3 },
        ],
      });
      mockCreateRadarPlacement.mockResolvedValue({ id: 'placement-1' });

      const result = await executeCreateTechnology(
        {
          name: 'LangChain',
          description: 'LLM framework',
          quadrant: 'Languages & Frameworks',
          ring: 'Trial',
        },
        { userId: 'user-1' }
      );

      expect(result.success).toBe(true);
      expect(result.data?.placedOnRadar).toBe(true);
      expect(result.data?.radarId).toBe('radar-1');
      expect(mockCreateRadarPlacement).toHaveBeenCalledWith(
        expect.objectContaining({
          technologyId: 'tech-2',
          radarId: 'radar-1',
          // New ID-first surface: placement carries stable quadrantId, not display name
          quadrantId: 'q_languages_frameworks',
          ring: 'Trial',
          placedBy: 'user-1',
        }),
        { requireOwnerId: 'user-1' }
      );
    });

    it('keeps technology creation id-first on collisions and whitespace-sensitive on names', async () => {
      mockCreateDecoupledTech.mockResolvedValue({ id: 'tech-collision', name: 'Collision Tech' });
      mockGetRadarById.mockResolvedValue({
        id: 'radar-1',
        name: 'Tech Radar',
        quadrants: [
          { id: 'q_name_target', name: 'collision', order: 0 },
          { id: 'collision', name: 'ID target', order: 1 },
        ],
      });
      mockCreateRadarPlacement.mockResolvedValue({ id: 'placement-collision' });

      const collision = await executeCreateTechnology(
        {
          name: 'Collision Tech',
          description: 'Collision resolution test',
          radarId: 'radar-1',
          quadrant: 'collision',
          ring: 'Trial',
        },
        { userId: 'user-1' }
      );
      const spaced = await executeCreateTechnology(
        {
          name: 'Spaced Tech',
          description: 'Whitespace compatibility test',
          radarId: 'radar-1',
          quadrant: ' collision ',
          ring: 'Trial',
        },
        { userId: 'user-1' }
      );

      expect(collision.data?.placedOnRadar).toBe(true);
      expect(mockCreateRadarPlacement).toHaveBeenCalledWith(expect.objectContaining({ quadrantId: 'collision' }), {
        requireOwnerId: 'user-1',
      });
      expect(spaced.data?.placedOnRadar).toBe(false);
      expect(mockCreateRadarPlacement).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['missing radar', null],
      ['radar with no quadrants', { id: 'radar-1', name: 'Empty Radar', quadrants: [] }],
    ])('reports no placement for a %s', async (_label, targetRadar) => {
      mockCreateDecoupledTech.mockResolvedValue({ id: 'tech-unplaced', name: 'Unplaced Tech' });
      mockGetRadarById.mockResolvedValue(targetRadar);

      const result = await executeCreateTechnology(
        {
          name: 'Unplaced Tech',
          description: 'Technology whose requested target cannot be used',
          radarId: 'radar-1',
          quadrant: 'Tools',
          ring: 'Trial',
        },
        { userId: 'user-1' }
      );

      expect(result.success).toBe(true);
      expect(result.data?.placedOnRadar).toBe(false);
      expect(mockCreateRadarPlacement).not.toHaveBeenCalled();
    });

    it('should forward trlScore and timeToImpact to the placement when provided', async () => {
      // Regression test: if the agent provides TRL and timeToImpact values when
      // placing a technology on a radar, those fields must flow through to the
      // Firestore placement doc so the entry list renders TRL and Time-to-Impact
      // columns instead of a literal "-".
      mockCreateDecoupledTech.mockResolvedValue({ id: 'tech-trl', name: 'LangChain' });
      mockGetRadars.mockResolvedValue([{ id: 'radar-1', name: 'Tech Radar' }]);
      mockGetRadarById.mockResolvedValue({
        id: 'radar-1',
        name: 'Tech Radar',
        quadrants: [
          { id: 'q_techniques', name: 'Techniques', order: 0 },
          { id: 'q_tools', name: 'Tools', order: 1 },
        ],
      });
      mockCreateRadarPlacement.mockResolvedValue({ id: 'placement-trl' });

      await executeCreateTechnology(
        {
          name: 'LangChain',
          description: 'LLM framework',
          quadrant: 'Tools',
          ring: 'Trial',
          trlScore: 6,
          timeToImpact: 'H2',
        },
        { userId: 'user-1' }
      );

      expect(mockCreateRadarPlacement).toHaveBeenCalledWith(
        expect.objectContaining({
          technologyId: 'tech-trl',
          quadrantId: 'q_tools',
          ring: 'Trial',
          trlScore: 6,
          timeToImpact: 'H2',
          placedBy: 'user-1',
        }),
        { requireOwnerId: 'user-1' }
      );
    });

    it('should OMIT trlScore and timeToImpact from the write when not provided (Firestore rejects undefined)', async () => {
      // Firestore's `updateDoc`/`setDoc` throws on undefined field values, so
      // the executor must strip `trlScore`/`timeToImpact` keys entirely when
      // the agent leaves them out — not pass `undefined`.
      mockCreateDecoupledTech.mockResolvedValue({ id: 'tech-notrl', name: 'Vue' });
      mockGetRadars.mockResolvedValue([{ id: 'radar-1', name: 'Tech Radar' }]);
      mockGetRadarById.mockResolvedValue({
        id: 'radar-1',
        name: 'Tech Radar',
        quadrants: [
          { id: 'q_techniques', name: 'Techniques', order: 0 },
          { id: 'q_tools', name: 'Tools', order: 1 },
        ],
      });
      mockCreateRadarPlacement.mockResolvedValue({ id: 'p1' });

      await executeCreateTechnology(
        {
          name: 'Vue',
          description: 'UI framework',
          quadrant: 'Tools',
          ring: 'Adopt',
        },
        { userId: 'user-1' }
      );

      // Assert the placement payload has NEITHER key (no undefined values).
      const callArgs = mockCreateRadarPlacement.mock.calls[0][0] as Record<string, unknown>;
      expect(callArgs).not.toHaveProperty('trlScore');
      expect(callArgs).not.toHaveProperty('timeToImpact');
      expect(callArgs.ring).toBe('Adopt');
    });

    it('should use provided radarId instead of fetching default', async () => {
      mockCreateDecoupledTech.mockResolvedValue({ id: 'tech-3', name: 'React' });
      mockGetRadarById.mockResolvedValue({
        id: 'custom-radar',
        name: 'Custom',
        quadrants: [
          { id: 'q_techniques', name: 'Techniques', order: 0 },
          { id: 'q_tools', name: 'Tools', order: 1 },
          { id: 'q_platforms', name: 'Platforms', order: 2 },
          { id: 'q_languages_frameworks', name: 'Languages & Frameworks', order: 3 },
        ],
      });
      mockCreateRadarPlacement.mockResolvedValue({ id: 'p1' });

      const result = await executeCreateTechnology(
        {
          name: 'React',
          description: 'UI framework',
          quadrant: 'Languages & Frameworks',
          ring: 'Adopt',
          radarId: 'custom-radar',
        },
        { userId: 'user-1' }
      );

      expect(result.success).toBe(true);
      expect(result.data?.radarId).toBe('custom-radar');
      expect(mockGetRadars).not.toHaveBeenCalled();
    });

    it('should not place on radar when no radars exist', async () => {
      mockCreateDecoupledTech.mockResolvedValue({ id: 'tech-4', name: 'SomeTech' });
      mockGetRadars.mockResolvedValue([]);

      const result = await executeCreateTechnology(
        {
          name: 'SomeTech',
          description: 'desc',
          quadrant: 'Tools',
          ring: 'Assess',
        },
        { userId: 'user-1' }
      );

      expect(result.success).toBe(true);
      expect(result.data?.placedOnRadar).toBe(false);
      expect(mockCreateRadarPlacement).not.toHaveBeenCalled();
    });

    it('should forward tags and category when provided', async () => {
      mockCreateDecoupledTech.mockResolvedValue({ id: 'tech-5', name: 'TensorFlow' });

      await executeCreateTechnology({
        name: 'TensorFlow',
        description: 'ML framework',
        tags: ['AI', 'ML', 'Python'],
        category: 'library',
      });

      expect(mockCreateDecoupledTech).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: ['AI', 'ML', 'Python'],
          category: 'library',
        })
      );
    });

    it('should generate a slug from the name', async () => {
      mockCreateDecoupledTech.mockResolvedValue({ id: 'tech-6', name: 'Next.js' });

      await executeCreateTechnology({
        name: 'Next.js',
        description: 'React framework',
      });

      expect(mockCreateDecoupledTech).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'next-js',
        })
      );
    });

    it('should handle service errors', async () => {
      mockCreateDecoupledTech.mockRejectedValue(new Error('DB error'));

      const result = await executeCreateTechnology({
        name: 'React',
        description: 'UI framework',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('DB error');
      expect(mockGetDecoupledTechnologies).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // executeCreateUseCase
  // --------------------------------------------------------------------------
  describe('executeCreateUseCase', () => {
    it('should create a use case with all fields', async () => {
      mockCreateUseCase.mockResolvedValue({
        id: 'uc-1',
        title: 'AI Invoice Processing',
      });

      const result = await executeCreateUseCase({
        title: 'AI Invoice Processing',
        description: 'Automate invoice handling with AI',
        category: 'Automation',
        problem: 'Manual processing takes 5 days',
        solution: 'Use OCR and ML',
        tags: ['AI', 'finance'],
        status: 'Proposed',
      });

      expect(result.success).toBe(true);
      expect(result.data?.id).toBe('uc-1');
      expect(result.data?.title).toBe('AI Invoice Processing');
      expect(mockCreateUseCase).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'AI Invoice Processing',
          problem: 'Manual processing takes 5 days',
          solution: 'Use OCR and ML',
          category: 'Automation',
          status: 'Proposed',
        })
      );
      expect(mockEmitDataRefresh).toHaveBeenCalledWith('useCases', 'ai-assistant');
    });

    it('should use default problem/solution when not provided', async () => {
      mockCreateUseCase.mockResolvedValue({ id: 'uc-2', title: 'Customer Analytics' });

      await executeCreateUseCase({
        title: 'Customer Analytics',
        description: 'Analyze customer behavior',
      });

      expect(mockCreateUseCase).toHaveBeenCalledWith(
        expect.objectContaining({
          problem: 'Business need related to: Customer Analytics',
        })
      );
    });

    it('should default status to Proposed when not provided', async () => {
      mockCreateUseCase.mockResolvedValue({ id: 'uc-3', title: 'Test' });

      await executeCreateUseCase({ title: 'Test', description: 'desc' });

      expect(mockCreateUseCase).toHaveBeenCalledWith(expect.objectContaining({ status: 'Proposed' }));
    });

    it('should default category to General when not provided', async () => {
      mockCreateUseCase.mockResolvedValue({ id: 'uc-4', title: 'Test' });

      await executeCreateUseCase({ title: 'Test', description: 'desc' });

      expect(mockCreateUseCase).toHaveBeenCalledWith(expect.objectContaining({ category: 'General' }));
    });

    it('should truncate long description in default solution', async () => {
      mockCreateUseCase.mockResolvedValue({ id: 'uc-5', title: 'Test' });
      const longDesc = 'a'.repeat(300);

      await executeCreateUseCase({ title: 'Test', description: longDesc });

      const call = mockCreateUseCase.mock.calls[0][0];
      expect(call.solution).toContain('...');
      expect(call.solution.length).toBeLessThan(300);
    });

    it('should handle service errors', async () => {
      mockCreateUseCase.mockRejectedValue(new Error('Write failed'));

      const result = await executeCreateUseCase({
        title: 'Test',
        description: 'desc',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Write failed');
    });
  });

  // --------------------------------------------------------------------------
  // executeCreatePrototype
  // --------------------------------------------------------------------------
  describe('executeCreatePrototype', () => {
    it('should create a prototype with all fields', async () => {
      mockCreatePrototype.mockResolvedValue({
        id: 'proto-1',
        name: 'AI Chatbot POC',
      });

      const result = await executeCreatePrototype({
        name: 'AI Chatbot POC',
        description: 'Testing LLM for customer support',
        targetBusinessUnit: 'Customer Service',
        team: ['Alice', 'Bob'],
        status: 'In Development',
      });

      expect(result.success).toBe(true);
      expect(result.data?.id).toBe('proto-1');
      expect(result.data?.name).toBe('AI Chatbot POC');
      expect(mockCreatePrototype).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'AI Chatbot POC',
          targetBusinessUnit: 'Customer Service',
          team: ['Alice', 'Bob'],
          status: 'In Development',
        })
      );
      expect(mockEmitDataRefresh).toHaveBeenCalledWith('prototypes', 'ai-assistant');
    });

    it('should use defaults for optional fields', async () => {
      mockCreatePrototype.mockResolvedValue({ id: 'proto-2', name: 'Test' });

      await executeCreatePrototype({ name: 'Test', description: 'desc' });

      expect(mockCreatePrototype).toHaveBeenCalledWith(
        expect.objectContaining({
          targetBusinessUnit: 'Unassigned',
          team: [],
          status: 'Ideation',
        })
      );
    });

    it('should include proper impact structure', async () => {
      mockCreatePrototype.mockResolvedValue({ id: 'proto-3', name: 'Test' });

      await executeCreatePrototype({ name: 'Test', description: 'desc' });

      expect(mockCreatePrototype).toHaveBeenCalledWith(
        expect.objectContaining({
          impact: expect.objectContaining({
            type: 'Business Transformation',
            estimatedValue: 0,
            confidence: 50,
          }),
        })
      );
    });

    it('should handle service errors', async () => {
      mockCreatePrototype.mockRejectedValue(new Error('DB write error'));

      const result = await executeCreatePrototype({
        name: 'Test',
        description: 'desc',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('DB write error');
    });
  });

  // --------------------------------------------------------------------------
  // executeCreateStrategy
  // --------------------------------------------------------------------------
  describe('executeCreateStrategy', () => {
    it('should create a strategy with directives', async () => {
      mockCreateStrategy.mockResolvedValue({
        id: 'strat-1',
        name: 'AI Strategy 2026',
      });

      const result = await executeCreateStrategy({
        name: 'AI Strategy 2026',
        description: 'Enterprise AI adoption roadmap',
        directives: [
          { directive: 'Deploy LLM for internal KB', priority: 'High' },
          { directive: 'Train ML models for demand forecasting', priority: 'Medium' },
          { directive: 'Explore edge AI', priority: 'Low' },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.data?.id).toBe('strat-1');
      expect(result.data?.name).toBe('AI Strategy 2026');
      expect(mockCreateStrategy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'AI Strategy 2026',
          mainDirectives: expect.arrayContaining([
            expect.objectContaining({ directive: 'Deploy LLM for internal KB', priority: 10 }),
            expect.objectContaining({ directive: 'Train ML models for demand forecasting', priority: 5 }),
            expect.objectContaining({ directive: 'Explore edge AI', priority: 3 }),
          ]),
        })
      );
      expect(mockEmitDataRefresh).toHaveBeenCalledWith('strategies', 'ai-assistant');
    });

    it('should create strategy without directives', async () => {
      mockCreateStrategy.mockResolvedValue({ id: 'strat-2', name: 'Cloud Strategy' });

      const result = await executeCreateStrategy({
        name: 'Cloud Strategy',
        description: 'Migrate to cloud',
      });

      expect(result.success).toBe(true);
      expect(mockCreateStrategy).toHaveBeenCalledWith(expect.objectContaining({ mainDirectives: [] }));
    });

    it('should use description as content and aiGeneratedSummary', async () => {
      mockCreateStrategy.mockResolvedValue({ id: 'strat-3', name: 'Data Strategy' });

      await executeCreateStrategy({
        name: 'Data Strategy',
        description: 'Unified data platform',
      });

      expect(mockCreateStrategy).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Unified data platform',
          aiGeneratedSummary: 'Unified data platform',
        })
      );
    });

    it('should generate directive IDs with index', async () => {
      mockCreateStrategy.mockResolvedValue({ id: 'strat-4', name: 'Test' });

      await executeCreateStrategy({
        name: 'Test',
        description: 'desc',
        directives: [{ directive: 'First directive', priority: 'High' }],
      });

      const call = mockCreateStrategy.mock.calls[0][0];
      expect(call.mainDirectives[0].id).toBe('directive-1');
    });

    it('should handle service errors', async () => {
      mockCreateStrategy.mockRejectedValue(new Error('Strategy creation failed'));

      const result = await executeCreateStrategy({
        name: 'Test',
        description: 'desc',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Strategy creation failed');
    });
  });

  // --------------------------------------------------------------------------
  // executeCreateSignal
  // --------------------------------------------------------------------------
  describe('executeCreateSignal', () => {
    it('should create a signal with all fields', async () => {
      mockCreateSignal.mockResolvedValue({
        id: 'signal-1',
        title: 'New AI Framework',
      });

      const result = await executeCreateSignal({
        type: 'news',
        title: 'New AI Framework',
        description: 'A new framework was released',
        source: 'TechCrunch',
        url: 'https://techcrunch.com/article',
        relevanceScore: 80,
      });

      expect(result.success).toBe(true);
      expect(result.data?.id).toBe('signal-1');
      expect(result.data?.title).toBe('New AI Framework');
      expect(mockCreateSignal).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'news',
          title: 'New AI Framework',
          source: 'TechCrunch',
          url: 'https://techcrunch.com/article',
          relevanceScore: 80,
        })
      );
      expect(mockEmitDataRefresh).toHaveBeenCalledWith('signals', 'ai-assistant');
    });

    it('should generate placeholder URL when none provided', async () => {
      mockCreateSignal.mockResolvedValue({ id: 'signal-2', title: 'Test' });

      await executeCreateSignal({
        type: 'trend',
        title: 'Test',
        description: 'AI trend',
      });

      const call = mockCreateSignal.mock.calls[0][0];
      expect(call.url).toContain('https://assistant.radarist.ai/signal/');
    });

    it('should add metadata when no URL provided', async () => {
      mockCreateSignal.mockResolvedValue({ id: 'signal-3', title: 'Test' });

      await executeCreateSignal({
        type: 'trend',
        title: 'Test',
        description: 'AI trend',
      });

      const call = mockCreateSignal.mock.calls[0][0];
      expect(call.metadata).toEqual({ agentId: 'ai-assistant', createdVia: 'chat' });
    });

    it('should NOT add metadata when URL is provided', async () => {
      mockCreateSignal.mockResolvedValue({ id: 'signal-4', title: 'Test' });

      await executeCreateSignal({
        type: 'news',
        title: 'Test',
        description: 'desc',
        url: 'https://example.com',
      });

      const call = mockCreateSignal.mock.calls[0][0];
      expect(call.metadata).toBeUndefined();
    });

    it('should default source to AI Assistant', async () => {
      mockCreateSignal.mockResolvedValue({ id: 'signal-5', title: 'Test' });

      await executeCreateSignal({ type: 'news', title: 'Test', description: 'desc' });

      expect(mockCreateSignal).toHaveBeenCalledWith(expect.objectContaining({ source: 'AI Assistant' }));
    });

    it('should default relevanceScore to 50', async () => {
      mockCreateSignal.mockResolvedValue({ id: 'signal-6', title: 'Test' });

      await executeCreateSignal({ type: 'news', title: 'Test', description: 'desc' });

      expect(mockCreateSignal).toHaveBeenCalledWith(expect.objectContaining({ relevanceScore: 50 }));
    });

    it('should truncate long descriptions in aiSummary', async () => {
      mockCreateSignal.mockResolvedValue({ id: 'signal-7', title: 'Test' });
      const longDesc = 'x'.repeat(300);

      await executeCreateSignal({ type: 'news', title: 'Test', description: longDesc });

      const call = mockCreateSignal.mock.calls[0][0];
      expect(call.aiSummary).toContain('...');
      expect(call.aiSummary.length).toBeLessThanOrEqual(203);
    });

    it('should handle service errors', async () => {
      mockCreateSignal.mockRejectedValue(new Error('Signal creation failed'));

      const result = await executeCreateSignal({
        type: 'news',
        title: 'Test',
        description: 'desc',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Signal creation failed');
    });

    it('uses provided summary for aiSummary instead of truncating description', async () => {
      mockCreateSignal.mockResolvedValue({ id: 'signal-summary', title: 'Test' });

      await executeCreateSignal({
        type: 'news',
        title: 'Test',
        description: 'A long description that should not be used for the summary field.',
        summary: 'A crisp 1-sentence synthesis.',
      });

      const call = mockCreateSignal.mock.calls[0][0];
      expect(call.aiSummary).toBe('A crisp 1-sentence synthesis.');
    });

    it('uses provided sentiment instead of hardcoded neutral', async () => {
      mockCreateSignal.mockResolvedValue({ id: 'signal-sent', title: 'Test' });

      await executeCreateSignal({
        type: 'news',
        title: 'Test',
        description: 'desc',
        sentiment: 'positive',
      });

      const call = mockCreateSignal.mock.calls[0][0];
      expect(call.sentiment).toBe('positive');
    });

    it('returns a structured error for invalid sentiment without calling createSignal', async () => {
      const result = await executeCreateSignal({
        type: 'news',
        title: 'Test',
        description: 'desc',
        sentiment: 'euphoric',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('sentiment must be one of');
      expect(mockCreateSignal).not.toHaveBeenCalled();
    });

    it('clamps relevanceScore to [0, 100]', async () => {
      mockCreateSignal.mockResolvedValue({ id: 'signal-clamp', title: 'Test' });

      await executeCreateSignal({
        type: 'news',
        title: 'Test',
        description: 'desc',
        relevanceScore: 150,
      });

      const callHigh = mockCreateSignal.mock.calls[0][0];
      expect(callHigh.relevanceScore).toBe(100);

      mockCreateSignal.mockClear();
      mockCreateSignal.mockResolvedValue({ id: 'signal-clamp2', title: 'Test' });

      await executeCreateSignal({
        type: 'news',
        title: 'Test',
        description: 'desc',
        relevanceScore: -10,
      });

      const callLow = mockCreateSignal.mock.calls[0][0];
      expect(callLow.relevanceScore).toBe(0);
    });

    it('uses publishedAt for the date field when provided', async () => {
      mockCreateSignal.mockResolvedValue({ id: 'signal-date', title: 'Test' });
      const pubDate = Date.UTC(2026, 3, 19);

      await executeCreateSignal({
        type: 'news',
        title: 'Test',
        description: 'desc',
        publishedAt: pubDate,
      });

      const call = mockCreateSignal.mock.calls[0][0];
      expect(call.date).toBe(pubDate);
    });

    // ------------------------------------------------------------------------
    // AI-040 — linkedEntityNames is all-or-nothing and fail-visible.
    // ------------------------------------------------------------------------
    describe('linkedEntityNames (AI-040)', () => {
      it('resolves every name, forwards buckets, and returns the resolved identities', async () => {
        mockCreateSignal.mockResolvedValue({ id: 'signal-le', title: 'Test' });
        mockResolveLinkedEntityNames.mockResolvedValueOnce({
          companies: ['co-nvidia'],
          technologies: ['tech-isaac'],
          resolved: [
            { requestedName: 'NVIDIA', matchedName: 'NVIDIA', id: 'co-nvidia', kind: 'company' },
            { requestedName: 'Isaac GR00T', matchedName: 'NVIDIA Isaac GR00T', id: 'tech-isaac', kind: 'technology' },
          ],
          unresolved: [],
        });

        const result = await executeCreateSignal({
          type: 'news',
          title: 'Test',
          description: 'desc',
          linkedEntityNames: ['NVIDIA', 'Isaac GR00T'],
        });

        expect(mockResolveLinkedEntityNames).toHaveBeenCalledWith(['NVIDIA', 'Isaac GR00T']);
        expect(mockCreateSignal.mock.calls[0][0].linkedEntities).toEqual({
          companies: ['co-nvidia'],
          technologies: ['tech-isaac'],
        });
        expect(result.success).toBe(true);
        // The receipt names exactly what was linked — the caller never has to
        // assume the request was honoured.
        expect(result.data?.linkedEntities).toEqual([
          { requestedName: 'NVIDIA', matchedName: 'NVIDIA', id: 'co-nvidia', kind: 'company' },
          { requestedName: 'Isaac GR00T', matchedName: 'NVIDIA Isaac GR00T', id: 'tech-isaac', kind: 'technology' },
        ]);
      });

      it('omits resolution entirely when linkedEntityNames is not provided', async () => {
        mockCreateSignal.mockResolvedValue({ id: 'signal-nole', title: 'Test' });

        const result = await executeCreateSignal({ type: 'news', title: 'Test', description: 'desc' });

        expect(mockResolveLinkedEntityNames).not.toHaveBeenCalled();
        expect(mockCreateSignal.mock.calls[0][0].linkedEntities).toEqual({});
        expect(result.data?.linkedEntities).toEqual([]);
      });

      it('refuses with ZERO mutation when a name matches nothing (the live AI-040 failure)', async () => {
        mockResolveLinkedEntityNames.mockResolvedValueOnce({
          companies: ['co-nvidia'],
          technologies: [],
          resolved: [{ requestedName: 'NVIDIA', matchedName: 'NVIDIA', id: 'co-nvidia', kind: 'company' }],
          unresolved: ['Totally Unknown Corp'],
        });

        const result = await executeCreateSignal({
          type: 'news',
          title: 'Test',
          description: 'desc',
          linkedEntityNames: ['NVIDIA', 'Totally Unknown Corp'],
        });

        expect(result.success).toBe(false);
        expect(mockCreateSignal).not.toHaveBeenCalled();
        expect(result.noMutation).toEqual({ mutationAttempted: false, stage: 'lookup' });
        // Names both the failure and what DID resolve, so the model can retry.
        expect(result.error).toContain('"Totally Unknown Corp"');
        expect(result.error).toContain('co-nvidia');
      });

      it('refuses with ZERO mutation when the entity libraries cannot be read', async () => {
        mockResolveLinkedEntityNames.mockRejectedValueOnce(
          new Error('Could not read the company library to resolve linked entity names: asyncQueue rejected')
        );

        const result = await executeCreateSignal({
          type: 'news',
          title: 'Test',
          description: 'desc',
          linkedEntityNames: ['NVIDIA'],
        });

        expect(result.success).toBe(false);
        expect(mockCreateSignal).not.toHaveBeenCalled();
        expect(result.noMutation).toEqual({ mutationAttempted: false, stage: 'lookup' });
        expect(result.error).toContain('could not be read');
        // A read failure must NOT be reported as "this entity does not exist".
        expect(result.error).not.toContain('matched no company');
      });

      it('refuses a non-array linkedEntityNames argument before any write', async () => {
        const result = await executeCreateSignal({
          type: 'news',
          title: 'Test',
          description: 'desc',
          linkedEntityNames: 'NVIDIA',
        });

        expect(result.success).toBe(false);
        expect(mockResolveLinkedEntityNames).not.toHaveBeenCalled();
        expect(mockCreateSignal).not.toHaveBeenCalled();
        expect(result.noMutation).toEqual({ mutationAttempted: false, stage: 'validation' });
      });

      it('refuses blank entries before any write', async () => {
        const result = await executeCreateSignal({
          type: 'news',
          title: 'Test',
          description: 'desc',
          linkedEntityNames: ['NVIDIA', '   '],
        });

        expect(result.success).toBe(false);
        expect(mockResolveLinkedEntityNames).not.toHaveBeenCalled();
        expect(mockCreateSignal).not.toHaveBeenCalled();
        expect(result.noMutation).toEqual({ mutationAttempted: false, stage: 'validation' });
      });

      it('refuses an over-cap list rather than silently truncating it', async () => {
        const result = await executeCreateSignal({
          type: 'news',
          title: 'Test',
          description: 'desc',
          linkedEntityNames: Array.from({ length: 11 }, (_, index) => `Name ${index}`),
        });

        expect(result.success).toBe(false);
        expect(mockResolveLinkedEntityNames).not.toHaveBeenCalled();
        expect(mockCreateSignal).not.toHaveBeenCalled();
        expect(result.noMutation).toEqual({ mutationAttempted: false, stage: 'validation' });
        expect(result.error).toContain('at most 10');
      });

      it('proves no mutation for an invalid signal type', async () => {
        const result = await executeCreateSignal({ type: 'nonsense', title: 'Test', description: 'desc' });

        expect(result.success).toBe(false);
        expect(mockCreateSignal).not.toHaveBeenCalled();
        expect(result.noMutation).toEqual({ mutationAttempted: false, stage: 'validation' });
      });

      it('does NOT claim no-mutation once the create has been attempted', async () => {
        mockCreateSignal.mockRejectedValueOnce(new Error('firestore write failed mid-flight'));

        const result = await executeCreateSignal({ type: 'news', title: 'Test', description: 'desc' });

        expect(result.success).toBe(false);
        expect(result.noMutation).toBeUndefined();
      });
    });
  });

  // --------------------------------------------------------------------------
  // executeDeleteEntity
  // --------------------------------------------------------------------------
  describe('executeDeleteEntity', () => {
    it('should require confirmation before deleting (machine caller, no confirmed flag)', async () => {
      const result = await executeDeleteEntity({
        entityType: 'company',
        id: 'c1',
        confirmed: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('requires confirmation');
    });

    it('should require either id or name', async () => {
      const result = await executeDeleteEntity({
        entityType: 'company',
        confirmed: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Either 'id' or 'name'");
    });

    it.each([
      { id: '' },
      { id: '   ' },
      { id: 42 },
      { id: '\ud800' },
      { name: '' },
      { name: '   ' },
      { name: { unsafe: true } },
      { name: '\ud800' },
    ])('rejects invalid identifiers before lookup, confirmation, or deletion: %p', async (identifier) => {
      const result = await executeDeleteEntity({
        entityType: 'company',
        ...identifier,
        confirmed: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('non-empty');
      expect(result.data).toBeUndefined();
      expect(mockGetCompanies).not.toHaveBeenCalled();
      expect(mockDeleteCompany).not.toHaveBeenCalled();
    });

    it('rejects an unknown entity type before creating confirmation state', async () => {
      const invalid = await executeDeleteEntity(
        { entityType: 'not-real', id: 'sensitive-id', confirmed: true },
        {
          principal: 'human',
          userId: 'u1',
          requestId: 'invalid-request',
          confirmationText: destructiveConfirmationPhrase(
            destructiveActionFingerprint('deleteEntity', 'not-real', 'sensitive-id')
          ),
        }
      );

      expect(invalid.success).toBe(false);
      expect(invalid.error).toContain('Unknown entity type');
      expect(invalid.data).toBeUndefined();

      const validFingerprint = destructiveActionFingerprint('deleteEntity', 'company', 'sensitive-id');
      const valid = await executeDeleteEntity(
        { entityType: 'company', id: 'sensitive-id', confirmed: true },
        {
          principal: 'human',
          userId: 'u1',
          requestId: 'valid-request',
          confirmationText: destructiveConfirmationPhrase(validFingerprint),
        }
      );
      expect(valid.success).toBe(false);
      expect(valid.data).toMatchObject({ requiresConfirmation: true });
      expect(mockDeleteCompany).not.toHaveBeenCalled();
    });

    it('rejects simultaneous id and name before creating confirmation state', async () => {
      const targetFingerprint = destructiveActionFingerprint('deleteEntity', 'company', 'sensitive-id');
      const invalid = await executeDeleteEntity(
        {
          entityType: 'company',
          id: 'sensitive-id',
          name: 'Harmless',
          confirmed: true,
        },
        {
          principal: 'human',
          userId: 'u1',
          requestId: 'invalid-request',
          confirmationText: destructiveConfirmationPhrase(targetFingerprint),
        }
      );

      expect(invalid.success).toBe(false);
      expect(invalid.error).toContain("either 'id' or 'name'");
      expect(invalid.data).toBeUndefined();
      expect(mockGetCompanies).not.toHaveBeenCalled();
      expect(mockDeleteCompany).not.toHaveBeenCalled();

      const validFirstTurn = await executeDeleteEntity(
        { entityType: 'company', id: 'sensitive-id', confirmed: true },
        {
          principal: 'human',
          userId: 'u1',
          requestId: 'valid-request',
          confirmationText: destructiveConfirmationPhrase(targetFingerprint),
        }
      );
      expect(validFirstTurn.success).toBe(false);
      expect(validFirstTurn.data).toMatchObject({ requiresConfirmation: true });
      expect(mockDeleteCompany).not.toHaveBeenCalled();
    });

    it('should delete company by id when confirmed', async () => {
      const result = await executeDeleteEntity({
        entityType: 'company',
        id: 'c1',
        confirmed: true,
      });

      expect(result.success).toBe(true);
      expect(result.data?.message).toContain('Successfully deleted company');
      expect(result.data).toMatchObject({
        mutatedEntityTypes: [
          'company',
          'relation',
          'document',
          'entityDocumentLink',
          'technology',
          'prototype',
          'useCase',
          'signal',
        ],
      });
      expect(mockDeleteCompany).toHaveBeenCalledWith('c1');
    });

    it('should delete useCase by id when confirmed', async () => {
      const result = await executeDeleteEntity({
        entityType: 'useCase',
        id: 'uc-1',
        confirmed: true,
      });

      expect(result.success).toBe(true);
      expect(result.data?.message).toContain('Successfully deleted useCase');
      expect(result.data).toMatchObject({
        mutatedEntityTypes: [
          'useCase',
          'relation',
          'document',
          'entityDocumentLink',
          'technology',
          'prototype',
          'signal',
        ],
      });
      expect(mockDeleteUseCase).toHaveBeenCalledWith('uc-1');
    });

    it('should delete prototype by id when confirmed', async () => {
      const result = await executeDeleteEntity({
        entityType: 'prototype',
        id: 'proto-1',
        confirmed: true,
      });

      expect(result.success).toBe(true);
      expect(result.data?.message).toContain('Successfully deleted prototype');
      expect(result.data).toMatchObject({
        mutatedEntityTypes: ['prototype', 'relation', 'document', 'entityDocumentLink', 'initiative', 'painPoint'],
      });
      expect(mockDeletePrototype).toHaveBeenCalledWith('proto-1');
    });

    it('should delete strategy by id when confirmed', async () => {
      const result = await executeDeleteEntity({
        entityType: 'strategy',
        id: 'strat-1',
        confirmed: true,
      });

      expect(result.success).toBe(true);
      expect(result.data?.message).toContain('Successfully deleted strategy');
      expect(result.data).toMatchObject({
        mutatedEntityTypes: [
          'strategy',
          'relation',
          'document',
          'entityDocumentLink',
          'prototype',
          'initiative',
          'signal',
        ],
      });
      expect(mockDeleteStrategy).toHaveBeenCalledWith('strat-1');
    });

    it('should delete signal by id when confirmed', async () => {
      const result = await executeDeleteEntity({
        entityType: 'signal',
        id: 'sig-1',
        confirmed: true,
      });

      expect(result.success).toBe(true);
      expect(result.data?.message).toContain('Successfully deleted signal');
      expect(result.data).toMatchObject({
        mutatedEntityTypes: ['signal', 'relation', 'document', 'entityDocumentLink'],
      });
      expect(mockAdminDeleteSignals).toHaveBeenCalledWith(['sig-1']);
      expect(mockClientDeleteSignal).not.toHaveBeenCalled();
    });

    it('should fail closed when the server-side signal cascade retains the entity', async () => {
      mockAdminDeleteSignals.mockResolvedValueOnce({ deleted: 0, failed: ['sig-1'], relationsDeleted: 3 });

      const result = await executeDeleteEntity({
        entityType: 'signal',
        id: 'sig-1',
        confirmed: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to delete signal sig-1');
      expect(result.data).toMatchObject({
        relationsDeleted: 3,
        mutatedEntityTypes: ['signal', 'relation', 'document', 'entityDocumentLink'],
      });
      expect(mockEmitDataRefresh).not.toHaveBeenCalled();
    });

    it('should return error for unknown entity type', async () => {
      const result = await executeDeleteEntity({
        entityType: 'unknownType',
        id: 'x1',
        confirmed: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown entity type');
    });

    it('should delete technology by id when confirmed', async () => {
      const result = await executeDeleteEntity({
        entityType: 'technology',
        id: 'tech-abc123',
        confirmed: true,
      });

      expect(result.success).toBe(true);
      expect(mockDeleteTechnologyCompletely).toHaveBeenCalledWith('tech-abc123');
      expect(result.data).toMatchObject({
        placementsDeleted: 2,
        relationsDeleted: 3,
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
      expect(mockEmitDataRefresh).toHaveBeenCalledWith('technologies', 'ai-assistant');
    });

    it('should fail closed when the complete technology cascade reports an error', async () => {
      mockDeleteTechnologyCompletely.mockResolvedValueOnce({
        success: false,
        placementsDeleted: 1,
        relationsDeleted: 0,
        neo4jDeleted: false,
        error: 'Relation cleanup failed',
      });

      const result = await executeDeleteEntity({
        entityType: 'technology',
        id: 'tech-abc123',
        confirmed: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Relation cleanup failed');
      expect(result.data).toMatchObject({
        placementsDeleted: 1,
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

    it('reports conservative mutation metadata when the complete technology cascade throws', async () => {
      mockDeleteTechnologyCompletely.mockRejectedValueOnce(new Error('Technology cascade transport failed'));

      const result = await executeDeleteEntity({
        entityType: 'technology',
        id: 'tech-abc123',
        confirmed: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Technology cascade transport failed');
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

    it.each([
      {
        entityType: 'orgUnit',
        id: 'org-direct',
        refreshType: 'orgUnits',
        deleteMock: mockDeleteOrgUnit,
        mutatedEntityTypes: ['orgUnit', 'relation', 'document', 'entityDocumentLink', 'painPoint'],
      },
      {
        entityType: 'initiative',
        id: 'init-direct',
        refreshType: 'initiatives',
        deleteMock: mockDeleteInitiative,
        mutatedEntityTypes: ['initiative', 'relation', 'document', 'entityDocumentLink', 'painPoint'],
      },
      {
        entityType: 'painPoint',
        id: 'pp-direct',
        refreshType: 'painPoints',
        deleteMock: mockDeletePainPoint,
        mutatedEntityTypes: ['painPoint', 'relation', 'document', 'entityDocumentLink', 'initiative'],
      },
    ])('should execute the $entityType Admin cascade when deleting by id', async (testCase) => {
      const result = await executeDeleteEntity({
        entityType: testCase.entityType,
        id: testCase.id,
        confirmed: true,
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ mutatedEntityTypes: testCase.mutatedEntityTypes });
      expect(testCase.deleteMock).toHaveBeenCalledWith(testCase.id);
      expect(mockEmitDataRefresh).toHaveBeenCalledWith(testCase.refreshType, 'ai-assistant');
    });

    it('preserves structured ownership blockers from a generic Admin cascade', async () => {
      mockDeleteOrgUnit.mockRejectedValueOnce(
        new EntityDeletionBlockedError('orgUnit', 'org-blocked', [
          {
            collection: 'org-units',
            fieldPath: 'parentId',
            count: 2,
            sampleDocumentIds: ['child-2', 'child-1'],
            reason: 'Child Org Units must be reassigned.',
          },
        ])
      );

      const result = await executeDeleteEntity({
        entityType: 'orgUnit',
        id: 'org-blocked',
        confirmed: true,
      });

      expect(result).toMatchObject({
        success: false,
        data: {
          message: expect.stringContaining('reassign dependent records'),
          mutatedEntityTypes: ['orgUnit', 'relation', 'document', 'entityDocumentLink', 'painPoint'],
          deletionBlocker: {
            code: 'entity-deletion-blocked',
            entityType: 'orgUnit',
            entityId: 'org-blocked',
            totalBlockers: 2,
            blockers: [
              expect.objectContaining({
                collection: 'org-units',
                fieldPath: 'parentId',
                count: 2,
                sampleDocumentIds: ['child-1', 'child-2'],
              }),
            ],
          },
        },
      });
      expect(mockEmitDataRefresh).not.toHaveBeenCalled();
    });

    it('should search by name when id not provided', async () => {
      mockGetCompanies.mockResolvedValue([{ id: 'c1', name: 'Acme Corp' }]);

      const result = await executeDeleteEntity({
        entityType: 'company',
        name: 'Acme Corp',
        confirmed: true,
      });

      expect(result.success).toBe(true);
      expect(mockGetCompanies).toHaveBeenCalled();
      expect(mockDeleteCompany).toHaveBeenCalledWith('c1');
    });

    it('should return error when entity not found by name', async () => {
      mockGetCompanies.mockResolvedValue([]);

      const result = await executeDeleteEntity({
        entityType: 'company',
        name: 'Nonexistent Co',
        confirmed: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No company found with name');
    });

    it('should return multiple matches when ambiguous name given', async () => {
      mockGetCompanies.mockResolvedValue([
        { id: 'c1', name: 'Acme Corp A' },
        { id: 'c2', name: 'Acme Corp B' },
      ]);

      const result = await executeDeleteEntity({
        entityType: 'company',
        name: 'Acme',
        confirmed: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Multiple');
      const data = result.data as { matchingEntities?: { id: string; name: string }[] };
      expect(data.matchingEntities).toHaveLength(2);
    });

    it('should search useCases by name', async () => {
      mockGetUseCases.mockResolvedValue([{ id: 'uc-1', title: 'Invoice Processing' }]);

      const result = await executeDeleteEntity({
        entityType: 'useCase',
        name: 'Invoice Processing',
        confirmed: true,
      });

      expect(result.success).toBe(true);
      expect(mockDeleteUseCase).toHaveBeenCalledWith('uc-1');
    });

    it('should search prototypes by name', async () => {
      mockGetPrototypes.mockResolvedValue([{ id: 'proto-1', name: 'AI Chatbot' }]);

      const result = await executeDeleteEntity({
        entityType: 'prototype',
        name: 'AI Chatbot',
        confirmed: true,
      });

      expect(result.success).toBe(true);
      expect(mockDeletePrototype).toHaveBeenCalledWith('proto-1');
    });

    it('should search strategies by name', async () => {
      mockGetStrategies.mockResolvedValue([{ id: 'strat-1', name: 'Cloud Strategy' }]);

      const result = await executeDeleteEntity({
        entityType: 'strategy',
        name: 'Cloud Strategy',
        confirmed: true,
      });

      expect(result.success).toBe(true);
      expect(mockDeleteStrategy).toHaveBeenCalledWith('strat-1');
    });

    it('should search signals by name', async () => {
      mockGetSignals.mockResolvedValue([{ id: 'sig-1', title: 'AI Trend Signal' }]);

      const result = await executeDeleteEntity({
        entityType: 'signal',
        name: 'AI Trend Signal',
        confirmed: true,
      });

      expect(result.success).toBe(true);
      expect(mockAdminDeleteSignals).toHaveBeenCalledWith(['sig-1']);
      expect(mockClientDeleteSignal).not.toHaveBeenCalled();
    });

    it('should search orgUnits by name', async () => {
      mockGetOrgUnits.mockResolvedValue([{ id: 'org-1', name: 'Engineering Team' }]);

      const result = await executeDeleteEntity({
        entityType: 'orgUnit',
        name: 'Engineering Team',
        confirmed: true,
      });

      expect(result.success).toBe(true);
      expect(mockDeleteOrgUnit).toHaveBeenCalledWith('org-1');
    });

    it('should search initiatives by name', async () => {
      mockGetInitiatives.mockResolvedValue([{ id: 'init-1', name: 'Cloud Migration' }]);

      const result = await executeDeleteEntity({
        entityType: 'initiative',
        name: 'Cloud Migration',
        confirmed: true,
      });

      expect(result.success).toBe(true);
      expect(mockDeleteInitiative).toHaveBeenCalledWith('init-1');
    });

    it('should search painPoints by name', async () => {
      mockGetPainPoints.mockResolvedValue([{ id: 'pp-1', title: 'Legacy System' }]);

      const result = await executeDeleteEntity({
        entityType: 'painPoint',
        name: 'Legacy System',
        confirmed: true,
      });

      expect(result.success).toBe(true);
      expect(mockDeletePainPoint).toHaveBeenCalledWith('pp-1');
    });

    it('should handle unknown entity type when searching by name', async () => {
      const result = await executeDeleteEntity({
        entityType: 'unknownType',
        name: 'Something',
        confirmed: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown entity type');
    });

    it('should handle search errors', async () => {
      mockGetCompanies.mockRejectedValue(new Error('DB query failed'));

      const result = await executeDeleteEntity({
        entityType: 'company',
        name: 'Acme Corp',
        confirmed: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to search for company by name');
    });

    it('should emit refresh event after deletion', async () => {
      const result = await executeDeleteEntity({
        entityType: 'company',
        id: 'c1',
        confirmed: true,
      });

      expect(result.success).toBe(true);
      expect(mockEmitDataRefresh).toHaveBeenCalledWith('companies', 'ai-assistant');
    });

    it('should search technology by name', async () => {
      mockGetDecoupledTechnologies.mockResolvedValue([{ id: 'tech-1', name: 'React' }]);

      const result = await executeDeleteEntity({
        entityType: 'technology',
        name: 'React',
        confirmed: true,
      });

      expect(result.success).toBe(true);
      expect(mockDeleteTechnologyCompletely).toHaveBeenCalledWith('tech-1');
    });
  });

  // --------------------------------------------------------------------------
  // executeDeleteEntity — server-verified confirmation, human path (#121)
  //
  // The model must NOT be able to self-confirm. A pending action raised in one
  // turn is only redeemable on a LATER turn (different requestId) carrying the exact
  // action-bound raw-user phrase. A model-set `confirmed: true` is ignored.
  // --------------------------------------------------------------------------
  describe('executeDeleteEntity — server-verified confirmation (human, #121)', () => {
    const targetFingerprint = destructiveActionFingerprint('deleteEntity', 'company', 'c1');
    const confirmationPhrase = destructiveConfirmationPhrase(targetFingerprint);
    const ctx = (requestId: string, confirmationText?: string) => ({
      principal: 'human' as const,
      userId: 'u1',
      requestId,
      confirmationText,
    });

    beforeEach(() => {
      _resetConfirmationStore();
      mockDeleteCompany.mockResolvedValue(undefined);
    });

    it('raises a confirmation and does NOT delete on the first call', async () => {
      const first = await executeDeleteEntity({ entityType: 'company', id: 'c1' }, ctx('req-1'));

      expect(first.success).toBe(false);
      const data = first.data as DestructiveGateRefusal;
      expect(data.requiresConfirmation).toBe(true);
      expect(mockDeleteCompany).not.toHaveBeenCalled();
    });

    it('ignores a model-set confirmed:true on the human path (cannot self-confirm)', async () => {
      const result = await executeDeleteEntity(
        { entityType: 'company', id: 'c1', confirmed: true },
        ctx('req-1', confirmationPhrase)
      );

      expect(result.success).toBe(false);
      expect((result.data as DestructiveGateRefusal).requiresConfirmation).toBe(true);
      expect(mockDeleteCompany).not.toHaveBeenCalled();
    });

    it('refuses a same-turn re-issue (same request cannot self-confirm)', async () => {
      await executeDeleteEntity({ entityType: 'company', id: 'c1' }, ctx('req-1'));

      const replay = await executeDeleteEntity({ entityType: 'company', id: 'c1' }, ctx('req-1', confirmationPhrase));

      expect(replay.success).toBe(false);
      expect(mockDeleteCompany).not.toHaveBeenCalled();
    });

    it('deletes when the exact action phrase arrives on a later turn', async () => {
      await executeDeleteEntity({ entityType: 'company', id: 'c1' }, ctx('req-1'));

      const second = await executeDeleteEntity({ entityType: 'company', id: 'c1' }, ctx('req-2', confirmationPhrase));

      expect(second.success).toBe(true);
      expect(mockDeleteCompany).toHaveBeenCalledWith('c1');
    });

    it('binds a sole substring name match to the canonical resolved ID and name', async () => {
      mockGetCompanies.mockResolvedValue([{ id: 'company-canonical', name: 'Acme Subsidiary' }]);
      const canonicalFingerprint = destructiveActionFingerprint('deleteEntity', 'company', 'company-canonical');
      const canonicalPhrase = destructiveConfirmationPhrase(canonicalFingerprint);

      const first = await executeDeleteEntity(
        { entityType: 'company', name: 'Acme', confirmed: true },
        ctx('req-name-1', canonicalPhrase)
      );

      expect(first.success).toBe(false);
      expect(first.error).toContain('delete the company "Acme Subsidiary"');
      expect(first.error).toContain(canonicalPhrase);
      expect(mockDeleteCompany).not.toHaveBeenCalled();

      const confirmed = await executeDeleteEntity(
        { entityType: 'company', name: 'Acme', confirmed: true },
        ctx('req-name-2', canonicalPhrase)
      );

      expect(confirmed.success).toBe(true);
      expect(mockDeleteCompany).toHaveBeenCalledWith('company-canonical');
    });

    it.each(['yes', 'no', 'please continue', undefined])(
      'a nonmatching later message (%p) cancels instead of deleting',
      async (confirmationText) => {
        await executeDeleteEntity({ entityType: 'company', id: 'c1' }, ctx('req-1'));

        const later = await executeDeleteEntity(
          { entityType: 'company', id: 'c1', confirmed: true },
          ctx('req-2', confirmationText)
        );

        expect(later.success).toBe(false);
        expect(later.error).toContain('cancelled');
        expect(mockDeleteCompany).not.toHaveBeenCalled();

        const stalePhrase = await executeDeleteEntity(
          { entityType: 'company', id: 'c1' },
          ctx('req-3', confirmationPhrase)
        );
        expect(stalePhrase.success).toBe(false);
        expect(mockDeleteCompany).not.toHaveBeenCalled();
      }
    );

    it('does not pre-confirm a different entity (fingerprint-bound)', async () => {
      await executeDeleteEntity({ entityType: 'company', id: 'c1' }, ctx('req-1'));

      // A different target on the next turn is NOT already confirmed — it re-prompts.
      const wrongTarget = await executeDeleteEntity(
        { entityType: 'company', id: 'c2' },
        ctx('req-2', confirmationPhrase)
      );

      expect(wrongTarget.success).toBe(false);
      expect(mockDeleteCompany).not.toHaveBeenCalled();
    });

    it('is one-time use — re-issuing after a completed delete re-prompts', async () => {
      await executeDeleteEntity({ entityType: 'company', id: 'c1' }, ctx('req-1'));
      await executeDeleteEntity({ entityType: 'company', id: 'c1' }, ctx('req-2', confirmationPhrase));
      mockDeleteCompany.mockClear();

      const reuse = await executeDeleteEntity({ entityType: 'company', id: 'c1' }, ctx('req-3', confirmationPhrase));

      expect(reuse.success).toBe(false);
      expect(mockDeleteCompany).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // executeCreateCompanyWithResearch
  // --------------------------------------------------------------------------
  describe('executeCreateCompanyWithResearch', () => {
    const minimalResearchData: ComprehensiveCompanyResearchResult = {
      name: 'TechCorp',
      description: 'A technology company',
      website: 'https://techcorp.com',
      industry: ['technology'],
      // AI-028 — real domain enum members. The old fixture used 'SME' and
      // 'Established', which are members of neither CompanySize nor CompanyStage
      // and were being cast straight onto the persisted company.
      size: 'medium',
      stage: 'private',
      location: { city: 'San Francisco', country: 'US' },
      socialLinks: {
        linkedin: 'https://linkedin.com/company/techcorp',
        twitter: 'https://twitter.com/techcorp',
        github: 'https://github.com/techcorp',
      },
      technologyStack: ['React', 'Node.js'],
      contacts: [],
      competitors: [],
      swot: { strengths: [], weaknesses: [], opportunities: [], threats: [] },
      receipts: { size: [{ url: 'https://reuters.com/techcorp' }] },
      unknowns: [],
      contradictions: [],
      vendorCapabilities: [],
      missingEvidence: ['benchmark', 'pricing', 'sla', 'security', 'trial'],
      sourcingComplete: false,
      citationsVerified: false,
    };

    // AI-028 — an unestablished field must not be written as if it were found.
    it('abstains on unknown size and stage, and records them as unknown', async () => {
      mockCreateCompany.mockResolvedValue({ id: 'c9', name: 'VagueCo' });
      mockGetCompanies.mockResolvedValue([]);

      await executeCreateCompanyWithResearch({
        ...minimalResearchData,
        name: 'VagueCo',
        size: undefined,
        stage: undefined,
        location: undefined,
        industry: [],
        technologyStack: [],
        receipts: {},
        unknowns: ['size', 'stage', 'country', 'industries'],
      });

      const created = mockCreateCompany.mock.calls[0][0] as {
        size?: string;
        stage?: string;
        industry: string[];
        location: { city: string; country: string };
        aiResearch: { data: { unknowns: string[] } };
      };
      // Abstain — size/stage are optional and stay absent when research could
      // not source them, rather than being written as a finding-like default.
      expect(created.size).toBeUndefined();
      expect(created.stage).toBeUndefined();
      expect(created.industry).toEqual([]);
      expect(created.location).toEqual({ city: '', country: '' });

      // The provenance block is now persisted atomically with the company
      // through persistSourcedCompanyResearch, not a separate update.
      expect(created.aiResearch.data.unknowns).toEqual(expect.arrayContaining(['size', 'stage']));
    });

    it('persists claim receipts even when no competitors were found', async () => {
      mockCreateCompany.mockResolvedValue({ id: 'c10', name: 'TechCorp' });
      mockGetCompanies.mockResolvedValue([]);

      await executeCreateCompanyWithResearch({ ...minimalResearchData, competitors: [] });

      const created = mockCreateCompany.mock.calls[0][0] as {
        aiResearch: { data: { receipts: Record<string, unknown>; missingEvidence: string[] } };
      };
      const research = created.aiResearch.data;
      expect(research.receipts.size).toBeDefined();
      expect(research.missingEvidence).toContain('pricing');
    });

    it('should create a company with basic research data', async () => {
      mockCreateCompany.mockResolvedValue({ id: 'c1', name: 'TechCorp', description: 'A technology company' });
      mockGetCompanies.mockResolvedValue([]);

      const result = await executeCreateCompanyWithResearch(minimalResearchData);

      expect(result.success).toBe(true);
      expect(result.data?.id).toBe('c1');
      expect(result.data?.name).toBe('TechCorp');
      expect(result.data?.contactsCreated).toBe(0);
      expect(result.data?.competitorsAdded).toBe(0);
      expect(result.data?.swotPopulated).toBe(false);
      expect(result.data?.researchStatus).toBe('draft');
      expect(result.data?.sourceReviewRequired).toBe(true);
      expect(result.data?.citationsVerified).toBe(false);
    });

    it('keeps unreceipted social links out of root fields and document links', async () => {
      mockCreateCompany.mockResolvedValue({ id: 'c1', name: 'TechCorp', description: 'A technology company' });
      mockGetCompanies.mockResolvedValue([]);

      await executeCreateCompanyWithResearch({
        ...minimalResearchData,
        receipts: {
          ...minimalResearchData.receipts,
          website: [{ url: 'https://publisher.example/techcorp-profile' }],
        },
      });

      const call = mockCreateCompany.mock.calls[0][0];
      expect(call.documents).toHaveLength(1);
      expect(call.documents[0]).toEqual(expect.objectContaining({ name: 'Company Website' }));
      expect(call.socialLinks).toEqual({});
    });

    it('should not add document links for URLs already in description', async () => {
      mockCreateCompany.mockResolvedValue({
        id: 'c1',
        name: 'TechCorp',
        description: 'Visit techcorp.com for more info',
      });
      mockGetCompanies.mockResolvedValue([]);

      await executeCreateCompanyWithResearch({
        ...minimalResearchData,
        description: 'Visit techcorp.com for more info',
        receipts: {
          ...minimalResearchData.receipts,
          website: [{ url: 'https://publisher.example/techcorp-profile' }],
        },
      });

      const call = mockCreateCompany.mock.calls[0][0];
      // Website document should be filtered since domain appears in description
      const websiteDoc = call.documents.find((d: { name: string }) => d.name === 'Company Website');
      expect(websiteDoc).toBeUndefined();
    });

    it('does not create a document or root field for an unsafe website value even with a receipt', async () => {
      mockCreateCompany.mockResolvedValue({ id: 'c1', name: 'TechCorp' });

      await executeCreateCompanyWithResearch({
        ...minimalResearchData,
        website: 'javascript:alert(1)',
        receipts: {
          ...minimalResearchData.receipts,
          website: [{ url: 'https://publisher.example/techcorp-profile' }],
        },
      });

      const created = mockCreateCompany.mock.calls[0][0];
      expect(created.documents).toEqual([]);
      expect(created.website).toBe('');
    });

    it('does not persist unsourced SWOT', async () => {
      mockCreateCompany.mockResolvedValue({ id: 'c1', name: 'TechCorp', description: 'A technology company' });
      mockUpdateCompany.mockResolvedValue(undefined);
      mockGetCompanies.mockResolvedValue([]);

      const result = await executeCreateCompanyWithResearch({
        ...minimalResearchData,
        swot: {
          strengths: ['Strong brand', 'Large market share'],
          weaknesses: ['High debt'],
          opportunities: ['AI expansion'],
          threats: ['Competition'],
        },
      });

      expect(result.data?.swotPopulated).toBe(false);
      expect(mockCreateCompany).toHaveBeenCalledTimes(1);
      expect('swot' in mockCreateCompany.mock.calls[0][0]).toBe(false);
    });

    it('does not auto-create contacts after their sources were dropped', async () => {
      mockCreateCompany.mockResolvedValue({ id: 'c1', name: 'TechCorp', description: 'A tech company' });
      mockGetCompanies.mockResolvedValue([]);

      const result = await executeCreateCompanyWithResearch({
        ...minimalResearchData,
        contacts: [
          { name: 'John Smith', role: 'CEO', linkedin: 'https://linkedin.com/in/johnsmith' },
          { name: 'Jane Doe', role: 'CTO', linkedin: '' },
        ],
      });

      expect(result.data?.contactsCreated).toBe(0);
    });

    it('keeps sourced competitor names in draft provenance without side materialization', async () => {
      mockCreateCompany.mockResolvedValue({ id: 'c1', name: 'TechCorp', description: 'A technology company' });
      mockGetCompanies.mockResolvedValue([]);
      mockUpdateCompany.mockResolvedValue(undefined);

      const result = await executeCreateCompanyWithResearch({
        ...minimalResearchData,
        competitors: [{ name: 'CompetitorA', sources: [{ url: 'https://news.example/competitorA' }] }],
      });

      expect(result.data?.competitorsAdded).toBe(0);
      expect(mockCreateCompany).toHaveBeenCalledTimes(1);
      expect(mockCreateCompany.mock.calls[0][0].aiResearch.data.competitors).toEqual(['CompetitorA']);
    });

    it('keeps unsourced competitor names draft-only too', async () => {
      mockCreateCompany.mockResolvedValue({ id: 'c1', name: 'TechCorp', description: 'A technology company' });
      const existingCompetitor = { id: 'existing-c2', name: 'ExistingCompetitor', description: 'Existing' };
      mockGetCompanies.mockResolvedValue([existingCompetitor]);
      mockUpdateCompany.mockResolvedValue(undefined);

      const result = await executeCreateCompanyWithResearch({
        ...minimalResearchData,
        competitors: [{ name: 'ExistingCompetitor', sources: [] }],
      });

      expect(result.data?.competitorsAdded).toBe(0);
      expect(mockCreateCompany).toHaveBeenCalledTimes(1);
      expect(mockCreateCompany.mock.calls[0][0].aiResearch.data.competitors).toEqual(['ExistingCompetitor']);
    });

    it('emits only a company refresh when competitor suggestions remain draft-only', async () => {
      mockCreateCompany.mockResolvedValue({ id: 'c1', name: 'TechCorp', description: 'A technology company' });
      mockGetCompanies.mockResolvedValue([]);
      mockUpdateCompany.mockResolvedValue(undefined);

      await executeCreateCompanyWithResearch({
        ...minimalResearchData,
        competitors: [{ name: 'CompetitorA', sources: [] }],
      });

      expect(mockEmitDataRefresh).toHaveBeenCalledWith(['companies'], 'ai-assistant');
    });

    it('should handle service errors gracefully', async () => {
      mockCreateCompany.mockRejectedValue(new Error('Company creation failed'));

      const result = await executeCreateCompanyWithResearch(minimalResearchData);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Company creation failed');
    });

    it('should skip competitors with empty or too-short names', async () => {
      mockCreateCompany.mockResolvedValue({ id: 'c1', name: 'TechCorp', description: 'A technology company' });
      mockGetCompanies.mockResolvedValue([]);

      const result = await executeCreateCompanyWithResearch({
        ...minimalResearchData,
        competitors: [
          { name: '', sources: [] },
          { name: 'A', sources: [] },
        ],
      });

      expect(result.data?.competitorsAdded).toBe(0);
    });
  });

  // ==========================================================================
  // Bug 3: parseHeadquarters tests
  // ==========================================================================

  describe('parseHeadquarters', () => {
    it('should parse standard "City, Country" format', () => {
      expect(parseHeadquarters('Barcelona, Spain')).toEqual({ city: 'Barcelona', country: 'Spain' });
    });

    it('should handle AI-polluted "locationBarcelona" prefix', () => {
      const result = parseHeadquarters('locationBarcelona');
      expect(result.city).toBe('Barcelona');
      expect(result.country).toBe('');
    });

    it('should strip social media pollution like "SpainSocial media linksLinkedin"', () => {
      const result = parseHeadquarters('SpainSocial media linksLinkedin');
      expect(result.city).toBe('Spain');
      expect(result.country).toBe('');
    });

    it('should return empty strings for empty/undefined input', () => {
      expect(parseHeadquarters('')).toEqual({ city: '', country: '' });
    });

    it('should strip URL pollution', () => {
      const result = parseHeadquarters('Berlin, Germanyhttps://example.com');
      expect(result.city).toBe('Berlin');
      expect(result.country).toBe('Germany');
    });

    it('removes a long mixed trailing punctuation suffix in one pass', () => {
      const result = parseHeadquarters(`Berlin, Germany${'\t,;. '.repeat(4_000)}`);
      expect(result).toEqual({ city: 'Berlin', country: 'Germany' });
    });

    it('preserves long internal whitespace when the final character is not trim punctuation', () => {
      const input = `Berlin${'\t'.repeat(20_000)}X`;
      expect(parseHeadquarters(input)).toEqual({ city: input, country: '' });
    });
  });

  // ==========================================================================
  // Bug 2: Auto-research trigger tests
  // ==========================================================================

  describe('executeCreateCompany auto-research', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockCreateCompany.mockResolvedValue({ id: 'c1', name: 'TestCo' });
      mockResearchCompanyComprehensive.mockResolvedValue({ overview: 'Test research' });
      mockUpdateCompany.mockResolvedValue(undefined);
    });

    it('should trigger background research after creation by default', async () => {
      const result = await executeCreateCompany({
        name: 'TestCo',
        description: 'A test company',
        website: 'https://test.co',
      });

      expect(result.success).toBe(true);
      expect(mockResearchCompanyComprehensive).toHaveBeenCalledWith({
        name: 'TestCo',
        website: 'https://test.co',
        description: 'A test company',
      });
    });

    it('should skip research when skipResearch is true', async () => {
      const result = await executeCreateCompany({
        name: 'TestCo',
        description: 'A test company',
        skipResearch: true,
      });

      expect(result.success).toBe(true);
      expect(mockResearchCompanyComprehensive).not.toHaveBeenCalled();
    });

    it('should succeed even if background research fails', async () => {
      mockResearchCompanyComprehensive.mockRejectedValue(new Error('Research API down'));

      const result = await executeCreateCompany({
        name: 'TestCo',
        description: 'A test company',
      });

      expect(result.success).toBe(true);
      expect(result.data?.id).toBe('c1');
      // Wait for the background promise to settle
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  });

  // --------------------------------------------------------------------------
  // DuplicateEntityError handling
  // --------------------------------------------------------------------------
  describe('DuplicateEntityError handling', () => {
    const { DuplicateEntityError } = jest.requireActual(
      '@/lib/entity-factory-shared'
    ) as typeof import('@/lib/entity-factory-shared');

    it('should return alreadyExists for duplicate company', async () => {
      mockCreateCompany.mockRejectedValue(new DuplicateEntityError('companies', 'slug', 'acme-corp', 'existing-c1'));

      const result = await executeCreateCompany({
        name: 'Acme Corp',
        description: 'A technology company',
      });

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.alreadyExists).toBe(true);
      expect(data.existingId).toBe('existing-c1');
      expect(data.message).toContain('already exists');
    });

    it('should still propagate non-duplicate errors for company', async () => {
      mockCreateCompany.mockRejectedValue(new Error('Network timeout'));

      const result = await executeCreateCompany({
        name: 'TestCo',
        description: 'desc',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network timeout');
    });
  });
});
