/**
 * @file LinkedEntitiesCard.tsx
 * @description Aside card for the insight detail page (Task 20 / P-D4) —
 * renders each of the insight's `relatedEntities` as an entity-chip row:
 * a canon-colored icon chip (`ENTITY_COLORS` + `entityIcon`, the same
 * CONV-CHIP convention the library tables use) plus an "Open" action that
 * reuses the existing URL-resolution logic (`getInsightAction`) the table
 * and card surfaces already rely on.
 *
 * Replaces the old plain-text "Linked entities" list that lived inside the
 * Details card — pulling it into its own card both gives it room for the
 * chip treatment and lines the insight detail page up with the Signal
 * detail page's "Related Entities" card.
 *
 * Color fallback is delegated to `resolveEntityChipColor` (the same guarded
 * ENTITY_COLORS lookup RelationsTab's relation cards use) rather than a
 * second, locally-invented bg-muted/text-muted-foreground fallback — Task 20
 * review finding #2.
 */

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { ExternalLink, Target } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ENTITY_COLORS } from '@/lib/entity-colors';
import { entityIcon } from '@/lib/entity-icons';
import { resolveEntityChipColor } from '@/lib/entity-chip-classes';
import { normaliseEntityType, getInsightAction } from '@/lib/graph/insight-actions';
import type { EntityType } from '@/lib/types';
import type { BriefingInsight } from '@/hooks/useBriefing';

interface LinkedEntitiesCardProps {
  entities: BriefingInsight['relatedEntities'];
}

/**
 * Normalises a loosely-typed related-entity `type` string (which may be a
 * plural collection name, e.g. from older data) to a canonical `EntityType`
 * for icon lookup. Returns `undefined` for anything unrecognised so callers
 * can fall back to the neutral `Target` icon instead of throwing. Color
 * fallback for the same unrecognised case is handled separately by
 * `resolveEntityChipColor`, which guards to the document palette rather than
 * `undefined` — see that module for why the two fallbacks live apart.
 */
function toEntityType(type: string): EntityType | undefined {
  const canonical = normaliseEntityType(type);
  return canonical in ENTITY_COLORS ? (canonical as EntityType) : undefined;
}

export function LinkedEntitiesCard({ entities }: LinkedEntitiesCardProps) {
  const router = useRouter();
  const items = useMemo(
    () => entities.map((e) => ({ ...e, url: getInsightAction(e.type, e.id).actionUrl })),
    [entities]
  );

  if (entities.length === 0) return null;

  return (
    <Card data-testid="linked-entities-card">
      <CardHeader>
        <CardTitle className="text-base">Linked Entities</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {items.map((e) => {
          const entityType = toEntityType(e.type);
          const Icon = entityType ? entityIcon(entityType) : Target;
          // Guarded lookup — never `undefined`, falls back to the document
          // palette for anything `toEntityType` couldn't recognise, same as
          // RelationsTab's relation-card chips.
          const colors = resolveEntityChipColor(normaliseEntityType(e.type) as EntityType);
          return (
            <div key={e.id} className="flex items-center justify-between gap-2" data-testid={`linked-entity-${e.id}`}>
              <div className="flex min-w-0 items-center gap-2">
                <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', colors.bg)}>
                  <Icon className={cn('h-4 w-4', colors.text)} />
                </span>
                <span className="truncate text-sm">{e.name}</span>
              </div>
              {e.url && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-xs"
                  onClick={() => router.push(e.url!)}
                  aria-label={`Open ${e.name}`}
                >
                  Open
                  <ExternalLink className="ml-1 h-3 w-3" />
                </Button>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
