/**
 * Unit Tests for CompanyCompetitors Logic
 *
 * Tests the business logic for competitor management:
 * - Filtering competitor relations
 * - Search filtering logic
 * - Competitor identification from relations
 *
 * Note: Component rendering tests require more sophisticated setup
 * for ESM modules and React Testing Library. This file focuses on
 * the pure business logic.
 *
 * @jest-environment node
 */

import { describe, it, expect } from '@jest/globals';
import type { Relation, Company, EntitySnapshot } from '@/lib/types';

/**
 * Helper to create a mock company
 */
function createMockCompany(overrides?: Partial<Company>): Company {
  // Phase 4: Updated to use new enum values
  return {
    id: 'company-1',
    name: 'Test Company',
    slug: 'test-company',
    description: 'A test company description',
    website: 'https://test.com',
    type: ['sme'],
    industry: ['technology'],
    size: 'small',
    stage: 'private',
    location: { city: 'San Francisco', country: 'USA' },
    status: 'Watching',
    tags: ['AI', 'ML'],
    socialLinks: {},
    technologyStack: [],
    documents: [],
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now(),
    ...overrides,
  };
}

/**
 * Helper to create a mock entity snapshot
 */
function createMockSnapshot(
  id: string,
  name: string,
  overrides?: Partial<EntitySnapshot>
): EntitySnapshot {
  return {
    type: 'company',
    id,
    name,
    snapshotAt: Date.now(),
    ...overrides,
  };
}

/**
 * Helper to create a mock competitor relation
 */
