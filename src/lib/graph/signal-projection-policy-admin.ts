import 'server-only';

import { db } from '@/lib/firebase-admin';
import {
  collectSignalProjectionReferences,
  decideSignalProjection,
  type SignalProjectionDecision,
} from './signal-projection-policy';
import type { SignalProjectionReference } from './signal-projection-policy';

type SignalSource = { status?: unknown };

/** Load references whose own Firestore rows remain authoritative. */
export async function loadSignalProjectionReferences(signalId: string): Promise<SignalProjectionReference[]> {
  const [sourceRelations, targetRelations, links] = await Promise.all([
    db.collection('relations').where('sourceSnapshot.id', '==', signalId).get(),
    db.collection('relations').where('targetSnapshot.id', '==', signalId).get(),
    db.collection('entityDocumentLinks').where('entityId', '==', signalId).get(),
  ]);

  return (
    collectSignalProjectionReferences({
      relations: [...sourceRelations.docs, ...targetRelations.docs].map((doc) => ({ ...doc.data(), id: doc.id })),
      documentLinks: links.docs.map((doc) => ({ ...doc.data(), id: doc.id })),
    }).get(signalId) ?? []
  );
}

export async function loadSignalProjectionDecision(
  signalId: string,
  source?: SignalSource | null
): Promise<SignalProjectionDecision> {
  const resolvedSource =
    source === undefined
      ? await db
          .collection('signals')
          .doc(signalId)
          .get()
          .then((snapshot) => (snapshot.exists ? (snapshot.data() as SignalSource) : null))
      : source;
  if (!resolvedSource) return decideSignalProjection(undefined);
  return decideSignalProjection(resolvedSource.status, await loadSignalProjectionReferences(signalId));
}

/**
 * Bulk form used by reconciliation. It avoids three reference queries per
 * Signal while producing byte-for-byte the same policy inputs as the worker.
 */
export async function loadReferencedSignalIds(): Promise<Map<string, SignalProjectionReference[]>> {
  const [relations, links] = await Promise.all([
    db.collection('relations').select('sourceSnapshot', 'targetSnapshot').get(),
    db.collection('entityDocumentLinks').where('entityType', '==', 'signal').select('entityId').get(),
  ]);
  return collectSignalProjectionReferences({
    relations: relations.docs.map((doc) => ({ ...doc.data(), id: doc.id })),
    documentLinks: links.docs.map((doc) => ({ ...doc.data(), id: doc.id, entityType: 'signal' })),
  });
}

/** Load the complete policy-eligible Signal inventory for bulk maintenance paths. */
export async function loadEligibleSignalProjectionIds(): Promise<string[]> {
  const [signals, references] = await Promise.all([
    db.collection('signals').select('status').get(),
    loadReferencedSignalIds(),
  ]);
  return signals.docs
    .flatMap((doc) =>
      decideSignalProjection(doc.data().status, references.get(doc.id)).eligible ? [doc.id] : []
    )
    .sort();
}
