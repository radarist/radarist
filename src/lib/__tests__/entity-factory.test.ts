/**
 * Unit Tests for Entity Factory
 *
 * Tests the centralized entity creation with uniqueness enforcement:
 * - generateSlug - URL-friendly slug generation
 * - generateEntityId - Unique ID generation
 * - createEntity - Create with uniqueness check
 * - entityExists - Check for existing entity
 * - getOrCreateEntity - Idempotent create/update
 * - validateEntityName - Pre-creation validation
 *
 * @author Radarist Team
 * @created 2026-01-17
 */

// Mock firebase module
jest.mock('../firebase', () => ({
  db: {},
}));

// Mock firebase/firestore module
jest.mock('firebase/firestore', () => ({
  __esModule: true,
  collection: jest.fn(),
  doc: jest.fn(),
  getDocs: jest.fn(),
  getDoc: jest.fn(),
  setDoc: jest.fn(),
  updateDoc: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  limit: jest.fn(),
  runTransaction: jest.fn(),
}));

// Mock inngest client so dynamic imports in entity-factory resolve
const mockInngestSend = jest.fn().mockResolvedValue({ ids: ['mock-id'] });
jest.mock('@/lib/inngest/client', () => ({
  inngest: {
    send: mockInngestSend,
  },
}));
jest.mock('@/lib/inngest/send-client', () => ({
  inngest: { send: mockInngestSend },
}));
jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: jest.fn(),
}));

// Import the module under test (after mocks)
import {
  generateSlug,
  generateEntityId,
  createEntity,
  entityExists,
  getOrCreateEntity,
  validateEntityName,
  getEntityConfig,
  isEntityTypeConfigured,
  getConfiguredEntityTypes,
  DuplicateEntityError,
  EntityConfigError,
  ENTITY_CONFIGS,
} from '../entity-factory';

// Import mocked functions
import { getDocs, runTransaction, collection, doc, query, where, limit } from 'firebase/firestore';

// Type the mocks
const mockGetDocs = getDocs as jest.MockedFunction<typeof getDocs>;
const mockRunTransaction = runTransaction as jest.MockedFunction<typeof runTransaction>;
const mockCollection = collection as jest.MockedFunction<typeof collection>;
const mockDoc = doc as jest.MockedFunction<typeof doc>;
const mockQuery = query as jest.MockedFunction<typeof query>;
const mockWhere = where as jest.MockedFunction<typeof where>;
const mockLimit = limit as jest.MockedFunction<typeof limit>;
const { fetchWithAuth: mockFetchWithAuth } = jest.requireMock('@/lib/fetch-with-auth') as {
  fetchWithAuth: jest.Mock;
};

