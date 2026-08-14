/**
 * @file relation-target-types.contract.test.ts
 * @description UX-054 — advertised targets must be resolvable targets.
 *
 * The relation picker offers a list of entity types. Every type on that list is
 * a promise that picking it will create a relation. That promise is only kept
 * if BOTH snapshot resolvers know the type:
 *
 *   - `buildEntitySnapshot` (relations-admin) — the server/admin resolver behind
 *     `POST /api/relations/from-ids`, which is the authorization boundary the
 *     write actually crosses;
 *   - `buildTargetSnapshot` (relation-snapshot) — the client resolver the other
 *     library pages use.
 *
 * The Use Case page advertised nine types and resolved six, so Pain Point,
 * Org Unit, and Initiative Adds closed without creating anything. This test
 * makes that class of drift a build failure: adding a type to the advertised
 * list without teaching both resolvers fails here.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RELATION_TARGET_ENTITY_TYPES } from '../relation-target-types';
import type { EntityType } from '@/lib/types';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');

/**
 * Read the resolver's `case` labels straight from source.
 *
 * `relations-admin.ts` is admin-SDK/server-only — importing it here would pull
 * firebase-admin into a jsdom unit test. The switch labels are the contract, and
 * reading them textually keeps this test honest about the real file without
 * booting the module.
 */
function resolvedEntityTypes(relativePath: string, functionName: string): Set<EntityType> {
  const source = readFileSync(join(REPO_ROOT, relativePath), 'utf8');
  const start = source.indexOf(`export async function ${functionName}`);
  if (start === -1) throw new Error(`${functionName} not found in ${relativePath}`);

  // Bound the scan at the next top-level export so a later switch cannot leak in.
  const nextExport = source.indexOf('\nexport ', start + 1);
  const body = source.slice(start, nextExport === -1 ? undefined : nextExport);

  const types = new Set<EntityType>();
  for (const match of body.matchAll(/case '([a-zA-Z]+)':/g)) {
    types.add(match[1] as EntityType);
  }
  if (types.size === 0) throw new Error(`No case labels found in ${functionName}`);
  return types;
}

describe('RELATION_TARGET_ENTITY_TYPES', () => {
  it('is non-empty and free of duplicates', () => {
    expect(RELATION_TARGET_ENTITY_TYPES.length).toBeGreaterThan(0);
    expect(new Set(RELATION_TARGET_ENTITY_TYPES).size).toBe(RELATION_TARGET_ENTITY_TYPES.length);
  });

  it('is fully resolvable by the server snapshot boundary', () => {
    const resolvable = resolvedEntityTypes('src/lib/relations-admin.ts', 'buildEntitySnapshot');

    const unresolvable = RELATION_TARGET_ENTITY_TYPES.filter((type) => !resolvable.has(type));
    expect(unresolvable).toEqual([]);
  });

  it('is fully resolvable by the client snapshot resolver', () => {
    const resolvable = resolvedEntityTypes('src/lib/relation-snapshot.ts', 'buildTargetSnapshot');

    const unresolvable = RELATION_TARGET_ENTITY_TYPES.filter((type) => !resolvable.has(type));
    expect(unresolvable).toEqual([]);
  });

  it('covers the three types the Use Case picker used to advertise but drop', () => {
    // The exact regression: these were offered, Add was enabled, and nothing
    // was written.
    expect(RELATION_TARGET_ENTITY_TYPES).toEqual(
      expect.arrayContaining<EntityType>(['painPoint', 'orgUnit', 'initiative'])
    );
  });
});
