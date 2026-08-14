/**
 * @file lib/graph/insight-actions.ts
 * @description Single source of truth for "what URL + label should an
 * insight's primary CTA target, given its observed entity's type?"
 *
 * Phase 0 step 0.4 of the 2026-05-13 briefing-pipeline cleanup. Replaces
 * three drifting copies of this map (in `dot-connector.ts`,
 * `proactive-insights.ts`, and historically in `InsightCard.tsx`).
 *
 * Two important behaviours:
 *
 *  1. **Plural / singular normalisation.** `findDataGapsFromFirestore`
 *     writes the collection name (e.g. `"technologies"`, plural) as the
 *     entity type on agent observations, while the rest of the graph
 *     uses the singular form (`"technology"`). This helper accepts both
 *     so the URL the insight gets persisted with always resolves. The
 *     write-side fix at `findDataGapsFromFirestore` lands in step 0.5;
 *     this normalisation is the safety net.
 *
 *  2. **`null` URL signals "no destination."** Previously the default
 *     branch returned `actionUrl: '/library'` — a generic home page link
 *     that wasted a click. `null` lets the UI hide the CTA when we
 *     genuinely don't know where to send the user.
 */

import { createLogger } from '@/lib/logger';
import { getEntityUrl } from '@/lib/entity-links';

const log = createLogger('insight-actions');

/** Shape returned by the helper. */
export interface InsightAction {
  /** Where to send the user. `null` when there is no useful destination. */
  actionUrl: string | null;
  /** Button copy, e.g. "View company". Always populated. */
  actionLabel: string;
}

/**
 * Map plural collection-name forms to their canonical singular entityType.
 * Keep aligned with `ENTITY_CONFIGS` in `entity-factory-shared.ts` —
 * the singular keys here MUST match the `entityType` field used elsewhere.
 */
const PLURAL_TO_SINGULAR: Record<string, string> = {
  companies: 'company',
  technologies: 'technology',
  'use-cases': 'useCase',
  useCases: 'useCase',
  strategies: 'strategy',
  prototypes: 'prototype',
  initiatives: 'initiative',
  'org-units': 'orgUnit',
  orgUnits: 'orgUnit',
  painPoints: 'painPoint',
  signals: 'signal',
};

/**
 * Normalise an incoming entityType (which may be plural collection-name
 * form from the Firestore-fallback gap-finder) to the canonical singular.
 */
export function normaliseEntityType(entityType: string | null | undefined): string {
  if (!entityType) return '';
  if (entityType in PLURAL_TO_SINGULAR) return PLURAL_TO_SINGULAR[entityType];
  return entityType;
}

/**
 * Given an entity type + id, return the URL + label for the primary
 * action a briefing-insight card should fire when the user clicks
 * "View" / the row.
 *
 * Returns `actionUrl: null` for unknown entity types so the caller can
 * hide the button rather than send the user to a useless `/library`
 * home page. The label is always populated — "View entity" is the
 * generic fallback.
 *
 * The helper deliberately tolerates plural collection-name forms (see
 * `normaliseEntityType` above) so insights persisted with whatever
 * shape the sweep-cycle produced still resolve to the right URL.
 */
/** Button copy per canonical entity type. Falls back to "View entity". */
const ACTION_LABELS: Record<string, string> = {
  company: 'View company',
  technology: 'View technology',
  useCase: 'View use case',
  strategy: 'View strategy',
  prototype: 'View prototype',
  initiative: 'View initiative',
  orgUnit: 'View org unit',
  painPoint: 'View pain point',
  signal: 'Review signals',
  document: 'View document',
};

export function getInsightAction(entityType: string | null | undefined, entityId: string): InsightAction {
  const canonical = normaliseEntityType(entityType);
  const actionLabel = ACTION_LABELS[canonical] ?? 'View entity';

  // Canonical URL from entity-links — the single source of truth for entity
  // deep links. Each list page's sheet listens to its own param (?company=,
  // ?technology=, …); the previous local `?sheet=` builder here was silently
  // ignored by every page. Signals deliberately resolve to /triage/signals
  // (no sheet param — signals have a dedicated page under Triage).
  const actionUrl = canonical ? getEntityUrl(canonical, entityId) : null;
  if (!actionUrl) {
    log.debug('Unknown entity type for insight action', { entityType, canonical });
  }

  return { actionUrl, actionLabel };
}

// `dot-connector.ts` historically prefixed every connection insight
// with `${agentName} found a link: …`. The prefix duplicated info the
// row already carries (Agent column + summary line) and pushed the
// useful "<A> connects to <B>" past the first wrap point on every
// row. The writer dropped the prefix on 2026-05-13; this regex
// strips it from titles already persisted in Firestore so the legacy
// rows render clean alongside the new ones.
const FOUND_A_LINK_PREFIX = /^[^:]+ found a link:\s*/;

/**
 * Strip the legacy `${agent} found a link:` prefix from an insight
 * title for display. Pure function — no-op on titles that don't
 * carry the prefix.
 */
export function displayInsightTitle(title: string): string {
  return title.replace(FOUND_A_LINK_PREFIX, '');
}
