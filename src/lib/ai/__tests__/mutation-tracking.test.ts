/**
 * Unit Tests for AI Mutation Tracking
 *
 * Tests the centralized mapping for AI tool mutations and cache invalidation.
 * Covers:
 * - Entity query key mapping
 * - Entity refresh type mapping
 * - Tool -> entity type resolution
 * - Mutation tool detection
 * - Entity type validation
 * - Cache invalidation
 * - Refresh type extraction
 * - Mutated type extraction from tool calls
 *
 * @jest-environment jsdom
 */

// Mock @tanstack/react-query
const mockInvalidateQueries = jest.fn();
jest.mock('@tanstack/react-query', () => ({
  QueryClient: jest.fn().mockImplementation(() => ({
    invalidateQueries: mockInvalidateQueries,
  })),
}));

// Mock query keys
jest.mock('@/lib/query-keys', () => ({
  companyKeys: { all: ['companies'] },
  technologyKeys: { all: ['technologies'] },
  useCaseKeys: { all: ['useCases'] },
  prototypeKeys: { all: ['prototypes'] },
  strategyKeys: { all: ['strategies'] },
  signalKeys: { all: ['signals'] },
  relationKeys: { all: ['relations'] },
  orgUnitKeys: { all: ['orgUnits'] },
  initiativeKeys: { all: ['initiatives'] },
  painPointKeys: { all: ['painPoints'] },
  documentKeys: { all: ['documents'] },
  entityDocumentLinkKeys: { all: ['entityDocumentLinks'] },
  radarKeys: { all: ['radar'] },
  radarPlacementKeys: { all: ['radarPlacements'] },
  visualizationKeys: {
    all: ['visualizations'],
    details: () => ['visualizations', 'detail'],
    detail: (id: string) => ['visualizations', 'detail', id],
  },
}));

// Mock data-refresh events
jest.mock('@/lib/events/data-refresh', () => ({
  emitDataRefresh: jest.fn(),
}));

import { QueryClient } from '@tanstack/react-query';

import {
  ENTITY_QUERY_KEYS,
  ENTITY_REFRESH_TYPES,
  DELETION_MUTATED_ENTITY_TYPES,
  TOOL_ENTITY_MAP,
  MUTATION_PREFIXES,
  getToolMutatedTypes,
  isMutationTool,
  isValidEntityType,
  invalidateCaches,
  getRefreshTypes,
  extractMutatedTypes,
  extractMutatedArtifactKeys,
} from '../mutation-tracking';

