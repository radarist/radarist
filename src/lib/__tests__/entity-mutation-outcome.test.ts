/**
 * @jest-environment node
 */

import { EntitySyncDispatchError } from '@/lib/entity-sync';
import { resolveEntityMutationOutcome } from '@/lib/entity-mutation-outcome';

type FixtureEntity = { id: string; name: string; revision: number };

describe('resolveEntityMutationOutcome', () => {
  const committed: FixtureEntity = { id: 'company-1', name: 'Committed name', revision: 2 };

  it('reports an acknowledged committed write without an extra authoritative read', async () => {
    const readAuthoritative = jest.fn();

    await expect(
      resolveEntityMutationOutcome({
        entityType: 'company',
        operation: 'update',
        mutate: async () => committed,
        readAuthoritative,
      })
    ).resolves.toEqual({
      status: 'saved-and-queued',
      entityType: 'company',
      entityId: 'company-1',
      operation: 'update',
      entity: committed,
    });
    expect(readAuthoritative).not.toHaveBeenCalled();
  });

  it('re-reads Firestore after a post-commit handoff failure and returns committed truth', async () => {
    const dispatchError = new EntitySyncDispatchError('company', 'company-1', 'update', new Error('route timed out'));
    const readAuthoritative = jest.fn().mockResolvedValue(committed);

    await expect(
      resolveEntityMutationOutcome({
        entityType: 'company',
        operation: 'update',
        mutate: async () => {
          throw dispatchError;
        },
        readAuthoritative,
      })
    ).resolves.toEqual({
      status: 'saved-locally',
      entityType: 'company',
      entityId: 'company-1',
      operation: 'update',
      entity: committed,
      graphSyncError: dispatchError,
    });
    expect(readAuthoritative).toHaveBeenCalledWith('company-1');
  });

  it('classifies a pre-commit write rejection without pretending anything was saved', async () => {
    const writeError = new Error('permission denied');
    const readAuthoritative = jest.fn();

    await expect(
      resolveEntityMutationOutcome({
        entityType: 'company',
        operation: 'create',
        mutate: async () => {
          throw writeError;
        },
        readAuthoritative,
      })
    ).resolves.toEqual({
      status: 'rejected',
      entityType: 'company',
      operation: 'create',
      error: writeError,
    });
    expect(readAuthoritative).not.toHaveBeenCalled();
  });

  it('rejects a mismatched update identity without reading or retrying another entity', async () => {
    const dispatchError = new EntitySyncDispatchError(
      'company',
      'company-other',
      'update',
      new Error('mismatched handoff')
    );
    const readAuthoritative = jest.fn();

    await expect(
      resolveEntityMutationOutcome({
        entityType: 'company',
        operation: 'update',
        expectedEntityId: 'company-1',
        mutate: async () => {
          throw dispatchError;
        },
        readAuthoritative,
      })
    ).resolves.toEqual({
      status: 'rejected',
      entityType: 'company',
      operation: 'update',
      error: dispatchError,
    });
    expect(readAuthoritative).not.toHaveBeenCalled();
  });

  it('fails honestly when committed state cannot be verified after an ambiguous handoff', async () => {
    const dispatchError = new EntitySyncDispatchError('company', 'company-1', 'create', new Error('route unavailable'));

    await expect(
      resolveEntityMutationOutcome({
        entityType: 'company',
        operation: 'create',
        mutate: async () => {
          throw dispatchError;
        },
        readAuthoritative: jest.fn().mockResolvedValue(null),
      })
    ).rejects.toThrow('could not be verified');
  });

  it('never converts delete failures into optimistic committed outcomes', async () => {
    const dispatchError = new EntitySyncDispatchError('company', 'company-1', 'delete', new Error('queue unavailable'));

    await expect(
      resolveEntityMutationOutcome({
        entityType: 'company',
        operation: 'delete',
        mutate: async () => {
          throw dispatchError;
        },
        readAuthoritative: jest.fn().mockResolvedValue(committed),
      })
    ).resolves.toEqual({
      status: 'rejected',
      entityType: 'company',
      operation: 'delete',
      error: dispatchError,
    });
  });
});
