/**
 * Stable identity for mission source observations.
 *
 * Inngest event IDs only provide bounded deduplication. New observations
 * persist the same value as :Observation.id so Neo4j remains the durable
 * idempotency layer; one matching pre-upgrade random ID may be adopted.
 */

import { createHash } from 'node:crypto';
import type { ObservationVerdict } from '@/lib/scout-bundle-parser';

const OBSERVATION_ID_NAMESPACE = 'radarist.mission-observation.v1';
const SWEEP_OBSERVATION_ID_NAMESPACE = 'radarist.sweep-observation.v1';

export type ObservationAgentType = 'scout' | 'creator' | 'linker' | 'curator' | 'manual';

export interface MissionObservationIdentity {
  missionId: string;
  entityId: string;
  sourceUrl: string;
}

export interface SweepObservationIdentity {
  sweepId: string;
  gapIndex: number;
  entityId: string;
}

export interface MissionObservationEventInput extends MissionObservationIdentity {
  verdict: ObservationVerdict;
  agentType: ObservationAgentType;
  observedAt: string;
}

export interface MissionObservationEvent {
  id: string;
  name: 'app/entity.observation.recorded';
  data: MissionObservationEventInput & { observationId: string };
}

export interface MissionObservationSource {
  sourceUrl: string;
  verdict: ObservationVerdict;
}

export interface DeduplicatedMissionObservationSources {
  accepted: MissionObservationSource[];
  conflictingSourceUrls: string[];
}

function assertIdentityPart(value: string, field: keyof MissionObservationIdentity): void {
  if (value.trim().length === 0) {
    throw new Error(`Mission observation ${field} must not be empty`);
  }
}

/**
 * Derive identity from the exact tuple. JSON encoding prevents delimiter
 * ambiguity, while retaining the exact cited URL avoids collapsing distinct
 * source records through lossy URL normalization.
 */
export function createMissionObservationId(input: MissionObservationIdentity): string {
  assertIdentityPart(input.missionId, 'missionId');
  assertIdentityPart(input.entityId, 'entityId');
  assertIdentityPart(input.sourceUrl, 'sourceUrl');

  const digest = createHash('sha256')
    .update(JSON.stringify([OBSERVATION_ID_NAMESPACE, input.missionId, input.entityId, input.sourceUrl]))
    .digest('hex');
  return `obs-mission-v1-${digest}`;
}

/** Derive one durable observation identity for one gap in one sweep. */
export function createSweepObservationId(input: SweepObservationIdentity): string {
  if (input.sweepId.trim().length === 0) {
    throw new Error('Sweep observation sweepId must not be empty');
  }
  if (!Number.isSafeInteger(input.gapIndex) || input.gapIndex < 0) {
    throw new Error('Sweep observation gapIndex must be a non-negative safe integer');
  }
  if (input.entityId.trim().length === 0) {
    throw new Error('Sweep observation entityId must not be empty');
  }

  const digest = createHash('sha256')
    .update(JSON.stringify([SWEEP_OBSERVATION_ID_NAMESPACE, input.sweepId, input.gapIndex, input.entityId]))
    .digest('hex');
  return `obs-sweep-v1-${digest}`;
}

/** Build the event once so its transport and persisted IDs cannot drift. */
export function createMissionObservationEvent(input: MissionObservationEventInput): MissionObservationEvent {
  const observationId = createMissionObservationId(input);
  return {
    id: observationId,
    name: 'app/entity.observation.recorded',
    data: { ...input, observationId },
  };
}

/**
 * A source URL is one logical vote per mission/entity. Exact duplicates are
 * collapsed; conflicting verdicts are omitted instead of letting event order
 * choose which payload wins Inngest deduplication.
 */
export function deduplicateMissionObservationSources(
  sources: MissionObservationSource[]
): DeduplicatedMissionObservationSources {
  const acceptedByUrl = new Map<string, MissionObservationSource>();
  const conflictingSourceUrls = new Set<string>();

  for (const source of sources) {
    if (conflictingSourceUrls.has(source.sourceUrl)) continue;
    const existing = acceptedByUrl.get(source.sourceUrl);
    if (!existing) {
      acceptedByUrl.set(source.sourceUrl, source);
    } else if (existing.verdict !== source.verdict) {
      acceptedByUrl.delete(source.sourceUrl);
      conflictingSourceUrls.add(source.sourceUrl);
    }
  }

  return {
    accepted: Array.from(acceptedByUrl.values()),
    conflictingSourceUrls: Array.from(conflictingSourceUrls),
  };
}
