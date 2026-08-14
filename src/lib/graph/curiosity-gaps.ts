import { runWriteTransaction, runReadTransaction } from '@/lib/graph/neo4j-client';

export interface CuriosityGapInput {
  question: string;
  entityIds: string[];
  agentName: string;
  missionId?: string;
  priority: 'high' | 'medium' | 'low';
  gapType: 'missing_data' | 'missing_relation' | 'stale_data' | 'conflicting_data';
}

export interface CuriosityGap {
  id: string;
  question: string;
  agentName: string;
  priority: string;
  gapType: string;
  entityIds: string[];
  createdAt: string;
  resolvedAt: string | null;
  resolution: string | null;
}

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

export async function recordCuriosityGap(input: CuriosityGapInput): Promise<string> {
  const id = `gap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = new Date().toISOString();

  await runWriteTransaction<{ id: string }>(
    `CREATE (g:CuriosityGap {
      id: $id, question: $question, agentName: $agentName,
      missionId: $missionId, priority: $priority,
      priorityOrder: $priorityOrder, gapType: $gapType,
      entityIds: $entityIds, createdAt: $createdAt,
      resolvedAt: null, resolution: null
    }) RETURN g.id AS id`,
    {
      id,
      question: input.question,
      agentName: input.agentName,
      missionId: input.missionId ?? null,
      priority: input.priority,
      priorityOrder: PRIORITY_ORDER[input.priority] ?? 1,
      gapType: input.gapType,
      entityIds: input.entityIds,
      createdAt,
    }
  );

  // Create edges to related entities (best-effort)
  try {
    const { ensureEdgesForNode } = await import('@/lib/graph/ensure-edges');
    await ensureEdgesForNode(id, 'CuriosityGap', {
      entityIds: input.entityIds,
      missionId: input.missionId ?? null,
    });
  } catch {
    /* best-effort */
  }

  return id;
}

/**
 * Scan the graph for data-quality gaps and create CuriosityGaps for them.
 *
 * Two detectors run per invocation:
 *   (a) Orphan Technology/Company entities (no incoming + outgoing edges),
 *       capped to `limit` per label per run.
 *   (b) Technology/Company entities with null or short description,
 *       capped to `limit` per label per run.
 *
 * Skips entities that already have an open CuriosityGap with the same
 * gapType (dedup via existing-gap check), so repeated invocations don't
 * flood the graph.
 *
 * Returns the number of CuriosityGaps created in this run.
 */
export async function detectDataQualityGaps(options: { limitPerDetector?: number } = {}): Promise<{
  orphanGapsCreated: number;
  missingDescGapsCreated: number;
}> {
  const limit = options.limitPerDetector ?? 5;

  const orphans = await runReadTransaction<{
    id: string;
    label: string;
    name: string;
  }>(
    `
    MATCH (e)
    WHERE ('Technology' IN labels(e) OR 'Company' IN labels(e))
      AND e.name IS NOT NULL
      AND NOT (e)--()
      AND NOT EXISTS {
        MATCH (g:CuriosityGap)
        WHERE g.resolvedAt IS NULL AND e.id IN g.entityIds AND g.gapType = 'missing_relation'
      }
    RETURN e.id AS id,
           [l IN labels(e) WHERE l IN ['Technology', 'Company']][0] AS label,
           e.name AS name
    ORDER BY e.createdAt DESC
    LIMIT toInteger($limit)
    `,
    { limit }
  );

  const missingDesc = await runReadTransaction<{
    id: string;
    label: string;
    name: string;
  }>(
    `
    MATCH (e)
    WHERE ('Technology' IN labels(e) OR 'Company' IN labels(e))
      AND e.name IS NOT NULL
      AND (e.description IS NULL OR size(e.description) < 20)
      AND NOT EXISTS {
        MATCH (g:CuriosityGap)
        WHERE g.resolvedAt IS NULL AND e.id IN g.entityIds AND g.gapType = 'missing_data'
      }
    RETURN e.id AS id,
           [l IN labels(e) WHERE l IN ['Technology', 'Company']][0] AS label,
           e.name AS name
    ORDER BY e.createdAt DESC
    LIMIT toInteger($limit)
    `,
    { limit }
  );

  let orphanGapsCreated = 0;
  for (const entity of orphans.records) {
    try {
      await recordCuriosityGap({
        question: `Why does ${entity.name} (${entity.label}) have no relations to other entities?`,
        entityIds: [entity.id],
        agentName: 'data-quality-scanner',
        priority: 'medium',
        gapType: 'missing_relation',
      });
      orphanGapsCreated++;
    } catch {
      /* best-effort */
    }
  }

  let missingDescGapsCreated = 0;
  for (const entity of missingDesc.records) {
    try {
      await recordCuriosityGap({
        question: `What is ${entity.name} (${entity.label})? The description is missing or too short.`,
        entityIds: [entity.id],
        agentName: 'data-quality-scanner',
        priority: 'low',
        gapType: 'missing_data',
      });
      missingDescGapsCreated++;
    } catch {
      /* best-effort */
    }
  }

  return { orphanGapsCreated, missingDescGapsCreated };
}

export async function resolveCuriosityGap(gapId: string, resolution: string): Promise<void> {
  await runWriteTransaction(
    `MATCH (g:CuriosityGap {id: $gapId})
     SET g.resolvedAt = $resolvedAt, g.resolution = $resolution`,
    { gapId, resolvedAt: new Date().toISOString(), resolution }
  );
}

export async function getOpenGaps(limit = 20): Promise<CuriosityGap[]> {
  const result = await runReadTransaction<{
    id: string;
    question: string;
    agentName: string;
    priority: string;
    gapType: string;
    entityIds: string[];
    createdAt: string;
    resolvedAt: string | null;
    resolution: string | null;
  }>(
    `MATCH (g:CuriosityGap) WHERE g.resolvedAt IS NULL
     RETURN g.id AS id, g.question AS question, g.agentName AS agentName,
            g.priority AS priority, g.gapType AS gapType,
            g.entityIds AS entityIds, g.createdAt AS createdAt,
            g.resolvedAt AS resolvedAt, g.resolution AS resolution
     ORDER BY g.priorityOrder ASC, g.createdAt DESC
     LIMIT toInteger($limit)`,
    { limit: Math.floor(limit) }
  );
  return result.records.map((r) => ({
    id: r.id,
    question: r.question,
    agentName: r.agentName,
    priority: r.priority,
    gapType: r.gapType,
    entityIds: r.entityIds ?? [],
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt ?? null,
    resolution: r.resolution ?? null,
  }));
}
