/**
 * @jest-environment node
 */

// ============================================================================
// Mocks
// ============================================================================

jest.mock('@/lib/firebase', () => ({ db: {} }));
jest.mock('firebase/firestore', () => ({
  __esModule: true,
  collection: jest.fn(),
  doc: jest.fn(() => ({ id: 'doc-id' })),
  getDocs: jest.fn(),
  getDoc: jest.fn(),
  setDoc: jest.fn(),
  updateDoc: jest.fn(),
  deleteDoc: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
}));

// All radar reads/writes in `radar-management.ts` moved to the admin-SDK
// helpers (see `radars-admin.ts`) so they work from the stateless
// `/api/ai/chat` route. The client-SDK `@/lib/radars` module is no longer
// imported by the source — every executor calls an `admin*` twin. Mock the
// full narrow surface they call.
const mockCreateRadar = jest.fn();
const mockGetAllRadars = jest.fn();
const mockUpdateRadar = jest.fn();
const mockAdminListRadars = jest.fn();
const mockAdminDeleteRadar = jest.fn();
const mockAdminGetRadarById = jest.fn();
const mockAdminGetOwnedRadarById = jest.fn();
// `getRadarById` and `adminGetRadarById` collapsed onto the single source
// import `adminGetRadarById`; keep the legacy `mockGetRadarById` name as an
// alias so the existing test-body stubs/assertions stay intact.
const mockGetRadarById = mockAdminGetRadarById;
const mockAdminGetTechnologiesWithPlacementsForRadar = jest.fn();
const mockAdminListTechnologies = jest.fn();
const mockAdminGetRadarPlacements = jest.fn();
const mockAdminSearchTechnologies = jest.fn();
jest.mock('@/lib/radars-admin', () => ({
  __esModule: true,
  adminCreateRadar: (...args: unknown[]) => mockCreateRadar(...args),
  adminUpdateRadar: (...args: unknown[]) => mockUpdateRadar(...args),
  adminGetAllRadars: (...args: unknown[]) => mockGetAllRadars(...args),
  adminListRadars: (...args: unknown[]) => mockAdminListRadars(...args),
  adminDeleteRadar: (...args: unknown[]) => mockAdminDeleteRadar(...args),
  adminGetRadarById: (...args: unknown[]) => mockAdminGetRadarById(...args),
  adminGetOwnedRadarById: (...args: unknown[]) => mockAdminGetOwnedRadarById(...args),
  adminGetTechnologiesWithPlacementsForRadar: (...args: unknown[]) =>
    mockAdminGetTechnologiesWithPlacementsForRadar(...args),
  adminListTechnologies: (...args: unknown[]) => mockAdminListTechnologies(...args),
  adminGetRadarPlacements: (...args: unknown[]) => mockAdminGetRadarPlacements(...args),
  adminSearchTechnologies: (...args: unknown[]) => mockAdminSearchTechnologies(...args),
  // Pass-through projection — keep the production shape so the
  // executor's return value matches what the model will see.
  // `description`/`ringSystem` are always-present keys (see radars-admin.ts).
  summarizeRadar: (r: {
    id: string;
    name: string;
    description?: string;
    ringSystem?: string;
    quadrants: unknown[];
  }) => ({
    id: r.id,
    name: r.name,
    description: r.description ?? '',
    ringSystem: r.ringSystem ?? 'Standard',
    quadrants: Array.isArray(r.quadrants)
      ? r.quadrants.map((q) =>
          typeof q === 'object' && q !== null && 'id' in q && 'name' in q
            ? {
                id: (q as { id: string }).id,
                name: (q as { name: string }).name,
                order: (q as { order?: number }).order ?? 0,
              }
            : { id: '', name: String(q), order: 0 }
        )
      : [],
  }),
  // Re-exported from `@/lib/radars` in production; defined here so the executor's
  // `instanceof OrphanedPlacementsError` orphan-handling branch is exercised.
  OrphanedPlacementsError: class OrphanedPlacementsError extends Error {
    report: unknown;
    constructor(report: { totalPlacements?: number }) {
      super(`Cannot shrink radar quadrants: ${report?.totalPlacements ?? 0} placement(s) would be orphaned`);
      this.name = 'OrphanedPlacementsError';
      this.report = report;
    }
  },
  // Real class so the executors' `instanceof RadarAuthorizationError` branch resolves.
  RadarAuthorizationError: class RadarAuthorizationError extends Error {
    radarId: string;
    constructor(radarId: string) {
      super(`Not authorized to mutate radar ${radarId}`);
      this.name = 'RadarAuthorizationError';
      this.radarId = radarId;
    }
  },
}));

// Technology reads/writes moved to the admin-SDK twin (`technology-admin.ts`):
// `getTechnologies` → `adminGetTechnologies`, `createTechnology` →
// `adminCreateTechnology`. The source no longer imports `@/lib/technology-service`,
// and the slug is now derived inline in the executor (no `generateSlug` call).
const mockGetTechnologies = jest.fn();
const mockCreateTechnology = jest.fn();
jest.mock('@/lib/technology-admin', () => ({
  __esModule: true,
  adminGetTechnologies: (...args: unknown[]) => mockGetTechnologies(...args),
  adminCreateTechnology: (...args: unknown[]) => mockCreateTechnology(...args),
}));

// Placement reads/writes moved to the admin-SDK twin (`radar-placement-admin.ts`).
// The source imports `adminCreateRadarPlacement`, `adminUpdateRadarPlacement`, and
// `adminGetPlacementForTechnologyOnRadar` from there. (`getRadarPlacements` and
// `getTechnologiesWithPlacementsForRadar` reads now live on `radars-admin` and are
// mocked above as `adminGetRadarPlacements` / `adminGetTechnologiesWithPlacementsForRadar`.)
const mockCreateRadarPlacement = jest.fn();
const mockUpdateRadarPlacement = jest.fn();
const mockGetPlacementForTechnologyOnRadar = jest.fn();
const acknowledgedGraphHandoff = {
  committed: true as const,
  acknowledged: true,
  reconciliationRequired: false,
};
const mockCreateRadarPlacementWithHandoff = jest.fn(
  async (...args: unknown[]) => ({
    placement: await mockCreateRadarPlacement(...args),
    graphHandoff: acknowledgedGraphHandoff,
  }),
);
const mockUpdateRadarPlacementWithHandoff = jest.fn(
  async (...args: unknown[]) => ({
    placement: await mockUpdateRadarPlacement(...args),
    graphHandoff: acknowledgedGraphHandoff,
  }),
);
jest.mock('@/lib/radar-placement-admin', () => ({
  __esModule: true,
  adminCreateRadarPlacement: (...args: unknown[]) => mockCreateRadarPlacement(...args),
  adminCreateRadarPlacementWithHandoff: (...args: unknown[]) =>
    mockCreateRadarPlacementWithHandoff(...args),
  adminUpdateRadarPlacement: (...args: unknown[]) => mockUpdateRadarPlacement(...args),
  adminUpdateRadarPlacementWithHandoff: (...args: unknown[]) =>
    mockUpdateRadarPlacementWithHandoff(...args),
  adminGetPlacementForTechnologyOnRadar: (...args: unknown[]) => mockGetPlacementForTechnologyOnRadar(...args),
  PlacementAuthorizationError: class PlacementAuthorizationError extends Error {
    radarId: string;
    constructor(radarId: string) {
      super(`Not authorized to mutate placements for radar ${radarId}`);
      this.name = 'PlacementAuthorizationError';
      this.radarId = radarId;
    }
  },
}));

const mockEmitDataRefresh = jest.fn();
jest.mock('@/lib/events/data-refresh', () => ({
  __esModule: true,
  emitDataRefresh: (...args: unknown[]) => mockEmitDataRefresh(...args),
}));

