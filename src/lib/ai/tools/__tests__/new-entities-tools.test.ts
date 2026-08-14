/**
 * @jest-environment node
 */

// ============================================================================
// Mocks (MUST be before imports)
// ============================================================================

jest.mock('@/lib/firebase', () => {
  throw new Error('new-entity tools must not import the Firebase client runtime');
});
jest.mock('firebase/firestore', () => {
  throw new Error('new-entity tools must not import firebase/firestore');
});

const mockGetOrgUnits = jest.fn();
const mockGetOrgUnitById = jest.fn();
const mockCreateOrgUnit = jest.fn();
const mockUpdateOrgUnit = jest.fn();
const mockDeleteOrgUnit = jest.fn();
jest.mock('@/lib/org-units-admin', () => ({
  __esModule: true,
  adminGetOrgUnits: (...args: unknown[]) => mockGetOrgUnits(...args),
  adminGetOrgUnitById: (...args: unknown[]) => mockGetOrgUnitById(...args),
  adminCreateOrgUnit: (...args: unknown[]) => mockCreateOrgUnit(...args),
  adminUpdateOrgUnit: (...args: unknown[]) => mockUpdateOrgUnit(...args),
  adminDeleteOrgUnit: (...args: unknown[]) => mockDeleteOrgUnit(...args),
}));

const mockGetInitiatives = jest.fn();
const mockGetInitiativeById = jest.fn();
const mockCreateInitiative = jest.fn();
const mockUpdateInitiative = jest.fn();
const mockDeleteInitiative = jest.fn();
jest.mock('@/lib/initiatives-admin', () => ({
  __esModule: true,
  adminGetInitiatives: (...args: unknown[]) => mockGetInitiatives(...args),
  adminGetInitiativeById: (...args: unknown[]) => mockGetInitiativeById(...args),
  adminCreateInitiative: (...args: unknown[]) => mockCreateInitiative(...args),
  adminUpdateInitiative: (...args: unknown[]) => mockUpdateInitiative(...args),
  adminDeleteInitiative: (...args: unknown[]) => mockDeleteInitiative(...args),
}));

const mockGetPainPoints = jest.fn();
const mockGetPainPointById = jest.fn();
const mockCreatePainPoint = jest.fn();
const mockUpdatePainPoint = jest.fn();
const mockDeletePainPoint = jest.fn();
jest.mock('@/lib/pain-points-admin', () => ({
  __esModule: true,
  adminGetPainPoints: (...args: unknown[]) => mockGetPainPoints(...args),
  adminGetPainPointById: (...args: unknown[]) => mockGetPainPointById(...args),
  adminCreatePainPoint: (...args: unknown[]) => mockCreatePainPoint(...args),
  adminUpdatePainPoint: (...args: unknown[]) => mockUpdatePainPoint(...args),
  adminDeletePainPoint: (...args: unknown[]) => mockDeletePainPoint(...args),
}));

const mockEmitDataRefresh = jest.fn();
jest.mock('@/lib/events/data-refresh', () => ({
  __esModule: true,
  emitDataRefresh: (...args: unknown[]) => mockEmitDataRefresh(...args),
}));

jest.mock('@/lib/entity-factory', () => {
  throw new Error('new-entity tools must not import the Firebase client entity factory');
});

// ============================================================================
// Imports (after mocks)
// ============================================================================

import {
  executeSearchOrgUnits,
  executeGetOrgUnitDetails,
  executeCreateOrgUnit,
  executeUpdateOrgUnit,
  executeDeleteOrgUnit,
  executeSearchInitiatives,
  executeGetInitiativeDetails,
  executeCreateInitiative,
  executeUpdateInitiative,
  executeDeleteInitiative,
  executeSearchPainPoints,
  executeGetPainPointDetails,
  executeCreatePainPoint,
  executeUpdatePainPoint,
  executeDeletePainPoint,
  executeListInitiativesByOrgUnit,
  executeListPainPointsByOrgUnit,
} from '../new-entities-tools';
import { EntityDeletionBlockedError } from '@/lib/entity-deletion-reference-policy';
import {
  CONFIRMATION_TTL_MS,
  _resetConfirmationStore,
  destructiveActionFingerprint,
  destructiveConfirmationPhrase,
  type DestructiveGateRefusal,
} from '@/lib/ai/destructive-confirmation';

// ============================================================================
// Test Data
// ============================================================================

const mockOrgUnit = {
  id: 'org-1',
  name: 'Engineering Department',
  description: 'Core engineering team',
  type: 'department',
  level: 'L2',
  headName: 'Alice Johnson',
  employeeCount: 50,
  location: 'New York',
  tags: ['engineering', 'technology'],
};

const mockInitiative = {
  id: 'init-1',
  name: 'Cloud Migration Program',
  description: 'Migrate legacy systems to cloud',
  ownerOrgUnitId: 'org-1',
  ownerOrgUnitName: 'Engineering Department',
  sponsorName: 'Jane Smith',
  status: 'active',
  priority: 'high',
  budget: 2500000,
  actualSpend: 500000,
  startDate: 1700000000000,
  targetEndDate: 1800000000000,
  linkedStrategyIds: ['strat-1'],
  linkedPrototypeIds: [],
  linkedPainPointIds: ['pp-1'],
  tags: ['cloud', 'infrastructure'],
};

const mockPainPoint = {
  id: 'pp-1',
  title: 'Legacy System Integration Bottleneck',
  description: 'Manual data transfer between CRM and ERP systems causes delays',
  severity: 'high',
  status: 'validated',
  category: 'technical',
  estimatedImpact: 250000,
  impactDescription: 'Lost productivity and data quality issues',
  rootCauses: ['No API integration', 'Legacy ERP lacks modern connectors'],
  affectedOrgUnitIds: ['org-1', 'org-2'],
  linkedPrototypeIds: ['proto-1'],
  linkedTechnologyIds: [],
  linkedInitiativeIds: ['init-1'],
  tags: ['integration', 'automation'],
};

// ============================================================================
// Tests
// ============================================================================

