/**
 * @file entity-collections.ts
 * @description Canonical map from EntityType to its Firestore collection name.
 *
 * SINGLE SOURCE OF TRUTH for "which collection does this entity type live in".
 * This is a LEAF module with ZERO Firebase imports (client or admin), so it is
 * safe to import from every context — the client-SDK entity factory, the
 * `server-only` admin cleanup twin, Inngest workers, and seed scripts alike.
 *
 * Historically three copies of this map existed and silently drifted:
 *  - `entity-factory.ts` (`ENTITY_CONFIGS[*].collection`) used the correct
 *    hyphenated `use-cases` / `org-units`.
 *  - `relations-admin.ts` and `relations-validation.ts` used camelCase
 *    `useCases` / `orgUnits`, so the nightly orphan-relation cleanup classified
 *    every relation touching an app-created use case or org unit as orphaned and
 *    batch-deleted it. `seed-emulator.ts` / `ContextualGraph.tsx` used `useCases`
 *    too, so seeded use cases were invisible to the app.
 *
 * All of those now import THIS map, and `ENTITY_CONFIGS` derives its `collection`
 * from it, so the spellings can never fork again. A test
 * (`entity-collections.test.ts`) asserts the factory config and this map agree.
 */

import type { EntityType } from '@/lib/types/common';

/**
 * EntityType → Firestore collection name. Every entity type in the
 * `EntityType` union (including `document`, which is a valid relation endpoint
 * but is not created through the entity factory) has exactly one entry here.
 */
export const ENTITY_COLLECTIONS: Record<EntityType, string> = {
  technology: 'technologies',
  company: 'companies',
  useCase: 'use-cases',
  strategy: 'strategies',
  prototype: 'prototypes',
  signal: 'signals',
  document: 'documents',
  orgUnit: 'org-units',
  initiative: 'initiatives',
  painPoint: 'painPoints',
  radarPlacement: 'radarPlacements',
};
