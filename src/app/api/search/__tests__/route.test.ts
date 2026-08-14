/**
 * Unit Tests for Search API Route
 *
 * Tests the GET /api/search endpoint for:
 * - Input validation (query parameter required)
 * - Successful search across all entity types
 * - Type-filtered search (single entity type)
 * - Limit parameter handling
 * - Case-insensitive search
 * - Description-based matching
 * - Error handling (service failures)
 * - Technology identity & deduplication — standalone inclusion, multi-radar
 *   dedup, stable canonical id, read-only (UX-030)
 * - Empty results handling
 * - Parallel execution of searches
 *
 * @jest-environment node
 */

import { NextRequest } from 'next/server';

// ============================================================================
// MOCKS - Must be defined before any imports that use them
// ============================================================================

// Mock firebase to break auth import chain
jest.mock('@/lib/firebase', () => ({
  __esModule: true,
  db: {},
  auth: {},
}));

// Mock technologies admin service. UX-030: the route now reads the canonical
// `technologies` collection directly via adminGetTechnologies (singular-tech
// admin twin), NOT the radar-placements join (adminGetTechnologiesWithRadar).
jest.mock('@/lib/technology-admin', () => ({
  __esModule: true,
  adminGetTechnologies: jest.fn(),
}));

// Mock companies admin service (route now uses the admin-SDK twin)
jest.mock('@/lib/companies-admin', () => ({
  __esModule: true,
  adminGetCompanies: jest.fn(),
}));

// Mock use-cases admin service
jest.mock('@/lib/use-cases-admin', () => ({
  __esModule: true,
  adminGetUseCases: jest.fn(),
}));

// Mock prototypes admin service
jest.mock('@/lib/prototypes-admin', () => ({
  __esModule: true,
  adminGetPrototypes: jest.fn(),
}));

// Mock strategies admin service
jest.mock('@/lib/strategies-admin', () => ({
  __esModule: true,
  adminGetStrategies: jest.fn(),
}));

// Mock signals admin service
jest.mock('@/lib/signals-admin', () => ({
  __esModule: true,
  adminGetSignals: jest.fn(),
}));

jest.mock('@/lib/org-units-admin', () => ({
  __esModule: true,
  adminGetOrgUnits: jest.fn(),
}));

jest.mock('@/lib/initiatives-admin', () => ({
  __esModule: true,
  adminGetInitiatives: jest.fn(),
}));

jest.mock('@/lib/pain-points-admin', () => ({
  __esModule: true,
  adminGetPainPoints: jest.fn(),
}));

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

// ============================================================================
// IMPORTS (after mocks)
// ============================================================================

import { adminGetTechnologies } from '@/lib/technology-admin';
import { adminGetCompanies } from '@/lib/companies-admin';
import { adminGetUseCases } from '@/lib/use-cases-admin';
import { adminGetPrototypes } from '@/lib/prototypes-admin';
import { adminGetStrategies } from '@/lib/strategies-admin';
import { adminGetSignals } from '@/lib/signals-admin';
import { adminGetOrgUnits } from '@/lib/org-units-admin';
import { adminGetInitiatives } from '@/lib/initiatives-admin';
import { adminGetPainPoints } from '@/lib/pain-points-admin';
import { GET } from '../route';

// Cast mocks for TypeScript
const mockGetTechnologies = adminGetTechnologies as jest.MockedFunction<typeof adminGetTechnologies>;
const mockGetCompanies = adminGetCompanies as jest.MockedFunction<typeof adminGetCompanies>;
const mockGetUseCases = adminGetUseCases as jest.MockedFunction<typeof adminGetUseCases>;
const mockGetPrototypes = adminGetPrototypes as jest.MockedFunction<typeof adminGetPrototypes>;
const mockGetStrategies = adminGetStrategies as jest.MockedFunction<typeof adminGetStrategies>;
const mockGetSignals = adminGetSignals as jest.MockedFunction<typeof adminGetSignals>;
const mockGetOrgUnits = adminGetOrgUnits as jest.MockedFunction<typeof adminGetOrgUnits>;
const mockGetInitiatives = adminGetInitiatives as jest.MockedFunction<typeof adminGetInitiatives>;
const mockGetPainPoints = adminGetPainPoints as jest.MockedFunction<typeof adminGetPainPoints>;

// ============================================================================
// HELPERS
// ============================================================================

function createSearchRequest(params: Record<string, string>): NextRequest {
  const url = new URL('http://localhost:3000/api/search');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url.toString(), { method: 'GET' });
}

