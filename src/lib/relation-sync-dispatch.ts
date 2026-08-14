export type RelationSyncOperation = 'create' | 'update' | 'delete';

/**
 * The Firestore mutation has committed, but Inngest did not acknowledge the
 * graph handoff. Callers must surface this state so retrying the same operation
 * can converge through the service's idempotent create/update/delete paths.
 */
export class RelationSyncDispatchError extends Error {
  readonly relationId: string;
  readonly operation: RelationSyncOperation;

  constructor(relationId: string, operation: RelationSyncOperation) {
    super(
      `Relation ${relationId} was ${operation === 'delete' ? 'deleted' : 'saved'} in Firestore, ` +
        (operation === 'delete'
          ? 'but its immediate graph synchronization handoff was not acknowledged. Durable cleanup remains queued; do not create a replacement relation.'
          : 'but its graph synchronization handoff was not acknowledged. Retry the same operation; do not create a replacement relation.')
    );
    this.name = 'RelationSyncDispatchError';
    this.relationId = relationId;
    this.operation = operation;
  }
}

export function requireRelationSyncAcknowledgement(
  acknowledged: boolean,
  relationId: string,
  operation: RelationSyncOperation
): void {
  if (!acknowledged) throw new RelationSyncDispatchError(relationId, operation);
}