function createMockRelation(
  sourceId: string,
  targetId: string,
  sourceName: string,
  targetName: string,
  overrides?: Partial<Relation>
): Relation {
  return {
    id: `rel-${sourceId}-${targetId}`,
    relationType: 'competes_with',
    sourceSnapshot: createMockSnapshot(sourceId, sourceName),
    targetSnapshot: createMockSnapshot(targetId, targetName),
    confidence: 100,
    aiSuggested: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('CompanyCompetitors Logic', () => {
  describe('Competitor Relation Filtering', () => {
    /**
     * Filter relations to get only competitor relations
     */
    function filterCompetitorRelations(relations: Relation[]): Relation[] {
      return relations.filter((rel) => rel.relationType === 'competes_with');
    }

    it('should filter only competitor relations', () => {
      const relations: Relation[] = [
        createMockRelation('company-1', 'company-2', 'Company A', 'Company B'),
        createMockRelation('company-1', 'company-3', 'Company A', 'Company C', {
          relationType: 'vendor', // Not a competitor relation
        }),
        createMockRelation('company-1', 'company-4', 'Company A', 'Company D'),
      ];

      const competitors = filterCompetitorRelations(relations);

      expect(competitors).toHaveLength(2);
      expect(competitors.every((r) => r.relationType === 'competes_with')).toBe(true);
    });

    it('should return empty array when no competitor relations exist', () => {
      const relations: Relation[] = [
        createMockRelation('company-1', 'company-2', 'Company A', 'Company B', {
          relationType: 'vendor',
        }),
        createMockRelation('company-1', 'company-3', 'Company A', 'Company C', {
          relationType: 'partner',
        }),
      ];

      const competitors = filterCompetitorRelations(relations);

      expect(competitors).toHaveLength(0);
    });

    it('should handle empty relations array', () => {
      const competitors = filterCompetitorRelations([]);

      expect(competitors).toHaveLength(0);
    });
  });

  describe('Competitor Identification', () => {
    /**
     * Get the competitor ID from a relation based on which side the company is on
     */
    function getCompetitorId(relation: Relation, companyId: string): string {
      const isSource = relation.sourceSnapshot.id === companyId;
      return isSource ? relation.targetSnapshot.id : relation.sourceSnapshot.id;
    }

    /**
     * Get the competitor name from a relation
     */
    function getCompetitorName(relation: Relation, companyId: string): string {
      const isSource = relation.sourceSnapshot.id === companyId;
      return isSource ? relation.targetSnapshot.name : relation.sourceSnapshot.name;
    }

    it('should identify competitor when company is source', () => {
      const relation = createMockRelation('company-1', 'company-2', 'Our Company', 'Competitor Corp');

      const competitorId = getCompetitorId(relation, 'company-1');
      const competitorName = getCompetitorName(relation, 'company-1');

      expect(competitorId).toBe('company-2');
      expect(competitorName).toBe('Competitor Corp');
    });

    it('should identify competitor when company is target', () => {
      const relation = createMockRelation('company-2', 'company-1', 'Competitor Corp', 'Our Company');

      const competitorId = getCompetitorId(relation, 'company-1');
      const competitorName = getCompetitorName(relation, 'company-1');

      expect(competitorId).toBe('company-2');
      expect(competitorName).toBe('Competitor Corp');
    });
  });

  describe('Company Search Filtering', () => {
    /**
     * Filter companies by search query (name or industry)
     */
    function filterCompaniesBySearch(companies: Company[], query: string): Company[] {
      const lowerQuery = query.toLowerCase();
      return companies.filter(
        (c) =>
          c.name.toLowerCase().includes(lowerQuery) ||
          c.industry.some((i) => i.toLowerCase().includes(lowerQuery))
      );
    }

    it('should filter by company name', () => {
      const companies = [
        createMockCompany({ id: 'c1', name: 'Alpha Corp' }),
        createMockCompany({ id: 'c2', name: 'Beta Inc' }),
        createMockCompany({ id: 'c3', name: 'Gamma Ltd' }),
      ];

      const result = filterCompaniesBySearch(companies, 'Alpha');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Alpha Corp');
    });

    it('should filter by industry', () => {
      // Phase 4: Updated to use new CompanyIndustry enum values
      const companies = [
        createMockCompany({ id: 'c1', name: 'Tech Co', industry: ['technology', 'professional'] }),
        createMockCompany({ id: 'c2', name: 'Food Co', industry: ['food_agriculture', 'consumer'] }),
      ];

      const result = filterCompaniesBySearch(companies, 'technology');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Tech Co');
    });

    it('should be case-insensitive', () => {
      const companies = [
        createMockCompany({ id: 'c1', name: 'Alpha Corp' }),
      ];

      const result = filterCompaniesBySearch(companies, 'ALPHA');

      expect(result).toHaveLength(1);
    });

    it('should return all companies when query is empty', () => {
      const companies = [
        createMockCompany({ id: 'c1', name: 'Alpha Corp' }),
        createMockCompany({ id: 'c2', name: 'Beta Inc' }),
      ];

      const result = filterCompaniesBySearch(companies, '');

      expect(result).toHaveLength(2);
    });

    it('should return empty array when no matches', () => {
      const companies = [
        createMockCompany({ id: 'c1', name: 'Alpha Corp' }),
      ];

      const result = filterCompaniesBySearch(companies, 'XYZ');

      expect(result).toHaveLength(0);
    });
  });

  describe('Available Companies Filtering', () => {
    /**
     * Filter out current company and existing competitors from available list
     */
    function filterAvailableCompanies(
      companies: Company[],
      currentCompanyId: string,
      existingCompetitorIds: Set<string>
    ): Company[] {
      return companies.filter(
        (c) => c.id !== currentCompanyId && !existingCompetitorIds.has(c.id)
      );
    }

    it('should exclude current company', () => {
      const companies = [
        createMockCompany({ id: 'company-1', name: 'Current Company' }),
        createMockCompany({ id: 'company-2', name: 'Other Company' }),
      ];

      const available = filterAvailableCompanies(
        companies,
        'company-1',
        new Set()
      );

      expect(available).toHaveLength(1);
      expect(available[0].id).toBe('company-2');
    });

    it('should exclude existing competitors', () => {
      const companies = [
        createMockCompany({ id: 'company-1', name: 'Current Company' }),
        createMockCompany({ id: 'company-2', name: 'Existing Competitor' }),
        createMockCompany({ id: 'company-3', name: 'New Potential' }),
      ];

      const available = filterAvailableCompanies(
        companies,
        'company-1',
        new Set(['company-2'])
      );

      expect(available).toHaveLength(1);
      expect(available[0].id).toBe('company-3');
    });

    it('should return empty array when all filtered out', () => {
      const companies = [
        createMockCompany({ id: 'company-1', name: 'Current Company' }),
      ];

      const available = filterAvailableCompanies(
        companies,
        'company-1',
        new Set()
      );

      expect(available).toHaveLength(0);
    });
  });

  describe('Relation Creation Data', () => {
    /**
     * Create source and target snapshots for a competitor relation
     */
    function createCompetitorRelationData(
      sourceCompany: Company,
      targetCompany: Company
    ): { sourceSnapshot: EntitySnapshot; targetSnapshot: EntitySnapshot } {
      return {
        sourceSnapshot: {
          type: 'company',
          id: sourceCompany.id,
          name: sourceCompany.name,
          snapshotAt: Date.now(),
        },
        targetSnapshot: {
          type: 'company',
          id: targetCompany.id,
          name: targetCompany.name,
          description: targetCompany.description,
          snapshotAt: Date.now(),
        },
      };
    }

    it('should create correct snapshot structure', () => {
      const source = createMockCompany({ id: 'source-1', name: 'Source Co' });
      const target = createMockCompany({ id: 'target-1', name: 'Target Co', description: 'Target description' });

      const { sourceSnapshot, targetSnapshot } = createCompetitorRelationData(source, target);

      expect(sourceSnapshot.type).toBe('company');
      expect(sourceSnapshot.id).toBe('source-1');
      expect(sourceSnapshot.name).toBe('Source Co');
      expect(sourceSnapshot.snapshotAt).toBeDefined();

      expect(targetSnapshot.type).toBe('company');
      expect(targetSnapshot.id).toBe('target-1');
      expect(targetSnapshot.name).toBe('Target Co');
      expect(targetSnapshot.description).toBe('Target description');
      expect(targetSnapshot.snapshotAt).toBeDefined();
    });
  });

  describe('Bidirectional Relation Handling', () => {
    /**
     * Build a set of competitor IDs from relations
     */
    function getCompetitorIdsFromRelations(
      relations: Relation[],
      companyId: string
    ): Set<string> {
      const ids = new Set<string>();
      for (const rel of relations) {
        if (rel.relationType === 'competes_with') {
          const isSource = rel.sourceSnapshot.id === companyId;
          const competitorId = isSource ? rel.targetSnapshot.id : rel.sourceSnapshot.id;
          ids.add(competitorId);
        }
      }
      return ids;
    }

    it('should extract competitor IDs when company is source', () => {
      const relations = [
        createMockRelation('company-1', 'company-2', 'Co A', 'Co B'),
        createMockRelation('company-1', 'company-3', 'Co A', 'Co C'),
      ];

      const competitorIds = getCompetitorIdsFromRelations(relations, 'company-1');

      expect(competitorIds.size).toBe(2);
      expect(competitorIds.has('company-2')).toBe(true);
      expect(competitorIds.has('company-3')).toBe(true);
    });

    it('should extract competitor IDs when company is target', () => {
      const relations = [
        createMockRelation('company-2', 'company-1', 'Co B', 'Co A'),
        createMockRelation('company-3', 'company-1', 'Co C', 'Co A'),
      ];

      const competitorIds = getCompetitorIdsFromRelations(relations, 'company-1');

      expect(competitorIds.size).toBe(2);
      expect(competitorIds.has('company-2')).toBe(true);
      expect(competitorIds.has('company-3')).toBe(true);
    });

    it('should handle mixed source/target relations', () => {
      const relations = [
        createMockRelation('company-1', 'company-2', 'Co A', 'Co B'), // source
        createMockRelation('company-3', 'company-1', 'Co C', 'Co A'), // target
      ];

      const competitorIds = getCompetitorIdsFromRelations(relations, 'company-1');

      expect(competitorIds.size).toBe(2);
      expect(competitorIds.has('company-2')).toBe(true);
      expect(competitorIds.has('company-3')).toBe(true);
    });

    it('should ignore non-competitor relations', () => {
      const relations = [
        createMockRelation('company-1', 'company-2', 'Co A', 'Co B'),
        createMockRelation('company-1', 'company-3', 'Co A', 'Co C', { relationType: 'vendor' }),
      ];

      const competitorIds = getCompetitorIdsFromRelations(relations, 'company-1');

      expect(competitorIds.size).toBe(1);
      expect(competitorIds.has('company-2')).toBe(true);
      expect(competitorIds.has('company-3')).toBe(false);
    });
  });
});
