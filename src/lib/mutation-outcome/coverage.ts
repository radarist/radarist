/**
 * @file lib/mutation-outcome/coverage.ts
 * @description Compile-time proof that every library entity type has a
 * saved-locally resolver (GRAPH-058).
 *
 * Deliberately import-free apart from the type vocabulary. A runtime registry
 * would have to import all eight service modules, dragging every service's
 * Firebase initialization into whichever page happened to reference it — which is
 * exactly why the resolvers live in one module per type.
 *
 * The check below is the whole point: adding a ninth `LibraryEntitySyncType`
 * without a resolver makes `_UncoveredLibraryEntityType` non-`never` and fails
 * `npm run typecheck`. It is the only mechanism that keeps "all eight library
 * types tell the truth about a committed write" from quietly regressing to seven,
 * which is the state this row was filed against.
 */

import { LIBRARY_ENTITY_SYNC_TYPES, type LibraryEntitySyncType } from '@/lib/entity-sync-contract';

/**
 * Company's resolver lives in `company-mutation-outcome.ts`; it predates this
 * directory and its update path carries a bespoke payload type. Listed here so
 * the coverage claim covers all eight rather than the seven that were added.
 */
export const LIBRARY_ENTITY_TYPES_WITH_MUTATION_OUTCOME = [
  'company',
  'technology',
  'strategy',
  'useCase',
  'prototype',
  'orgUnit',
  'initiative',
  'painPoint',
] as const satisfies readonly LibraryEntitySyncType[];

/**
 * A library entity type that provably has a saved-locally resolver.
 *
 * `useLibraryEntityGraphSync` accepts this rather than the raw
 * `LibraryEntitySyncType`, so the coverage claim is load-bearing at the call
 * site instead of being an assertion nobody reads: a type without a resolver
 * cannot be handed to the recovery hook in the first place.
 */
export type LibraryEntityTypeWithMutationOutcome = (typeof LIBRARY_ENTITY_TYPES_WITH_MUTATION_OUTCOME)[number];

type _UncoveredLibraryEntityType = Exclude<
  (typeof LIBRARY_ENTITY_SYNC_TYPES)[number],
  LibraryEntityTypeWithMutationOutcome
>;

const _allLibraryTypesCovered: _UncoveredLibraryEntityType extends never ? true : never = true;
void _allLibraryTypesCovered;
