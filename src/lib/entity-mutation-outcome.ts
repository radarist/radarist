/**
 * Client-safe truth contract for Firestore mutations followed by required
 * graph delivery. Firestore is authoritative; Neo4j delivery is a separate
 * post-commit outcome and must never rewrite a committed save as a rejection.
 */

import { EntitySyncDispatchError, type EntitySyncOperation, type LibraryEntitySyncType } from '@/lib/entity-sync';

export type EntityMutationOutcome<T extends { id: string }> =
  | {
      status: 'rejected';
      entityType: LibraryEntitySyncType;
      operation: EntitySyncOperation;
      error: Error;
    }
  | {
      status: 'saved-and-queued';
      entityType: LibraryEntitySyncType;
      entityId: string;
      operation: Exclude<EntitySyncOperation, 'delete'>;
      entity: T;
    }
  | {
      status: 'saved-locally';
      entityType: LibraryEntitySyncType;
      entityId: string;
      operation: Exclude<EntitySyncOperation, 'delete'>;
      entity: T;
      graphSyncError: EntitySyncDispatchError;
    };

interface ResolveEntityMutationOutcomeOptions<T extends { id: string }> {
  entityType: LibraryEntitySyncType;
  operation: EntitySyncOperation;
  expectedEntityId?: string;
  mutate: () => Promise<T>;
  readAuthoritative: (entityId: string) => Promise<T | null>;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Run one entity mutation and classify its real persistence boundary.
 *
 * Required create/update handoffs happen after the Firestore commit. When
 * that handoff is unacknowledged, re-read Firestore using the identity carried
 * by the trusted dispatch error. Only a verified document may be presented as
 * saved locally. Deletes deliberately stay on the rejection path because
 * their handoff is a precondition and the parent document must remain intact.
 */
export async function resolveEntityMutationOutcome<T extends { id: string }>(
  options: ResolveEntityMutationOutcomeOptions<T>
): Promise<EntityMutationOutcome<T>> {
  try {
    const entity = await options.mutate();
    if (options.operation === 'delete') {
      throw new Error('Delete mutations are not supported by the post-commit outcome helper');
    }
    return {
      status: 'saved-and-queued',
      entityType: options.entityType,
      entityId: entity.id,
      operation: options.operation,
      entity,
    };
  } catch (error) {
    const normalized = toError(error);
    const isMatchingPostCommitFailure =
      normalized instanceof EntitySyncDispatchError &&
      normalized.operation !== 'delete' &&
      normalized.entityType === options.entityType &&
      normalized.operation === options.operation &&
      (!options.expectedEntityId || normalized.entityId === options.expectedEntityId);

    if (!isMatchingPostCommitFailure) {
      return {
        status: 'rejected',
        entityType: options.entityType,
        operation: options.operation,
        error: normalized,
      };
    }

    const committed = await options.readAuthoritative(normalized.entityId);
    if (!committed || committed.id !== normalized.entityId) {
      throw new Error(
        `The ${options.entityType} write may have committed, but its authoritative state could not be verified.`,
        { cause: normalized }
      );
    }

    return {
      status: 'saved-locally',
      entityType: options.entityType,
      entityId: normalized.entityId,
      operation: normalized.operation,
      entity: committed,
      graphSyncError: normalized,
    };
  }
}