function createMockTechnology(overrides: Record<string, unknown> = {}) {
  // UX-030: Technologies are now read from the canonical `technologies`
  // collection, so the mock mirrors a Technology doc — a single stable `id`
  // (the `tech-…` document key) plus name/description. There is no radarId or
  // placement field on a Technology search result.
  return {
    id: 'tech-001',
    name: 'React',
    slug: 'react',
    description: 'A JavaScript library for building user interfaces',
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'test-user-123',
    ...overrides,
  };
}

function createMockCompany(overrides: Record<string, unknown> = {}) {
  return {
    id: 'company-1',
    name: 'Acme Corp',
    slug: 'acme-corp',
    description: 'A technology company',
    ...overrides,
  };
}

function createMockUseCase(overrides: Record<string, unknown> = {}) {
  return {
    id: 'uc-1',
    title: 'AI-Powered Search',
    slug: 'ai-powered-search',
    description: 'Use AI to improve search results',
    ...overrides,
  };
}

function createMockPrototype(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proto-1',
    name: 'Search Prototype',
    slug: 'search-prototype',
    description: 'A prototype for advanced search',
    ...overrides,
  };
}

function createMockStrategy(overrides: Record<string, unknown> = {}) {
  return {
    id: 'strategy-1',
    name: 'AI Strategy',
    slug: 'ai-strategy',
    description: 'Strategic plan for AI adoption',
    ...overrides,
  };
}

function createMockSignal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'signal-1',
    title: 'AI Market Signal',
    slug: 'ai-market-signal',
    type: 'market',
    description: 'Signal about AI market trends',
    ...overrides,
  };
}

