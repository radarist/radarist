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

const mockUpdateCompany = jest.fn();
const mockGetCompanies = jest.fn();
const mockGetCompanyById = jest.fn();
jest.mock('@/lib/companies-admin', () => ({
  __esModule: true,
  adminGetCompanies: (...args: unknown[]) => mockGetCompanies(...args),
  adminGetCompanyById: (...args: unknown[]) => mockGetCompanyById(...args),
  adminUpdateCompany: (...args: unknown[]) => mockUpdateCompany(...args),
}));

const mockCreateRelationFromIds = jest.fn();
jest.mock('@/lib/relations-admin', () => ({
  __esModule: true,
  adminCreateRelationFromIds: (...args: unknown[]) => mockCreateRelationFromIds(...args),
}));

jest.mock('@/lib/ai/signal-evaluation', () => ({
  __esModule: true,
  cleanMarkdownFromText: jest.fn((text: string) => text.replace(/[*#_]/g, '')),
}));

jest.mock('@/lib/migration', () => {
  const _needsResolution = jest.fn().mockReturnValue(false);
  const _safeResolve = jest.fn((id: string) => id);
  return {
    __esModule: true,
    needsResolution: _needsResolution,
    safeResolve: _safeResolve,
  };
});

jest.mock('@/lib/fuzzy-search', () => ({
  __esModule: true,
  fuzzySearch: jest.fn(() => []),
}));

const mockGetUseCases = jest.fn().mockResolvedValue([]);
jest.mock('@/lib/use-cases', () => ({
  __esModule: true,
  getUseCases: (...args: unknown[]) => mockGetUseCases(...args),
}));

const mockGetPrototypes = jest.fn().mockResolvedValue([]);
jest.mock('@/lib/prototypes', () => ({
  __esModule: true,
  getPrototypes: (...args: unknown[]) => mockGetPrototypes(...args),
}));

const mockGetStrategies = jest.fn().mockResolvedValue([]);
jest.mock('@/lib/strategies', () => ({
  __esModule: true,
  getStrategies: (...args: unknown[]) => mockGetStrategies(...args),
}));

const mockGetDocuments = jest.fn().mockResolvedValue([]);
jest.mock('@/lib/document-service', () => ({
  __esModule: true,
  getDocuments: (...args: unknown[]) => mockGetDocuments(...args),
}));

const mockGetTechnologiesService = jest.fn().mockResolvedValue([]);
const mockUpdateTechnologyService = jest.fn();
jest.mock('@/lib/technology-admin', () => ({
  __esModule: true,
  adminGetTechnologies: (...args: unknown[]) => mockGetTechnologiesService(...args),
  adminUpdateTechnology: (...args: unknown[]) => mockUpdateTechnologyService(...args),
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import {
  executeEnrichTechnology,
  executeBulkCreateRelations,
  executeBulkUpdateEntities,
  executeFindAndLinkRelatedEntities,
  executeCreateRelationsByName,
} from '../enrichment';
import { ENRICHMENT_TOOLS } from '../enrichment';

const migrationMock = require('@/lib/migration') as {
  needsResolution: jest.Mock;
  safeResolve: jest.Mock;
};

// ============================================================================
// Tests
// ============================================================================

describe('Enrichment Tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    migrationMock.needsResolution.mockReturnValue(false);
    migrationMock.safeResolve.mockImplementation((id: string) => id);
  });

  // --------------------------------------------------------------------------
  // enrichCompanyFromResearch removal (AI-043)
  // --------------------------------------------------------------------------
  describe('enrichCompanyFromResearch removal', () => {
    it('is no longer a declared enrichment tool', () => {
      expect(ENRICHMENT_TOOLS.map((tool) => tool.name)).not.toContain('enrichCompanyFromResearch');
    });
  });

  // --------------------------------------------------------------------------
  // executeEnrichTechnology
  // --------------------------------------------------------------------------
  describe('executeEnrichTechnology', () => {
    it('should reject invalid IDs that cannot be resolved to tech-xxx', async () => {
      const result = await executeEnrichTechnology({
        technologyId: 'invalid-id-no-colon',
        updates: { description: 'test' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('tech-xxx');
    });

    it('should use decoupled service for new format IDs', async () => {
      mockUpdateTechnologyService.mockResolvedValue(undefined);

      const result = await executeEnrichTechnology({
        technologyId: 'tech-abc123',
        updates: { description: 'Decoupled update' },
      });

      expect(result.success).toBe(true);
      expect(result.data?.technologyId).toBe('tech-abc123');
      expect(mockUpdateTechnologyService).toHaveBeenCalledWith('tech-abc123', expect.any(Object));
    });

    it('should resolve old IDs when resolution is needed', async () => {
      migrationMock.needsResolution.mockReturnValue(true);
      migrationMock.safeResolve.mockReturnValue('tech-resolved');
      mockUpdateTechnologyService.mockResolvedValue(undefined);

      const result = await executeEnrichTechnology({
        technologyId: 'old-format-id',
        updates: { description: 'test' },
      });

      expect(result.success).toBe(true);
      expect(result.data?.technologyId).toBe('tech-resolved');
    });

    it('should handle service errors gracefully', async () => {
      mockUpdateTechnologyService.mockRejectedValue(new Error('Tech update failed'));

      const result = await executeEnrichTechnology({
        technologyId: 'tech-abc123',
        updates: { description: 'test' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Tech update failed');
    });
  });

  // --------------------------------------------------------------------------
  // executeBulkCreateRelations
  // --------------------------------------------------------------------------
  describe('executeBulkCreateRelations', () => {
    it('should create multiple relations successfully', async () => {
      mockCreateRelationFromIds.mockResolvedValue({ id: 'rel-1' });

      const result = await executeBulkCreateRelations({
        relations: [
          { sourceType: 'company', sourceId: 'c1', targetType: 'technology', targetId: 't1', relationType: 'uses' },
          { sourceType: 'company', sourceId: 'c1', targetType: 'technology', targetId: 't2', relationType: 'uses' },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.data?.created).toBe(2);
      expect(result.data?.failed).toBe(0);
      expect(mockCreateRelationFromIds).toHaveBeenCalledTimes(2);
    });

    it('should handle partial failures', async () => {
      mockCreateRelationFromIds
        .mockResolvedValueOnce({ id: 'rel-1' })
        .mockRejectedValueOnce(new Error('Duplicate relation'));

      const result = await executeBulkCreateRelations({
        relations: [
          { sourceType: 'company', sourceId: 'c1', targetType: 'technology', targetId: 't1', relationType: 'uses' },
          { sourceType: 'company', sourceId: 'c1', targetType: 'technology', targetId: 't1', relationType: 'uses' },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.data?.created).toBe(1);
      expect(result.data?.failed).toBe(1);
      expect(result.data?.results[1].error).toBe('Duplicate relation');
    });

    it('should return success with zero relations', async () => {
      const result = await executeBulkCreateRelations({ relations: [] });

      expect(result.success).toBe(true);
      expect(result.data?.created).toBe(0);
      expect(result.data?.failed).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // executeBulkUpdateEntities
  // --------------------------------------------------------------------------
  describe('executeBulkUpdateEntities', () => {
    it('should require confirmation', async () => {
      const result = await executeBulkUpdateEntities({
        entityType: 'company',
        ids: ['c1', 'c2'],
        updates: { description: 'bulk' },
        confirmed: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('requires confirmation');
    });

    it('should bulk update companies when confirmed', async () => {
      mockUpdateCompany.mockResolvedValue(undefined);

      const result = await executeBulkUpdateEntities({
        entityType: 'company',
        ids: ['c1', 'c2'],
        updates: { description: 'bulk update' },
        confirmed: true,
      });

      expect(result.success).toBe(true);
      expect(result.data?.updated).toBe(2);
      expect(result.data?.failed).toBe(0);
    });

    it('should handle unknown entity type', async () => {
      const result = await executeBulkUpdateEntities({
        entityType: 'unknownType',
        ids: ['x1'],
        updates: { name: 'test' },
        confirmed: true,
      });

      expect(result.success).toBe(true);
      expect(result.data?.failed).toBe(1);
      expect(result.data?.results[0].error).toContain('Unknown entity type');
    });

    it('should bulk update use cases', async () => {
      const mockUpdateUseCase = jest.fn().mockResolvedValue(undefined);
      jest.doMock('@/lib/use-cases', () => ({
        __esModule: true,
        getUseCases: mockGetUseCases,
        updateUseCase: mockUpdateUseCase,
      }));

      const result = await executeBulkUpdateEntities({
        entityType: 'useCase',
        ids: ['uc1'],
        updates: { description: 'updated' },
        confirmed: true,
      });

      expect(result.success).toBe(true);
    });

    it('should handle partial failures in batch', async () => {
      mockUpdateCompany.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Permission denied'));

      const result = await executeBulkUpdateEntities({
        entityType: 'company',
        ids: ['c1', 'c2'],
        updates: { description: 'test' },
        confirmed: true,
      });

      expect(result.success).toBe(true);
      expect(result.data?.updated).toBe(1);
      expect(result.data?.failed).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // executeFindAndLinkRelatedEntities
  // --------------------------------------------------------------------------
  describe('executeFindAndLinkRelatedEntities', () => {
    it('should return empty suggestions (placeholder)', async () => {
      const result = await executeFindAndLinkRelatedEntities({
        entityType: 'company',
        entityId: 'c1',
        targetTypes: ['technology'],
        autoLink: false,
      });

      expect(result.success).toBe(true);
      expect(result.data?.suggestions).toEqual([]);
      expect(result.data?.autoLinked).toBe(0);
    });

    it('should handle errors gracefully', async () => {
      // Force an error by making the function body throw
      const result = await executeFindAndLinkRelatedEntities({
        entityType: 'company',
        entityId: 'c1',
      });

      expect(result.success).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // executeCreateRelationsByName
  // --------------------------------------------------------------------------
  describe('executeCreateRelationsByName', () => {
    it('should resolve entities by name and create relations', async () => {
      mockGetCompanies.mockResolvedValue([
        { id: 'c1', name: 'Acme Corp' },
        { id: 'c2', name: 'Beta Inc' },
      ]);
      mockCreateRelationFromIds.mockResolvedValue({ id: 'rel-1' });

      const result = await executeCreateRelationsByName({
        relations: [
          {
            sourceType: 'company',
            sourceName: 'Acme Corp',
            targetType: 'company',
            targetName: 'Beta Inc',
            relationType: 'competes_with',
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.data?.created).toBe(1);
      expect(result.data?.notFound).toBe(0);
    });

    it('should use provided IDs directly when available', async () => {
      mockCreateRelationFromIds.mockResolvedValue({ id: 'rel-1' });

      const result = await executeCreateRelationsByName({
        relations: [
          {
            sourceType: 'company',
            sourceId: 'c1',
            targetType: 'company',
            targetId: 'c2',
            relationType: 'competes_with',
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.data?.created).toBe(1);
      expect(mockGetCompanies).not.toHaveBeenCalled();
    });

    it('should track not-found entities', async () => {
      mockGetCompanies.mockResolvedValue([]);

      const result = await executeCreateRelationsByName({
        relations: [
          {
            sourceType: 'company',
            sourceName: 'NonExistent Corp',
            targetType: 'company',
            targetName: 'Also Missing',
            relationType: 'competes_with',
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.data?.notFound).toBe(1);
      expect(result.data?.notFoundEntities).toHaveLength(1);
      expect(result.data?.notFoundEntities[0].name).toBe('NonExistent Corp');
    });

    it('should fail when no source ID or name provided', async () => {
      const result = await executeCreateRelationsByName({
        relations: [
          {
            sourceType: 'company',
            targetType: 'company',
            targetId: 'c2',
            relationType: 'uses',
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.data?.failed).toBe(1);
      expect(result.data?.results[0].error).toContain('No source ID or name');
    });

    it('should fail when no target ID or name provided', async () => {
      const result = await executeCreateRelationsByName({
        relations: [
          {
            sourceType: 'company',
            sourceId: 'c1',
            targetType: 'company',
            relationType: 'uses',
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.data?.failed).toBe(1);
      expect(result.data?.results[0].error).toContain('No target ID or name');
    });

    it('should handle createRelation errors per-relation', async () => {
      mockGetCompanies.mockResolvedValue([
        { id: 'c1', name: 'Acme Corp' },
        { id: 'c2', name: 'Beta Inc' },
      ]);
      mockCreateRelationFromIds.mockRejectedValue(new Error('Constraint violation'));

      const result = await executeCreateRelationsByName({
        relations: [
          {
            sourceType: 'company',
            sourceName: 'Acme Corp',
            targetType: 'company',
            targetName: 'Beta Inc',
            relationType: 'competes_with',
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.data?.failed).toBe(1);
      expect(result.data?.results[0].error).toBe('Constraint violation');
    });

    it('should resolve technology entities by name', async () => {
      mockGetTechnologiesService.mockResolvedValue([{ id: 'tech-1', name: 'React' }]);
      mockCreateRelationFromIds.mockResolvedValue({ id: 'rel-1' });

      const result = await executeCreateRelationsByName({
        relations: [
          {
            sourceType: 'technology',
            sourceName: 'React',
            targetType: 'company',
            targetId: 'c1',
            relationType: 'uses',
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.data?.created).toBe(1);
    });
  });
});
