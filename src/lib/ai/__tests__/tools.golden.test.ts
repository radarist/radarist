/**
 * Golden Tests for AI Function Calling Tools
 *
 * These tests compare AI tool outputs against saved "golden" files
 * to ensure deterministic and consistent behavior.
 *
 * To update golden files when behavior intentionally changes:
 * ```bash
 * UPDATE_GOLDEN=true npm test -- tools.golden
 * ```
 *
 * @jest-environment node
 */

// NOTE: Using native Jest globals instead of @jest/globals to fix mock hoisting

// ============================================================================
// Mocks - Must be BEFORE any imports that use the mocked modules
// ============================================================================

// Mock firebase first
jest.mock('../../firebase', () => ({
  db: {},
}));

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

// Mock decoupled technology-admin module (used via dynamic import in tools.ts:
// `adminGetTechnologies` for searchEntities, `adminGetTechnologyById` for getEntityDetails)
const mockGetDecoupledTechnologies = jest.fn();
const mockGetDecoupledTechById = jest.fn();
jest.mock('@/lib/technology-admin', () => ({
  __esModule: true,
  adminGetTechnologies: (...args: unknown[]) => mockGetDecoupledTechnologies(...args),
  adminGetTechnologyById: (...args: unknown[]) => mockGetDecoupledTechById(...args),
  adminUpdateTechnology: jest.fn(),
}));

// Mock companies-admin module (tools.ts uses adminGetCompanies / adminGetCompanyById)
jest.mock('@/lib/companies-admin', () => ({
  __esModule: true,
  adminGetCompanies: jest.fn(),
  adminGetCompanyById: jest.fn(),
  adminUpdateCompany: jest.fn(),
}));

// Mock use-cases module
jest.mock('../../use-cases', () => ({
  __esModule: true,
  getUseCases: jest.fn(),
  getUseCaseById: jest.fn(),
}));

// Mock prototypes module
jest.mock('../../prototypes', () => ({
  __esModule: true,
  getPrototypes: jest.fn(),
  getPrototypeById: jest.fn(),
}));

// Mock strategies module
jest.mock('../../strategies', () => ({
  __esModule: true,
  getStrategies: jest.fn(),
  getStrategyById: jest.fn(),
}));

// Mock relations module
jest.mock('../../relations', () => ({
  __esModule: true,
  createRelationFromIds: jest.fn(),
}));

// ============================================================================
// Imports (AFTER mocks)
// ============================================================================

import { compareWithGolden, normalizeForGolden, shouldUpdateGolden } from './golden/golden-utils';

import { executeTool } from '../tools';
import { adminGetCompanies, adminGetCompanyById } from '@/lib/companies-admin';
import { getUseCases, getUseCaseById } from '../../use-cases';
import { getPrototypes, getPrototypeById } from '../../prototypes';
import { getStrategies, getStrategyById } from '../../strategies';
import { createRelationFromIds } from '../../relations';

// Cast mocks for type safety
const mockGetCompanies = adminGetCompanies as jest.Mock;
const _mockGetCompanyById = adminGetCompanyById as jest.Mock;
const _mockGetUseCases = getUseCases as jest.Mock;
const _mockGetUseCaseById = getUseCaseById as jest.Mock;
const _mockGetPrototypes = getPrototypes as jest.Mock;
const _mockGetPrototypeById = getPrototypeById as jest.Mock;
const _mockGetStrategies = getStrategies as jest.Mock;
const _mockGetStrategyById = getStrategyById as jest.Mock;
const _mockCreateRelationFromIds = createRelationFromIds as jest.Mock;

// ============================================================================
// Test Data
// ============================================================================

const MOCK_TECHNOLOGIES = [
  {
    id: 'tech-1',
    name: 'React',
    description: 'A JavaScript library for building user interfaces',
    category: 'framework',
    tags: ['frontend', 'javascript'],
    websiteUrl: null,
    linkedCompanies: [],
    linkedUseCases: [],
  },
  {
    id: 'tech-2',
    name: 'React Native',
    description: 'A framework for building native apps with React',
    category: 'framework',
    tags: ['mobile', 'cross-platform'],
    websiteUrl: null,
    linkedCompanies: [],
    linkedUseCases: [],
  },
];

const MOCK_COMPANY = {
  id: 'c1',
  name: 'Acme Corp',
  description: 'Technology solutions provider',
  type: 'vendor',
  industry: ['Technology'],
  status: 'active',
  size: 'medium',
  stage: 'Growth',
};

