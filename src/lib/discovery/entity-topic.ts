/**
 * @file discovery/entity-topic.ts
 * @description Resolve an EXISTING entity's interest topic from the same source the
 * selector ranks on (its Firestore tags) → `deriveFeedbackTopic` (first MEANINGFUL,
 * stopword-filtered tag). The feedback write path uses this so its posterior
 * key-space matches the selector's read key-space (A1 unification + M17 stopword
 * fix). Missing entity / no meaningful tags → entityType fallback.
 *
 * Server-only (Firestore admin read). The collection map mirrors the selector's
 * `COLLECTION_BY_ENTITY_TYPE` (the read side); keep them in sync.
 */
import 'server-only';
import { db } from '@/lib/firebase-admin';
import { createLogger } from '@/lib/logger';
import { deriveFeedbackTopic } from './candidate-topic';

const log = createLogger('discovery/entity-topic');

const COLLECTION_BY_ENTITY_TYPE: Record<string, string> = {
  technology: 'technologies',
  company: 'companies',
  useCase: 'use-cases',
  painPoint: 'painPoints',
  prototype: 'prototypes',
  // Non-discoverable types that can still be a FEEDBACK subject (e.g. an artifact
  // recommendation scoped to a strategy) — resolve their real tags so the posterior
  // lands on the shared tag key-space, not a verbatim type string the selector ignores.
  strategy: 'strategies',
  initiative: 'initiatives',
  orgUnit: 'org-units',
};

/** The tag topic for an existing entity (selector's source of truth), or entityType on miss. */
export async function resolveEntityTopic(entityId: string, entityType: string): Promise<string> {
  const collection = COLLECTION_BY_ENTITY_TYPE[entityType];
  if (!collection) return entityType;
  const snap = await db.collection(collection).doc(entityId).get();
  if (!snap.exists) {
    // Distinct from a genuine no-tags entity: the target is missing (deleted, or a
    // half-failed mint on the approve path). Surface it — the feedback will key to the
    // coarse entityType, the exact mis-key A1 set out to eliminate.
    log.warn('resolveEntityTopic: entity not found — feedback will key to entityType', { entityId, entityType });
    return entityType;
  }
  const tags = (snap.data() as { tags?: unknown } | undefined)?.tags;
  // M17: key on the first MEANINGFUL tag (stopword-filtered) — the same filtered
  // key-space the selector's scoreCandidate reads. The raw first tag can be a
  // stopword ('competitor', 'hyped', …) whose posterior the selector never reads
  // for weight but still counts against the class's exploration bonus — which
  // would INVERT the learning signal (approve → rank down).
  return deriveFeedbackTopic(tags, entityType);
}