jest.mock('@/lib/ai/signal-evaluation', () => ({
  __esModule: true,
  cleanMarkdownFromText: jest.fn((text: string) => text.replace(/[*#_]/g, '')),
}));

jest.mock('@/lib/types', () => {
  const actualTypes = jest.requireActual('@/lib/types') as typeof import('@/lib/types');
  const _DEFAULT_CONFIGS = [
    { id: 'q_techniques', name: 'Techniques', order: 0 },
    { id: 'q_tools', name: 'Tools', order: 1 },
    { id: 'q_platforms', name: 'Platforms', order: 2 },
    { id: 'q_languages_frameworks', name: 'Languages & Frameworks', order: 3 },
  ];
  return {
    __esModule: true,
    normalizeQuadrants: jest.fn((q: unknown) =>
      Array.isArray(q) && q.length && typeof q[0] === 'object'
        ? (q as Array<{ name: string }>).map((x) => x.name)
        : ((q as string[]) ?? ['Languages & Frameworks', 'Platforms', 'Tools', 'Techniques'])
    ),
    ensureQuadrantConfigs: jest.fn((legacy: unknown) => {
      if (!Array.isArray(legacy) || legacy.length === 0) return [];
      return (legacy as (string | { id: string; name: string; order?: number })[]).map((item, i) => {
        if (typeof item === 'object' && item !== null && 'id' in item) {
          return { id: item.id, name: item.name, order: item.order ?? i };
        }
        const slug = String(item)
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_|_$/g, '');
        return { id: slug ? `q_${slug}` : `q_${i}`, name: String(item), order: i };
      });
    }),
    getQuadrantById: jest.fn((radar: { quadrants?: Array<{ id: string }> }, id: string) =>
      radar.quadrants?.find((q) => q.id === id)
    ),
    resolveQuadrantReference: actualTypes.resolveQuadrantReference,
    // Faithful id-first reconcile mirroring src/lib/types/radar.ts: existing id
    // preserved (and renamed), missing id minted, unknown id errors, removed ids
    // collected. Keeps this unit test honest about the executor's wiring.
    reconcileQuadrantConfigs: jest.fn(
      (
        existing: Array<{ id: string; name: string; description?: string }>,
        proposed: Array<{ id?: string; name: string; description?: string }>,
        idGen: (name: string, index: number) => string
      ) => {
        const errors: string[] = [];
        if (!proposed || proposed.length === 0) {
          errors.push('At least 1 quadrant is required');
          return { next: [], added: [], removed: [], renamed: [], errors };
        }
        const byId = new Map(existing.map((q) => [q.id, q]));
        const next: Array<{ id: string; name: string; description?: string; order: number }> = [];
        const added: typeof next = [];
        const renamed: Array<{ id: string; oldName: string; newName: string }> = [];
        const keptIds = new Set<string>();
        proposed.forEach((item, i) => {
          const name = (item.name ?? '').trim();
          if (item.id) {
            const ex = byId.get(item.id);
            if (!ex) {
              errors.push(`Unknown quadrant id: ${item.id}`);
              return;
            }
            const description = item.description ?? ex.description;
            next.push({ id: ex.id, name, ...(description !== undefined ? { description } : {}), order: i });
            keptIds.add(ex.id);
            if (ex.name !== name) renamed.push({ id: ex.id, oldName: ex.name, newName: name });
          } else {
            const minted = {
              id: idGen(name, i),
              name,
              ...(item.description !== undefined ? { description: item.description } : {}),
              order: i,
            };
            next.push(minted);
            added.push(minted);
          }
        });
        if (errors.length > 0) return { next: [], added: [], removed: [], renamed: [], errors };
        const removed = existing.filter((q) => !keptIds.has(q.id)).map((q) => q.id);
        return { next, added, removed, renamed, errors: [] };
      }
    ),
  };
});

jest.mock('@/lib/constants', () => ({
  __esModule: true,
  MIN_QUADRANTS: 1,
  MAX_QUADRANTS: 8,
  defaultQuadrantIdFromName: jest.fn((name: string, index: number) => {
    const slug = String(name)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '');
    return slug ? `q_${slug}` : `q_${index}`;
  }),
  buildDefaultQuadrantConfigs: jest.fn(() => [
    { id: 'q_techniques', name: 'Techniques', order: 0 },
    { id: 'q_tools', name: 'Tools', order: 1 },
    { id: 'q_platforms', name: 'Platforms', order: 2 },
    { id: 'q_languages_frameworks', name: 'Languages & Frameworks', order: 3 },
  ]),
}));

// ============================================================================
// Imports
// ============================================================================

import {
  RADAR_MANAGEMENT_TOOLS,
  executeCreateRadar,
  executeDeleteRadar,
  executeUpdateRadarSettings,
  executeListRadars,
  executeGetRadarDetails,
  executeSearchTechnologiesAdvanced,
  executeAddTechnologiesToRadar,
  executeUpdateTechnologyOnRadar,
  executePopulateRadarFromContext,
} from '../radar-management';
import {
  _resetConfirmationStore,
  destructiveActionFingerprint,
  destructiveConfirmationPhrase,
  type DestructiveGateRefusal,
} from '@/lib/ai/destructive-confirmation';
import type { QuadrantConfig } from '@/lib/types';
import { PlacementAuthorizationError } from '@/lib/radar-placement-admin';

// ============================================================================
// Tests
// ============================================================================

describe('Radar Management Tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: the acting user owns whatever radar they name. Owner-scoped
    // deletion tests that act as a non-owner override this to throw.
    mockAdminGetOwnedRadarById.mockImplementation(async (radarId: string) => {
      const resolved = await mockAdminGetRadarById(radarId);
      return (
        resolved ?? {
          id: radarId,
          name: 'Old Radar',
          quadrants: [],
        }
      );
    });
  });

  // --------------------------------------------------------------------------
  // executeCreateRadar
  // --------------------------------------------------------------------------
  describe('tool declaration contracts', () => {
    it('documents the same suggested placement keys the populate executor consumes', () => {
      const declaration = RADAR_MANAGEMENT_TOOLS.find(
        ({ name }) => name === 'populateRadarFromContext',
      );

      expect(declaration?.description).toContain('suggestedQuadrant');
      expect(declaration?.description).toContain('suggestedRing');
      expect(declaration?.description).not.toContain(
        'quadrant, ring (recommended',
      );
      expect(declaration?.description).not.toContain(
        'quadrant: "ML Frameworks"',
      );
    });
  });

  // --------------------------------------------------------------------------
  // executeCreateRadar
  // --------------------------------------------------------------------------
  describe('executeCreateRadar', () => {
    it('should create a radar with defaults', async () => {
      mockCreateRadar.mockResolvedValue({
        id: 'radar-1',
        name: 'AI Radar',
        slug: 'ai-radar',
        quadrants: [
          { id: 'q_techniques', name: 'Techniques', order: 0 },
          { id: 'q_tools', name: 'Tools', order: 1 },
          { id: 'q_platforms', name: 'Platforms', order: 2 },
          { id: 'q_languages_frameworks', name: 'Languages & Frameworks', order: 3 },
        ],
      });

      const result = await executeCreateRadar({ name: 'AI Radar' }, { userId: 'user-1' });

      expect(result.success).toBe(true);
      expect(result.data?.id).toBe('radar-1');
      expect(result.data?.name).toBe('AI Radar');
      // createRadar now takes (ownerId, name, description?, quadrants?) — owner threaded from context
      expect(mockCreateRadar).toHaveBeenCalledWith('user-1', 'AI Radar', undefined, undefined);
      expect(mockEmitDataRefresh).toHaveBeenCalledWith('radars', 'ai-assistant');
    });

    it('should create a radar with custom quadrants', async () => {
      mockCreateRadar.mockResolvedValue({
        id: 'radar-2',
        name: 'Frontend',
        slug: 'frontend',
        quadrants: [
          { id: 'q_frameworks', name: 'Frameworks', order: 0 },
          { id: 'q_build_tools', name: 'Build Tools', order: 1 },
          { id: 'q_testing', name: 'Testing', order: 2 },
          { id: 'q_design_systems', name: 'Design Systems', order: 3 },
        ],
      });
      mockUpdateRadar.mockResolvedValue(undefined);

      const result = await executeCreateRadar(
        {
          name: 'Frontend',
          quadrants: ['Frameworks', 'Build Tools', 'Testing', 'Design Systems'],
          ringSystem: 'Standard',
        },
        { userId: 'user-1' }
      );

      expect(result.success).toBe(true);
      // Custom quadrants go into createRadar as QuadrantConfig[] via ensureQuadrantConfigs,
      // ringSystem is then applied via a separate updateRadar call.
      expect(mockCreateRadar).toHaveBeenCalled();
      // The ring-system update carries the creator as the required owner arg.
      expect(mockUpdateRadar).toHaveBeenCalledWith('radar-2', 'user-1', {
        ringSystem: 'Standard',
      });
    });

    it('should reject invalid quadrant count', async () => {
      const result = await executeCreateRadar(
        {
          name: 'Bad',
          // 9 quadrants — exceeds MAX_QUADRANTS
          quadrants: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9'],
        },
        { userId: 'user-1' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/out of range/i);
    });

    it('should handle creation errors', async () => {
      mockCreateRadar.mockRejectedValue(new Error('Database error'));

      const result = await executeCreateRadar({ name: 'Test' }, { userId: 'user-1' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Database error');
    });

    it('does not report success when the committed Radar graph handoff is unacknowledged', async () => {
      mockCreateRadar.mockRejectedValue(
        new Error(
          'Radar radar-1 was saved in Firestore, but its graph projection handoff was not acknowledged. ' +
            'Do not recreate it; reconciliation will retry from the committed Radar.'
        )
      );

      const result = await executeCreateRadar({ name: 'Assistant Radar' }, { userId: 'user-1' });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/saved in Firestore.*not acknowledged.*Do not recreate.*reconciliation/i);
      expect(mockEmitDataRefresh).not.toHaveBeenCalled();
    });

    it('#1 (Assistant-tool authz) refuses to create a radar with no authenticated user — fails closed, never touches the DB', async () => {
      const anonymous = await executeCreateRadar({ name: 'Anon Radar' }, undefined);
      const emptyUid = await executeCreateRadar({ name: 'Anon Radar' }, { userId: '' });

      expect(anonymous.success).toBe(false);
      expect(anonymous.error).toMatch(/signed in/i);
      expect(emptyUid.success).toBe(false);
      expect(mockCreateRadar).not.toHaveBeenCalled();
    });

    it('#1 (Assistant-tool authz) stamps the calling user as the owner (Alice creates → Alice owns)', async () => {
      mockCreateRadar.mockResolvedValue({ id: 'radar-alice', name: 'Alice Radar', slug: 'alice-radar', quadrants: [] });

      await executeCreateRadar({ name: 'Alice Radar' }, { userId: 'alice' });

      // ownerId is threaded as the first positional arg to adminCreateRadar.
      expect(mockCreateRadar).toHaveBeenCalledWith('alice', 'Alice Radar', undefined, undefined);
    });
  });

  // --------------------------------------------------------------------------
  // executeDeleteRadar
  // --------------------------------------------------------------------------
  describe('executeDeleteRadar', () => {
    it.each([undefined, '', '   ', 42, '\ud800'])(
      'rejects an invalid radar ID before lookup or confirmation (%p)',
      async (radarId) => {
        const result = await executeDeleteRadar({ radarId, confirmed: true });

        expect(result.success).toBe(false);
        expect(result.error).toContain('non-empty radar ID');
        expect(result.data).toBeUndefined();
        expect(mockAdminListRadars).not.toHaveBeenCalled();
        expect(mockAdminDeleteRadar).not.toHaveBeenCalled();
      }
    );

    it('should require confirmation', async () => {
      mockAdminListRadars.mockResolvedValue([{ id: 'radar-1', name: 'Old Radar', quadrants: [] }]);

      const result = await executeDeleteRadar({ radarId: 'radar-1', confirmed: false }, { userId: 'u1' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('confirmation');
    });

    it('#2 refuses to delete when the acting user is not authenticated, and never reads or mutates', async () => {
      mockAdminListRadars.mockResolvedValue([{ id: 'radar-1', name: 'Old Radar', quadrants: [] }]);
      mockAdminDeleteRadar.mockResolvedValue({ placementsDeleted: 5 });

      // No `userId` — an unauthenticated caller must refuse BEFORE any lookup and
      // must never reach the mutation primitive with an undefined owner (the
      // `requireOwnerId: context?.userId` silent-bypass footgun this closes).
      const result = await executeDeleteRadar({ radarId: 'radar-1', confirmed: true }, {});

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/signed in/i);
      expect(mockAdminListRadars).not.toHaveBeenCalled();
      expect(mockAdminGetOwnedRadarById).not.toHaveBeenCalled();
      expect(mockAdminDeleteRadar).not.toHaveBeenCalled();
    });

    // ----------------------------------------------------------------------
    // #2 owner-scoped resolution BEFORE confirmation. A signed-in non-owner must
    // learn nothing: a foreign-owned radar and a nonexistent one produce the
    // SAME response, never the radar name, and never a confirmation prompt.
    // ----------------------------------------------------------------------
    describe('#2 owner-scoped resolution (no name/existence leak to non-owners)', () => {
      const { RadarAuthorizationError } = jest.requireMock('@/lib/radars-admin') as {
        RadarAuthorizationError: new (radarId: string) => Error;
      };
      const SECRET = 'Alice Secret Q3 Radar';

      beforeEach(() => {
        _resetConfirmationStore();
        // Alice owns radar-1 (named SECRET); every other (radarId, owner) pair —
        // foreign, ownerless, or missing — throws the SAME authorization error.
        mockAdminGetOwnedRadarById.mockImplementation(async (radarId: string, ownerId: string) => {
          if (radarId === 'radar-1' && ownerId === 'alice') {
            return { id: 'radar-1', name: SECRET, quadrants: [] };
          }
          throw new RadarAuthorizationError(radarId);
        });
        // If the flow ever fell back to the legacy name lookup, it WOULD expose
        // the name — leave it populated so the leak would surface if it regressed.
        mockAdminListRadars.mockResolvedValue([{ id: 'radar-1', name: SECRET, quadrants: [] }]);
        mockAdminDeleteRadar.mockResolvedValue({ placementsDeleted: 0 });
      });

      it('lets Alice confirm and delete her own radar', async () => {
        const result = await executeDeleteRadar({ radarId: 'radar-1', confirmed: true }, { userId: 'alice' });

        expect(result.success).toBe(true);
        expect(mockAdminDeleteRadar).toHaveBeenCalledWith('radar-1', 'alice', { cascade: true });
      });

      it("gives Bob byte-identical refusals for Alice's radar and a nonexistent one, leaking neither name nor existence", async () => {
        const foreign = await executeDeleteRadar(
          { radarId: 'radar-1' },
          { principal: 'human', userId: 'bob', requestId: 'req-foreign' }
        );
        _resetConfirmationStore();
        const missing = await executeDeleteRadar(
          { radarId: 'radar-gone' },
          { principal: 'human', userId: 'bob', requestId: 'req-missing' }
        );

        // Same response for a foreign-owned and a nonexistent radar → no oracle.
        expect(foreign).toEqual(missing);
        // Never reveals the radar name anywhere in the payload…
        expect(JSON.stringify(foreign)).not.toContain(SECRET);
        // …and never raises a confirmation prompt that would confirm existence.
        expect((foreign.data as DestructiveGateRefusal | undefined)?.requiresConfirmation).toBeUndefined();
        // A refusal, and NO mutation attempted for either target.
        expect(foreign.success).toBe(false);
        expect(mockAdminDeleteRadar).not.toHaveBeenCalled();
      });

      it('resolves ownership BEFORE minting a confirmation token (no token for a non-owner)', async () => {
        const first = await executeDeleteRadar(
          { radarId: 'radar-1' },
          { principal: 'human', userId: 'bob', requestId: 'req-1' }
        );
        // Even a later turn with the "correct" phrase cannot delete — Bob never
        // owned it, so no confirmation was ever raised to satisfy.
        expect(first.success).toBe(false);
        expect(mockAdminDeleteRadar).not.toHaveBeenCalled();
      });
    });

    it('should delete radar when confirmed', async () => {
      mockAdminListRadars.mockResolvedValue([{ id: 'radar-1', name: 'Old Radar', quadrants: [] }]);
      mockAdminDeleteRadar.mockResolvedValue({ placementsDeleted: 5 });

      const result = await executeDeleteRadar({ radarId: 'radar-1', confirmed: true }, { userId: 'u1' });

      expect(result.success).toBe(true);
      const data = result.data as {
        placementsDeleted?: number;
        mutatedEntityTypes: readonly string[];
      };
      expect(data.placementsDeleted).toBe(5);
      expect(data.mutatedEntityTypes).toEqual(['radar', 'radarPlacement', 'technology', 'relation']);
      expect(mockEmitDataRefresh).toHaveBeenCalledWith('radars', 'ai-assistant');
    });

    it('#2 gives a nonexistent radar the SAME denial as a foreign one (no not-found existence oracle)', async () => {
      const { RadarAuthorizationError } = jest.requireMock('@/lib/radars-admin') as {
        RadarAuthorizationError: new (radarId: string) => Error;
      };
      // Owner-scoped resolution throws for a missing radar exactly as it does for
      // a foreign one — the caller cannot tell the two apart.
      mockAdminGetOwnedRadarById.mockRejectedValue(new RadarAuthorizationError('missing'));

      const result = await executeDeleteRadar({ radarId: 'missing', confirmed: false }, { userId: 'u1' });

      expect(result.success).toBe(false);
      expect(result.error).not.toMatch(/not found/i);
      expect(result.error).toMatch(/permission/i);
      expect(mockAdminDeleteRadar).not.toHaveBeenCalled();
    });

    it('should handle delete errors', async () => {
      mockAdminListRadars.mockResolvedValue([{ id: 'radar-1', name: 'Old Radar', quadrants: [] }]);
      mockAdminDeleteRadar.mockRejectedValue(new Error('Permission denied'));

      const result = await executeDeleteRadar({ radarId: 'radar-1', confirmed: true }, { userId: 'u1' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Permission denied');
      expect(result.data).toMatchObject({
        mutatedEntityTypes: ['radar', 'radarPlacement', 'technology', 'relation'],
      });
      expect(mockEmitDataRefresh).not.toHaveBeenCalled();
    });

    // Server-verified confirmation, human path (#121) — the model cannot
    // self-confirm; the exact action phrase only redeems on a later turn.
    describe('server-verified confirmation (human, #121)', () => {
      const fingerprint = destructiveActionFingerprint('deleteRadar', 'radar-1', true);
      const phrase = destructiveConfirmationPhrase(fingerprint);
      const ctx = (requestId: string, confirmationText?: string) => ({
        principal: 'human' as const,
        userId: 'u1',
        requestId,
        confirmationText,
      });

      beforeEach(() => {
        _resetConfirmationStore();
        mockAdminListRadars.mockResolvedValue([{ id: 'radar-1', name: 'Old Radar', quadrants: [] }]);
        mockAdminDeleteRadar.mockResolvedValue({ placementsDeleted: 3 });
      });

      it('raises a confirmation and does NOT delete on the first call', async () => {
        const first = await executeDeleteRadar({ radarId: 'radar-1' }, ctx('req-1'));

        expect(first.success).toBe(false);
        expect((first.data as DestructiveGateRefusal).requiresConfirmation).toBe(true);
        expect(mockAdminDeleteRadar).not.toHaveBeenCalled();
      });

      it('ignores a model-set confirmed:true on the human path', async () => {
        const result = await executeDeleteRadar({ radarId: 'radar-1', confirmed: true }, ctx('req-1', phrase));

        expect(result.success).toBe(false);
        expect(mockAdminDeleteRadar).not.toHaveBeenCalled();
      });

      it('deletes when the exact phrase arrives on a later turn', async () => {
        await executeDeleteRadar({ radarId: 'radar-1' }, ctx('req-1'));

        const second = await executeDeleteRadar({ radarId: 'radar-1' }, ctx('req-2', phrase));

        expect(second.success).toBe(true);
        expect(mockAdminDeleteRadar).toHaveBeenCalledWith('radar-1', 'u1', { cascade: true });
      });

      it('binds the confirmation to the cascade choice (fingerprint)', async () => {
        await executeDeleteRadar({ radarId: 'radar-1', cascadeDelete: true }, ctx('req-1'));

        // A different cascade flag → different fingerprint → not pre-confirmed.
        const mismatch = await executeDeleteRadar({ radarId: 'radar-1', cascadeDelete: false }, ctx('req-2', phrase));

        expect(mismatch.success).toBe(false);
        expect(mockAdminDeleteRadar).not.toHaveBeenCalled();
      });

      it('cancels rather than deleting on a plain later retry', async () => {
        await executeDeleteRadar({ radarId: 'radar-1' }, ctx('req-1'));

        const retry = await executeDeleteRadar({ radarId: 'radar-1' }, ctx('req-2', 'yes'));

        expect(retry.success).toBe(false);
        expect(retry.error).toContain('cancelled');
        expect(mockAdminDeleteRadar).not.toHaveBeenCalled();
      });
    });
  });

  // --------------------------------------------------------------------------
  // executeUpdateRadarSettings
  // --------------------------------------------------------------------------
  describe('executeUpdateRadarSettings', () => {
    it('should update radar name and description', async () => {
      mockUpdateRadar.mockResolvedValue(undefined);

      const result = await executeUpdateRadarSettings(
        {
          radarId: 'radar-1',
          name: 'Updated Radar',
          description: 'New description',
        },
        { userId: 'u1' }
      );

      expect(result.success).toBe(true);
      expect(result.data?.updated).toContain('name');
      expect(result.data?.updated).toContain('description');
    });

    it('should reject invalid quadrant count', async () => {
      const result = await executeUpdateRadarSettings(
        {
          radarId: 'radar-1',
          // 9 quadrants — exceeds MAX_QUADRANTS (8)
          quadrants: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9'],
        },
        { userId: 'u1' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/out of range/i);
    });

    it('should reject empty updates', async () => {
      const result = await executeUpdateRadarSettings({ radarId: 'radar-1' }, { userId: 'u1' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No updates');
    });

    it('#2 refuses to update when the acting user is not authenticated, and never mutates', async () => {
      mockUpdateRadar.mockResolvedValue(undefined);

      const result = await executeUpdateRadarSettings({ radarId: 'radar-1', name: 'Anon' }, {});

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/signed in/i);
      expect(mockUpdateRadar).not.toHaveBeenCalled();
    });

    it('should handle update errors', async () => {
      mockUpdateRadar.mockRejectedValue(new Error('Network error'));

      const result = await executeUpdateRadarSettings(
        {
          radarId: 'radar-1',
          name: 'Test',
        },
        { userId: 'u1' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });

    it('does not report update convergence when projection dispatch is unacknowledged', async () => {
      mockUpdateRadar.mockRejectedValue(
        new Error(
          'Radar radar-1 was saved in Firestore, but its graph projection handoff was not acknowledged. ' +
            'Do not recreate it; reconciliation will retry from the committed Radar.'
        )
      );

      const result = await executeUpdateRadarSettings({ radarId: 'radar-1', name: 'Updated Radar' }, { userId: 'u1' });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/saved in Firestore.*not acknowledged.*reconciliation/i);
      expect(mockEmitDataRefresh).not.toHaveBeenCalled();
    });

    // ----------------------------------------------------------------------
    // Regression: editing quadrants of an existing radar must PRESERVE the
    // stable ids of kept/renamed quadrants so placements are not orphaned.
    // (Pre-fix the tool took names only, minted fresh ids, and falsely
    // orphaned every placement → the assistant fell back to reset+recreate.)
    // ----------------------------------------------------------------------
    it('preserves existing quadrant ids when expanding 4→6 by id, so placements are not orphaned', async () => {
      mockAdminGetRadarById.mockResolvedValue({
        id: 'radar-1',
        name: 'AI in Human Resources',
        quadrants: [
          { id: 'q_sourcing', name: 'Sourcing & Recruiting', order: 0 },
          { id: 'q_onboarding', name: 'Onboarding & Core HR', order: 1 },
          { id: 'q_learning', name: 'Learning & Coaching', order: 2 },
          { id: 'q_analytics', name: 'People Analytics & Planning', order: 3 },
        ],
      });
      mockUpdateRadar.mockResolvedValue(undefined);

      const result = await executeUpdateRadarSettings(
        {
          radarId: 'radar-1',
          quadrants: [
            { id: 'q_sourcing', name: 'Sourcing & Recruiting' },
            { id: 'q_onboarding', name: 'Onboarding & Core HR' },
            { id: 'q_learning', name: 'Learning & Coaching' },
            { id: 'q_analytics', name: 'People Analytics & Planning' },
            { name: 'Performance & Compensation' },
            { name: 'Employee Listening & Support' },
          ],
        },
        { userId: 'u1' }
      );

      expect(result.success).toBe(true);
      // Args are now [radarId, ownerId, updates, quadrantOptions].
      const [, , updates] = mockUpdateRadar.mock.calls[0] as [string, string, { quadrants: Array<{ id: string }> }];
      const ids = updates.quadrants.map((q) => q.id);
      // Original 4 ids preserved verbatim (placements stay attached), 2 new minted.
      expect(ids.slice(0, 4)).toEqual(['q_sourcing', 'q_onboarding', 'q_learning', 'q_analytics']);
      expect(updates.quadrants).toHaveLength(6);
      // No orphan-resolution options needed for a non-shrinking expand.
      expect(mockUpdateRadar.mock.calls[0][3]).toBeUndefined();
    });

    it('adds the retained seventh id-less quadrant without materializing absent descriptions', async () => {
      const existingQuadrants = [
        { id: 'q_carbon_emissions_management', name: 'Carbon & Emissions Management' },
        { id: 'q_sustainable_supply_chain', name: 'Sustainable Supply Chain' },
        { id: 'q_circular_economy_waste', name: 'Circular Economy & Waste' },
        { id: 'q_energy_resource_optimization', name: 'Energy & Resource Optimization' },
        { id: 'q_green_it_digital_infrastructure', name: 'Green IT & Digital Infrastructure' },
        { id: 'q_esg_reporting_compliance', name: 'ESG Reporting & Compliance' },
      ].map((quadrant, index) => ({
        ...quadrant,
        order: index,
      }));
      mockAdminGetRadarById.mockResolvedValue({
        id: 'radar-1',
        name: 'Sustainability Tech Radar',
        quadrants: existingQuadrants,
      });
      mockUpdateRadar.mockResolvedValue(undefined);

      const result = await executeUpdateRadarSettings(
        {
          radarId: 'radar-1',
          quadrants: [
            ...existingQuadrants.map(({ id, name }) => ({ id, name })),
            { name: 'Sustainable Food & Materials' },
          ],
        },
        { userId: 'u1' }
      );

      expect(result.success).toBe(true);
      expect(mockUpdateRadar).toHaveBeenCalledTimes(1);
      const [, , updates] = mockUpdateRadar.mock.calls[0] as [
        string,
        string,
        { quadrants: QuadrantConfig[] },
      ];
      expect(updates.quadrants).toHaveLength(7);
      expect(updates.quadrants.slice(0, 6).map(({ id }) => id)).toEqual(
        existingQuadrants.map(({ id }) => id)
      );
      expect(updates.quadrants[6]).toEqual({
        id: 'q_sustainable_food_materials',
        name: 'Sustainable Food & Materials',
        order: 6,
      });
      expect(updates.quadrants.every((config) => !Object.prototype.hasOwnProperty.call(config, 'description'))).toBe(
        true
      );
    });

    it('back-fills ids by name for legacy string[] input so unchanged quadrants keep their placements', async () => {
      mockAdminGetRadarById.mockResolvedValue({
        id: 'radar-1',
        name: 'AI in HR',
        quadrants: [
          { id: 'q_sourcing', name: 'Sourcing & Recruiting', order: 0 },
          { id: 'q_learning', name: 'Learning & Coaching', order: 1 },
        ],
      });
      mockUpdateRadar.mockResolvedValue(undefined);

      const result = await executeUpdateRadarSettings(
        {
          radarId: 'radar-1',
          // Names only (legacy contract): the two existing names must reuse their ids.
          quadrants: ['Sourcing & Recruiting', 'Learning & Coaching', 'Performance & Compensation'],
        },
        { userId: 'u1' }
      );

      expect(result.success).toBe(true);
      const [, , updates] = mockUpdateRadar.mock.calls[0] as [string, string, { quadrants: Array<{ id: string }> }];
      expect(updates.quadrants.map((q) => q.id)).toEqual(['q_sourcing', 'q_learning', 'q_performance_compensation']);
    });

    it('surfaces an orphan situation as actionable guidance (NOT reset/recreate) when a quadrant with placements is removed', async () => {
      const { OrphanedPlacementsError } = jest.requireMock('@/lib/radars-admin') as {
        OrphanedPlacementsError: new (report: unknown) => Error;
      };
      mockAdminGetRadarById.mockResolvedValue({
        id: 'radar-1',
        name: 'AI in HR',
        quadrants: [
          { id: 'q_sourcing', name: 'Sourcing & Recruiting', order: 0 },
          { id: 'q_learning', name: 'Learning & Coaching', order: 1 },
        ],
      });
      mockUpdateRadar.mockRejectedValue(
        new OrphanedPlacementsError({
          totalPlacements: 2,
          orphans: [
            {
              quadrantId: 'q_learning',
              quadrantName: 'Learning & Coaching',
              placements: [
                { id: 'p1', technologyId: 't1', ring: 'Adopt' },
                { id: 'p2', technologyId: 't2', ring: 'Trial' },
              ],
            },
          ],
        })
      );

      const result = await executeUpdateRadarSettings(
        {
          radarId: 'radar-1',
          quadrants: [{ id: 'q_sourcing', name: 'Sourcing & Recruiting' }],
        },
        { userId: 'u1' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/orphan/i);
      expect(result.error).toMatch(/reassignments|deleteOrphans/);
      expect(result.error).toMatch(/do not reset or recreate/i);
    });

    it('threads reassignments into adminUpdateRadar so a true shrink resolves in place', async () => {
      mockAdminGetRadarById.mockResolvedValue({
        id: 'radar-1',
        name: 'AI in HR',
        quadrants: [
          { id: 'q_sourcing', name: 'Sourcing & Recruiting', order: 0 },
          { id: 'q_learning', name: 'Learning & Coaching', order: 1 },
        ],
      });
      mockUpdateRadar.mockResolvedValue(undefined);

      const result = await executeUpdateRadarSettings(
        {
          radarId: 'radar-1',
          quadrants: [{ id: 'q_sourcing', name: 'Sourcing & Recruiting' }],
          reassignments: [{ fromQuadrantId: 'q_learning', toQuadrantId: 'q_sourcing' }],
        },
        { userId: 'u1' }
      );

      expect(result.success).toBe(true);
      expect(mockUpdateRadar.mock.calls[0][3]).toEqual({ reassignments: { q_learning: 'q_sourcing' } });
    });
  });

  // --------------------------------------------------------------------------
  // executeListRadars
  // --------------------------------------------------------------------------
  describe('executeListRadars', () => {
    it('should list all radars', async () => {
      mockAdminListRadars.mockResolvedValue([
        { id: 'r1', name: 'AI Radar', description: 'AI stuff', quadrants: ['Q1', 'Q2', 'Q3', 'Q4'] },
        { id: 'r2', name: 'Frontend', quadrants: undefined },
      ]);

      const result = await executeListRadars({ includeStats: false });

      expect(result.success).toBe(true);
      expect(result.data?.count).toBe(2);
      expect(result.data?.radars).toHaveLength(2);
    });

    it('every radar carries a description key ("" when empty) and ringSystem', async () => {
      // The company-wide radar omitted `description` entirely — external
      // MCP clients saw an inconsistent key set across radars.
      mockAdminListRadars.mockResolvedValue([
        { id: 'r1', name: 'AI Radar', description: 'AI stuff', ringSystem: 'TRL', quadrants: [] },
        { id: 'r-company', name: 'Company Radar', quadrants: [] },
      ]);

      const result = await executeListRadars({ includeStats: false });

      expect(result.success).toBe(true);
      expect(result.data?.radars[0].description).toBe('AI stuff');
      expect(result.data?.radars[0].ringSystem).toBe('TRL');
      expect(result.data?.radars[1].description).toBe('');
      expect(result.data?.radars[1].ringSystem).toBe('Standard');
    });

    it('skips the placement read when includeStats is explicitly false', async () => {
      mockAdminListRadars.mockResolvedValue([{ id: 'r1', name: 'Radar', quadrants: [] }]);

      const result = await executeListRadars({ includeStats: false });

      expect(result.success).toBe(true);
      expect(result.data?.radars[0].stats).toBeUndefined();
      expect(mockGetAllRadars).not.toHaveBeenCalled();
    });

    it('defaults to includeStats=true so ring counts are always present (2.3)', async () => {
      // The model used to omit the flag and guess ("3 vs 10"); now stats are on by
      // default — `{}` takes the stats path and exposes exact per-ring counts.
      mockGetAllRadars.mockResolvedValue([
        {
          id: 'r1',
          name: 'AI Radar',
          quadrants: [],
          stats: { totalPlacements: 14, byRing: { Adopt: 2, Trial: 8, Assess: 3, Hold: 1 }, byQuadrant: {} },
        },
      ]);

      const result = await executeListRadars({});

      expect(mockGetAllRadars).toHaveBeenCalledWith(true);
      expect(result.data?.radars[0].stats?.trial).toBe(8);
      expect(result.data?.radars[0].stats?.byRing).toEqual({ Adopt: 2, Trial: 8, Assess: 3, Hold: 1 });
    });

    it('includeStats: true returns per-radar stats in the promised shape', async () => {
      // Stats come from adminGetAllRadars(true) — ONE bounded placements
      // collection read bucketed in-memory, not a per-radar fan-out.
      mockGetAllRadars.mockResolvedValue([
        {
          id: 'r1',
          name: 'Cloud Radar',
          description: 'Cloud stuff',
          quadrants: [{ id: 'q1', name: 'Q1', order: 0 }],
          stats: {
            totalPlacements: 24,
            byRing: { Adopt: 8, Trial: 6, Assess: 7, Hold: 3 },
            byQuadrant: { q1: { name: 'Q1', count: 24 } },
          },
        },
        {
          id: 'r2',
          name: 'Empty Radar',
          quadrants: [],
          stats: { totalPlacements: 0, byRing: {}, byQuadrant: {} },
        },
      ]);

      const result = await executeListRadars({ includeStats: true });

      expect(result.success).toBe(true);
      expect(mockGetAllRadars).toHaveBeenCalledWith(true);
      expect(mockAdminListRadars).not.toHaveBeenCalled();
      expect(result.data?.radars[0].stats).toEqual({
        total: 24,
        adopt: 8,
        trial: 6,
        assess: 7,
        hold: 3,
        byRing: { Adopt: 8, Trial: 6, Assess: 7, Hold: 3 },
        byQuadrant: { q1: { name: 'Q1', count: 24 } },
      });
      // Empty radars degrade to zeroed stats, not a missing key.
      expect(result.data?.radars[1].stats).toEqual({
        total: 0,
        adopt: 0,
        trial: 0,
        assess: 0,
        hold: 0,
        byRing: {},
        byQuadrant: {},
      });
    });

    it('should handle errors', async () => {
      mockAdminListRadars.mockRejectedValue(new Error('Firestore error'));

      const result = await executeListRadars({ includeStats: false });

      expect(result.success).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // executeGetRadarDetails
  // --------------------------------------------------------------------------
  describe('executeGetRadarDetails', () => {
    it('should return radar with technologies and stats', async () => {
      mockAdminGetRadarById.mockResolvedValue({
        id: 'r1',
        name: 'AI Radar',
        description: 'test',
        quadrants: [
          { id: 'q_q1', name: 'Q1', order: 0 },
          { id: 'q_q2', name: 'Q2', order: 1 },
          { id: 'q_q3', name: 'Q3', order: 2 },
          { id: 'q_q4', name: 'Q4', order: 3 },
        ],
        slug: 'ai',
      });
      mockAdminGetTechnologiesWithPlacementsForRadar.mockResolvedValue([
        {
          id: 'tech-1',
          name: 'React',
          description: 'UI lib',
          category: 'framework',
          tags: ['frontend'],
          placement: { ring: 'Adopt', quadrantId: 'q_q1', status: 'Stable' },
        },
        {
          id: 'tech-2',
          name: 'Vue',
          description: 'UI framework',
          category: 'framework',
          tags: ['frontend'],
          placement: { ring: 'Trial', quadrantId: 'q_q1', status: 'Trending' },
        },
      ]);

      const result = await executeGetRadarDetails({ radarId: 'r1' });

      expect(result.success).toBe(true);
      expect(result.data?.technologies).toHaveLength(2);
      expect(result.data?.stats).toEqual(
        expect.objectContaining({
          total: 2,
          byRing: expect.objectContaining({ Adopt: 1, Trial: 1 }),
        })
      );
    });

    it('truncates long technology descriptions to 280 chars by default and notes it in the envelope', async () => {
      const dossier = 'x'.repeat(15000); // the 15k-char research-dossier case from the session log
      mockAdminGetRadarById.mockResolvedValue({
        id: 'r1',
        name: 'Radar',
        quadrants: [{ id: 'q_q1', name: 'Q1', order: 0 }],
        slug: 'r',
      });
      mockAdminGetTechnologiesWithPlacementsForRadar.mockResolvedValue([
        {
          id: 'tech-1',
          name: 'Dossier Tech',
          description: dossier,
          placement: { ring: 'Adopt', quadrantId: 'q_q1' },
        },
        {
          id: 'tech-2',
          name: 'Short Tech',
          description: 'short',
          placement: { ring: 'Trial', quadrantId: 'q_q1' },
        },
      ]);

      const result = await executeGetRadarDetails({ radarId: 'r1' });

      expect(result.success).toBe(true);
      const techs = result.data?.technologies as Array<{ description: string }>;
      expect(techs[0].description).toHaveLength(281); // 280 chars + ellipsis
      expect(techs[0].description.endsWith('…')).toBe(true);
      expect(techs[0].description.startsWith('x'.repeat(280))).toBe(true);
      expect(techs[1].description).toBe('short'); // under the limit — untouched
      expect(result.data?.note).toContain('getEntityDetails');
      expect(result.data?.note).toContain('280');
    });

    it('descriptionMaxLength: 0 opts out of truncation (no note)', async () => {
      const dossier = 'y'.repeat(5000);
      mockAdminGetRadarById.mockResolvedValue({
        id: 'r1',
        name: 'Radar',
        quadrants: [{ id: 'q_q1', name: 'Q1', order: 0 }],
        slug: 'r',
      });
      mockAdminGetTechnologiesWithPlacementsForRadar.mockResolvedValue([
        { id: 'tech-1', name: 'T', description: dossier, placement: { ring: 'Adopt', quadrantId: 'q_q1' } },
      ]);

      const result = await executeGetRadarDetails({ radarId: 'r1', descriptionMaxLength: 0 });

      expect(result.success).toBe(true);
      const techs = result.data?.technologies as Array<{ description: string }>;
      expect(techs[0].description).toBe(dossier);
      expect(result.data?.note).toBeUndefined();
    });

    it('honors a custom descriptionMaxLength', async () => {
      mockAdminGetRadarById.mockResolvedValue({
        id: 'r1',
        name: 'Radar',
        quadrants: [{ id: 'q_q1', name: 'Q1', order: 0 }],
        slug: 'r',
      });
      mockAdminGetTechnologiesWithPlacementsForRadar.mockResolvedValue([
        { id: 'tech-1', name: 'T', description: 'z'.repeat(100), placement: { ring: 'Adopt', quadrantId: 'q_q1' } },
      ]);

      const result = await executeGetRadarDetails({ radarId: 'r1', descriptionMaxLength: 50 });

      const techs = result.data?.technologies as Array<{ description: string }>;
      expect(techs[0].description).toBe(`${'z'.repeat(50)}…`);
      expect(result.data?.note).toContain('50');
    });

    it("omits timeToImpact when 'unknown' or unset, keeps it when assessed", async () => {
      mockAdminGetRadarById.mockResolvedValue({
        id: 'r1',
        name: 'Radar',
        quadrants: [{ id: 'q_q1', name: 'Q1', order: 0 }],
        slug: 'r',
      });
      mockAdminGetTechnologiesWithPlacementsForRadar.mockResolvedValue([
        { id: 't1', name: 'A', placement: { ring: 'Adopt', quadrantId: 'q_q1', timeToImpact: 'unknown' } },
        { id: 't2', name: 'B', placement: { ring: 'Trial', quadrantId: 'q_q1', timeToImpact: 'H2' } },
        { id: 't3', name: 'C', placement: { ring: 'Hold', quadrantId: 'q_q1' } },
      ]);

      const result = await executeGetRadarDetails({ radarId: 'r1' });

      const techs = result.data?.technologies as Array<{ placement: Record<string, unknown> }>;
      expect(Object.keys(techs[0].placement)).not.toContain('timeToImpact');
      expect(techs[1].placement.timeToImpact).toBe('H2');
      expect(Object.keys(techs[2].placement)).not.toContain('timeToImpact');
    });

    it('radar info always carries description ("" when empty) and ringSystem', async () => {
      mockAdminGetRadarById.mockResolvedValue({
        id: 'r1',
        name: 'Radar',
        quadrants: [{ id: 'q_q1', name: 'Q1', order: 0 }],
        slug: 'r',
        // no description, no ringSystem on the doc
      });
      mockAdminGetTechnologiesWithPlacementsForRadar.mockResolvedValue([]);

      const result = await executeGetRadarDetails({ radarId: 'r1' });

      const radar = result.data?.radar as { description: string; ringSystem: string };
      expect(radar.description).toBe('');
      expect(radar.ringSystem).toBe('Standard');
    });

    it('should return error for non-existent radar', async () => {
      mockAdminGetRadarById.mockResolvedValue(null);

      const result = await executeGetRadarDetails({ radarId: 'missing' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should include unplaced technologies when requested', async () => {
      mockAdminGetRadarById.mockResolvedValue({
        id: 'r1',
        name: 'Radar',
        quadrants: [
          { id: 'q_q1', name: 'Q1', order: 0 },
          { id: 'q_q2', name: 'Q2', order: 1 },
          { id: 'q_q3', name: 'Q3', order: 2 },
          { id: 'q_q4', name: 'Q4', order: 3 },
        ],
        slug: 'r',
      });
      mockAdminGetTechnologiesWithPlacementsForRadar.mockResolvedValue([
        { id: 'tech-1', name: 'React', placement: { ring: 'Adopt', quadrantId: 'q_q1' } },
      ]);
      mockAdminListTechnologies.mockResolvedValue([
        { id: 'tech-1', name: 'React', category: 'framework', tags: [] },
        { id: 'tech-2', name: 'Vue', category: 'framework', tags: [] },
        { id: 'tech-3', name: 'Angular', category: 'framework', tags: [] },
      ]);

      const result = await executeGetRadarDetails({
        radarId: 'r1',
        includeUnplacedInLibrary: true,
      });

      expect(result.success).toBe(true);
      expect(result.data?.unplacedTechnologies).toHaveLength(2);
    });

    it('should handle errors', async () => {
      mockAdminGetRadarById.mockRejectedValue(new Error('Connection failed'));

      const result = await executeGetRadarDetails({ radarId: 'r1' });

      expect(result.success).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // executeSearchTechnologiesAdvanced
  // --------------------------------------------------------------------------
  describe('executeSearchTechnologiesAdvanced', () => {
    it('should search technologies without placement filters', async () => {
      mockAdminSearchTechnologies.mockResolvedValue([
        { id: 'tech-1', name: 'React', category: 'framework', tags: ['frontend'] },
        { id: 'tech-2', name: 'Vue', category: 'framework', tags: ['frontend'] },
      ]);

      const result = await executeSearchTechnologiesAdvanced({ query: 'frontend' });

      expect(result.success).toBe(true);
      expect(result.data?.count).toBe(2);
      // T1-4: navigable entity type on every result item (simple-search path)
      expect(result.data?.results.every((r) => r.type === 'technology')).toBe(true);
    });

    it('should filter by placement criteria', async () => {
      mockAdminSearchTechnologies.mockResolvedValue([
        { id: 'tech-1', name: 'React', tags: [] },
        { id: 'tech-2', name: 'Vue', tags: [] },
      ]);
      mockAdminGetRadarPlacements.mockResolvedValue([
        { technologyId: 'tech-1', radarId: 'r1', ring: 'Adopt', quadrant: 'Q1', status: 'Stable' },
        { technologyId: 'tech-2', radarId: 'r1', ring: 'Trial', quadrant: 'Q1', status: 'Trending' },
      ]);

      const result = await executeSearchTechnologiesAdvanced({ ring: 'Adopt' });

      expect(result.success).toBe(true);
      expect(result.data?.count).toBe(1);
      expect(result.data?.results[0].name).toBe('React');
      // T1-4: navigable entity type on every result item (placement-filter path)
      expect(result.data?.results[0].type).toBe('technology');
    });

    it('returns an exact split technology linked by a radar placement', async () => {
      const technologyName = 'FINAL-QA-20260715 Gate-Based Superconducting Qubits';
      mockAdminSearchTechnologies.mockResolvedValue([
        { id: 'tech-marker', name: technologyName, category: 'infrastructure', tags: ['quantum'] },
      ]);
      mockAdminGetRadarPlacements.mockResolvedValue([
        {
          id: 'placement-marker',
          technologyId: 'tech-marker',
          radarId: 'radar-marker',
          ring: 'Trial',
          quadrantId: 'q_hardware',
        },
      ]);

      const result = await executeSearchTechnologiesAdvanced({
        query: technologyName,
        radarId: 'radar-marker',
        limit: 1,
      });

      expect(result).toEqual({
        success: true,
        data: {
          count: 1,
          results: [
            expect.objectContaining({
              id: 'tech-marker',
              name: technologyName,
              type: 'technology',
              placements: [expect.objectContaining({ radarId: 'radar-marker', ring: 'Trial', quadrant: 'q_hardware' })],
            }),
          ],
        },
      });
      expect(mockAdminGetRadarPlacements).toHaveBeenCalledWith({ radarId: 'radar-marker' });
    });

    it('defers the result limit until after a broad radar placement intersection', async () => {
      const candidates = Array.from({ length: 201 }, (_, index) => ({
        id: `tech-${index}`,
        name: `Technology ${index}`,
        tags: [],
      }));
      mockAdminSearchTechnologies.mockResolvedValue(candidates);
      mockAdminGetRadarPlacements.mockResolvedValue([
        {
          id: 'placement-last',
          technologyId: 'tech-200',
          radarId: 'radar-marker',
          ring: 'Adopt',
          quadrantId: 'q_hardware',
        },
      ]);

      const result = await executeSearchTechnologiesAdvanced({
        query: 'Technology',
        radarId: 'radar-marker',
        limit: 1,
      });

      expect(result.data?.results.map((technology) => technology.id)).toEqual(['tech-200']);
      expect(mockAdminSearchTechnologies.mock.calls[0][0]).not.toHaveProperty('limit');
    });

    it('requires a radar id for a non-empty quadrant filter before reading search data', async () => {
      const result = await executeSearchTechnologiesAdvanced({ quadrant: 'Tools' });

      expect(result).toEqual({
        success: false,
        error: expect.stringMatching(/radarId is required.*listRadars.*getRadarDetails/i),
      });
      expect(mockAdminGetRadarById).not.toHaveBeenCalled();
      expect(mockAdminSearchTechnologies).not.toHaveBeenCalled();
      expect(mockAdminGetRadarPlacements).not.toHaveBeenCalled();
    });

    it('rejects a malformed quadrant filter before reading search data', async () => {
      const result = await executeSearchTechnologiesAdvanced({ radarId: 'r1', quadrant: 42 });

      expect(result).toEqual({
        success: false,
        error: expect.stringMatching(/quadrant must be a string.*getRadarDetails/i),
      });
      expect(mockAdminGetRadarById).not.toHaveBeenCalled();
      expect(mockAdminSearchTechnologies).not.toHaveBeenCalled();
      expect(mockAdminGetRadarPlacements).not.toHaveBeenCalled();
    });

    it('rejects an unknown radar before reading search data', async () => {
      mockAdminGetRadarById.mockResolvedValue(null);

      const result = await executeSearchTechnologiesAdvanced({ radarId: 'missing-radar', quadrant: 'Tools' });

      expect(result).toEqual({
        success: false,
        error: expect.stringMatching(/Radar missing-radar not found.*listRadars/i),
      });
      expect(mockAdminGetRadarById).toHaveBeenCalledWith('missing-radar');
      expect(mockAdminSearchTechnologies).not.toHaveBeenCalled();
      expect(mockAdminGetRadarPlacements).not.toHaveBeenCalled();
    });

    it('rejects unknown and whitespace-variant quadrant references without broadening the search', async () => {
      mockAdminGetRadarById.mockResolvedValue({
        id: 'r1',
        name: 'Radar',
        quadrants: [{ id: 'q_tools', name: 'Tools', order: 0 }],
      });

      const unknown = await executeSearchTechnologiesAdvanced({ radarId: 'r1', quadrant: 'Unknown' });
      const spaced = await executeSearchTechnologiesAdvanced({ radarId: 'r1', quadrant: ' Tools ' });

      expect(unknown).toEqual({
        success: false,
        error: expect.stringMatching(/Quadrant "Unknown" was not found.*getRadarDetails.*exact quadrant/i),
      });
      expect(spaced).toEqual({
        success: false,
        error: expect.stringMatching(/Quadrant " Tools " was not found.*getRadarDetails.*exact quadrant/i),
      });
      expect(mockAdminSearchTechnologies).not.toHaveBeenCalled();
      expect(mockAdminGetRadarPlacements).not.toHaveBeenCalled();
    });

    it('rejects a quadrant filter when persisted quadrant data is malformed', async () => {
      mockAdminGetRadarById.mockResolvedValue({
        id: 'r1',
        name: 'Malformed radar',
        quadrants: ['Tools', { id: '', name: 'Tools' }, { id: 'q_tools', name: '' }],
      });

      const result = await executeSearchTechnologiesAdvanced({ radarId: 'r1', quadrant: 'Tools' });

      expect(result).toEqual({
        success: false,
        error: expect.stringMatching(/Quadrant "Tools" was not found.*getRadarDetails/i),
      });
      expect(mockAdminSearchTechnologies).not.toHaveBeenCalled();
      expect(mockAdminGetRadarPlacements).not.toHaveBeenCalled();
    });

    it('keeps advanced search id-first on cross-collisions', async () => {
      mockAdminGetRadarById.mockResolvedValue({
        id: 'r1',
        name: 'Radar',
        quadrants: [
          { id: 'q_name_target', name: 'collision', order: 0 },
          { id: 'collision', name: 'ID target', order: 1 },
        ],
      });
      mockAdminSearchTechnologies.mockResolvedValue([
        { id: 'tech-id', name: 'ID match', tags: [] },
        { id: 'tech-name', name: 'Name match', tags: [] },
      ]);
      mockAdminGetRadarPlacements.mockResolvedValue([
        { technologyId: 'tech-id', radarId: 'r1', ring: 'Adopt', quadrantId: 'collision' },
        { technologyId: 'tech-name', radarId: 'r1', ring: 'Adopt', quadrantId: 'q_name_target' },
      ]);

      const collision = await executeSearchTechnologiesAdvanced({ radarId: 'r1', quadrant: 'collision' });

      expect(collision.success).toBe(true);
      expect(collision.data?.results.map((technology) => technology.id)).toEqual(['tech-id']);
    });

    it('applies a resolved quadrant together with every other placement filter', async () => {
      mockAdminGetRadarById.mockResolvedValue({
        id: 'r1',
        name: 'Radar',
        quadrants: [{ id: 'q_tools', name: 'Tools', order: 0 }],
      });
      mockAdminSearchTechnologies.mockResolvedValue([
        { id: 'match', name: 'Match', tags: [] },
        { id: 'wrong-ring', name: 'Wrong ring', tags: [] },
        { id: 'wrong-quadrant', name: 'Wrong quadrant', tags: [] },
        { id: 'wrong-status', name: 'Wrong status', tags: [] },
        { id: 'wrong-trl-min', name: 'Wrong minimum TRL', tags: [] },
        { id: 'wrong-trl-max', name: 'Wrong maximum TRL', tags: [] },
        { id: 'wrong-time', name: 'Wrong time horizon', tags: [] },
        { id: 'split-placement', name: 'Split placement criteria', tags: [] },
      ]);
      mockAdminGetRadarPlacements.mockResolvedValue([
        {
          technologyId: 'match',
          radarId: 'r1',
          ring: 'Adopt',
          quadrantId: 'q_tools',
          status: 'Stable',
          trlScore: 8,
          timeToImpact: 'H1',
        },
        {
          technologyId: 'wrong-ring',
          radarId: 'r1',
          ring: 'Trial',
          quadrantId: 'q_tools',
          status: 'Stable',
          trlScore: 8,
          timeToImpact: 'H1',
        },
        {
          technologyId: 'wrong-quadrant',
          radarId: 'r1',
          ring: 'Adopt',
          quadrantId: 'q_platforms',
          status: 'Stable',
          trlScore: 8,
          timeToImpact: 'H1',
        },
        {
          technologyId: 'wrong-status',
          radarId: 'r1',
          ring: 'Adopt',
          quadrantId: 'q_tools',
          status: 'Trending',
          trlScore: 8,
          timeToImpact: 'H1',
        },
        {
          technologyId: 'wrong-trl-min',
          radarId: 'r1',
          ring: 'Adopt',
          quadrantId: 'q_tools',
          status: 'Stable',
          trlScore: 6,
          timeToImpact: 'H1',
        },
        {
          technologyId: 'wrong-trl-max',
          radarId: 'r1',
          ring: 'Adopt',
          quadrantId: 'q_tools',
          status: 'Stable',
          trlScore: 10,
          timeToImpact: 'H1',
        },
        {
          technologyId: 'wrong-time',
          radarId: 'r1',
          ring: 'Adopt',
          quadrantId: 'q_tools',
          status: 'Stable',
          trlScore: 8,
          timeToImpact: 'H2',
        },
        {
          technologyId: 'split-placement',
          radarId: 'r1',
          ring: 'Adopt',
          quadrantId: 'q_tools',
          status: 'Stable',
          trlScore: 8,
          timeToImpact: 'H2',
        },
        {
          technologyId: 'split-placement',
          radarId: 'r1',
          ring: 'Adopt',
          quadrantId: 'q_platforms',
          status: 'Stable',
          trlScore: 8,
          timeToImpact: 'H1',
        },
      ]);

      const result = await executeSearchTechnologiesAdvanced({
        query: 'Match',
        tags: ['cloud'],
        category: 'tool',
        radarId: 'r1',
        quadrant: 'Tools',
        ring: 'Adopt',
        status: 'Stable',
        trlScoreMin: 7,
        trlScoreMax: 9,
        timeToImpact: 'H1',
      });

      expect(result.success).toBe(true);
      expect(result.data?.results.map((technology) => technology.id)).toEqual(['match']);
      expect(mockAdminSearchTechnologies).toHaveBeenCalledWith({
        search: 'Match',
        category: 'tool',
        tags: ['cloud'],
      });
      expect(mockAdminGetRadarPlacements).toHaveBeenCalledWith({ radarId: 'r1' });
    });

    it('treats an empty quadrant string as no filter', async () => {
      mockAdminSearchTechnologies.mockResolvedValue([
        { id: 'tech-1', name: 'React', category: 'framework', tags: ['frontend'] },
      ]);

      const result = await executeSearchTechnologiesAdvanced({ quadrant: '' });

      expect(result.success).toBe(true);
      expect(result.data?.results.map((technology) => technology.id)).toEqual(['tech-1']);
      expect(mockAdminGetRadarById).not.toHaveBeenCalled();
    });

    it('should filter by TRL score range', async () => {
      mockAdminSearchTechnologies.mockResolvedValue([
        { id: 'tech-1', name: 'Mature', tags: [] },
        { id: 'tech-2', name: 'Early', tags: [] },
      ]);
      mockAdminGetRadarPlacements.mockResolvedValue([
        { technologyId: 'tech-1', radarId: 'r1', ring: 'Adopt', quadrant: 'Q1', trlScore: 8 },
        { technologyId: 'tech-2', radarId: 'r1', ring: 'Assess', quadrant: 'Q2', trlScore: 3 },
      ]);

      const result = await executeSearchTechnologiesAdvanced({ trlScoreMin: 7 });

      expect(result.success).toBe(true);
      expect(result.data?.count).toBe(1);
      expect(result.data?.results[0].name).toBe('Mature');
    });

    it('should respect limit parameter', async () => {
      const techs = Array.from({ length: 30 }, (_, i) => ({
        id: `tech-${i}`,
        name: `Tech ${i}`,
        tags: [],
      }));
      mockAdminSearchTechnologies.mockResolvedValue(techs);

      const result = await executeSearchTechnologiesAdvanced({ limit: 5 });

      expect(result.data?.count).toBe(5);
    });

    it('should handle errors', async () => {
      mockAdminSearchTechnologies.mockRejectedValue(new Error('Query failed'));

      const result = await executeSearchTechnologiesAdvanced({});

      expect(result.success).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // executeAddTechnologiesToRadar
  // --------------------------------------------------------------------------
  describe('executeAddTechnologiesToRadar', () => {
    it('refuses an unauthenticated bulk mutation before every read and write', async () => {
      const result = await executeAddTechnologiesToRadar({
        radarId: 'r1',
        technologies: [{ technologyId: 'tech-1', quadrant: 'Q1', ring: 'Adopt' }],
      });

      expect(result).toEqual({
        success: false,
        error: 'You must be signed in to add technologies to a radar.',
      });
      expect(mockGetRadarById).not.toHaveBeenCalled();
      expect(mockAdminListRadars).not.toHaveBeenCalled();
      expect(mockAdminGetOwnedRadarById).not.toHaveBeenCalled();
      expect(mockGetTechnologies).not.toHaveBeenCalled();
      expect(mockCreateTechnology).not.toHaveBeenCalled();
      expect(mockCreateRadarPlacementWithHandoff).not.toHaveBeenCalled();
    });

    it('refuses a foreign radar before searching or creating a child Technology', async () => {
      const { RadarAuthorizationError } = jest.requireMock('@/lib/radars-admin') as {
        RadarAuthorizationError: new (radarId: string) => Error;
      };
      mockGetRadarById.mockResolvedValue({
        id: 'r1',
        name: 'Alice Radar',
        quadrants: [{ id: 'q_q1', name: 'Q1', order: 0 }],
      });
      mockAdminGetOwnedRadarById.mockRejectedValue(new RadarAuthorizationError('r1'));

      const result = await executeAddTechnologiesToRadar(
        {
          radarId: 'r1',
          technologies: [{ name: 'Should Not Exist', quadrant: 'Q1', ring: 'Adopt' }],
        },
        { userId: 'bob' },
      );

      expect(result).toEqual({
        success: false,
        error: 'You do not have permission to add technologies to this radar.',
      });
      expect(mockGetTechnologies).not.toHaveBeenCalled();
      expect(mockCreateTechnology).not.toHaveBeenCalled();
      expect(mockGetPlacementForTechnologyOnRadar).not.toHaveBeenCalled();
      expect(mockCreateRadarPlacementWithHandoff).not.toHaveBeenCalled();
    });

    it('should add existing technologies to radar', async () => {
      mockGetRadarById.mockResolvedValue({
        id: 'r1',
        name: 'Radar',
        quadrants: [
          { id: 'q_frameworks', name: 'Frameworks', order: 0 },
          { id: 'q_tools', name: 'Tools', order: 1 },
          { id: 'q_platforms', name: 'Platforms', order: 2 },
          { id: 'q_languages', name: 'Languages', order: 3 },
        ],
      });
      mockGetTechnologies.mockResolvedValue([{ id: 'tech-1', name: 'React' }]);
      mockGetPlacementForTechnologyOnRadar.mockResolvedValue(null);
      mockCreateRadarPlacement.mockResolvedValue({ id: 'p1' });

      const result = await executeAddTechnologiesToRadar(
        {
          radarId: 'r1',
          technologies: [{ technologyId: 'tech-1', quadrant: 'Frameworks', ring: 'Adopt' }],
        },
        { userId: 'user-1' },
      );

      expect(result.success).toBe(true);
      expect(result.data?.added).toBe(1);
      expect(result.data).toEqual(
        expect.objectContaining({
          graphAcknowledged: 1,
          reconciliationRequired: 0,
          failed: 0,
          complete: true,
        }),
      );
      expect(mockCreateRadarPlacementWithHandoff).toHaveBeenCalledWith(
        expect.objectContaining({
          technologyId: 'tech-1',
          placedBy: 'user-1',
        }),
        { requireOwnerId: 'user-1' },
      );
    });

    it('should create new technology when not found', async () => {
      mockGetRadarById.mockResolvedValue({
        id: 'r1',
        name: 'Radar',
        quadrants: [
          { id: 'q_frameworks', name: 'Frameworks', order: 0 },
          { id: 'q_tools', name: 'Tools', order: 1 },
          { id: 'q_platforms', name: 'Platforms', order: 2 },
          { id: 'q_languages', name: 'Languages', order: 3 },
        ],
      });
      mockGetTechnologies.mockResolvedValue([]);
      mockCreateTechnology.mockResolvedValue({ id: 'tech-new', name: 'SolidJS' });
      mockGetPlacementForTechnologyOnRadar.mockResolvedValue(null);
      mockCreateRadarPlacement.mockResolvedValue({ id: 'p1' });

      const result = await executeAddTechnologiesToRadar(
        {
          radarId: 'r1',
          technologies: [{ name: 'SolidJS', description: 'Reactive UI', quadrant: 'Frameworks', ring: 'Trial' }],
        },
        { userId: 'user-1' },
      );

      expect(result.success).toBe(true);
      expect(result.data?.created).toBe(1);
      expect(result.data?.added).toBe(1);
      expect(mockCreateTechnology).toHaveBeenCalledWith(
        expect.objectContaining({ createdBy: 'user-1' }),
      );
    });

    it('keeps bulk-add name-first on collisions and whitespace-sensitive on names', async () => {
      mockGetRadarById.mockResolvedValue({
        id: 'r1',
        name: 'Radar',
        quadrants: [
          { id: 'q_name_target', name: 'collision', order: 0 },
          { id: 'collision', name: 'ID target', order: 1 },
        ],
      });
      mockGetPlacementForTechnologyOnRadar.mockResolvedValue(null);
      mockCreateRadarPlacement.mockResolvedValue({ id: 'p1' });

      const collision = await executeAddTechnologiesToRadar(
        {
          radarId: 'r1',
          technologies: [{ technologyId: 'tech-1', quadrant: 'collision', ring: 'Adopt' }],
        },
        { userId: 'user-1' },
      );
      const spaced = await executeAddTechnologiesToRadar(
        {
          radarId: 'r1',
          technologies: [{ technologyId: 'tech-2', quadrant: ' collision ', ring: 'Trial' }],
        },
        { userId: 'user-1' },
      );

      expect(collision.data?.added).toBe(1);
      expect(mockCreateRadarPlacement).toHaveBeenCalledWith(
        expect.objectContaining({ quadrantId: 'q_name_target' }),
        { requireOwnerId: 'user-1' },
      );
      expect(spaced.data?.added).toBe(0);
      expect(spaced.data?.failed).toBe(1);
      expect(spaced.data?.complete).toBe(false);
      expect(mockCreateRadarPlacement).toHaveBeenCalledTimes(1);
    });

    it('selects an exact existing technology before any alphabetic fuzzy predecessor', async () => {
      mockGetRadarById.mockResolvedValue({
        id: 'r1',
        name: 'Radar',
        quadrants: [{ id: 'q_frameworks', name: 'Frameworks', order: 0 }],
      });
      mockGetTechnologies.mockResolvedValue([
        { id: 'tech-preact', name: 'Preact' },
        { id: 'tech-react', name: 'React' },
      ]);
      mockGetPlacementForTechnologyOnRadar.mockResolvedValue(null);
      mockCreateRadarPlacement.mockResolvedValue({ id: 'p-react' });

      const result = await executeAddTechnologiesToRadar(
        {
          radarId: 'r1',
          technologies: [{ name: 'React', quadrant: 'Frameworks', ring: 'Adopt' }],
        },
        { userId: 'user-1' },
      );

      expect(result.data?.added).toBe(1);
      expect(mockGetTechnologies).toHaveBeenCalledWith({ search: 'React' });
      expect(mockCreateTechnology).not.toHaveBeenCalled();
      expect(mockCreateRadarPlacement).toHaveBeenCalledWith(
        expect.objectContaining({ technologyId: 'tech-react' }),
        { requireOwnerId: 'user-1' },
      );
    });

    it('should skip existing placements by default', async () => {
      mockGetRadarById.mockResolvedValue({ id: 'r1', name: 'Radar' });
      mockGetPlacementForTechnologyOnRadar.mockResolvedValue({ id: 'p-existing' });

      const result = await executeAddTechnologiesToRadar(
        {
          radarId: 'r1',
          technologies: [{ technologyId: 'tech-1', quadrant: 'Q1', ring: 'Adopt' }],
        },
        { userId: 'user-1' },
      );

      expect(result.success).toBe(true);
      expect(result.data?.skipped).toBe(1);
      expect(result.data?.added).toBe(0);
    });

    it('should update existing placement when skipExisting is false', async () => {
      mockGetRadarById.mockResolvedValue({
        id: 'r1',
        name: 'Radar',
        quadrants: [
          { id: 'q_q1', name: 'Q1', order: 0 },
          { id: 'q_q2', name: 'Q2', order: 1 },
          { id: 'q_q3', name: 'Q3', order: 2 },
          { id: 'q_q4', name: 'Q4', order: 3 },
        ],
      });
      mockGetPlacementForTechnologyOnRadar.mockResolvedValue({ id: 'p-existing' });
      mockUpdateRadarPlacementWithHandoff.mockResolvedValue({ placement: { id: 'p1' }, graphHandoff: acknowledgedGraphHandoff });

      const result = await executeAddTechnologiesToRadar(
        {
          radarId: 'r1',
          technologies: [{ technologyId: 'tech-1', quadrant: 'Q1', ring: 'Adopt' }],
          skipExisting: false,
        },
        { userId: 'user-1' },
      );

      expect(result.success).toBe(true);
      expect(result.data?.added).toBe(1);
      expect(mockUpdateRadarPlacementWithHandoff).toHaveBeenCalledWith(
        'p-existing',
        expect.objectContaining({ quadrantId: 'q_q1', ring: 'Adopt' }),
        { requireOwnerId: 'user-1' },
      );
    });

    it('should return error for non-existent radar', async () => {
      mockGetRadarById.mockResolvedValue(null);
      mockAdminListRadars.mockResolvedValue([]);

      const result = await executeAddTechnologiesToRadar(
        {
          radarId: 'missing',
          technologies: [{ quadrant: 'Q1', ring: 'Adopt' }],
        },
        { userId: 'user-1' },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('No radar matches "missing"');
    });

    it('fails an invalid technology identity and keeps the batch incomplete', async () => {
      mockGetRadarById.mockResolvedValue({ id: 'r1', name: 'Radar' });

      const result = await executeAddTechnologiesToRadar(
        {
          radarId: 'r1',
          technologies: [{ quadrant: 'Q1', ring: 'Adopt' }],
        },
        { userId: 'user-1' },
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual(
        expect.objectContaining({
          added: 0,
          skipped: 0,
          failed: 1,
          complete: false,
          failures: [
            {
              reason: 'Technology row must include a technologyId or name.',
            },
          ],
        }),
      );
    });

    it('stops the batch after transactional placement authorization is lost', async () => {
      mockGetRadarById.mockResolvedValue({
        id: 'r1',
        name: 'Radar',
        quadrants: [{ id: 'q_q1', name: 'Q1', order: 0 }],
      });
      mockGetPlacementForTechnologyOnRadar.mockResolvedValue(null);
      mockCreateRadarPlacementWithHandoff.mockRejectedValueOnce(
        new PlacementAuthorizationError('r1'),
      );

      const result = await executeAddTechnologiesToRadar(
        {
          radarId: 'r1',
          technologies: [
            { technologyId: 'tech-1', quadrant: 'Q1', ring: 'Adopt' },
            { technologyId: 'tech-2', quadrant: 'Q1', ring: 'Trial' },
          ],
        },
        { userId: 'user-1' },
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual(
        expect.objectContaining({
          added: 0,
          failed: 1,
          authorizationLost: true,
          complete: false,
        }),
      );
      expect(result.data?.failures[0]?.reason).toBe(
        'Authorization was lost while updating this radar; remaining rows were not attempted.',
      );
      expect(mockGetPlacementForTechnologyOnRadar).toHaveBeenCalledTimes(1);
      expect(mockCreateRadarPlacementWithHandoff).toHaveBeenCalledTimes(1);
    });

    it('separates committed, pending-reconciliation, failed, and complete truth for a mixed batch', async () => {
      mockGetRadarById.mockResolvedValue({
        id: 'r1',
        name: 'Radar',
        quadrants: [{ id: 'q_q1', name: 'Q1', order: 0 }],
      });
      mockGetPlacementForTechnologyOnRadar.mockResolvedValue(null);
      mockCreateRadarPlacementWithHandoff
        .mockResolvedValueOnce({
          placement: { id: 'p-pending' },
          graphHandoff: {
            committed: true,
            acknowledged: false,
            reconciliationRequired: true,
          },
        })
        .mockRejectedValueOnce(new Error('placement write failed'))
        .mockResolvedValueOnce({
          placement: { id: 'p-acknowledged' },
          graphHandoff: acknowledgedGraphHandoff,
        });

      const result = await executeAddTechnologiesToRadar(
        {
          radarId: 'r1',
          technologies: [
            { technologyId: 'tech-pending', quadrant: 'Q1', ring: 'Trial' },
            { technologyId: 'tech-failed', quadrant: 'Q1', ring: 'Assess' },
            { technologyId: 'tech-acknowledged', quadrant: 'Q1', ring: 'Adopt' },
          ],
        },
        { userId: 'user-1' },
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual(
        expect.objectContaining({
          added: 2,
          skipped: 0,
          graphAcknowledged: 1,
          reconciliationRequired: 1,
          failed: 1,
          complete: false,
          failures: [
            {
              technologyId: 'tech-failed',
              reason: 'placement write failed',
            },
          ],
        }),
      );
      expect(result.data?.placements.map((placement) => placement.technologyId)).toEqual([
        'tech-pending',
        'tech-acknowledged',
      ]);
      expect(result.data?.guidance).toMatch(/Do not retry or recreate committed placements/i);
      expect(mockCreateRadarPlacementWithHandoff).toHaveBeenCalledTimes(3);
    });
  });

  // --------------------------------------------------------------------------
  // executeUpdateTechnologyOnRadar
  // --------------------------------------------------------------------------
  describe('executeUpdateTechnologyOnRadar', () => {
    it('should update placement ring and track movement', async () => {
      mockGetPlacementForTechnologyOnRadar.mockResolvedValue({
        id: 'p1',
        ring: 'Trial',
        quadrant: 'Q1',
      });
      mockUpdateRadarPlacementWithHandoff.mockResolvedValue({ placement: { id: 'p1' }, graphHandoff: acknowledgedGraphHandoff });

      const result = await executeUpdateTechnologyOnRadar({
        technologyId: 'tech-1',
        radarId: 'r1',
        ring: 'Adopt',
        rationale: 'Proven in production',
      }, { userId: 'user-1' });

      expect(result.success).toBe(true);
      expect(result.data?.movedFrom).toBe('Trial');
      expect(result.data?.movedTo).toBe('Adopt');
      expect(result.data?.updated).toContain('ring');
    });

    it('keeps placement updates id-first on collisions and whitespace-sensitive on names', async () => {
      mockGetPlacementForTechnologyOnRadar.mockResolvedValue({ id: 'p1', ring: 'Trial' });
      mockAdminGetRadarById.mockResolvedValue({
        id: 'r1',
        name: 'Radar',
        quadrants: [
          { id: 'q_name_target', name: 'collision', order: 0 },
          { id: 'collision', name: 'ID target', order: 1 },
        ],
      });
      mockUpdateRadarPlacementWithHandoff.mockResolvedValue({ placement: { id: 'p1' }, graphHandoff: acknowledgedGraphHandoff });

      const collision = await executeUpdateTechnologyOnRadar({
        technologyId: 'tech-1',
        radarId: 'r1',
        quadrant: 'collision',
      }, { userId: 'user-1' });
      const spaced = await executeUpdateTechnologyOnRadar({
        technologyId: 'tech-1',
        radarId: 'r1',
        quadrant: ' collision ',
      }, { userId: 'user-1' });

      expect(collision.success).toBe(true);
      expect(mockUpdateRadarPlacementWithHandoff).toHaveBeenCalledWith('p1', { quadrantId: 'collision' }, { requireOwnerId: 'user-1' });
      expect(spaced.success).toBe(false);
      expect(spaced.error).toContain('not found');
      expect(mockUpdateRadarPlacementWithHandoff).toHaveBeenCalledTimes(1);
    });

    it('should return error when technology not on radar', async () => {
      mockGetPlacementForTechnologyOnRadar.mockResolvedValue(null);

      const result = await executeUpdateTechnologyOnRadar({
        technologyId: 'tech-1',
        radarId: 'r1',
        ring: 'Adopt',
      }, { userId: 'user-1' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not placed');
    });

    it('should reject empty updates', async () => {
      mockGetPlacementForTechnologyOnRadar.mockResolvedValue({ id: 'p1', ring: 'Trial' });

      const result = await executeUpdateTechnologyOnRadar({
        technologyId: 'tech-1',
        radarId: 'r1',
      }, { userId: 'user-1' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No updates');
    });

    it('should handle update errors', async () => {
      mockGetPlacementForTechnologyOnRadar.mockResolvedValue({ id: 'p1', ring: 'Trial' });
      mockUpdateRadarPlacementWithHandoff.mockRejectedValue(new Error('Write failed'));

      const result = await executeUpdateTechnologyOnRadar({
        technologyId: 'tech-1',
        radarId: 'r1',
        ring: 'Adopt',
      }, { userId: 'user-1' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Write failed');
    });
  });

  // --------------------------------------------------------------------------
  // executePopulateRadarFromContext
  // --------------------------------------------------------------------------
  describe('executePopulateRadarFromContext', () => {
    it('refuses an unauthenticated populate operation before every read and write', async () => {
      const result = await executePopulateRadarFromContext({
        radarId: 'r1',
        technologies: [],
      });

      expect(result).toEqual({
        success: false,
        error: 'You must be signed in to populate a radar.',
      });
      expect(mockGetRadarById).not.toHaveBeenCalled();
      expect(mockAdminListRadars).not.toHaveBeenCalled();
      expect(mockCreateRadar).not.toHaveBeenCalled();
      expect(mockCreateRadarPlacementWithHandoff).not.toHaveBeenCalled();
    });

    it('should create new radar and add technologies', async () => {
      mockGetAllRadars.mockResolvedValue([]);
      const radarWithQuadrants = {
        id: 'radar-new',
        name: 'AI Radar',
        quadrants: [
          { id: 'q_ml_frameworks', name: 'ML Frameworks', order: 0 },
          { id: 'q_tools', name: 'Tools', order: 1 },
          { id: 'q_platforms', name: 'Platforms', order: 2 },
          { id: 'q_languages', name: 'Languages', order: 3 },
        ],
      };
      mockCreateRadar.mockResolvedValue(radarWithQuadrants);
      // The shared resolver probes by ID first — only the CREATED radar's ID
      // resolves; the name probe must miss so creation actually happens.
      mockGetRadarById.mockImplementation(async (id: string) => (id === 'radar-new' ? radarWithQuadrants : null));
      mockAdminListRadars.mockResolvedValue([]);
      mockGetTechnologies.mockResolvedValue([]);
      mockCreateTechnology.mockResolvedValue({ id: 'tech-1', name: 'TensorFlow' });
      mockGetPlacementForTechnologyOnRadar.mockResolvedValue(null);
      mockCreateRadarPlacement.mockResolvedValue({ id: 'p1' });

      const result = await executePopulateRadarFromContext(
        {
          radarName: 'AI Radar',
          createMissingRadar: true,
          technologies: [
            {
              name: 'TensorFlow',
              description: 'ML framework',
              suggestedQuadrant: 'ML Frameworks',
              suggestedRing: 'Adopt',
            },
          ],
        },
        { userId: 'user-1' }
      );

      expect(result.success).toBe(true);
      expect(result.data?.radarCreated).toBe(true);
      expect(result.data?.placementsCreated).toBe(1);
    });

    it('should use existing radar by name', async () => {
      mockGetAllRadars.mockResolvedValue([{ id: 'r-existing', name: 'AI Radar' }]);
      mockGetRadarById.mockResolvedValue({ id: 'r-existing', name: 'AI Radar' });
      mockGetTechnologies.mockResolvedValue([{ id: 'tech-1', name: 'TensorFlow' }]);
      mockGetPlacementForTechnologyOnRadar.mockResolvedValue(null);
      mockCreateRadarPlacement.mockResolvedValue({ id: 'p1' });

      const result = await executePopulateRadarFromContext(
        {
          radarName: 'AI Radar',
          technologies: [{ name: 'TensorFlow', suggestedQuadrant: 'Q1', suggestedRing: 'Adopt' }],
        },
        { userId: 'user-1' },
      );

      expect(result.success).toBe(true);
      expect(result.data?.radarCreated).toBe(false);
      expect(result.data?.radarId).toBe('r-existing');
    });

    it('should use existing radar by ID', async () => {
      mockGetRadarById.mockResolvedValue({ id: 'r1', name: 'My Radar' });
      mockGetTechnologies.mockResolvedValue([]);
      mockCreateTechnology.mockResolvedValue({ id: 'tech-new', name: 'New Tech' });
      mockGetPlacementForTechnologyOnRadar.mockResolvedValue(null);
      mockCreateRadarPlacement.mockResolvedValue({ id: 'p1' });

      const result = await executePopulateRadarFromContext(
        {
          radarId: 'r1',
          technologies: [{ name: 'New Tech', suggestedQuadrant: 'Q1', suggestedRing: 'Trial' }],
        },
        { userId: 'user-1' },
      );

      expect(result.success).toBe(true);
      expect(result.data?.radarId).toBe('r1');
    });

    it('preserves skipped, failed, pending, and row details through the populate wrapper', async () => {
      mockGetRadarById.mockResolvedValue({
        id: 'r1',
        name: 'My Radar',
        quadrants: [{ id: 'q_q1', name: 'Q1', order: 0 }],
      });
      mockGetTechnologies.mockImplementation(
        async ({ search }: { search?: string }) => [
          { id: `tech-${search?.toLowerCase()}`, name: search },
        ],
      );
      mockGetPlacementForTechnologyOnRadar.mockImplementation(
        async (technologyId: string) =>
          technologyId === 'tech-already' ? { id: 'p-existing' } : null,
      );
      mockCreateRadarPlacementWithHandoff
        .mockResolvedValueOnce({
          placement: { id: 'p-pending' },
          graphHandoff: {
            committed: true,
            acknowledged: false,
            reconciliationRequired: true,
          },
        })
        .mockRejectedValueOnce(new Error('placement write failed'));

      const result = await executePopulateRadarFromContext(
        {
          radarId: 'r1',
          technologies: [
            { name: 'Already', suggestedQuadrant: 'Q1', suggestedRing: 'Adopt' },
            { name: 'Pending', suggestedQuadrant: 'Q1', suggestedRing: 'Trial' },
            { name: 'Failed', suggestedQuadrant: 'Q1', suggestedRing: 'Assess' },
          ],
        },
        { userId: 'user-1' },
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual(
        expect.objectContaining({
          placementsCreated: 1,
          graphAcknowledged: 0,
          reconciliationRequired: 1,
          skipped: 1,
          failed: 1,
          authorizationLost: false,
          complete: false,
          failures: [
            {
              name: 'Failed',
              reason: 'placement write failed',
            },
          ],
        }),
      );
      expect(result.data?.placements[0]?.graphHandoff).toEqual(
        expect.objectContaining({
          acknowledged: false,
          reconciliationRequired: true,
        }),
      );
      expect(result.data?.guidance).toContain(
        'Do not retry or recreate committed placements',
      );
    });

    it('should fail when no radar found and creation not requested', async () => {
      mockGetRadarById.mockResolvedValue(null);
      mockAdminListRadars.mockResolvedValue([]);

      const result = await executePopulateRadarFromContext(
        {
          radarName: 'Missing',
          createMissingRadar: false,
          technologies: [{ name: 'X', suggestedQuadrant: 'Q1', suggestedRing: 'Adopt' }],
        },
        { userId: 'user-1' },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('createMissingRadar is false');
    });

    it('should reject invalid custom quadrants', async () => {
      mockGetRadarById.mockResolvedValue(null);
      mockAdminListRadars.mockResolvedValue([]);

      const result = await executePopulateRadarFromContext(
        {
          radarName: 'Test',
          createMissingRadar: true,
          // 9 quadrants — exceeds MAX_QUADRANTS (8)
          customQuadrants: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9'],
          technologies: [{ name: 'X', suggestedQuadrant: 'Q1', suggestedRing: 'Adopt' }],
        },
        { userId: 'user-1' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/out of range/i);
    });

    it('should return error when radar ID not found', async () => {
      mockGetRadarById.mockResolvedValue(null);

      const result = await executePopulateRadarFromContext(
        {
          radarId: 'missing',
          technologies: [{ name: 'X', suggestedQuadrant: 'Q1', suggestedRing: 'Adopt' }],
        },
        { userId: 'user-1' },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should handle errors gracefully', async () => {
      mockGetRadarById.mockResolvedValue(null);
      mockAdminListRadars.mockRejectedValue(new Error('DB down'));

      const result = await executePopulateRadarFromContext(
        {
          radarName: 'Test',
          technologies: [],
        },
        { userId: 'user-1' },
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('DB down');
    });
  });

  // --------------------------------------------------------------------------
  // Write-tool envelope consistency
  //
  // External MCP read tools carry a Presentation Guidance block; write tools
  // returned bare JSON. Every write executor now ships a one-line `guidance`
  // string in its data envelope so external clients render consistently.
  // --------------------------------------------------------------------------
  describe('write-tool guidance envelope', () => {
    it('updateTechnologyOnRadar returns one-line guidance mentioning before/after ring', async () => {
      mockGetPlacementForTechnologyOnRadar.mockResolvedValue({ id: 'p1', ring: 'Trial' });
      mockUpdateRadarPlacementWithHandoff.mockResolvedValue({ placement: { id: 'p1' }, graphHandoff: acknowledgedGraphHandoff });

      const result = await executeUpdateTechnologyOnRadar({
        technologyId: 'tech-1',
        radarId: 'r1',
        ring: 'Adopt',
      }, { userId: 'user-1' });

      expect(result.success).toBe(true);
      expect(result.data?.guidance).toBe('Confirm the change to the user, mentioning before/after ring.');
    });

    it('createRadar, updateRadarSettings, deleteRadar, addTechnologiesToRadar and populateRadarFromContext all carry a guidance line', async () => {
      mockCreateRadar.mockResolvedValue({ id: 'r1', name: 'R', slug: 'r', quadrants: [] });
      const created = await executeCreateRadar({ name: 'R' }, { userId: 'user-1' });
      expect(typeof created.data?.guidance).toBe('string');
      expect(created.data?.guidance.length).toBeGreaterThan(0);

      mockUpdateRadar.mockResolvedValue(undefined);
      const updated = await executeUpdateRadarSettings({ radarId: 'r1', name: 'R2' }, { userId: 'user-1' });
      expect(typeof updated.data?.guidance).toBe('string');

      mockAdminDeleteRadar.mockResolvedValue({ placementsDeleted: 2 });
      const deleted = await executeDeleteRadar({ radarId: 'r1', confirmed: true }, { userId: 'user-1' });
      expect(typeof (deleted.data as { guidance: string }).guidance).toBe('string');

      mockGetRadarById.mockResolvedValue({
        id: 'r1',
        name: 'Radar',
        quadrants: [{ id: 'q_q1', name: 'Q1', order: 0 }],
      });
      mockGetPlacementForTechnologyOnRadar.mockResolvedValue(null);
      mockCreateRadarPlacement.mockResolvedValue({ id: 'p1' });
      const added = await executeAddTechnologiesToRadar(
        {
          radarId: 'r1',
          technologies: [{ technologyId: 'tech-1', quadrant: 'Q1', ring: 'Adopt' }],
        },
        { userId: 'user-1' },
      );
      expect(typeof added.data?.guidance).toBe('string');

      const populated = await executePopulateRadarFromContext(
        {
          radarId: 'r1',
          technologies: [],
        },
        { userId: 'user-1' },
      );
      expect(typeof populated.data?.guidance).toBe('string');
    });
  });
});