const MOCK_TECHNOLOGY_DETAIL = {
  id: 'tech-42',
  name: 'React',
  description: 'A declarative, efficient, and flexible JavaScript library for building user interfaces',
  category: 'framework',
  tags: ['frontend', 'javascript', 'ui'],
};

// ============================================================================
// Golden Tests
// ============================================================================

describe('AI Tools - Golden Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (shouldUpdateGolden()) {
      console.log('\n✅ Golden files have been updated.\n');
    }
  });

  describe('searchEntities', () => {
    it('should match golden output for technology search', async () => {
      mockGetDecoupledTechnologies.mockResolvedValueOnce(MOCK_TECHNOLOGIES);

      const result = await executeTool({
        name: 'searchEntities',
        args: { entityType: 'technology', query: 'react' },
      });

      const comparison = compareWithGolden('tools', 'search-entities-technology', result);

      if (!comparison.matches) {
        console.log('Differences:', comparison.diff);
      }

      expect(comparison.matches).toBe(true);
    });

    it('should match golden output for company search', async () => {
      mockGetCompanies.mockResolvedValueOnce([MOCK_COMPANY]);

      const result = await executeTool({
        name: 'searchEntities',
        args: { entityType: 'company', query: 'acme' },
      });

      const comparison = compareWithGolden('tools', 'search-entities-company', result);

      if (!comparison.matches) {
        console.log('Differences:', comparison.diff);
      }

      expect(comparison.matches).toBe(true);
    });

    it('should match golden output for unknown entity type', async () => {
      const result = await executeTool({
        name: 'searchEntities',
        args: { entityType: 'unknown', query: 'test' },
      });

      const comparison = compareWithGolden('tools', 'search-entities-unknown-type', result);

      if (!comparison.matches) {
        console.log('Differences:', comparison.diff);
      }

      expect(comparison.matches).toBe(true);
    });
  });

  describe('getEntityDetails', () => {
    it('should match golden output for technology details', async () => {
      mockGetDecoupledTechById.mockResolvedValueOnce(MOCK_TECHNOLOGY_DETAIL);

      const result = await executeTool({
        name: 'getEntityDetails',
        args: { entityType: 'technology', id: 'tech-42' },
      });

      const comparison = compareWithGolden('tools', 'get-entity-details-technology', result);

      if (!comparison.matches) {
        console.log('Differences:', comparison.diff);
      }

      expect(comparison.matches).toBe(true);
    });
  });
});

// ============================================================================
// Golden Utils Tests
// ============================================================================

describe('Golden Utils', () => {
  describe('normalizeForGolden', () => {
    it('should normalize timestamps', () => {
      const data = {
        name: 'Test',
        createdAt: 1704067200000,
        updatedAt: 1704153600000,
        timestamp: 1704067200000,
      };

      const normalized = normalizeForGolden(data);

      expect(normalized.name).toBe('Test');
      expect(normalized.createdAt).toBe('<TIMESTAMP>');
      expect(normalized.updatedAt).toBe('<TIMESTAMP>');
      expect(normalized.timestamp).toBe('<TIMESTAMP>');
    });

    it('should normalize IDs', () => {
      const data = {
        name: 'Test',
        id: 'abc123456789xyz',
        userId: 'user-12345678901',
        shortId: 'abc',
      };

      const normalized = normalizeForGolden(data);

      expect(normalized.name).toBe('Test');
      expect(normalized.id).toBe('<ID>');
      expect(normalized.userId).toBe('<ID>');
      expect(normalized.shortId).toBe('abc'); // Short IDs preserved
    });

    it('should remove specified fields', () => {
      const data = {
        name: 'Test',
        secret: 'should-be-removed',
        token: 'also-removed',
      };

      const normalized = normalizeForGolden(data, {
        removeFields: ['secret', 'token'],
      });

      expect(normalized.name).toBe('Test');
      expect(normalized).not.toHaveProperty('secret');
      expect(normalized).not.toHaveProperty('token');
    });

    it('should recursively normalize nested objects', () => {
      const data = {
        name: 'Test',
        nested: {
          id: 'nested-id-12345',
          createdAt: 1704067200000,
        },
        items: [
          { id: 'item-1-id-12345', name: 'Item 1' },
          { id: 'item-2-id-12345', name: 'Item 2' },
        ],
      };

      const normalized = normalizeForGolden(data);

      expect(normalized.name).toBe('Test');
      expect(normalized.nested.id).toBe('<ID>');
      expect(normalized.nested.createdAt).toBe('<TIMESTAMP>');
      expect(normalized.items[0].id).toBe('<ID>');
      expect(normalized.items[0].name).toBe('Item 1');
    });
  });
});
