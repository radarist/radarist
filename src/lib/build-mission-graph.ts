/**
 * @file lib/build-mission-graph.ts
 * @description Connect a published artifact back into the knowledge graph —
 * the "E0" keystone. An artifact is no longer an orphan: on publish it
 * proposes typed relations from the Prototype to the entities that
 * motivated it (the source Technology, use cases, pain points, strategies).
 *
 * SAFETY: writes go through the existing proposed-relations pipeline
 * (`createProposedRelationIfNotExists`), which stages them as PENDING for
 * human triage at /triage/relations. Evaluation autopilot may approve only
 * proposals created by its run after the feature flag and confidence checks;
 * those approvals keep machine provenance and remain confidence-gated.
 *
 * Admin-SDK module (never the client SDK) so it is safe to call from the
 * Inngest supervisor. Dynamically imported inside a step.run (see
 * run-build-mission.ts) per the project's Inngest import convention.
 */
import { createHash } from 'crypto';
import { db } from '@/lib/firebase-admin';
import { createProposedRelationIfNotExists } from '@/lib/proposed-relations-admin';
import { createLogger } from '@/lib/logger';
import type { EvidenceReference, RelationType } from '@/lib/types/relations';
import type { EntityType } from '@/lib/types';
import type { ArtifactMotivation } from '@/lib/schemas/mission-build';

const log = createLogger('build-mission-graph');

/** Entity type → Firestore collection (mirrors ENTITY_CONFIGS in entity-factory). */
const COLLECTION: Partial<Record<EntityType, string>> = {
  technology: 'technologies',
  useCase: 'use-cases',
  painPoint: 'painPoints',
  strategy: 'strategies',
  prototype: 'prototypes',
  document: 'documents',
};

/** The relation predicate from a prototype to each motivating entity type (per relation-ontology). */
const PREDICATE: Partial<Record<EntityType, RelationType>> = {
  technology: 'uses',
  useCase: 'demonstrates',
  painPoint: 'solves',
  strategy: 'aligns_with',
};

interface Snapshot {
  type: EntityType;
  id: string;
  name: string;
  snapshotAt: number;
}

async function snapshotOf(type: EntityType, id: string): Promise<Snapshot> {
  const fallback: Snapshot = { type, id, name: id, snapshotAt: Date.now() };
  const collection = COLLECTION[type];
  if (!collection) return fallback;
  try {
    const snap = await db.collection(collection).doc(id).get();
    if (!snap.exists) {
      // Distinct from a transient fetch error: the target was deleted. Surface it — a
      // relation to a tombstone (name = raw id) is a real, debuggable degradation.
      log.warn('snapshot target does not exist (deleted?) — using id as fallback name', { type, id });
      return fallback;
    }
    const data = snap.data() as { name?: string; title?: string } | undefined;
    const name = data?.name ?? data?.title ?? id;
    return { type, id, name: String(name).slice(0, 100), snapshotAt: Date.now() };
  } catch (error) {
    log.warn('snapshot fetch failed', { type, id, error: error instanceof Error ? error.message : String(error) });
    return fallback;
  }
}

function buildEvidence(summary: string, missionId: string, artifactType: EntityType): EvidenceReference[] {
  const snippet = summary.slice(0, 500);
  return [
    {
      sourceType: 'entity_field',
      sourceId: missionId,
      location: { entityType: artifactType, field: 'description' },
      snippet,
      snippetHash: createHash('sha256').update(snippet).digest('hex'),
      extractedAt: Date.now(),
    },
  ];
}

export interface ConnectArtifactOptions {
  /** The published artifact entity. Field names kept as prototype* for the
   *  solution path; evaluation/architecture/report pass a Document via these
   *  plus artifactType:'document'. */
  prototypeId: string;
  prototypeName: string;
  /** 'prototype' (default, solution) or 'document' (evaluation/architecture/report). */
  artifactType?: EntityType;
  motivation: ArtifactMotivation;
  /** One-line provenance used as the evidence snippet (e.g. "QA-passed by mission X, $12, 3 sessions"). */
  evidenceSummary: string;
  missionId: string;
  /** 0–100; defaults to 80 (Class B proposed — stays pending for review). */
  confidence?: number;
  /** Override the default predicate per target type (e.g. {technology:'evaluates'} for an evaluation Document). */
  predicateOverride?: Partial<Record<EntityType, RelationType>>;
}