describe('EntityFactory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Setup default mock returns
    mockCollection.mockReturnValue({} as any);
    mockDoc.mockReturnValue({} as any);
    mockQuery.mockReturnValue({} as any);
    mockWhere.mockReturnValue({} as any);
    mockLimit.mockReturnValue({} as any);
    mockInngestSend.mockResolvedValue({ ids: ['mock-id'] });
    mockFetchWithAuth.mockResolvedValue({ ok: true, status: 202 });
  });

  // ==========================================================================
  // generateSlug Tests
  // ==========================================================================

  describe('generateSlug', () => {
    it('should convert name to lowercase slug', () => {
      expect(generateSlug('AI Flavor Lab')).toBe('ai-flavor-lab');
    });

    it('should handle single word', () => {
      expect(generateSlug('Prototype')).toBe('prototype');
    });

    it('should handle multiple spaces', () => {
      expect(generateSlug('Multiple   Spaces   Here')).toBe('multiple-spaces-here');
    });

    it('should handle leading and trailing spaces', () => {
      expect(generateSlug('  Trimmed  ')).toBe('trimmed');
    });

    it('should remove special characters', () => {
      expect(generateSlug('Test & Demo (v2)')).toBe('test-demo-v2');
    });

    it('should handle brackets and parentheses', () => {
      expect(generateSlug('Project [Alpha] (Beta)')).toBe('project-alpha-beta');
    });

    it('should handle unicode/diacritics', () => {
      expect(generateSlug('Café AI')).toBe('cafe-ai');
      expect(generateSlug('Naïve Bayesian')).toBe('naive-bayesian');
      expect(generateSlug('Résumé Parser')).toBe('resume-parser');
    });

    it('should collapse multiple hyphens', () => {
      expect(generateSlug('Test - - Demo')).toBe('test-demo');
      expect(generateSlug('A---B---C')).toBe('a-b-c');
    });

    it('should trim hyphens from edges', () => {
      expect(generateSlug('-Test-')).toBe('test');
      expect(generateSlug('---Leading')).toBe('leading');
      expect(generateSlug('Trailing---')).toBe('trailing');
    });

    it('should handle numbers', () => {
      expect(generateSlug('Version 2.0')).toBe('version-20');
      expect(generateSlug('AI 3000')).toBe('ai-3000');
    });

    it('should truncate long names to 100 characters', () => {
      const longName = 'a'.repeat(200);
      const slug = generateSlug(longName);
      expect(slug.length).toBeLessThanOrEqual(100);
    });

    it('should handle empty string', () => {
      expect(generateSlug('')).toBe('');
    });

    it('should handle null/undefined gracefully', () => {
      expect(generateSlug(null as any)).toBe('');
      expect(generateSlug(undefined as any)).toBe('');
    });

    it('should handle string with only special characters', () => {
      expect(generateSlug('!@#$%^&*()')).toBe('');
    });

    it('should handle mixed case', () => {
      expect(generateSlug('MixedCASE Test')).toBe('mixedcase-test');
    });

    it('should handle common tech terms', () => {
      expect(generateSlug('Machine Learning')).toBe('machine-learning');
      expect(generateSlug('GraphQL API')).toBe('graphql-api');
      expect(generateSlug('Node.js')).toBe('nodejs');
      expect(generateSlug('C++')).toBe('c');
      expect(generateSlug('React.js Framework')).toBe('reactjs-framework');
    });
  });

  // ==========================================================================
  // generateEntityId Tests
  // ==========================================================================

  describe('generateEntityId', () => {
    it('should generate ID with correct prefix', () => {
      const id = generateEntityId('proto');
      expect(id).toMatch(/^proto-\d+-[a-z0-9]+$/);
    });

    it('should use default prefix if not provided', () => {
      const id = generateEntityId();
      expect(id).toMatch(/^entity-\d+-[a-z0-9]+$/);
    });

    it('should generate unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateEntityId('test'));
      }
      expect(ids.size).toBe(100);
    });

    it('should include timestamp', () => {
      const before = Date.now();
      const id = generateEntityId('test');
      const after = Date.now();

      const timestamp = parseInt(id.split('-')[1], 10);
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });
  });

  // ==========================================================================
  // createEntity Tests
  // ==========================================================================

  describe('createEntity', () => {
    it('should create entity with generated slug and ID', async () => {
      // Mock transaction to execute callback
      mockRunTransaction.mockImplementation(async (db, callback) => {
        const mockTransaction = {
          set: jest.fn(),
          update: jest.fn(),
        };
        return callback(mockTransaction as any);
      });

      // Mock empty result (no existing entity)
      mockGetDocs.mockResolvedValue({
        empty: true,
        docs: [],
      } as any);

      const result = await createEntity('prototype', {
        name: 'Test Prototype',
        description: 'A test prototype',
        status: 'Ideation',
      });

      expect(result.created).toBe(true);
      expect(result.entity.slug).toBe('test-prototype');
      expect(result.entity.name).toBe('Test Prototype');
      expect(result.entity.id).toMatch(/^proto-\d+-[a-z0-9]+$/);
      expect(result.entity.createdAt).toBeDefined();
      expect(result.entity.updatedAt).toBeDefined();
    });

    it('uses one authenticated required handoff after a company commit', async () => {
      mockRunTransaction.mockImplementation(async (_db, callback) => {
        const mockTransaction = { set: jest.fn(), update: jest.fn() };
        return callback(mockTransaction as any);
      });
      mockGetDocs.mockResolvedValue({ empty: true, docs: [] } as any);

      const result = await createEntity('company', { name: 'Required Sync Company' }, { graphSync: 'required' });

      expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
      const request = mockFetchWithAuth.mock.calls[0][1] as RequestInit;
      expect(request.method).toBe('POST');
      expect(JSON.parse(request.body as string)).toEqual({
        entityType: 'company',
        entityId: result.entity.id,
        operation: 'create',
      });
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('should throw DuplicateEntityError for existing entity', async () => {
      mockRunTransaction.mockImplementation(async (db, callback) => {
        const mockTransaction = {
          set: jest.fn(),
          update: jest.fn(),
        };
        return callback(mockTransaction as any);
      });

      // Mock existing entity
      mockGetDocs.mockResolvedValue({
        empty: false,
        docs: [
          {
            id: 'existing-123',
            data: () => ({ name: 'Test Prototype', slug: 'test-prototype' }),
          },
        ],
      } as any);

      await expect(
        createEntity('prototype', {
          name: 'Test Prototype',
          description: 'Duplicate',
        })
      ).rejects.toThrow(DuplicateEntityError);

      try {
        await createEntity('prototype', {
          name: 'Test Prototype',
          description: 'Duplicate',
        });
      } catch (error) {
        expect(error).toBeInstanceOf(DuplicateEntityError);
        expect((error as DuplicateEntityError).entityType).toBe('prototype');
        expect((error as DuplicateEntityError).existingId).toBe('existing-123');
      }
    });

    it('should upsert when option is set', async () => {
      const mockUpdate = jest.fn();
      mockRunTransaction.mockImplementation(async (db, callback) => {
        const mockTransaction = {
          set: jest.fn(),
          update: mockUpdate,
        };
        return callback(mockTransaction as any);
      });

      // Mock existing entity
      mockGetDocs.mockResolvedValue({
        empty: false,
        docs: [
          {
            id: 'existing-123',
            data: () => ({
              name: 'Test Prototype',
              slug: 'test-prototype',
              description: 'Original',
              createdAt: 1000,
            }),
          },
        ],
      } as any);

      const result = await createEntity(
        'prototype',
        {
          name: 'Test Prototype',
          description: 'Updated description',
        },
        { upsert: true }
      );

      expect(result.created).toBe(false);
      expect(result.existingId).toBe('existing-123');
      expect(result.entity.description).toBe('Updated description');
      expect(mockUpdate).toHaveBeenCalled();
    });

    it('should throw EntityConfigError for unknown entity type', async () => {
      await expect(createEntity('unknownType' as any, { name: 'Test' })).rejects.toThrow(EntityConfigError);
    });

    it('should throw EntityConfigError if name/title is missing', async () => {
      await expect(createEntity('prototype', { description: 'No name' } as any)).rejects.toThrow(EntityConfigError);
    });

    it('should use title field for signal entities', async () => {
      mockRunTransaction.mockImplementation(async (db, callback) => {
        const mockTransaction = {
          set: jest.fn(),
          update: jest.fn(),
        };
        return callback(mockTransaction as any);
      });

      mockGetDocs.mockResolvedValue({
        empty: true,
        docs: [],
      } as any);

      const result = await createEntity('signal', {
        title: 'New AI Framework Released',
        source: 'TechCrunch',
      });

      expect(result.entity.slug).toBe('new-ai-framework-released');
    });

    it('should handle scoped uniqueness', async () => {
      mockRunTransaction.mockImplementation(async (db, callback) => {
        const mockTransaction = {
          set: jest.fn(),
          update: jest.fn(),
        };
        return callback(mockTransaction as any);
      });

      mockGetDocs.mockResolvedValue({
        empty: true,
        docs: [],
      } as any);

      await createEntity(
        'radarPlacement',
        {
          name: 'placement',
          technologyId: 'tech-123',
          radarId: 'radar-456',
        },
        { scope: 'radar-456' }
      );

      // Verify where clause included scope
      expect(mockWhere).toHaveBeenCalledWith('radarId', '==', 'radar-456');
    });
  });

  // ==========================================================================
  // entityExists Tests
  // ==========================================================================

  describe('entityExists', () => {
    it('should return false for non-existent entity', async () => {
      mockGetDocs.mockResolvedValue({
        empty: true,
        docs: [],
      } as any);

      const result = await entityExists('prototype', 'Does Not Exist');

      expect(result.exists).toBe(false);
      expect(result.id).toBeUndefined();
      expect(result.slug).toBe('does-not-exist');
    });

    it('should return true with ID for existing entity', async () => {
      mockGetDocs.mockResolvedValue({
        empty: false,
        docs: [{ id: 'existing-123' }],
      } as any);

      const result = await entityExists('prototype', 'Existing Prototype');

      expect(result.exists).toBe(true);
      expect(result.id).toBe('existing-123');
      expect(result.slug).toBe('existing-prototype');
    });

    it('should throw for unknown entity type', async () => {
      await expect(entityExists('unknownType' as any, 'Test')).rejects.toThrow(EntityConfigError);
    });

    it('should return false for empty name', async () => {
      const result = await entityExists('prototype', '');
      expect(result.exists).toBe(false);
    });
  });

  // ==========================================================================
  // getOrCreateEntity Tests
  // ==========================================================================

  describe('getOrCreateEntity', () => {
    it('should create entity if not exists', async () => {
      mockRunTransaction.mockImplementation(async (db, callback) => {
        const mockTransaction = {
          set: jest.fn(),
          update: jest.fn(),
        };
        return callback(mockTransaction as any);
      });

      mockGetDocs.mockResolvedValue({
        empty: true,
        docs: [],
      } as any);

      const result = await getOrCreateEntity('prototype', {
        name: 'New Prototype',
        description: 'Brand new',
      });

      expect(result.created).toBe(true);
    });

    it('should return existing entity if exists', async () => {
      mockRunTransaction.mockImplementation(async (db, callback) => {
        const mockTransaction = {
          set: jest.fn(),
          update: jest.fn(),
        };
        return callback(mockTransaction as any);
      });

      mockGetDocs.mockResolvedValue({
        empty: false,
        docs: [
          {
            id: 'existing-123',
            data: () => ({
              name: 'Existing Prototype',
              slug: 'existing-prototype',
              createdAt: 1000,
            }),
          },
        ],
      } as any);

      const result = await getOrCreateEntity('prototype', {
        name: 'Existing Prototype',
        description: 'Updated',
      });

      expect(result.created).toBe(false);
      expect(result.existingId).toBe('existing-123');
    });
  });

  // ==========================================================================
  // validateEntityName Tests
  // ==========================================================================

  describe('validateEntityName', () => {
    it('should return valid for unique name', async () => {
      mockGetDocs.mockResolvedValue({
        empty: true,
        docs: [],
      } as any);

      const result = await validateEntityName('prototype', 'Unique Name');

      expect(result.valid).toBe(true);
      expect(result.slug).toBe('unique-name');
      expect(result.error).toBeUndefined();
    });

    it('should return invalid for existing name', async () => {
      mockGetDocs.mockResolvedValue({
        empty: false,
        docs: [{ id: 'existing-123' }],
      } as any);

      const result = await validateEntityName('prototype', 'Existing Name');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('already exists');
      expect(result.existingId).toBe('existing-123');
    });

    it('should return invalid for empty name', async () => {
      const result = await validateEntityName('prototype', '');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('alphanumeric');
    });

    it('should return invalid for name with only special chars', async () => {
      const result = await validateEntityName('prototype', '!!!');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('alphanumeric');
    });

    it('should return invalid for very short name', async () => {
      const result = await validateEntityName('prototype', 'A');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('too short');
    });
  });

  // ==========================================================================
  // Configuration Tests
  // ==========================================================================

  describe('Entity Configuration', () => {
    it('should have all required entity types configured', () => {
      const requiredTypes = [
        'prototype',
        'signal',
        'company',
        'useCase',
        'strategy',
        'initiative',
        'painPoint',
        'orgUnit',
        'technology',
        'radarPlacement',
      ];

      for (const type of requiredTypes) {
        expect(ENTITY_CONFIGS[type]).toBeDefined();
        expect(ENTITY_CONFIGS[type].collection).toBeDefined();
        expect(ENTITY_CONFIGS[type].uniqueField).toBeDefined();
        expect(ENTITY_CONFIGS[type].idPrefix).toBeDefined();
        expect(ENTITY_CONFIGS[type].nameField).toBeDefined();
      }
    });

    it('getEntityConfig should return config for valid type', () => {
      const config = getEntityConfig('prototype');
      expect(config).toBeDefined();
      expect(config?.collection).toBe('prototypes');
    });

    it('getEntityConfig should return undefined for invalid type', () => {
      const config = getEntityConfig('invalid');
      expect(config).toBeUndefined();
    });

    it('isEntityTypeConfigured should return true for valid types', () => {
      expect(isEntityTypeConfigured('prototype')).toBe(true);
      expect(isEntityTypeConfigured('company')).toBe(true);
    });

    it('isEntityTypeConfigured should return false for invalid types', () => {
      expect(isEntityTypeConfigured('invalid')).toBe(false);
    });

    it('getConfiguredEntityTypes should return all types', () => {
      const types = getConfiguredEntityTypes();
      expect(types).toContain('prototype');
      expect(types).toContain('company');
      expect(types).toContain('signal');
      expect(types.length).toBeGreaterThanOrEqual(10);
    });
  });

  // ==========================================================================
  // Error Class Tests
  // ==========================================================================

  describe('DuplicateEntityError', () => {
    it('should have correct properties', () => {
      const error = new DuplicateEntityError('prototype', 'slug', 'test-prototype', 'existing-123');

      expect(error.name).toBe('DuplicateEntityError');
      expect(error.entityType).toBe('prototype');
      expect(error.field).toBe('slug');
      expect(error.value).toBe('test-prototype');
      expect(error.existingId).toBe('existing-123');
      expect(error.message).toContain('prototype');
      expect(error.message).toContain('test-prototype');
      expect(error.message).toContain('existing-123');
    });

    it('should be instanceof Error', () => {
      const error = new DuplicateEntityError('test', 'field', 'value', 'id');
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('EntityConfigError', () => {
    it('should have correct properties', () => {
      const error = new EntityConfigError('Test error message');

      expect(error.name).toBe('EntityConfigError');
      expect(error.message).toBe('Test error message');
    });

    it('should be instanceof Error', () => {
      const error = new EntityConfigError('test');
      expect(error).toBeInstanceOf(Error);
    });
  });
});

// ==========================================================================
// Verification Trigger Tests (outside main describe to use module-level mock)
// ==========================================================================

describe('entity-factory verification trigger', () => {
  // GRAPH-048: the client factory must NOT emit
  // 'app/entity.verification.requested' — a browser bundle can never see the
  // non-NEXT_PUBLIC DEFENSE_MINISTER_ENABLED flag, so the old in-factory
  // dispatch was dead code that only ever fired inside Node test processes.
  // Entity-created verification now dispatches server-side from the entity
  // sync workers (sync-entity-to-neo4j / sync-technology-to-neo4j). These
  // tests set the flag in-process to prove the factory stays silent EVEN
  // WHEN it could see the env.
  beforeEach(() => {
    process.env.DEFENSE_MINISTER_ENABLED = 'true';
    // Reset mocks before each test
    mockInngestSend.mockClear();
    mockInngestSend.mockResolvedValue({ ids: ['mock-id'] });

    // Re-apply standard firestore mocks
    const { collection, doc, query, where, limit, runTransaction } = jest.requireMock('firebase/firestore');
    (collection as jest.Mock).mockReturnValue({});
    (doc as jest.Mock).mockReturnValue({});
    (query as jest.Mock).mockReturnValue({});
    (where as jest.Mock).mockReturnValue({});
    (limit as jest.Mock).mockReturnValue({});
    (runTransaction as jest.Mock).mockImplementation(
      async (_db: unknown, callback: (tx: { set: jest.Mock; update: jest.Mock }) => Promise<unknown>) => {
        const mockTransaction = { set: jest.fn(), update: jest.fn() };
        return callback(mockTransaction);
      }
    );
    const { getDocs } = jest.requireMock('firebase/firestore');
    (getDocs as jest.Mock).mockResolvedValue({ empty: true, docs: [] });
  });

  afterEach(() => {
    delete process.env.DEFENSE_MINISTER_ENABLED;
  });

  it('emits no verification event from the client factory even with the flag set in-process (GRAPH-048)', async () => {
    await createEntity('company', { name: 'Acme Verify Test', description: 'test' });

    const verificationCall = mockInngestSend.mock.calls.find(
      ([event]: [{ name: string }]) => event?.name === 'app/entity.verification.requested'
    );
    expect(verificationCall).toBeUndefined();
  });

  it('emits no verification event on the skipUniquenessCheck create path either (GRAPH-048)', async () => {
    await createEntity('company', { name: 'Acme Skip Check Test', description: 'test' }, { skipUniquenessCheck: true });

    const verificationCall = mockInngestSend.mock.calls.find(
      ([event]: [{ name: string }]) => event?.name === 'app/entity.verification.requested'
    );
    expect(verificationCall).toBeUndefined();
  });
});

// ==========================================================================
// Graph Sync Payload Tests (pin the id field per entity type)
// ==========================================================================

describe('entity-factory graph sync payload', () => {
  // The browser factory must hand every library mutation to the authenticated
  // same-origin route. The route owns the server-side event mapping
  // (`technologyId` for technology, `entityId` for unified entities), which is
  // pinned separately by entity-sync.test.ts.
  beforeEach(() => {
    mockInngestSend.mockClear();
    mockInngestSend.mockResolvedValue({ ids: ['mock-id'] });
    mockFetchWithAuth.mockClear();
    mockFetchWithAuth.mockResolvedValue({ ok: true, status: 202 });

    const { collection, doc, query, where, limit, runTransaction, getDocs } = jest.requireMock('firebase/firestore');
    (collection as jest.Mock).mockReturnValue({});
    (doc as jest.Mock).mockReturnValue({});
    (query as jest.Mock).mockReturnValue({});
    (where as jest.Mock).mockReturnValue({});
    (limit as jest.Mock).mockReturnValue({});
    (runTransaction as jest.Mock).mockImplementation(
      async (_db: unknown, callback: (tx: { set: jest.Mock; update: jest.Mock }) => Promise<unknown>) => {
        const mockTransaction = { set: jest.fn(), update: jest.fn() };
        return callback(mockTransaction);
      }
    );
    (getDocs as jest.Mock).mockResolvedValue({ empty: true, docs: [] });
  });

  it('puts a best-effort technology create to the authenticated graph-sync boundary', async () => {
    const result = await createEntity('technology', { name: 'Sync Field Tech', description: 'test' });

    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
    expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/graph/entity-sync', expect.objectContaining({
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entityType: 'technology',
        entityId: result.entity.id,
        operation: 'create',
      }),
      signal: expect.any(AbortSignal),
    }));
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it('puts a best-effort company create to the authenticated graph-sync boundary', async () => {
    const result = await createEntity('company', { name: 'Sync Field Co', description: 'test' });

    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
    expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/graph/entity-sync', expect.objectContaining({
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entityType: 'company',
        entityId: result.entity.id,
        operation: 'create',
      }),
      signal: expect.any(AbortSignal),
    }));
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it('uses the same authenticated boundary on the skipUniquenessCheck path', async () => {
    const result = await createEntity(
      'technology',
      { name: 'Sync Field Tech Skip', description: 'test' },
      { skipUniquenessCheck: true }
    );

    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
    expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/graph/entity-sync', expect.objectContaining({
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entityType: 'technology',
        entityId: result.entity.id,
        operation: 'create',
      }),
      signal: expect.any(AbortSignal),
    }));
    expect(mockInngestSend).not.toHaveBeenCalled();
  });
});