describe('Mutation Tracking', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ============================================================================
  // ENTITY QUERY KEYS
  // ============================================================================

  describe('ENTITY_QUERY_KEYS', () => {
    it('should have query keys for all entity types', () => {
      const expectedTypes = [
        'company',
        'technology',
        'useCase',
        'prototype',
        'strategy',
        'signal',
        'relation',
        'orgUnit',
        'initiative',
        'painPoint',
        'document',
        'entityDocumentLink',
        'report',
        'radar',
        'radarPlacement',
      ];

      for (const type of expectedTypes) {
        expect(ENTITY_QUERY_KEYS[type as keyof typeof ENTITY_QUERY_KEYS]).toBeDefined();
      }
    });

    it('should map company to companies query key', () => {
      expect(ENTITY_QUERY_KEYS.company).toEqual(['companies']);
    });

    it('should map technology to technologies query key', () => {
      expect(ENTITY_QUERY_KEYS.technology).toEqual(['technologies']);
    });

    it('should map radarPlacement to radarPlacements query key', () => {
      expect(ENTITY_QUERY_KEYS.radarPlacement).toEqual(['radarPlacements']);
    });

    it('should map radar and report to their list query keys', () => {
      expect(ENTITY_QUERY_KEYS.radar).toEqual(['radar']);
      expect(ENTITY_QUERY_KEYS.report).toEqual(['reports']);
    });

    it('maps entity-document links to the cache deleted by entity cascades', () => {
      expect(ENTITY_QUERY_KEYS.entityDocumentLink).toEqual(['entityDocumentLinks']);
    });
  });

  // ============================================================================
  // ENTITY REFRESH TYPES
  // ============================================================================

  describe('ENTITY_REFRESH_TYPES', () => {
    it('should map entity types to plural refresh event types', () => {
      expect(ENTITY_REFRESH_TYPES.company).toBe('companies');
      expect(ENTITY_REFRESH_TYPES.technology).toBe('technologies');
      expect(ENTITY_REFRESH_TYPES.useCase).toBe('useCases');
      expect(ENTITY_REFRESH_TYPES.prototype).toBe('prototypes');
      expect(ENTITY_REFRESH_TYPES.strategy).toBe('strategies');
      expect(ENTITY_REFRESH_TYPES.signal).toBe('signals');
      expect(ENTITY_REFRESH_TYPES.relation).toBe('relations');
      expect(ENTITY_REFRESH_TYPES.orgUnit).toBe('orgUnits');
      expect(ENTITY_REFRESH_TYPES.initiative).toBe('initiatives');
      expect(ENTITY_REFRESH_TYPES.painPoint).toBe('painPoints');
      expect(ENTITY_REFRESH_TYPES.document).toBe('documents');
      expect(ENTITY_REFRESH_TYPES.entityDocumentLink).toBe('documents');
      expect(ENTITY_REFRESH_TYPES.report).toBe('reports');
      expect(ENTITY_REFRESH_TYPES.radar).toBe('radars');
      expect(ENTITY_REFRESH_TYPES.radarPlacement).toBe('radarPlacements');
    });
  });

  // ============================================================================
  // TOOL ENTITY MAP
  // ============================================================================

  describe('TOOL_ENTITY_MAP', () => {
    it('should map company tools to company entity type', () => {
      expect(TOOL_ENTITY_MAP.createCompany).toEqual(['company']);
      expect(TOOL_ENTITY_MAP.updateCompany).toEqual(['company']);
      expect(TOOL_ENTITY_MAP.deleteCompany).toEqual(DELETION_MUTATED_ENTITY_TYPES.company);
      // enrichCompanyFromResearch was removed (AI-043) — no longer a mutation-tracked tool.
      expect(TOOL_ENTITY_MAP.enrichCompanyFromResearch).toBeUndefined();
      expect(TOOL_ENTITY_MAP.researchCompanyComprehensive).toBeUndefined();
      expect(TOOL_ENTITY_MAP.bulkResearchCompanies).toEqual(['company']);
    });

    it('should map technology tools to technology entity type', () => {
      expect(TOOL_ENTITY_MAP.createTechnology).toEqual(['technology']);
      expect(TOOL_ENTITY_MAP.updateTechnology).toEqual(['technology']);
      expect(TOOL_ENTITY_MAP.deleteTechnology).toEqual(DELETION_MUTATED_ENTITY_TYPES.technology);
    });

    it('should map placeTechnologyOnRadar to both radarPlacement and technology', () => {
      expect(TOOL_ENTITY_MAP.placeTechnologyOnRadar).toEqual(['radarPlacement', 'technology']);
      expect(TOOL_ENTITY_MAP.removeTechnologyFromRadar).toEqual(DELETION_MUTATED_ENTITY_TYPES.radarPlacement);
    });

    it('should map radar mutations to all affected caches', () => {
      expect(TOOL_ENTITY_MAP.createRadar).toEqual(['radar']);
      expect(TOOL_ENTITY_MAP.updateRadarSettings).toEqual(['radar', 'radarPlacement', 'technology']);
      expect(TOOL_ENTITY_MAP.deleteRadar).toEqual(DELETION_MUTATED_ENTITY_TYPES.radar);
    });

    it('should map persisted report mutations', () => {
      expect(TOOL_ENTITY_MAP.publishReport).toEqual(['report']);
      expect(TOOL_ENTITY_MAP.updateReport).toEqual(['report']);
      expect(TOOL_ENTITY_MAP.restoreReport).toEqual(['report']);
      expect(TOOL_ENTITY_MAP.deleteReport).toEqual(['report']);
    });

    it('should map signal tools to signal entity type', () => {
      expect(TOOL_ENTITY_MAP.createSignal).toEqual(['signal']);
      expect(TOOL_ENTITY_MAP.approveSignalForImport).toEqual(['signal']);
      expect(TOOL_ENTITY_MAP.bulkApproveSignals).toEqual(['signal']);
    });

    it('should map generic tools to empty arrays', () => {
      expect(TOOL_ENTITY_MAP.updateEntity).toEqual([]);
      expect(TOOL_ENTITY_MAP.deleteEntity).toEqual([]);
      expect(TOOL_ENTITY_MAP.bulkUpdateEntities).toEqual([]);
    });

    it('should map relation tools correctly', () => {
      expect(TOOL_ENTITY_MAP.createRelation).toEqual(['relation']);
      expect(TOOL_ENTITY_MAP.proposeVerifiedRelation).toEqual(['relation']);
      expect(TOOL_ENTITY_MAP.approveProposedRelation).toEqual(['relation']);
      expect(TOOL_ENTITY_MAP.deleteRelation).toEqual(['relation']);
      expect(TOOL_ENTITY_MAP.bulkCreateRelations).toEqual(['relation']);
    });

    it('should map document tools correctly', () => {
      expect(TOOL_ENTITY_MAP.createDocument).toEqual(['document']);
      expect(TOOL_ENTITY_MAP.captureEvidence).toEqual(['document', 'relation']);
    });
  });

  // ============================================================================
  // MUTATION PREFIXES
  // ============================================================================

  describe('MUTATION_PREFIXES', () => {
    it('should contain expected prefixes', () => {
      expect(MUTATION_PREFIXES).toContain('create');
      expect(MUTATION_PREFIXES).toContain('update');
      expect(MUTATION_PREFIXES).toContain('delete');
      expect(MUTATION_PREFIXES).toContain('enrich');
      expect(MUTATION_PREFIXES).toContain('bulk');
      expect(MUTATION_PREFIXES).toContain('approve');
      expect(MUTATION_PREFIXES).toContain('reject');
    });
  });

  // ============================================================================
  // getToolMutatedTypes
  // ============================================================================

  describe('getToolMutatedTypes()', () => {
    it('should return entity types for exact match tool', () => {
      const types = getToolMutatedTypes('createCompany');
      expect(types).toEqual(['company']);
    });

    it('should return multiple types for multi-entity tools', () => {
      const types = getToolMutatedTypes('placeTechnologyOnRadar');
      expect(types).toEqual(['radarPlacement', 'technology']);
    });

    it('should resolve generic tools using args', () => {
      const types = getToolMutatedTypes('updateEntity', { entityType: 'company' });
      expect(types).toEqual(['company']);
    });

    it('should resolve deleteEntity from args', () => {
      const types = getToolMutatedTypes('deleteEntity', { entityType: 'signal' });
      expect(types).toEqual(DELETION_MUTATED_ENTITY_TYPES.signal);
    });

    it('should resolve bulkUpdateEntities from args', () => {
      const types = getToolMutatedTypes('bulkUpdateEntities', { entityType: 'prototype' });
      expect(types).toEqual(['prototype']);
    });

    it('should resolve bulkDeleteEntities from args', () => {
      const types = getToolMutatedTypes('bulkDeleteEntities', { entityType: 'initiative' });
      expect(types).toEqual(DELETION_MUTATED_ENTITY_TYPES.initiative);
    });

    it('should return empty array for unknown tool with no matching prefix', () => {
      const types = getToolMutatedTypes('getCompanyDetails');
      expect(types).toEqual([]);
    });

    it.each(['constructor', 'toString', '__proto__'])('does not resolve inherited object key %s', (toolName) => {
      expect(getToolMutatedTypes(toolName)).toEqual([]);
    });

    it('should return empty array for generic tool without args', () => {
      const types = getToolMutatedTypes('updateEntity');
      expect(types).toEqual([]);
    });

    it('should return empty array for generic tool with invalid entity type', () => {
      const types = getToolMutatedTypes('updateEntity', { entityType: 'invalidType' });
      expect(types).toEqual([]);
    });

    it('should infer entity type from tool name with mutation prefix', () => {
      // Tool not in map but has mutation prefix and entity type in name
      const types = getToolMutatedTypes('createSomethingCompany');
      // 'company' is in the tool name (case-insensitive) + starts with 'create'
      expect(types).toEqual(['company']);
    });

    it('should prefer radarPlacement over the overlapping radar type when inferring', () => {
      expect(getToolMutatedTypes('updateRadarPlacementStatus')).toEqual(['radarPlacement']);
    });

    it('should not infer for non-mutation prefixed tool', () => {
      const types = getToolMutatedTypes('getCompany');
      expect(types).toEqual([]);
    });
  });

  // ============================================================================
  // isMutationTool
  // ============================================================================

  describe('isMutationTool()', () => {
    it('should return true for tools in the map', () => {
      expect(isMutationTool('createCompany')).toBe(true);
      expect(isMutationTool('updateTechnology')).toBe(true);
      expect(isMutationTool('deleteSignal')).toBe(true);
    });

    it('should return true for tools with mutation prefixes', () => {
      expect(isMutationTool('createSomething')).toBe(true);
      expect(isMutationTool('updateCustomEntity')).toBe(true);
      expect(isMutationTool('deleteCustomEntity')).toBe(true);
      expect(isMutationTool('enrichData')).toBe(true);
      expect(isMutationTool('bulkProcess')).toBe(true);
      expect(isMutationTool('approveRequest')).toBe(true);
      expect(isMutationTool('rejectRequest')).toBe(true);
    });

    it('should return false for read-only tools', () => {
      expect(isMutationTool('getCompanyDetails')).toBe(false);
      expect(isMutationTool('listSignals')).toBe(false);
      expect(isMutationTool('searchDocuments')).toBe(false);
      expect(isMutationTool('webSearch')).toBe(false);
    });

    it.each(['constructor', 'toString', '__proto__'])(
      'does not classify inherited object key %s as a mutation',
      (toolName) => {
        expect(isMutationTool(toolName)).toBe(false);
      }
    );

    it('should return true for generic mutation tools in map', () => {
      expect(isMutationTool('updateEntity')).toBe(true);
      expect(isMutationTool('deleteEntity')).toBe(true);
    });
  });

  // ============================================================================
  // isValidEntityType
  // ============================================================================

  describe('isValidEntityType()', () => {
    it('should return true for valid entity types', () => {
      expect(isValidEntityType('company')).toBe(true);
      expect(isValidEntityType('technology')).toBe(true);
      expect(isValidEntityType('useCase')).toBe(true);
      expect(isValidEntityType('prototype')).toBe(true);
      expect(isValidEntityType('strategy')).toBe(true);
      expect(isValidEntityType('signal')).toBe(true);
      expect(isValidEntityType('relation')).toBe(true);
      expect(isValidEntityType('orgUnit')).toBe(true);
      expect(isValidEntityType('initiative')).toBe(true);
      expect(isValidEntityType('painPoint')).toBe(true);
      expect(isValidEntityType('document')).toBe(true);
      expect(isValidEntityType('entityDocumentLink')).toBe(true);
      expect(isValidEntityType('report')).toBe(true);
      expect(isValidEntityType('radar')).toBe(true);
      expect(isValidEntityType('radarPlacement')).toBe(true);
    });

    it('should return false for invalid entity types', () => {
      expect(isValidEntityType('invalid')).toBe(false);
      expect(isValidEntityType('companies')).toBe(false);
      expect(isValidEntityType('')).toBe(false);
      expect(isValidEntityType('user')).toBe(false);
      expect(isValidEntityType('toString')).toBe(false);
      expect(isValidEntityType('__proto__')).toBe(false);
    });
  });

  // ============================================================================
  // invalidateCaches
  // ============================================================================

  describe('invalidateCaches()', () => {
    it('should invalidate caches for given entity types', () => {
      const queryClient = new QueryClient();
      invalidateCaches(queryClient, ['company', 'technology']);

      expect(mockInvalidateQueries).toHaveBeenCalledTimes(2);
      expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['companies'] });
      expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['technologies'] });
    });

    it('should handle single entity type', () => {
      const queryClient = new QueryClient();
      invalidateCaches(queryClient, ['signal']);

      expect(mockInvalidateQueries).toHaveBeenCalledTimes(1);
      expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['signals'] });
    });

    it('should handle empty entity types array', () => {
      const queryClient = new QueryClient();
      invalidateCaches(queryClient, []);

      expect(mockInvalidateQueries).not.toHaveBeenCalled();
    });

    it('should invalidate all known entity types', () => {
      const queryClient = new QueryClient();
      const allTypes = [
        'company',
        'technology',
        'useCase',
        'prototype',
        'strategy',
        'signal',
        'relation',
        'orgUnit',
        'initiative',
        'painPoint',
        'document',
        'entityDocumentLink',
        'report',
        'radar',
        'radarPlacement',
      ] as const;

      invalidateCaches(queryClient, [...allTypes]);

      expect(mockInvalidateQueries).toHaveBeenCalledTimes(15);
      expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['entityDocumentLinks'] });
    });
  });

  // ============================================================================
  // getRefreshTypes
  // ============================================================================

  describe('getRefreshTypes()', () => {
    it('should return refresh types for entity types', () => {
      const types = getRefreshTypes(['company', 'technology']);
      expect(types).toEqual(['companies', 'technologies']);
    });

    it('should handle single entity type', () => {
      const types = getRefreshTypes(['signal']);
      expect(types).toEqual(['signals']);
    });

    it('deduplicates refresh events for documents and their link cache', () => {
      expect(getRefreshTypes(['document', 'entityDocumentLink'])).toEqual(['documents']);
    });

    it('should handle empty array', () => {
      const types = getRefreshTypes([]);
      expect(types).toEqual([]);
    });

    it('should map all entity types correctly', () => {
      const types = getRefreshTypes([
        'company',
        'technology',
        'useCase',
        'prototype',
        'strategy',
        'signal',
        'relation',
        'orgUnit',
        'initiative',
        'painPoint',
        'document',
        'entityDocumentLink',
        'report',
        'radar',
        'radarPlacement',
      ]);
      expect(types).toEqual([
        'companies',
        'technologies',
        'useCases',
        'prototypes',
        'strategies',
        'signals',
        'relations',
        'orgUnits',
        'initiatives',
        'painPoints',
        'documents',
        'reports',
        'radars',
        'radarPlacements',
      ]);
    });
  });

  // ============================================================================
  // extractMutatedTypes
  // ============================================================================

  describe('extractMutatedTypes()', () => {
    it('should extract entity types from successful tool calls', () => {
      const toolCalls = [
        { name: 'createCompany', args: {}, success: true },
        { name: 'createTechnology', args: {}, success: true },
      ];

      const result = extractMutatedTypes(toolCalls);

      expect(result.has('company')).toBe(true);
      expect(result.has('technology')).toBe(true);
      expect(result.size).toBe(2);
    });

    it('should skip failed tool calls', () => {
      const toolCalls = [
        { name: 'createCompany', args: {}, success: true },
        { name: 'createTechnology', args: {}, success: false },
      ];

      const result = extractMutatedTypes(toolCalls);

      expect(result.has('company')).toBe(true);
      expect(result.has('technology')).toBe(false);
      expect(result.size).toBe(1);
    });

    it('should retain valid result-reported mutations from a failed partial cascade', () => {
      const result = extractMutatedTypes([
        {
          name: 'deleteEntity',
          args: { entityType: 'technology' },
          success: false,
          result: {
            success: false,
            data: {
              mutatedEntityTypes: [
                'technology',
                'radarPlacement',
                'relation',
                'document',
                'prototype',
                'useCase',
                'painPoint',
              ],
            },
          },
        },
      ]);

      expect(Array.from(result)).toEqual([
        'technology',
        'radarPlacement',
        'relation',
        'document',
        'prototype',
        'useCase',
        'painPoint',
      ]);
    });

    it('should filter invalid reported mutation types and deduplicate valid values', () => {
      const result = extractMutatedTypes([
        {
          name: 'deleteEntity',
          args: { entityType: 'technology' },
          success: false,
          result: {
            data: {
              mutatedEntityTypes: ['technology', 'technology', 'radars', 'toString', '__proto__', 7, null],
            },
          },
        },
      ]);

      expect(Array.from(result)).toEqual(['technology']);
    });

    it('should merge result-reported mutations with the mapping for a successful call', () => {
      const result = extractMutatedTypes([
        {
          name: 'createCompany',
          args: {},
          success: true,
          result: { data: { mutatedEntityTypes: ['relation', 'document'] } },
        },
      ]);

      expect(Array.from(result)).toEqual(['relation', 'document', 'company']);
    });

    it('should ignore malformed result mutation metadata', () => {
      const result = extractMutatedTypes([
        {
          name: 'deleteEntity',
          args: { entityType: 'technology' },
          success: false,
          result: { data: { mutatedEntityTypes: 'technology' } },
        },
        {
          name: 'deleteEntity',
          args: { entityType: 'signal' },
          success: false,
          result: null,
        },
      ]);

      expect(result.size).toBe(0);
    });

    it('should deduplicate entity types', () => {
      const toolCalls = [
        { name: 'createCompany', args: {}, success: true },
        { name: 'updateCompany', args: {}, success: true },
      ];

      const result = extractMutatedTypes(toolCalls);

      expect(result.has('company')).toBe(true);
      expect(result.size).toBe(1);
    });

    it('should handle empty tool calls array', () => {
      const result = extractMutatedTypes([]);
      expect(result.size).toBe(0);
    });

    it('should handle generic tools with args', () => {
      const toolCalls = [{ name: 'updateEntity', args: { entityType: 'prototype' }, success: true }];

      const result = extractMutatedTypes(toolCalls);

      expect(result.has('prototype')).toBe(true);
    });

    it('should handle multi-entity tools', () => {
      const toolCalls = [{ name: 'placeTechnologyOnRadar', args: {}, success: true }];

      const result = extractMutatedTypes(toolCalls);

      expect(result.has('radarPlacement')).toBe(true);
      expect(result.has('technology')).toBe(true);
      expect(result.size).toBe(2);
    });

    it('should handle all failed tool calls', () => {
      const toolCalls = [
        { name: 'createCompany', args: {}, success: false },
        { name: 'createTechnology', args: {}, success: false },
      ];

      const result = extractMutatedTypes(toolCalls);
      expect(result.size).toBe(0);
    });
  });

  // ============================================================================
  // extractMutatedArtifactKeys — artifacts (visualizations) are NOT graph EntityTypes,
  // so they refresh via a separate seam. This is what makes a saved diagram / generated
  // visualization appear in /infographics without a manual page reload.
  // ============================================================================

  describe('extractMutatedArtifactKeys()', () => {
    it('returns the visualizations key when a successful saveDiagram ran', () => {
      const keys = extractMutatedArtifactKeys([{ name: 'saveDiagram', success: true }]);
      expect(keys).toContainEqual(['visualizations']);
    });

    it('also fires for generateVisualization (same gallery — pre-existing gap)', () => {
      const keys = extractMutatedArtifactKeys([{ name: 'generateVisualization', success: true }]);
      expect(keys).toContainEqual(['visualizations']);
    });

    it('targets the persisted visualization detail key when the identity is reported (AI-011)', () => {
      const keys = extractMutatedArtifactKeys([
        {
          name: 'generateVisualization',
          success: true,
          result: { success: true, data: { visualizationId: 'viz-abc123' } },
        },
      ]);
      expect(keys).toContainEqual(['visualizations']);
      expect(keys).toContainEqual(['visualizations', 'detail', 'viz-abc123']);
    });

    it('does not target a detail key when the result is absent', () => {
      const keys = extractMutatedArtifactKeys([{ name: 'generateVisualization', success: true }]);
      expect(keys).toContainEqual(['visualizations']);
      expect(keys).not.toContainEqual(['visualizations', 'detail', 'viz-abc123']);
    });

    it('does not target a detail key on a persistence failure (no identity)', () => {
      const keys = extractMutatedArtifactKeys([
        {
          name: 'generateVisualization',
          success: false,
          result: { success: false, error: 'save failed' },
        },
      ]);
      expect(keys).toEqual([]);
    });

    it('ignores failed artifact tool calls', () => {
      expect(extractMutatedArtifactKeys([{ name: 'saveDiagram', success: false }])).toEqual([]);
    });

    it('returns [] when no artifact-producing tool ran', () => {
      expect(extractMutatedArtifactKeys([{ name: 'createCompany', success: true }])).toEqual([]);
      expect(extractMutatedArtifactKeys([])).toEqual([]);
    });
  });
});