/**
 * Propose relations connecting the prototype to its motivating entities.
 * Returns how many NEW proposals were staged (idempotent — re-running a
 * mission won't duplicate). Never throws on a single failed target.
 */
export async function connectArtifactToGraph(
  opts: ConnectArtifactOptions
): Promise<{ proposed: number; proposedIds: string[]; failed: number }> {
  const artifactType: EntityType = opts.artifactType ?? 'prototype';
  const source: Snapshot = {
    type: artifactType,
    id: opts.prototypeId,
    name: opts.prototypeName.slice(0, 100),
    snapshotAt: Date.now(),
  };
  const evidence = buildEvidence(opts.evidenceSummary, opts.missionId, artifactType);

  const targets: Array<{ type: EntityType; id: string }> = [];
  if (opts.motivation.sourceTechnologyId) targets.push({ type: 'technology', id: opts.motivation.sourceTechnologyId });
  // Dimension-agnostic: link the artifact to the EXISTING entity it evaluated
  // (useCase/painPoint/etc) named in sourceEntityId — the non-technology evaluation
  // path. With predicateOverride {<type>:'evaluates'} this stages the verdict→entity
  // edge that replaced the old phantom net-new proposedEntity.
  if (opts.motivation.sourceEntityId && opts.motivation.entityType) {
    targets.push({ type: opts.motivation.entityType, id: opts.motivation.sourceEntityId });
  }
  for (const id of opts.motivation.useCaseIds ?? []) targets.push({ type: 'useCase', id });
  for (const id of opts.motivation.painPointIds ?? []) targets.push({ type: 'painPoint', id });
  for (const id of opts.motivation.strategyIds ?? []) targets.push({ type: 'strategy', id });

  // Dedup by (type,id): the technology path sets both sourceTechnologyId and
  // sourceEntityId to the same id — propose the relation once, not twice.
  const seenTargets = new Set<string>();
  const dedupedTargets = targets.filter((t) => {
    const key = `${t.type}:${t.id}`;
    if (seenTargets.has(key)) return false;
    seenTargets.add(key);
    return true;
  });

  const proposedIds: string[] = [];
  let failed = 0;
  for (const target of dedupedTargets) {
    const relationType = opts.predicateOverride?.[target.type] ?? PREDICATE[target.type];
    if (!relationType) continue;
    try {
      const targetSnapshot = await snapshotOf(target.type, target.id);
      const result = await createProposedRelationIfNotExists({
        sourceType: artifactType,
        sourceId: opts.prototypeId,
        sourceSnapshot: source,
        targetType: target.type,
        targetId: target.id,
        targetSnapshot,
        relationType,
        confidence: opts.confidence ?? 80,
        reasoning: `Artifact "${opts.prototypeName}" was produced by build mission ${opts.missionId}; it ${relationType} this ${target.type}.`,
        evidence,
        // RelationDiscoverySource is restricted; 'ai-assistant' is the closest
        // fit for an autonomous build. runId carries the mission for tracing.
        discoveredBy: 'ai-assistant',
        runId: opts.missionId,
      });
      if (result.created) proposedIds.push(result.proposal.id);
    } catch (error) {
      // The caller uses `failed` to tell an orphaned verdict (a single-target evaluation
      // whose only link failed) from a legitimate dedup/no-op. A swallowed warn alone is
      // not enough when the lone target IS the verdict's entire graph footprint.
      failed += 1;
      log.warn('proposal failed (continuing)', {
        target: `${target.type}:${target.id}`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  log.info('artifact connected to graph', {
    missionId: opts.missionId,
    prototypeId: opts.prototypeId,
    proposed: proposedIds.length,
    failed,
  });
  return { proposed: proposedIds.length, proposedIds, failed };
}
