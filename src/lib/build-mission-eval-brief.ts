/**
 * @file lib/build-mission-eval-brief.ts
 * @description Compose an evaluation brief FROM THE GRAPH (E1) — what makes the
 * artifact a judgment instrument rather than a generic builder.
 *
 * This module is the dimension-agnostic DISPATCHER: it routes to the registered
 * per-entityType composer (`build-mission-eval-composers.ts`). The technology
 * composer is the only one shipped in this plan; other entityTypes are the seam
 * and throw `UnsupportedEvaluationEntityError`.
 *
 * NB (P1a-T3 deviation, recorded): `entityType` is passed via `opts.entityType`
 * (default 'technology'), NOT as a positional 2nd arg — existing callers already
 * pass `(id, { useCaseIds })`, so this keeps every call site byte-identical.
 *
 * Admin-SDK module (server-only path) — safe to call from the dispatch API
 * route / supervisor.
 */
import type { SupportedEntityType } from '@/lib/schemas/proposed-entity';
import { COMPOSERS, UnsupportedEvaluationEntityError } from './build-mission-eval-composers';

export type { ComposedEvaluation } from './build-mission-eval-composers';
export { UnsupportedEvaluationEntityError } from './build-mission-eval-composers';

/**
 * Compose an evaluation brief for the given source entity. Routes through the
 * composer registry by `entityType` (default 'technology'). The technology path
 * is byte-identical to the pre-parameterization behavior.
 */
export async function composeEvaluationBrief(
  sourceEntityId: string,
  opts?: { entityType?: SupportedEntityType; useCaseIds?: string[] }
) {
  const entityType = opts?.entityType ?? 'technology';
  const composer = COMPOSERS[entityType];
  if (!composer) throw new UnsupportedEvaluationEntityError(entityType);
  return composer(sourceEntityId, { useCaseIds: opts?.useCaseIds });
}
