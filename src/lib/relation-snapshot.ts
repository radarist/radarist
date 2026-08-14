/**
 * @file relation-snapshot.ts
 * @description Resolve a relation target's canonical `EntitySnapshot` from its
 * id + type.
 *
 * The relation write path (`createRelation`) stores the target snapshot
 * verbatim — it never backfills `name`. Callers that shortcut with
 * `name: ''` therefore persist an empty target name, which breaks the sheet's
 * relation card render and makes UI unlink impossible (UX-034/035). This helper
 * fetches the target entity and builds the snapshot with the real name,
 * generalizing the resolution the use-case page already does inline and
 * additionally covering Org Unit / Initiative / Pain Point targets.
 *
 * Client-SDK services only (safe to import from client library pages).
 */

import { getCompanyById } from '@/lib/companies';
import { getTechnologyById } from '@/lib/technology-service';
import { getUseCaseById } from '@/lib/use-cases';
import { getPrototypeById } from '@/lib/prototypes';
import { getStrategyById } from '@/lib/strategies';
import { getSignalById } from '@/lib/signals-client';
import { getOrgUnitById } from '@/lib/org-units';
import { getInitiativeById } from '@/lib/initiatives';
import { getPainPointById } from '@/lib/pain-points';
import type { EntityType, EntitySnapshot } from '@/lib/types';

/**
 * Fetch the target entity and build its snapshot with the real display name.
 * Returns `null` when the entity cannot be found or the type is not linkable
 * via the entity-relation UI (`document` / `radarPlacement`) — callers must
 * surface that as a visible failure rather than persisting an empty snapshot.
 */
export async function buildTargetSnapshot(
  targetId: string,
  targetType: EntityType
): Promise<EntitySnapshot | null> {
  const snapshotAt = Date.now();

  switch (targetType) {
    case 'company': {
      const e = await getCompanyById(targetId);
      return e
        ? { type: 'company', id: e.id, name: e.name, description: e.description, status: e.status, snapshotAt }
        : null;
    }
    case 'technology': {
      const e = await getTechnologyById(targetId);
      return e ? { type: 'technology', id: targetId, name: e.name, description: e.description, snapshotAt } : null;
    }
    case 'useCase': {
      const e = await getUseCaseById(targetId);
      return e
        ? { type: 'useCase', id: e.id, name: e.title, description: e.description, status: e.status, snapshotAt }
        : null;
    }
    case 'prototype': {
      const e = await getPrototypeById(targetId);
      return e
        ? { type: 'prototype', id: e.id, name: e.name, description: e.description, status: e.status, snapshotAt }
        : null;
    }
    case 'strategy': {
      const e = await getStrategyById(targetId);
      return e ? { type: 'strategy', id: e.id, name: e.name, description: e.description, snapshotAt } : null;
    }
    case 'signal': {
      const e = await getSignalById(targetId);
      return e
        ? { type: 'signal', id: e.id, name: e.title, description: e.description, status: e.status, snapshotAt }
        : null;
    }
    case 'orgUnit': {
      const e = await getOrgUnitById(targetId);
      return e ? { type: 'orgUnit', id: e.id, name: e.name, description: e.description, snapshotAt } : null;
    }
    case 'initiative': {
      const e = await getInitiativeById(targetId);
      return e
        ? { type: 'initiative', id: e.id, name: e.name, description: e.description, status: e.status, snapshotAt }
        : null;
    }
    case 'painPoint': {
      const e = await getPainPointById(targetId);
      return e
        ? { type: 'painPoint', id: e.id, name: e.title, description: e.description, status: e.status, snapshotAt }
        : null;
    }
    default:
      return null;
  }
}
