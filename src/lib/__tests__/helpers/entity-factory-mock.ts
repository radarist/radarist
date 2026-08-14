/**
 * Shared entity-factory mock utility for unit tests.
 *
 * Provides a reusable mock of `@/lib/entity-factory` that
 * can be used across entity service test files.
 *
 * Usage:
 * ```typescript
 * import { createEntityFactoryMock } from './helpers/entity-factory-mock';
 *
 * const { factory, mockCreateEntity } = createEntityFactoryMock();
 * jest.mock('../entity-factory', () => factory);
 * ```
 */

let entityCounter = 0;

export function createEntityFactoryMock() {
  const mockCreateEntity = jest.fn().mockImplementation(
    async (_type: string, data: Record<string, unknown>) => {
      entityCounter++;
      return {
        entity: { ...data, id: `entity-${entityCounter}` },
        isNew: true,
      };
    }
  );

  return {
    mockCreateEntity,
    factory: {
      __esModule: true,
      createEntity: mockCreateEntity,
      DuplicateEntityError: class DuplicateEntityError extends Error {
        public readonly entityType: string;
        public readonly field: string;
        public readonly value: string;
        public readonly existingId: string;
        constructor(entityType: string, field: string, value: string, existingId: string) {
          super(`${entityType} with ${field} "${value}" already exists (ID: ${existingId})`);
          this.name = 'DuplicateEntityError';
          this.entityType = entityType;
          this.field = field;
          this.value = value;
          this.existingId = existingId;
        }
      },
      generateSlug: jest.fn((name: string) =>
        name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
      ),
    },
    resetCounter: () => { entityCounter = 0; },
  };
}

/**
 * Creates a mock for `@/lib/inngest/functions/sync-entity-to-neo4j`.
 */
export function createSyncEntityMock() {
  return {
    triggerUnifiedEntitySync: jest.fn().mockResolvedValue(undefined),
    syncUnifiedEntityToNeo4jJob: jest.fn(),
  };
}
