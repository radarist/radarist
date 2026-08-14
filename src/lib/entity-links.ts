/**
 * @file entity-links.ts
 * @description Canonical entity-type → navigation URL mapping (client-safe).
 *
 * Single source of truth for deep-linking to an entity from chat chips, the
 * command palette, the graph workbench detail panel, recent items, etc. There
 * are no `/library/<type>/[id]` detail routes — entities open as sheets on
 * their list page, driven by a page-specific query param (see
 * `useControlledSheet` / `useSheetUrl` in useSheetUrl.ts).
 *
 * IMPORTANT: the sheet param is NOT uniform. Each list page picks its own
 * `paramName` (`?company=`, `?technology=`, `?painpoint=`, …). A generic
 * `?open=` is silently ignored by every page — that bug shipped in
 * CommandPalette for months because the navigation "worked" (the list page
 * rendered) while the sheet never opened. Types without an entry in
 * ENTITY_SHEET_PARAMS have no URL-driven sheet; deep links land on the list
 * page itself.
 */

/** Entity type → list page path. Mirrors the sidebar/library routes. */
export const ENTITY_LIST_PATHS: Record<string, string> = {
  company: '/library/companies',
  technology: '/library/technologies',
  useCase: '/library/use-cases',
  prototype: '/library/prototypes',
  strategy: '/library/strategies',
  signal: '/triage/signals',
  document: '/library/documents',
  orgUnit: '/library/org-units',
  initiative: '/library/initiatives',
  painPoint: '/library/pain-points',
  radarPlacement: '/radar',
};

/**
 * Entity type → query param its list page's URL-controlled sheet listens to.
 * Must match the `paramName` passed to `useControlledSheet`/`useSheetUrl` in
 * the corresponding hook (or page, where sheet state lives inline).
 */
export const ENTITY_SHEET_PARAMS: Record<string, string> = {
  company: 'company', // useCompaniesPage.ts
  prototype: 'prototype', // usePrototypesPage.ts
  strategy: 'strategy', // useStrategiesPage.ts
  useCase: 'usecase', // useUseCasesPage.ts
  technology: 'technology', // useTechnologiesPage.ts
  painPoint: 'painpoint', // usePainPointsPage.ts
  document: 'document', // useDocumentsPage.ts
  orgUnit: 'orgunit', // app/library/org-units/page.tsx (inline sheet state)
  initiative: 'initiative', // app/library/initiatives/page.tsx (inline sheet state)
};

/**
 * Build the deep-link URL for an entity. Opens the entity sheet where the
 * list page supports it; otherwise links to the list page. Returns null for
 * unknown types — callers should no-op (and may log).
 */
export function getEntityUrl(type: string, id: string): string | null {
  const basePath = ENTITY_LIST_PATHS[type];
  if (!basePath) {
    return null;
  }
  const param = ENTITY_SHEET_PARAMS[type];
  return param ? `${basePath}?${param}=${encodeURIComponent(id)}` : basePath;
}

// ============================================================================
// GRAPH NODE → ENTITY RESOLUTION
// ============================================================================

/**
 * Neo4j node label → canonical entity type. Graph entity nodes carry a
 * PascalCase type label alongside the generic `Entity` label; entity-link
 * types are camelCase (`UseCase` → `useCase`). Exact-match only: lowercase
 * labels (e.g. the `technology` label on `:Memory` nodes) are NOT entities.
 */
export const GRAPH_LABEL_ENTITY_TYPES: Record<string, string> = {
  Company: 'company',
  Technology: 'technology',
  UseCase: 'useCase',
  Prototype: 'prototype',
  Strategy: 'strategy',
  Signal: 'signal',
  OrgUnit: 'orgUnit',
  Initiative: 'initiative',
  PainPoint: 'painPoint',
  Document: 'document',
};

/** First entity type found among a graph node's labels, or null. */
export function getEntityTypeFromGraphLabels(labels: string[]): string | null {
  for (const label of labels) {
    const type = GRAPH_LABEL_ENTITY_TYPES[label];
    if (type) {
      return type;
    }
  }
  return null;
}

/**
 * Neo4j elementId shape: `<db-id>:<database-uuid>:<internal-id>`
 * (e.g. `4:c0a65d5c-e6d8-4f0e-8b1e-9a1f2b3c4d5e:42`). These are internal
 * graph identifiers, never Firestore document ids.
 */
const NEO4J_ELEMENT_ID_PATTERN = /^\d+:[0-9a-f-]+:\d+$/i;

/** Pure-numeric ids come from the legacy `identity.toString()` fallback. */
const NEO4J_NUMERIC_ID_PATTERN = /^\d+$/;

/**
 * Resolve the Firestore entity id for a graph node. The renderer node `id` is the
 * Neo4j elementId (set in /api/graph/query) — the Firestore id lives in
 * `properties.id`. Returns null when no usable id exists so callers can hide
 * the deep link instead of emitting a broken one.
 */
export function resolveGraphNodeEntityId(node: { id: string; properties: Record<string, unknown> }): string | null {
  const propId = node.properties?.id;
  if (typeof propId === 'string' && propId.trim().length > 0) {
    return propId;
  }
  // Last resort: tolerate callers that already key nodes by entity id, but
  // never emit Neo4j-internal identifiers as entity ids.
  if (
    typeof node.id === 'string' &&
    node.id.trim().length > 0 &&
    !NEO4J_ELEMENT_ID_PATTERN.test(node.id) &&
    !NEO4J_NUMERIC_ID_PATTERN.test(node.id)
  ) {
    return node.id;
  }
  return null;
}