describe('New Entities Tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetConfirmationStore();
  });

  const humanContext = (requestId: string, userId = 'user-1', confirmationText?: string) => ({
    principal: 'human' as const,
    userId,
    requestId,
    confirmationText,
  });

  describe.each([
    {
      label: 'org unit',
      id: 'org-gated',
      fingerprint: destructiveActionFingerprint('deleteOrgUnit', 'org-gated'),
      execute: executeDeleteOrgUnit,
      deleteMock: mockDeleteOrgUnit,
    },
    {
      label: 'initiative',
      id: 'initiative-gated',
      fingerprint: destructiveActionFingerprint('deleteInitiative', 'initiative-gated'),
      execute: executeDeleteInitiative,
      deleteMock: mockDeleteInitiative,
    },
    {
      label: 'pain point',
      id: 'pain-point-gated',
      fingerprint: destructiveActionFingerprint('deletePainPoint', 'pain-point-gated'),
      execute: executeDeletePainPoint,
      deleteMock: mockDeletePainPoint,
    },
  ])('$label deletion confirmation gate', ({ id, fingerprint, execute, deleteMock }) => {
    it.each([undefined, '   ', 42, '\ud800'])(
      'rejects an invalid ID before creating confirmation state (%p)',
      async (invalidId) => {
      const invalid = await execute({ id: invalidId, confirmed: true }, humanContext('invalid-request'));

      expect(invalid.success).toBe(false);
      expect(invalid.error).toContain('non-empty');
      expect(invalid.data).toBeUndefined();
      expect(deleteMock).not.toHaveBeenCalled();

      const validFirstTurn = await execute({ id, confirmed: true }, humanContext('valid-request'));
      expect(validFirstTurn.success).toBe(false);
      expect(validFirstTurn.data).toMatchObject({ requiresConfirmation: true });
      expect(deleteMock).not.toHaveBeenCalled();
      }
    );

    it('rejects model self-confirmation and same-turn replay, redeems once later, then rejects replay', async () => {
      deleteMock.mockResolvedValue(undefined);
      const phrase = destructiveConfirmationPhrase(fingerprint);

      const first = await execute({ id, confirmed: true }, humanContext('request-1', 'user-1', phrase));
      expect(first.success).toBe(false);
      expect(first.data).toMatchObject({ requiresConfirmation: true });
      expect(deleteMock).not.toHaveBeenCalled();

      const sameTurn = await execute({ id, confirmed: true }, humanContext('request-1', 'user-1', phrase));
      expect(sameTurn.success).toBe(false);
      expect(sameTurn.data).toMatchObject({ requiresConfirmation: true });
      expect(deleteMock).not.toHaveBeenCalled();

      const laterTurn = await execute({ id, confirmed: true }, humanContext('request-2', 'user-1', phrase));
      expect(laterTurn.success).toBe(true);
      expect(deleteMock).toHaveBeenCalledTimes(1);
      expect(deleteMock).toHaveBeenCalledWith(id);

      const replay = await execute({ id, confirmed: true }, humanContext('request-3', 'user-1', phrase));
      expect(replay.success).toBe(false);
      expect(replay.data).toMatchObject({ requiresConfirmation: true });
      expect(deleteMock).toHaveBeenCalledTimes(1);
    });
  });

  it('binds a pending confirmation to the authenticated user principal', async () => {
    const phrase = destructiveConfirmationPhrase(destructiveActionFingerprint('deleteOrgUnit', 'principal-bound'));
    await executeDeleteOrgUnit({ id: 'principal-bound' }, humanContext('request-1', 'user-1'));

    const wrongPrincipal = await executeDeleteOrgUnit(
      { id: 'principal-bound', confirmed: true },
      humanContext('request-2', 'user-2', phrase)
    );

    expect(wrongPrincipal.success).toBe(false);
    expect((wrongPrincipal.data as DestructiveGateRefusal).requiresConfirmation).toBe(true);
    expect(mockDeleteOrgUnit).not.toHaveBeenCalled();

    const originalPrincipal = await executeDeleteOrgUnit(
      { id: 'principal-bound' },
      humanContext('request-2', 'user-1', phrase)
    );
    expect(originalPrincipal.success).toBe(true);
    expect(mockDeleteOrgUnit).toHaveBeenCalledWith('principal-bound');
  });

  it('binds a pending confirmation to the exact entity type and ID', async () => {
    const phrase = destructiveConfirmationPhrase(destructiveActionFingerprint('deleteOrgUnit', 'shared-id'));
    await executeDeleteOrgUnit({ id: 'shared-id' }, humanContext('request-1'));

    const wrongId = await executeDeleteOrgUnit(
      { id: 'other-id' },
      humanContext('request-2', 'user-1', phrase)
    );
    const wrongType = await executeDeleteInitiative(
      { id: 'shared-id' },
      humanContext('request-2', 'user-1', phrase)
    );

    expect(wrongId.success).toBe(false);
    expect(wrongType.success).toBe(false);
    expect(mockDeleteOrgUnit).not.toHaveBeenCalled();
    expect(mockDeleteInitiative).not.toHaveBeenCalled();

    const exactTarget = await executeDeleteOrgUnit(
      { id: 'shared-id' },
      humanContext('request-2', 'user-1', phrase)
    );
    expect(exactTarget.success).toBe(true);
    expect(mockDeleteOrgUnit).toHaveBeenCalledWith('shared-id');
  });

  it('does not redeem an expired confirmation', async () => {
    const now = 1_700_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);

    try {
      await executeDeletePainPoint({ id: 'expired-id' }, humanContext('request-1'));
      clock.mockReturnValue(now + CONFIRMATION_TTL_MS + 1);

      const expired = await executeDeletePainPoint(
        { id: 'expired-id' },
        humanContext(
          'request-2',
          'user-1',
          destructiveConfirmationPhrase(destructiveActionFingerprint('deletePainPoint', 'expired-id'))
        )
      );

      expect(expired.success).toBe(false);
      expect((expired.data as DestructiveGateRefusal).requiresConfirmation).toBe(true);
      expect(mockDeletePainPoint).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  // ==========================================================================
  // OrgUnit Functions
  // ==========================================================================

  describe('executeSearchOrgUnits', () => {
    it('should return matching org units by query', async () => {
      mockGetOrgUnits.mockResolvedValue([
        mockOrgUnit,
        { ...mockOrgUnit, id: 'org-2', name: 'Marketing Team', description: 'The marketing team', type: 'team' },
      ]);

      const result = await executeSearchOrgUnits({ query: 'engineering' });

      expect(result.success).toBe(true);
      const data = result.data as { count: number; results: unknown[] };
      expect(data.count).toBe(1);
      expect(data.results).toHaveLength(1);
    });

    it('should filter by type', async () => {
      mockGetOrgUnits.mockResolvedValue([
        mockOrgUnit,
        { ...mockOrgUnit, id: 'org-2', name: 'DevOps Team', type: 'team' },
        { ...mockOrgUnit, id: 'org-3', name: 'Engineering Squad', type: 'squad' },
      ]);

      const result = await executeSearchOrgUnits({ query: 'engineering', type: 'department' });

      const data = result.data as { count: number };
      expect(data.count).toBe(1);
    });

    it('should filter by level', async () => {
      mockGetOrgUnits.mockResolvedValue([
        mockOrgUnit, // L2
        { ...mockOrgUnit, id: 'org-2', name: 'Engineering Squad', level: 'L3' },
      ]);

      const result = await executeSearchOrgUnits({ query: 'engineering', level: 'L2' });

      const data = result.data as { count: number };
      expect(data.count).toBe(1);
    });

    it('should respect limit parameter', async () => {
      const manyOrgUnits = Array.from({ length: 20 }, (_, i) => ({
        ...mockOrgUnit,
        id: `org-${i}`,
        name: `Engineering Team ${i}`,
      }));
      mockGetOrgUnits.mockResolvedValue(manyOrgUnits);

      const result = await executeSearchOrgUnits({ query: 'engineering', limit: 5 });

      const data = result.data as { count: number };
      expect(data.count).toBe(5);
    });

    it('should cap limit at 50', async () => {
      const manyOrgUnits = Array.from({ length: 100 }, (_, i) => ({
        ...mockOrgUnit,
        id: `org-${i}`,
        name: `Engineering Team ${i}`,
      }));
      mockGetOrgUnits.mockResolvedValue(manyOrgUnits);

      const result = await executeSearchOrgUnits({ query: 'engineering', limit: 200 });

      const data = result.data as { count: number };
      expect(data.count).toBe(50);
    });

    it('should match by description too', async () => {
      mockGetOrgUnits.mockResolvedValue([
        { ...mockOrgUnit, name: 'IT Department', description: 'handles engineering work' },
      ]);

      const result = await executeSearchOrgUnits({ query: 'engineering' });

      const data = result.data as { count: number };
      expect(data.count).toBe(1);
    });

    it('should return empty results when no matches', async () => {
      mockGetOrgUnits.mockResolvedValue([mockOrgUnit]);

      const result = await executeSearchOrgUnits({ query: 'finance' });

      const data = result.data as { count: number };
      expect(data.count).toBe(0);
    });

    it('should handle service errors', async () => {
      mockGetOrgUnits.mockRejectedValue(new Error('DB connection failed'));

      const result = await executeSearchOrgUnits({ query: 'engineering' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('DB connection failed');
    });

    it('should include correct fields in results', async () => {
      mockGetOrgUnits.mockResolvedValue([mockOrgUnit]);

      const result = await executeSearchOrgUnits({ query: 'engineering' });

      const data = result.data as { results: Record<string, unknown>[] };
      expect(data.results[0]).toMatchObject({
        id: 'org-1',
        name: 'Engineering Department',
        // T1-7: `type` is the navigable entity type (drives chat entity chips);
        // the domain value lives in `orgUnitType`.
        type: 'orgUnit',
        orgUnitType: 'department',
        level: 'L2',
        headName: 'Alice Johnson',
        employeeCount: 50,
      });
    });

    it('pins type: orgUnit on every result item (entity-chip contract)', async () => {
      mockGetOrgUnits.mockResolvedValue([
        mockOrgUnit,
        { ...mockOrgUnit, id: 'org-2', name: 'Engineering Squad', type: 'squad' },
      ]);

      const result = await executeSearchOrgUnits({ query: 'engineering' });

      const data = result.data as { results: Array<{ type: string; orgUnitType: string }> };
      expect(data.results).toHaveLength(2);
      for (const item of data.results) {
        expect(item.type).toBe('orgUnit');
      }
      expect(data.results[1].orgUnitType).toBe('squad');
    });
  });

  describe('executeGetOrgUnitDetails', () => {
    it('should return org unit details for valid id', async () => {
      mockGetOrgUnitById.mockResolvedValue(mockOrgUnit);

      const result = await executeGetOrgUnitDetails({ id: 'org-1' });

      expect(result.success).toBe(true);
      const data = result.data as { id: string; _type: string };
      expect(data.id).toBe('org-1');
      expect(data._type).toBe('orgUnit');
    });

    it('should return error when org unit not found', async () => {
      mockGetOrgUnitById.mockResolvedValue(null);

      const result = await executeGetOrgUnitDetails({ id: 'nonexistent' });

      expect(result.success).toBe(false);
      expect(result.error).toContain("'nonexistent' not found");
    });

    it('should handle service errors', async () => {
      mockGetOrgUnitById.mockRejectedValue(new Error('Firestore error'));

      const result = await executeGetOrgUnitDetails({ id: 'org-1' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Firestore error');
    });
  });

  describe('executeCreateOrgUnit', () => {
    it('should create an org unit with all fields', async () => {
      mockCreateOrgUnit.mockResolvedValue({ id: 'org-new', name: 'AI Innovation Lab' });

      const result = await executeCreateOrgUnit({
        name: 'AI Innovation Lab',
        description: 'Cross-functional AI team',
        type: 'squad',
        level: 'L3',
        parentId: 'org-1',
        headName: 'Bob Manager',
        employeeCount: 8,
        location: 'New York',
        tags: ['ai', 'innovation'],
      });

      expect(result.success).toBe(true);
      const data = result.data as { id: string; name: string };
      expect(data.id).toBe('org-new');
      expect(data.name).toBe('AI Innovation Lab');
      expect(mockCreateOrgUnit).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'AI Innovation Lab',
          description: 'Cross-functional AI team',
          type: 'squad',
          level: 'L3',
          parentId: 'org-1',
          headName: 'Bob Manager',
          employeeCount: 8,
          location: 'New York',
          tags: ['ai', 'innovation'],
        })
      );
      expect(mockEmitDataRefresh).toHaveBeenCalledWith('orgUnits', 'ai-assistant');
    });

    it('should use defaults for optional fields', async () => {
      mockCreateOrgUnit.mockResolvedValue({ id: 'org-2', name: 'Test Team' });

      await executeCreateOrgUnit({ name: 'Test Team', type: 'team', level: 'L4' });

      expect(mockCreateOrgUnit).toHaveBeenCalledWith(
        expect.objectContaining({
          description: '',
          tags: [],
        })
      );
    });

    it('should handle service errors', async () => {
      mockCreateOrgUnit.mockRejectedValue(new Error('OrgUnit creation failed'));

      const result = await executeCreateOrgUnit({
        name: 'Test',
        type: 'team',
        level: 'L3',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('OrgUnit creation failed');
    });
  });

  describe('executeUpdateOrgUnit', () => {
    it('should require confirmation', async () => {
      const result = await executeUpdateOrgUnit({
        id: 'org-1',
        updates: { headName: 'New Manager' },
        confirmed: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('requires user confirmation');
      expect(result.data).toEqual({ pendingUpdate: { id: 'org-1', updates: { headName: 'New Manager' } } });
    });

    it('should update org unit when confirmed', async () => {
      mockUpdateOrgUnit.mockResolvedValue(undefined);

      const result = await executeUpdateOrgUnit({
        id: 'org-1',
        updates: { headName: 'New Manager', employeeCount: 60 },
        confirmed: true,
      });

      expect(result.success).toBe(true);
      expect(mockUpdateOrgUnit).toHaveBeenCalledWith('org-1', { headName: 'New Manager', employeeCount: 60 });
      expect(mockEmitDataRefresh).toHaveBeenCalledWith('orgUnits', 'ai-assistant');
    });

    it('should handle service errors when updating', async () => {
      mockUpdateOrgUnit.mockRejectedValue(new Error('Update failed'));

      const result = await executeUpdateOrgUnit({
        id: 'org-1',
        updates: { headName: 'New Manager' },
        confirmed: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Update failed');
    });
  });

  describe('executeDeleteOrgUnit', () => {
    it('should require confirmation', async () => {
      const result = await executeDeleteOrgUnit({
        id: 'org-1',
        confirmed: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('requires confirmation');
      expect(result.error).toContain('org-1');
    });

    it('should delete org unit when confirmed', async () => {
      mockDeleteOrgUnit.mockResolvedValue(undefined);

      const result = await executeDeleteOrgUnit({
        id: 'org-1',
        confirmed: true,
      });

      expect(result.success).toBe(true);
      const data = result.data as { message: string; mutatedEntityTypes: string[] };
      expect(data.message).toContain('Successfully deleted org unit');
      expect(data.message).toContain('org-1');
      expect(data.mutatedEntityTypes).toEqual([
        'orgUnit',
        'relation',
        'document',
        'entityDocumentLink',
        'painPoint',
      ]);
      expect(mockDeleteOrgUnit).toHaveBeenCalledWith('org-1');
      expect(mockEmitDataRefresh).toHaveBeenCalledWith('orgUnits', 'ai-assistant');
    });

    it('should handle service errors', async () => {
      mockDeleteOrgUnit.mockRejectedValue(new Error('Cannot delete org unit with children'));

      const result = await executeDeleteOrgUnit({
        id: 'org-1',
        confirmed: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Cannot delete org unit with children');
      expect(result.data).toMatchObject({
        mutatedEntityTypes: ['orgUnit', 'relation', 'document', 'entityDocumentLink', 'painPoint'],
      });
    });

    it('returns structured ownership blockers for assistant recovery', async () => {
      mockDeleteOrgUnit.mockRejectedValue(
        new EntityDeletionBlockedError('orgUnit', 'org-1', [
          {
            collection: 'org-units',
            fieldPath: 'parentId',
            count: 2,
            sampleDocumentIds: ['child-2', 'child-1'],
            reason: 'Child Org Units must be reassigned.',
          },
        ])
      );

      const result = await executeDeleteOrgUnit({ id: 'org-1', confirmed: true });

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('reassign dependent records'),
        data: {
          mutatedEntityTypes: ['orgUnit', 'relation', 'document', 'entityDocumentLink', 'painPoint'],
          deletionBlocker: {
            code: 'entity-deletion-blocked',
            entityType: 'orgUnit',
            entityId: 'org-1',
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
    });
  });

  // ==========================================================================
  // Initiative Functions
  // ==========================================================================

  describe('executeSearchInitiatives', () => {
    it('should return matching initiatives by query', async () => {
      mockGetInitiatives.mockResolvedValue([
        mockInitiative,
        { ...mockInitiative, id: 'init-2', name: 'AI Adoption Program', description: 'Adopt AI tools across the org' },
      ]);

      const result = await executeSearchInitiatives({ query: 'cloud' });

      expect(result.success).toBe(true);
      const data = result.data as { count: number };
      expect(data.count).toBe(1);
    });

    it('should filter by status', async () => {
      mockGetInitiatives.mockResolvedValue([
        mockInitiative, // active
        { ...mockInitiative, id: 'init-2', name: 'Data Strategy', status: 'proposed' },
      ]);

      const result = await executeSearchInitiatives({ query: '', status: 'active' });

      const data = result.data as { count: number };
      expect(data.count).toBe(1);
    });

    it('should filter by priority', async () => {
      mockGetInitiatives.mockResolvedValue([
        mockInitiative, // high priority
        { ...mockInitiative, id: 'init-2', name: 'Low Priority Init', priority: 'low' },
      ]);

      const result = await executeSearchInitiatives({ query: '', priority: 'high' });

      const data = result.data as { count: number };
      expect(data.count).toBe(1);
    });

    it('should filter by ownerOrgUnitId', async () => {
      mockGetInitiatives.mockResolvedValue([
        mockInitiative, // owner: org-1
        { ...mockInitiative, id: 'init-2', name: 'Marketing Init', ownerOrgUnitId: 'org-99' },
      ]);

      const result = await executeSearchInitiatives({ query: '', ownerOrgUnitId: 'org-1' });

      const data = result.data as { count: number };
      expect(data.count).toBe(1);
    });

    it('should match by description too', async () => {
      mockGetInitiatives.mockResolvedValue([
        { ...mockInitiative, name: 'IT Initiative', description: 'cloud migration effort' },
      ]);

      const result = await executeSearchInitiatives({ query: 'migration' });

      const data = result.data as { count: number };
      expect(data.count).toBe(1);
    });

    it('should respect limit parameter', async () => {
      const manyInits = Array.from({ length: 20 }, (_, i) => ({
        ...mockInitiative,
        id: `init-${i}`,
        name: `Initiative ${i}`,
      }));
      mockGetInitiatives.mockResolvedValue(manyInits);

      const result = await executeSearchInitiatives({ query: '', limit: 3 });

      const data = result.data as { count: number };
      expect(data.count).toBe(3);
    });

    it('should handle service errors', async () => {
      mockGetInitiatives.mockRejectedValue(new Error('DB error'));

      const result = await executeSearchInitiatives({ query: 'cloud' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('DB error');
    });

    it('should include correct result fields', async () => {
      mockGetInitiatives.mockResolvedValue([mockInitiative]);

      const result = await executeSearchInitiatives({ query: 'cloud' });

      const data = result.data as { results: Record<string, unknown>[] };
      expect(data.results[0]).toMatchObject({
        id: 'init-1',
        name: 'Cloud Migration Program',
        status: 'active',
        priority: 'high',
        budget: 2500000,
      });
    });
  });

  describe('executeGetInitiativeDetails', () => {
    it('should return initiative details for valid id', async () => {
      mockGetInitiativeById.mockResolvedValue(mockInitiative);

      const result = await executeGetInitiativeDetails({ id: 'init-1' });

      expect(result.success).toBe(true);
      const data = result.data as { id: string; _type: string };
      expect(data.id).toBe('init-1');
      expect(data._type).toBe('initiative');
    });

    it('should return error when initiative not found', async () => {
      mockGetInitiativeById.mockResolvedValue(null);

      const result = await executeGetInitiativeDetails({ id: 'nonexistent' });

      expect(result.success).toBe(false);
      expect(result.error).toContain("'nonexistent' not found");
    });

    it('should handle service errors', async () => {
      mockGetInitiativeById.mockRejectedValue(new Error('Query failed'));

      const result = await executeGetInitiativeDetails({ id: 'init-1' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Query failed');
    });
  });

  describe('executeCreateInitiative', () => {
    it('should create an initiative with all fields', async () => {
      mockCreateInitiative.mockResolvedValue({ id: 'init-new', name: 'Cloud Migration' });

      const result = await executeCreateInitiative({
        name: 'Cloud Migration',
        description: 'Migrate all systems to cloud',
        ownerOrgUnitId: 'org-1',
        ownerOrgUnitName: 'Engineering',
        sponsorName: 'CEO Jane',
        status: 'approved',
        priority: 'high',
        startDate: 1700000000000,
        targetEndDate: 1800000000000,
        budget: 1000000,
        linkedStrategyIds: ['strat-1'],
        linkedPrototypeIds: ['proto-1'],
        linkedPainPointIds: ['pp-1'],
        tags: ['cloud', 'modernization'],
      });

      expect(result.success).toBe(true);
      const data = result.data as { id: string; name: string };
      expect(data.id).toBe('init-new');
      expect(data.name).toBe('Cloud Migration');
      expect(mockCreateInitiative).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Cloud Migration',
          ownerOrgUnitId: 'org-1',
          status: 'approved',
          priority: 'high',
          budget: 1000000,
        })
      );
      expect(mockEmitDataRefresh).toHaveBeenCalledWith('initiatives', 'ai-assistant');
    });

    it('should use defaults for optional fields', async () => {
      mockCreateInitiative.mockResolvedValue({ id: 'init-2', name: 'Minimal Init' });

      await executeCreateInitiative({
        name: 'Minimal Init',
        description: 'desc',
        ownerOrgUnitId: 'org-1',
      });

      expect(mockCreateInitiative).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'proposed',
          priority: 'medium',
          linkedStrategyIds: [],
          linkedPrototypeIds: [],
          linkedPainPointIds: [],
          tags: [],
        })
      );
    });

    it('should handle service errors', async () => {
      mockCreateInitiative.mockRejectedValue(new Error('Initiative creation failed'));

      const result = await executeCreateInitiative({
        name: 'Test',
        description: 'desc',
        ownerOrgUnitId: 'org-1',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Initiative creation failed');
    });
  });

  describe('executeUpdateInitiative', () => {
    it('should require confirmation', async () => {
      const result = await executeUpdateInitiative({
        id: 'init-1',
        updates: { status: 'completed' },
        confirmed: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('requires user confirmation');
    });

    it('should update initiative when confirmed', async () => {
      mockUpdateInitiative.mockResolvedValue(undefined);

      const result = await executeUpdateInitiative({
        id: 'init-1',
        updates: { status: 'completed', actualSpend: 2000000 },
        confirmed: true,
      });

      expect(result.success).toBe(true);
      expect(mockUpdateInitiative).toHaveBeenCalledWith('init-1', { status: 'completed', actualSpend: 2000000 });
      expect(mockEmitDataRefresh).toHaveBeenCalledWith('initiatives', 'ai-assistant');
    });

    it('should handle service errors when updating', async () => {
      mockUpdateInitiative.mockRejectedValue(new Error('Update failed'));

      const result = await executeUpdateInitiative({
        id: 'init-1',
        updates: { status: 'completed' },
        confirmed: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Update failed');
    });
  });

  describe('executeDeleteInitiative', () => {
    it('should require confirmation', async () => {
      const result = await executeDeleteInitiative({
        id: 'init-1',
        confirmed: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('requires confirmation');
      expect(result.error).toContain('init-1');
    });

    it('should delete initiative when confirmed', async () => {
      mockDeleteInitiative.mockResolvedValue(undefined);

      const result = await executeDeleteInitiative({
        id: 'init-1',
        confirmed: true,
      });

      expect(result.success).toBe(true);
      const data = result.data as { message: string; mutatedEntityTypes: string[] };
      expect(data.message).toContain('Successfully deleted initiative');
      expect(data.message).toContain('init-1');
      expect(data.mutatedEntityTypes).toEqual([
        'initiative',
        'relation',
        'document',
        'entityDocumentLink',
        'painPoint',
      ]);
      expect(mockDeleteInitiative).toHaveBeenCalledWith('init-1');
      expect(mockEmitDataRefresh).toHaveBeenCalledWith('initiatives', 'ai-assistant');
    });

    it('should handle service errors', async () => {
      mockDeleteInitiative.mockRejectedValue(new Error('Delete failed'));

      const result = await executeDeleteInitiative({
        id: 'init-1',
        confirmed: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Delete failed');
      expect(result.data).toMatchObject({
        mutatedEntityTypes: ['initiative', 'relation', 'document', 'entityDocumentLink', 'painPoint'],
      });
    });
  });

  // ==========================================================================
  // PainPoint Functions
  // ==========================================================================

  describe('executeSearchPainPoints', () => {
    it('should return matching pain points by query', async () => {
      mockGetPainPoints.mockResolvedValue([
        mockPainPoint,
        { ...mockPainPoint, id: 'pp-2', title: 'Customer Churn Issue', category: 'customer' },
      ]);

      const result = await executeSearchPainPoints({ query: 'legacy' });

      expect(result.success).toBe(true);
      const data = result.data as { count: number };
      expect(data.count).toBe(1);
    });

    it('should filter by severity', async () => {
      mockGetPainPoints.mockResolvedValue([
        mockPainPoint, // high severity
        { ...mockPainPoint, id: 'pp-2', title: 'Minor Issue', severity: 'low' },
      ]);

      const result = await executeSearchPainPoints({ query: '', severity: 'high' });

      const data = result.data as { count: number };
      expect(data.count).toBe(1);
    });

    it('should filter by status', async () => {
      mockGetPainPoints.mockResolvedValue([
        mockPainPoint, // validated
        { ...mockPainPoint, id: 'pp-2', title: 'New Issue', status: 'identified' },
      ]);

      const result = await executeSearchPainPoints({ query: '', status: 'validated' });

      const data = result.data as { count: number };
      expect(data.count).toBe(1);
    });

    it('should filter by category', async () => {
      mockGetPainPoints.mockResolvedValue([
        mockPainPoint, // technical
        { ...mockPainPoint, id: 'pp-2', title: 'Customer Issue', category: 'customer' },
      ]);

      const result = await executeSearchPainPoints({ query: '', category: 'technical' });

      const data = result.data as { count: number };
      expect(data.count).toBe(1);
    });

    it('should match by description too', async () => {
      mockGetPainPoints.mockResolvedValue([
        { ...mockPainPoint, title: 'IT Pain', description: 'legacy ERP system issue' },
      ]);

      const result = await executeSearchPainPoints({ query: 'legacy' });

      const data = result.data as { count: number };
      expect(data.count).toBe(1);
    });

    it('should respect limit parameter', async () => {
      const manyPPs = Array.from({ length: 20 }, (_, i) => ({
        ...mockPainPoint,
        id: `pp-${i}`,
        title: `Pain Point ${i}`,
      }));
      mockGetPainPoints.mockResolvedValue(manyPPs);

      const result = await executeSearchPainPoints({ query: '', limit: 4 });

      const data = result.data as { count: number };
      expect(data.count).toBe(4);
    });

    it('should handle service errors', async () => {
      mockGetPainPoints.mockRejectedValue(new Error('DB query failed'));

      const result = await executeSearchPainPoints({ query: 'legacy' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('DB query failed');
    });

    it('should include correct result fields', async () => {
      mockGetPainPoints.mockResolvedValue([mockPainPoint]);

      const result = await executeSearchPainPoints({ query: 'legacy' });

      const data = result.data as { results: Record<string, unknown>[] };
      expect(data.results[0]).toMatchObject({
        id: 'pp-1',
        title: 'Legacy System Integration Bottleneck',
        severity: 'high',
        status: 'validated',
        category: 'technical',
        estimatedImpact: 250000,
      });
    });
  });

  describe('executeGetPainPointDetails', () => {
    it('should return pain point details for valid id', async () => {
      mockGetPainPointById.mockResolvedValue(mockPainPoint);

      const result = await executeGetPainPointDetails({ id: 'pp-1' });

      expect(result.success).toBe(true);
      const data = result.data as { id: string; _type: string };
      expect(data.id).toBe('pp-1');
      expect(data._type).toBe('painPoint');
    });

    it('should return error when pain point not found', async () => {
      mockGetPainPointById.mockResolvedValue(null);

      const result = await executeGetPainPointDetails({ id: 'nonexistent' });

      expect(result.success).toBe(false);
      expect(result.error).toContain("'nonexistent' not found");
    });

    it('should handle service errors', async () => {
      mockGetPainPointById.mockRejectedValue(new Error('Query failed'));

      const result = await executeGetPainPointDetails({ id: 'pp-1' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Query failed');
    });
  });

  describe('executeCreatePainPoint', () => {
    it('should create a pain point with all fields', async () => {
      mockCreatePainPoint.mockResolvedValue({ id: 'pp-new', title: 'New Pain Point' });

      const result = await executeCreatePainPoint({
        title: 'New Pain Point',
        description: 'Detailed description of the problem',
        severity: 'high',
        category: 'technical',
        status: 'validated',
        affectedOrgUnitIds: ['org-1', 'org-2'],
        estimatedImpact: 100000,
        impactDescription: '10 hours/week lost',
        rootCauses: ['Root cause 1', 'Root cause 2'],
        linkedPrototypeIds: ['proto-1'],
        tags: ['automation', 'efficiency'],
      });

      expect(result.success).toBe(true);
      const data = result.data as { id: string; title: string };
      expect(data.id).toBe('pp-new');
      expect(data.title).toBe('New Pain Point');
      expect(mockCreatePainPoint).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'New Pain Point',
          severity: 'high',
          category: 'technical',
          status: 'validated',
          affectedOrgUnitIds: ['org-1', 'org-2'],
          estimatedImpact: 100000,
          rootCauses: ['Root cause 1', 'Root cause 2'],
        })
      );
      expect(mockEmitDataRefresh).toHaveBeenCalledWith('painPoints', 'ai-assistant');
    });

    it('should use defaults for optional fields', async () => {
      mockCreatePainPoint.mockResolvedValue({ id: 'pp-2', title: 'Minimal Pain Point' });

      await executeCreatePainPoint({
        title: 'Minimal Pain Point',
        description: 'desc',
        severity: 'medium',
        category: 'other',
      });

      expect(mockCreatePainPoint).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'identified',
          affectedOrgUnitIds: [],
          rootCauses: [],
          linkedPrototypeIds: [],
          linkedTechnologyIds: [],
          linkedInitiativeIds: [],
          tags: [],
        })
      );
    });

    it('should handle service errors', async () => {
      mockCreatePainPoint.mockRejectedValue(new Error('PainPoint creation failed'));

      const result = await executeCreatePainPoint({
        title: 'Test',
        description: 'desc',
        severity: 'high',
        category: 'technical',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('PainPoint creation failed');
    });
  });

  describe('executeUpdatePainPoint', () => {
    it('should require confirmation', async () => {
      const result = await executeUpdatePainPoint({
        id: 'pp-1',
        updates: { status: 'resolved' },
        confirmed: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('requires user confirmation');
      expect(result.data).toEqual({ pendingUpdate: { id: 'pp-1', updates: { status: 'resolved' } } });
    });

    it('should update pain point when confirmed', async () => {
      mockUpdatePainPoint.mockResolvedValue(undefined);

      const result = await executeUpdatePainPoint({
        id: 'pp-1',
        updates: { status: 'resolved', severity: 'low' },
        confirmed: true,
      });

      expect(result.success).toBe(true);
      const data = result.data as { message: string };
      expect(data.message).toContain('updated successfully');
      expect(mockUpdatePainPoint).toHaveBeenCalledWith('pp-1', { status: 'resolved', severity: 'low' });
      expect(mockEmitDataRefresh).toHaveBeenCalledWith('painPoints', 'ai-assistant');
    });

    it('should handle service errors when updating', async () => {
      mockUpdatePainPoint.mockRejectedValue(new Error('Update failed'));

      const result = await executeUpdatePainPoint({
        id: 'pp-1',
        updates: { status: 'resolved' },
        confirmed: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Update failed');
    });
  });

  describe('executeDeletePainPoint', () => {
    it('should require confirmation', async () => {
      const result = await executeDeletePainPoint({
        id: 'pp-1',
        confirmed: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('requires confirmation');
      expect(result.error).toContain('pp-1');
    });

    it('should delete pain point when confirmed', async () => {
      mockDeletePainPoint.mockResolvedValue(undefined);

      const result = await executeDeletePainPoint({
        id: 'pp-1',
        confirmed: true,
      });

      expect(result.success).toBe(true);
      const data = result.data as { message: string; mutatedEntityTypes: string[] };
      expect(data.message).toContain('Successfully deleted pain point');
      expect(data.message).toContain('pp-1');
      expect(data.mutatedEntityTypes).toEqual([
        'painPoint',
        'relation',
        'document',
        'entityDocumentLink',
        'initiative',
      ]);
      expect(mockDeletePainPoint).toHaveBeenCalledWith('pp-1');
      expect(mockEmitDataRefresh).toHaveBeenCalledWith('painPoints', 'ai-assistant');
    });

    it('should handle service errors', async () => {
      mockDeletePainPoint.mockRejectedValue(new Error('Delete failed'));

      const result = await executeDeletePainPoint({
        id: 'pp-1',
        confirmed: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Delete failed');
      expect(result.data).toMatchObject({
        mutatedEntityTypes: ['painPoint', 'relation', 'document', 'entityDocumentLink', 'initiative'],
      });
    });
  });

  // ==========================================================================
  // Cross-Entity Functions
  // ==========================================================================

  describe('executeListInitiativesByOrgUnit', () => {
    it('should list all initiatives owned by an org unit', async () => {
      mockGetInitiatives.mockResolvedValue([
        mockInitiative, // ownerOrgUnitId: 'org-1'
        { ...mockInitiative, id: 'init-2', name: 'Other Init', ownerOrgUnitId: 'org-99' },
      ]);

      const result = await executeListInitiativesByOrgUnit({ orgUnitId: 'org-1' });

      expect(result.success).toBe(true);
      const data = result.data as { orgUnitId: string; count: number; initiatives: unknown[] };
      expect(data.orgUnitId).toBe('org-1');
      expect(data.count).toBe(1);
      expect(data.initiatives).toHaveLength(1);
    });

    it('should filter by status when provided', async () => {
      mockGetInitiatives.mockResolvedValue([
        mockInitiative, // status: active
        { ...mockInitiative, id: 'init-2', name: 'Proposed Init', ownerOrgUnitId: 'org-1', status: 'proposed' },
      ]);

      const result = await executeListInitiativesByOrgUnit({ orgUnitId: 'org-1', status: 'active' });

      const data = result.data as { count: number };
      expect(data.count).toBe(1);
    });

    it('should return empty list when org unit has no initiatives', async () => {
      mockGetInitiatives.mockResolvedValue([{ ...mockInitiative, ownerOrgUnitId: 'org-99' }]);

      const result = await executeListInitiativesByOrgUnit({ orgUnitId: 'org-1' });

      const data = result.data as { count: number };
      expect(data.count).toBe(0);
    });

    it('should include correct fields in results', async () => {
      mockGetInitiatives.mockResolvedValue([mockInitiative]);

      const result = await executeListInitiativesByOrgUnit({ orgUnitId: 'org-1' });

      const data = result.data as { initiatives: Record<string, unknown>[] };
      expect(data.initiatives[0]).toMatchObject({
        id: 'init-1',
        name: 'Cloud Migration Program',
        status: 'active',
        priority: 'high',
        budget: 2500000,
      });
    });

    it('should handle service errors', async () => {
      mockGetInitiatives.mockRejectedValue(new Error('Query failed'));

      const result = await executeListInitiativesByOrgUnit({ orgUnitId: 'org-1' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Query failed');
    });
  });

  describe('executeListPainPointsByOrgUnit', () => {
    it('should list all pain points affecting an org unit', async () => {
      mockGetPainPoints.mockResolvedValue([
        mockPainPoint, // affectedOrgUnitIds: ['org-1', 'org-2']
        { ...mockPainPoint, id: 'pp-2', title: 'Unrelated Pain', affectedOrgUnitIds: ['org-99'] },
      ]);

      const result = await executeListPainPointsByOrgUnit({ orgUnitId: 'org-1' });

      expect(result.success).toBe(true);
      const data = result.data as { orgUnitId: string; count: number; painPoints: unknown[] };
      expect(data.orgUnitId).toBe('org-1');
      expect(data.count).toBe(1);
      expect(data.painPoints).toHaveLength(1);
    });

    it('should filter by severity when provided', async () => {
      mockGetPainPoints.mockResolvedValue([
        mockPainPoint, // severity: high
        { ...mockPainPoint, id: 'pp-2', title: 'Low Pain', severity: 'low', affectedOrgUnitIds: ['org-1'] },
      ]);

      const result = await executeListPainPointsByOrgUnit({ orgUnitId: 'org-1', severity: 'high' });

      const data = result.data as { count: number };
      expect(data.count).toBe(1);
    });

    it('should return empty list when org unit has no pain points', async () => {
      mockGetPainPoints.mockResolvedValue([{ ...mockPainPoint, affectedOrgUnitIds: ['org-99'] }]);

      const result = await executeListPainPointsByOrgUnit({ orgUnitId: 'org-1' });

      const data = result.data as { count: number };
      expect(data.count).toBe(0);
    });

    it('should include correct fields in results', async () => {
      mockGetPainPoints.mockResolvedValue([mockPainPoint]);

      const result = await executeListPainPointsByOrgUnit({ orgUnitId: 'org-1' });

      const data = result.data as { painPoints: Record<string, unknown>[] };
      expect(data.painPoints[0]).toMatchObject({
        id: 'pp-1',
        title: 'Legacy System Integration Bottleneck',
        severity: 'high',
        status: 'validated',
        category: 'technical',
      });
    });

    it('should work when affected org-2 is queried', async () => {
      mockGetPainPoints.mockResolvedValue([mockPainPoint]); // affectedOrgUnitIds: ['org-1', 'org-2']

      const result = await executeListPainPointsByOrgUnit({ orgUnitId: 'org-2' });

      const data = result.data as { count: number };
      expect(data.count).toBe(1);
    });

    it('should handle service errors', async () => {
      mockGetPainPoints.mockRejectedValue(new Error('DB error'));

      const result = await executeListPainPointsByOrgUnit({ orgUnitId: 'org-1' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('DB error');
    });
  });

  // ==========================================================================
  // Bug 5: DuplicateEntityError handling
  // ==========================================================================

  describe('DuplicateEntityError handling', () => {
    const { DuplicateEntityError } = jest.requireActual(
      '@/lib/entity-factory-shared'
    ) as typeof import('@/lib/entity-factory-shared');

    it('should return success with alreadyExists for duplicate OrgUnit', async () => {
      mockCreateOrgUnit.mockRejectedValue(
        new DuplicateEntityError('orgUnits', 'name', 'Engineering', 'org-existing-1')
      );

      const result = await executeCreateOrgUnit({
        name: 'Engineering',
        description: 'Engineering dept',
        type: 'department',
      });

      expect(result.success).toBe(true);
      const data = result.data as { alreadyExists: boolean; existingId: string; message: string };
      expect(data.alreadyExists).toBe(true);
      expect(data.existingId).toBe('org-existing-1');
      expect(data.message).toContain('Already exists');
    });

    it('should return success with alreadyExists for duplicate Initiative', async () => {
      mockCreateInitiative.mockRejectedValue(
        new DuplicateEntityError('initiatives', 'name', 'Cloud Migration', 'init-existing-1')
      );

      const result = await executeCreateInitiative({
        name: 'Cloud Migration',
        description: 'Migrate to cloud',
        ownerOrgUnitId: 'org-1',
      });

      expect(result.success).toBe(true);
      const data = result.data as { alreadyExists: boolean; existingId: string };
      expect(data.alreadyExists).toBe(true);
      expect(data.existingId).toBe('init-existing-1');
    });

    it('should return success with alreadyExists for duplicate PainPoint', async () => {
      mockCreatePainPoint.mockRejectedValue(
        new DuplicateEntityError('painPoints', 'title', 'Slow Deployments', 'pp-existing-1')
      );

      const result = await executeCreatePainPoint({
        title: 'Slow Deployments',
        description: 'Deploys take too long',
      });

      expect(result.success).toBe(true);
      const data = result.data as { alreadyExists: boolean; existingId: string };
      expect(data.alreadyExists).toBe(true);
      expect(data.existingId).toBe('pp-existing-1');
    });
  });
});