function createMockOrgUnit(overrides: Record<string, unknown> = {}) {
  return {
    id: 'org-unit-1',
    name: 'Research and Development',
    slug: 'research-and-development',
    description: 'Scientific research organization',
    type: 'department',
    level: 2,
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function createMockInitiative(overrides: Record<string, unknown> = {}) {
  return {
    id: 'initiative-1',
    name: 'Quantum Readiness Program',
    slug: 'quantum-readiness-program',
    description: 'Prepare the organization for quantum workflows',
    ownerOrgUnitId: 'org-unit-1',
    status: 'active',
    priority: 'high',
    linkedStrategyIds: [],
    linkedPrototypeIds: [],
    linkedPainPointIds: [],
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function createMockPainPoint(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pain-point-1',
    title: 'Molecule replacement uncertainty',
    slug: 'molecule-replacement-uncertainty',
    description: 'Finding safe replacements is too slow',
    severity: 'high',
    category: 'process',
    affectedOrgUnitIds: [],
    status: 'identified',
    linkedPrototypeIds: [],
    linkedTechnologyIds: [],
    linkedInitiativeIds: [],
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function setupDefaultMocks() {
  mockGetTechnologies.mockResolvedValue([createMockTechnology()] as never[]);
  mockGetCompanies.mockResolvedValue([createMockCompany()] as never[]);
  mockGetUseCases.mockResolvedValue([createMockUseCase()] as never[]);
  mockGetPrototypes.mockResolvedValue([createMockPrototype()] as never[]);
  mockGetStrategies.mockResolvedValue([createMockStrategy()] as never[]);
  mockGetSignals.mockResolvedValue([createMockSignal()] as never[]);
  mockGetOrgUnits.mockResolvedValue([createMockOrgUnit()] as never[]);
  mockGetInitiatives.mockResolvedValue([createMockInitiative()] as never[]);
  mockGetPainPoints.mockResolvedValue([createMockPainPoint()] as never[]);
}

// ============================================================================
// TESTS
// ============================================================================

describe('Search API Route - GET /api/search', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultMocks();
  });

  // --------------------------------------------------------------------------
  // Input Validation
  // --------------------------------------------------------------------------

  describe('Input Validation', () => {
    it('should return 400 when query parameter "q" is missing', async () => {
      const request = createSearchRequest({});

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toContain('"q" is required');
    });

    it('should return 400 when query parameter "q" is empty string', async () => {
      const request = createSearchRequest({ q: '' });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toContain('"q" is required');
    });

    it('should return 400 when query parameter "q" is whitespace only', async () => {
      const request = createSearchRequest({ q: '   ' });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toContain('"q" is required');
    });

    it('should accept a valid query parameter', async () => {
      const request = createSearchRequest({ q: 'react' });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Successful Search - All Types
  // --------------------------------------------------------------------------

  describe('Successful Search - All Types', () => {
    it('should return results from all entity types when no type filter is provided', async () => {
      const request = createSearchRequest({ q: 'a' });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.type).toBe('all');
      // Should have called every entity service exposed by RelationPicker.
      expect(mockGetTechnologies).toHaveBeenCalledTimes(1);
      expect(mockGetCompanies).toHaveBeenCalledTimes(1);
      expect(mockGetUseCases).toHaveBeenCalledTimes(1);
      expect(mockGetPrototypes).toHaveBeenCalledTimes(1);
      expect(mockGetStrategies).toHaveBeenCalledTimes(1);
      expect(mockGetSignals).toHaveBeenCalledTimes(1);
      expect(mockGetOrgUnits).toHaveBeenCalledTimes(1);
      expect(mockGetInitiatives).toHaveBeenCalledTimes(1);
      expect(mockGetPainPoints).toHaveBeenCalledTimes(1);
    });

    it('should return correct result structure with id, name, type, description', async () => {
      const request = createSearchRequest({ q: 'react' });

      const response = await GET(request);
      const data = await response.json();

      expect(data.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: expect.any(String),
            name: expect.any(String),
            type: expect.any(String),
          }),
        ])
      );
    });

    it('should return count matching the data array length', async () => {
      const request = createSearchRequest({ q: 'a' });

      const response = await GET(request);
      const data = await response.json();

      expect(data.count).toBe(data.data.length);
    });

    it('should include the original query in the response', async () => {
      const request = createSearchRequest({ q: 'react' });

      const response = await GET(request);
      const data = await response.json();

      expect(data.query).toBe('react');
    });
  });

  // --------------------------------------------------------------------------
  // Type-Filtered Search
  // --------------------------------------------------------------------------

  describe('Type-Filtered Search', () => {
    it('should search only technologies when type=technology', async () => {
      const request = createSearchRequest({ q: 'react', type: 'technology' });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.type).toBe('technology');
      expect(mockGetTechnologies).toHaveBeenCalledTimes(1);
      expect(mockGetCompanies).not.toHaveBeenCalled();
      expect(mockGetUseCases).not.toHaveBeenCalled();
      expect(mockGetPrototypes).not.toHaveBeenCalled();
      expect(mockGetStrategies).not.toHaveBeenCalled();
      expect(mockGetSignals).not.toHaveBeenCalled();
    });

    it('should search only companies when type=company', async () => {
      const request = createSearchRequest({ q: 'acme', type: 'company' });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.type).toBe('company');
      expect(mockGetCompanies).toHaveBeenCalledTimes(1);
      expect(mockGetTechnologies).not.toHaveBeenCalled();
      expect(mockGetUseCases).not.toHaveBeenCalled();
    });

    it('should search only use cases when type=useCase', async () => {
      const request = createSearchRequest({ q: 'ai', type: 'useCase' });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.type).toBe('useCase');
      expect(mockGetUseCases).toHaveBeenCalledTimes(1);
      expect(mockGetTechnologies).not.toHaveBeenCalled();
      expect(mockGetCompanies).not.toHaveBeenCalled();
    });

    it('should search only prototypes when type=prototype', async () => {
      const request = createSearchRequest({ q: 'search', type: 'prototype' });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.type).toBe('prototype');
      expect(mockGetPrototypes).toHaveBeenCalledTimes(1);
      expect(mockGetTechnologies).not.toHaveBeenCalled();
    });

    it('should search only strategies when type=strategy', async () => {
      const request = createSearchRequest({ q: 'ai', type: 'strategy' });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.type).toBe('strategy');
      expect(mockGetStrategies).toHaveBeenCalledTimes(1);
      expect(mockGetTechnologies).not.toHaveBeenCalled();
    });

    it('should search only signals when type=signal', async () => {
      const request = createSearchRequest({ q: 'market', type: 'signal' });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.type).toBe('signal');
      expect(mockGetSignals).toHaveBeenCalledTimes(1);
      expect(mockGetTechnologies).not.toHaveBeenCalled();
    });

    it.each([
      ['orgUnit', mockGetOrgUnits],
      ['initiative', mockGetInitiatives],
      ['painPoint', mockGetPainPoints],
    ] as const)('should search only %s entities when that type is selected', async (type, expectedReader) => {
      const request = createSearchRequest({ q: 'marker', type });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.type).toBe(type);
      expect(expectedReader).toHaveBeenCalledTimes(1);
      expect(mockGetTechnologies).not.toHaveBeenCalled();
      expect(mockGetCompanies).not.toHaveBeenCalled();
      expect(mockGetUseCases).not.toHaveBeenCalled();
      expect(mockGetPrototypes).not.toHaveBeenCalled();
      expect(mockGetStrategies).not.toHaveBeenCalled();
      expect(mockGetSignals).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Case-Insensitive Search
  // --------------------------------------------------------------------------

  describe('Case-Insensitive Search', () => {
    it('should find companies with case-insensitive name matching', async () => {
      mockGetCompanies.mockResolvedValue([createMockCompany({ id: 'c-1', name: 'Google Cloud' })] as never[]);

      const request = createSearchRequest({ q: 'GOOGLE', type: 'company' });

      const response = await GET(request);
      const data = await response.json();

      expect(data.data).toHaveLength(1);
      expect(data.data[0].name).toBe('Google Cloud');
    });

    it('should find entities with partial name matching', async () => {
      mockGetCompanies.mockResolvedValue([
        createMockCompany({ id: 'c-1', name: 'Google Cloud' }),
        createMockCompany({ id: 'c-2', name: 'Microsoft Azure' }),
      ] as never[]);

      const request = createSearchRequest({ q: 'oo', type: 'company' });

      const response = await GET(request);
      const data = await response.json();

      expect(data.data).toHaveLength(1);
      expect(data.data[0].name).toBe('Google Cloud');
    });
  });

  // --------------------------------------------------------------------------
  // Description-Based Matching
  // --------------------------------------------------------------------------

  describe('Description-Based Matching', () => {
    it('should match companies by description', async () => {
      mockGetCompanies.mockResolvedValue([
        createMockCompany({
          id: 'c-1',
          name: 'Acme Corp',
          description: 'Enterprise cloud computing solutions',
        }),
      ] as never[]);

      const request = createSearchRequest({ q: 'cloud', type: 'company' });

      const response = await GET(request);
      const data = await response.json();

      expect(data.data).toHaveLength(1);
      expect(data.data[0].name).toBe('Acme Corp');
    });

    it('should match use cases by description', async () => {
      mockGetUseCases.mockResolvedValue([
        createMockUseCase({
          id: 'uc-1',
          title: 'Smart Docs',
          description: 'Machine learning for document classification',
        }),
      ] as never[]);

      const request = createSearchRequest({ q: 'machine learning', type: 'useCase' });

      const response = await GET(request);
      const data = await response.json();

      expect(data.data).toHaveLength(1);
      expect(data.data[0].name).toBe('Smart Docs');
    });

    it('should match prototypes by description', async () => {
      mockGetPrototypes.mockResolvedValue([
        createMockPrototype({
          id: 'p-1',
          name: 'Demo App',
          description: 'Natural language processing demo',
        }),
      ] as never[]);

      const request = createSearchRequest({ q: 'natural language', type: 'prototype' });

      const response = await GET(request);
      const data = await response.json();

      expect(data.data).toHaveLength(1);
      expect(data.data[0].name).toBe('Demo App');
    });

    it('should match strategies by description', async () => {
      mockGetStrategies.mockResolvedValue([
        createMockStrategy({
          id: 's-1',
          name: 'Digital First',
          description: 'Blockchain adoption strategy',
        }),
      ] as never[]);

      const request = createSearchRequest({ q: 'blockchain', type: 'strategy' });

      const response = await GET(request);
      const data = await response.json();

      expect(data.data).toHaveLength(1);
      expect(data.data[0].name).toBe('Digital First');
    });

    it('should match signals by description', async () => {
      mockGetSignals.mockResolvedValue([
        createMockSignal({
          id: 'sig-1',
          title: 'New Funding Round',
          description: 'Quantum computing startup raises Series B',
        }),
      ] as never[]);

      const request = createSearchRequest({ q: 'quantum', type: 'signal' });

      const response = await GET(request);
      const data = await response.json();

      expect(data.data).toHaveLength(1);
      expect(data.data[0].name).toBe('New Funding Round');
    });

    it.each([
      ['orgUnit', mockGetOrgUnits, createMockOrgUnit({ name: 'R&D', description: 'Quantum science group' })],
      ['initiative', mockGetInitiatives, createMockInitiative({ name: 'Modernization', description: 'Quantum program' })],
      ['painPoint', mockGetPainPoints, createMockPainPoint({ title: 'Capacity gap', description: 'Quantum skills gap' })],
    ] as const)('should match %s entities by description', async (type, reader, entity) => {
      reader.mockResolvedValue([entity] as never[]);

      const response = await GET(createSearchRequest({ q: 'QUANTUM', type }));
      const data = await response.json();

      expect(data.data).toHaveLength(1);
      expect(data.data[0]).toMatchObject({ id: entity.id, type, description: entity.description });
    });
  });

  // --------------------------------------------------------------------------
  // Limit Parameter
  // --------------------------------------------------------------------------

  describe('Limit Parameter', () => {
    it('should default to limit of 10 when not provided', async () => {
      const manyCompanies = Array.from({ length: 15 }, (_, i) =>
        createMockCompany({ id: `c-${i}`, name: `Company ${i}` })
      );
      mockGetCompanies.mockResolvedValue(manyCompanies as never[]);

      const request = createSearchRequest({ q: 'company', type: 'company' });

      const response = await GET(request);
      const data = await response.json();

      expect(data.data.length).toBeLessThanOrEqual(10);
    });

    it('should respect custom limit parameter', async () => {
      const manyCompanies = Array.from({ length: 15 }, (_, i) =>
        createMockCompany({ id: `c-${i}`, name: `Company ${i}` })
      );
      mockGetCompanies.mockResolvedValue(manyCompanies as never[]);

      const request = createSearchRequest({ q: 'company', type: 'company', limit: '5' });

      const response = await GET(request);
      const data = await response.json();

      expect(data.data.length).toBeLessThanOrEqual(5);
    });

    it('should cap limit at 50 maximum', async () => {
      const manyCompanies = Array.from({ length: 60 }, (_, i) =>
        createMockCompany({ id: `c-${i}`, name: `Company ${i}` })
      );
      mockGetCompanies.mockResolvedValue(manyCompanies as never[]);

      const request = createSearchRequest({ q: 'company', type: 'company', limit: '100' });

      const response = await GET(request);
      const data = await response.json();

      expect(data.data.length).toBeLessThanOrEqual(50);
    });

    it('should handle non-numeric limit gracefully (defaults to NaN -> 10)', async () => {
      const request = createSearchRequest({ q: 'react', type: 'technology', limit: 'abc' });

      const response = await GET(request);

      // parseInt('abc') returns NaN, Math.min(NaN, 50) returns NaN
      // The slice(0, NaN) returns empty, so we just expect 200
      expect(response.status).toBe(200);
    });
  });

  // --------------------------------------------------------------------------
  // Technology identity & deduplication (UX-030)
  //
  // The route previously derived Technology IDs from radar placements, so a
  // standalone Technology (no placement) was invisible and a multi-radar
  // Technology was the only kind that could dedupe. These tests pin the fix:
  // the canonical `technologies` collection is the single source, every
  // Technology is returned on its own stable `tech-…` id exactly once, and the
  // read path never mutates.
  // --------------------------------------------------------------------------

  describe('Technology identity & deduplication (UX-030)', () => {
    it('returns a standalone Technology that has NO radar placement', async () => {
      // The library holds one Technology with no placement anywhere. The old
      // placements-join returned zero results for it.
      mockGetTechnologies.mockResolvedValue([
        createMockTechnology({ id: 'tech-standalone', name: 'Standalone Tech' }),
      ] as never[]);

      const response = await GET(createSearchRequest({ q: 'standalone', type: 'technology' }));
      const data = await response.json();

      expect(data.data).toHaveLength(1);
      expect(data.data[0]).toMatchObject({ id: 'tech-standalone', name: 'Standalone Tech', type: 'technology' });
    });

    it('returns a multi-radar Technology exactly once on its canonical id (no composite radarId:id)', async () => {
      // The same Technology doc — one canonical `tech-…` id — is placed on
      // several radars. Reading the collection returns the doc once; the route
      // must not re-introduce the legacy `radarId:id` composite or duplicate it.
      mockGetTechnologies.mockResolvedValue([
        createMockTechnology({ id: 'tech-multi', name: 'Multi Radar Tech', description: 'shared' }),
      ] as never[]);

      const response = await GET(createSearchRequest({ q: 'multi', type: 'technology' }));
      const data = await response.json();

      const techResults = data.data.filter((r: { type: string }) => r.type === 'technology');
      expect(techResults).toHaveLength(1);
      expect(techResults[0].id).toBe('tech-multi');
      expect(techResults[0].id).not.toMatch(/:/); // no legacy composite id
    });

    it('preserves the stable Technology id across repeated searches (identity does not drift)', async () => {
      const tech = createMockTechnology({ id: 'tech-stable', name: 'Stable Identity Tech' });
      mockGetTechnologies.mockResolvedValue([tech] as never[]);

      const first = await GET(createSearchRequest({ q: 'stable', type: 'technology' }));
      const firstData = await first.json();

      const second = await GET(createSearchRequest({ q: 'stable', type: 'technology' }));
      const secondData = await second.json();

      expect(firstData.data[0].id).toBe('tech-stable');
      expect(secondData.data[0].id).toBe('tech-stable');
    });

    it('does not mutate the underlying Technology documents (read-only search)', async () => {
      mockGetTechnologies.mockResolvedValue([createMockTechnology({ id: 'tech-ro', name: 'Read Only' })] as never[]);

      await GET(createSearchRequest({ q: 'read', type: 'technology' }));

      // The search boundary performs a single read; it must never write.
      expect(mockGetTechnologies).toHaveBeenCalledTimes(1);
      expect(mockGetTechnologies).toHaveBeenCalledWith();
    });

    it('returns Technologies alongside placed and standalone siblings without dropping either', async () => {
      mockGetTechnologies.mockResolvedValue([
        createMockTechnology({ id: 'tech-a', name: 'Alpha Library' }),
        createMockTechnology({ id: 'tech-b', name: 'Beta Library' }),
        createMockTechnology({ id: 'tech-c', name: 'Gamma Library' }),
      ] as never[]);

      const response = await GET(createSearchRequest({ q: 'library', type: 'technology' }));
      const data = await response.json();

      const ids = data.data.map((r: { id: string }) => r.id).sort();
      expect(ids).toEqual(['tech-a', 'tech-b', 'tech-c']);
    });
  });

  // --------------------------------------------------------------------------
  // Technology Search Parameter
  // --------------------------------------------------------------------------

  describe('Technology Search Parameter', () => {
    it('reads the full technology library with no filter argument (filters in-memory)', async () => {
      mockGetTechnologies.mockResolvedValue([createMockTechnology()] as never[]);

      await GET(createSearchRequest({ q: 'React', type: 'technology' }));

      // UX-030: search is now in-memory (mirrors companies), so the reader is
      // called with no arguments — the whole library is the source of truth.
      expect(mockGetTechnologies).toHaveBeenCalledWith();
    });

    it('matches technologies case-insensitively by name', async () => {
      mockGetTechnologies.mockResolvedValue([createMockTechnology({ name: 'TensorFlow' })] as never[]);

      const response = await GET(createSearchRequest({ q: 'TENSOR', type: 'technology' }));
      const data = await response.json();

      expect(data.data).toHaveLength(1);
      expect(data.data[0].name).toBe('TensorFlow');
    });

    it('matches technologies by description', async () => {
      mockGetTechnologies.mockResolvedValue([
        createMockTechnology({ name: 'Rust', description: 'A systems programming language' }),
      ] as never[]);

      const response = await GET(createSearchRequest({ q: 'systems programming', type: 'technology' }));
      const data = await response.json();

      expect(data.data).toHaveLength(1);
      expect(data.data[0].name).toBe('Rust');
    });
  });

  // --------------------------------------------------------------------------
  // Entity Type Mapping
  // --------------------------------------------------------------------------

  describe('Entity Type Mapping', () => {
    it('should map technology results with type "technology"', async () => {
      const request = createSearchRequest({ q: 'react', type: 'technology' });

      const response = await GET(request);
      const data = await response.json();

      expect(data.data[0].type).toBe('technology');
    });

    it('should map company results with type "company"', async () => {
      const request = createSearchRequest({ q: 'acme', type: 'company' });

      const response = await GET(request);
      const data = await response.json();

      expect(data.data[0].type).toBe('company');
    });

    it('should map use case results with type "useCase"', async () => {
      const request = createSearchRequest({ q: 'ai', type: 'useCase' });

      const response = await GET(request);
      const data = await response.json();

      expect(data.data[0].type).toBe('useCase');
    });

    it('should use title field as name for use cases', async () => {
      mockGetUseCases.mockResolvedValue([createMockUseCase({ title: 'My Use Case Title' })] as never[]);

      const request = createSearchRequest({ q: 'my', type: 'useCase' });

      const response = await GET(request);
      const data = await response.json();

      expect(data.data[0].name).toBe('My Use Case Title');
    });

    it('should use "Untitled Use Case" when title is missing', async () => {
      mockGetUseCases.mockResolvedValue([createMockUseCase({ title: undefined })] as never[]);

      // When title is undefined, the filter checks u.title?.toLowerCase().includes(...)
      // which returns undefined (falsy), so description match is needed
      const request = createSearchRequest({ q: 'use ai', type: 'useCase' });

      const response = await GET(request);
      const data = await response.json();

      expect(data.data[0].name).toBe('Untitled Use Case');
    });

    it('should use title field as name for signals', async () => {
      mockGetSignals.mockResolvedValue([createMockSignal({ title: 'Breaking News Signal' })] as never[]);

      const request = createSearchRequest({ q: 'breaking', type: 'signal' });

      const response = await GET(request);
      const data = await response.json();

      expect(data.data[0].name).toBe('Breaking News Signal');
    });

    it.each([
      ['orgUnit', mockGetOrgUnits, createMockOrgUnit({ id: 'ou-marker', name: 'Marker Org Unit' }), 'Marker Org Unit'],
      [
        'initiative',
        mockGetInitiatives,
        createMockInitiative({ id: 'init-marker', name: 'Marker Initiative' }),
        'Marker Initiative',
      ],
      [
        'painPoint',
        mockGetPainPoints,
        createMockPainPoint({ id: 'pain-marker', title: 'Marker Pain Point' }),
        'Marker Pain Point',
      ],
    ] as const)('should map %s results to the RelationPicker entity contract', async (type, reader, entity, name) => {
      reader.mockResolvedValue([entity] as never[]);

      const response = await GET(createSearchRequest({ q: 'marker', type }));
      const data = await response.json();

      expect(data.data).toEqual([
        expect.objectContaining({
          id: entity.id,
          name,
          type,
        }),
      ]);
    });
  });

  // --------------------------------------------------------------------------
  // Empty Results
  // --------------------------------------------------------------------------

  describe('Empty Results', () => {
    it('should return empty array when no entities match the query', async () => {
      mockGetCompanies.mockResolvedValue([] as never[]);
      mockGetTechnologies.mockResolvedValue([] as never[]);
      mockGetUseCases.mockResolvedValue([] as never[]);
      mockGetPrototypes.mockResolvedValue([] as never[]);
      mockGetStrategies.mockResolvedValue([] as never[]);
      mockGetSignals.mockResolvedValue([] as never[]);
      mockGetOrgUnits.mockResolvedValue([] as never[]);
      mockGetInitiatives.mockResolvedValue([] as never[]);
      mockGetPainPoints.mockResolvedValue([] as never[]);

      const request = createSearchRequest({ q: 'zzzznonexistent' });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data).toEqual([]);
      expect(data.count).toBe(0);
    });

    it('should return empty for a type filter when no matching entities exist', async () => {
      mockGetCompanies.mockResolvedValue([] as never[]);

      const request = createSearchRequest({ q: 'nonexistent', type: 'company' });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toEqual([]);
      expect(data.count).toBe(0);
    });

    it('should filter out non-matching entities from a populated list', async () => {
      mockGetCompanies.mockResolvedValue([
        createMockCompany({ id: 'c-1', name: 'Alpha Corp', description: 'desc alpha' }),
        createMockCompany({ id: 'c-2', name: 'Beta Inc', description: 'desc beta' }),
      ] as never[]);

      const request = createSearchRequest({ q: 'alpha', type: 'company' });

      const response = await GET(request);
      const data = await response.json();

      expect(data.data).toHaveLength(1);
      expect(data.data[0].name).toBe('Alpha Corp');
    });
  });

  // --------------------------------------------------------------------------
  // Error Handling
  // --------------------------------------------------------------------------

  describe('Error Handling', () => {
    it('should return 500 when all services throw (error must not masquerade as 0 results)', async () => {
      const error = new Error('Database connection failed');
      mockGetTechnologies.mockRejectedValue(error);
      mockGetCompanies.mockRejectedValue(error);
      mockGetUseCases.mockRejectedValue(error);
      mockGetPrototypes.mockRejectedValue(error);
      mockGetStrategies.mockRejectedValue(error);
      mockGetSignals.mockRejectedValue(error);
      mockGetOrgUnits.mockRejectedValue(error);
      mockGetInitiatives.mockRejectedValue(error);
      mockGetPainPoints.mockRejectedValue(error);

      const request = createSearchRequest({ q: 'test' });

      const response = await GET(request);
      const data = await response.json();

      // Reads now RE-THROW instead of swallowing to []. When every requested
      // search fails the route surfaces a hard 500 so a failure can never look
      // like a successful empty result set.
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Failed to search entities');
      expect(data.failedTypes).toEqual(
        expect.arrayContaining([
          'technology',
          'company',
          'useCase',
          'prototype',
          'strategy',
          'signal',
          'orgUnit',
          'initiative',
          'painPoint',
        ])
      );
    });

    it('should flag partial failure (200) when a single service fails but others succeed', async () => {
      mockGetTechnologies.mockRejectedValue(new Error('Tech service down'));
      // Other services return valid data
      mockGetCompanies.mockResolvedValue([createMockCompany({ id: 'c-1', name: 'Acme Corp' })] as never[]);

      const request = createSearchRequest({ q: 'a' });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      // Partial failure is now explicitly flagged so the gap is not read as "no matches".
      expect(data.partialFailure).toBe(true);
      expect(data.failedTypes).toContain('technology');
      // Should still contain results from working services
      expect(data.data.length).toBeGreaterThan(0);
    });

    it('should return 500 with error details when unexpected error occurs in GET handler', async () => {
      // Force an error in the GET handler itself (not in individual search functions)
      // by making request.url throw
      const badRequest = {
        url: 'invalid-url-that-will-break-new-URL',
      } as unknown as NextRequest;

      const response = await GET(badRequest);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Failed to search entities');
      expect(data.message).toBeDefined();
    });

    it('should include error message in 500 response for Error instances', async () => {
      // Override request URL construction to trigger an error in the try/catch
      const request = new NextRequest('http://localhost:3000/api/search?q=test');
      // Override the URL getter to throw
      jest.spyOn(URL.prototype, 'searchParams', 'get').mockImplementationOnce(() => {
        throw new Error('Specific parse error');
      });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.message).toBe('Specific parse error');
    });
  });

  // --------------------------------------------------------------------------
  // Response Structure
  // --------------------------------------------------------------------------

  describe('Response Structure', () => {
    it('should include success, data, count, query, and type fields', async () => {
      const request = createSearchRequest({ q: 'react' });

      const response = await GET(request);
      const data = await response.json();

      expect(data).toHaveProperty('success');
      expect(data).toHaveProperty('data');
      expect(data).toHaveProperty('count');
      expect(data).toHaveProperty('query');
      expect(data).toHaveProperty('type');
    });

    it('should set type to "all" when no type filter is provided', async () => {
      const request = createSearchRequest({ q: 'test' });

      const response = await GET(request);
      const data = await response.json();

      expect(data.type).toBe('all');
    });

    it('should set type to the filtered type when provided', async () => {
      const request = createSearchRequest({ q: 'test', type: 'company' });

      const response = await GET(request);
      const data = await response.json();

      expect(data.type).toBe('company');
    });

    it('should include description in results when available', async () => {
      mockGetCompanies.mockResolvedValue([
        createMockCompany({
          id: 'c-1',
          name: 'Test Corp',
          description: 'A test company description',
        }),
      ] as never[]);

      const request = createSearchRequest({ q: 'test', type: 'company' });

      const response = await GET(request);
      const data = await response.json();

      expect(data.data[0].description).toBe('A test company description');
    });
  });

  // --------------------------------------------------------------------------
  // Parallel Execution
  // --------------------------------------------------------------------------

  describe('Parallel Execution', () => {
    it('should execute all searches in parallel (not sequentially)', async () => {
      const callOrder: string[] = [];

      mockGetTechnologies.mockImplementation(async () => {
        callOrder.push('tech-start');
        await new Promise((resolve) => setTimeout(resolve, 10));
        callOrder.push('tech-end');
        return [];
      });

      mockGetCompanies.mockImplementation(async () => {
        callOrder.push('company-start');
        await new Promise((resolve) => setTimeout(resolve, 10));
        callOrder.push('company-end');
        return [];
      });

      mockGetUseCases.mockImplementation(async () => {
        callOrder.push('usecase-start');
        return [];
      });

      mockGetPrototypes.mockImplementation(async () => {
        callOrder.push('prototype-start');
        return [];
      });

      mockGetStrategies.mockImplementation(async () => {
        callOrder.push('strategy-start');
        return [];
      });

      mockGetSignals.mockImplementation(async () => {
        callOrder.push('signal-start');
        return [];
      });

      const request = createSearchRequest({ q: 'test' });
      await GET(request);

      // All start calls should happen before any end calls for the delayed ones
      // This verifies Promise.all (parallel) rather than sequential execution
      const techStartIdx = callOrder.indexOf('tech-start');
      const companyStartIdx = callOrder.indexOf('company-start');
      const techEndIdx = callOrder.indexOf('tech-end');

      // Both should start before either ends (parallel execution)
      expect(techStartIdx).toBeLessThan(techEndIdx);
      expect(companyStartIdx).toBeLessThan(techEndIdx);
    });
  });
});
