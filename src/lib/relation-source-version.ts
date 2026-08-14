import type { Relation } from '@/lib/types';

export const RELATION_SOURCE_FINGERPRINT_LENGTH = 64;

const RELATION_SOURCE_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

type RelationProjectionSource = Pick<
  Relation,
  | 'sourceSnapshot'
  | 'targetSnapshot'
  | 'relationType'
  | 'confidence'
  | 'claimStatus'
  | 'evidenceRefs'
  | 'notes'
  | 'reasoningSummary'
  | 'aiSuggested'
  | 'agentName'
>;

export type RelationSourceFingerprintInput = {
  [Key in keyof RelationProjectionSource]?: unknown;
};

function projectionEndpoint(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const endpoint = value as Record<string, unknown>;
  return {
    id: endpoint.id,
    type: endpoint.type,
    name: endpoint.name,
  };
}

export class InvalidRelationSourceFingerprintError extends Error {
  constructor() {
    super('Invalid relation source fingerprint');
    this.name = 'InvalidRelationSourceFingerprintError';
  }
}

function compareStableStrings(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(canonicalize)
      .sort((left, right) => compareStableStrings(JSON.stringify(left), JSON.stringify(right)));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => compareStableStrings(left, right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value === undefined ? null : value;
}

/** Canonical graph-driving relation content; worker-owned back-pointers are excluded. */
export function relationSourceFingerprintPayload(source: RelationSourceFingerprintInput): string {
  return JSON.stringify(
    canonicalize({
      // Snapshot descriptions, tags, timestamps, and arbitrary SDK metadata
      // are display-cache fields. Neo4j projects only this stable endpoint
      // identity, so excluding the rest also keeps client/Admin SDK hashes
      // identical for equivalent graph input.
      sourceSnapshot: projectionEndpoint(source.sourceSnapshot),
      targetSnapshot: projectionEndpoint(source.targetSnapshot),
      relationType: source.relationType,
      confidence: source.confidence,
      claimStatus: source.claimStatus,
      evidenceRefs: source.evidenceRefs,
      notes: source.notes,
      reasoningSummary: source.reasoningSummary,
      aiSuggested: source.aiSuggested,
      agentName: source.agentName,
    })
  );
}

/** Browser-safe SHA-256 used before client- or admin-SDK relation writes. */
export async function createRelationSourceFingerprint(
  source: Partial<RelationProjectionSource>
): Promise<string> {
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') {
    throw new Error('Secure digest generation is unavailable');
  }
  const bytes = new TextEncoder().encode(relationSourceFingerprintPayload(source));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function parseRelationSourceFingerprint(value: unknown): string | null {
  if (typeof value !== 'string' || value.length !== RELATION_SOURCE_FINGERPRINT_LENGTH) return null;
  return RELATION_SOURCE_FINGERPRINT_PATTERN.test(value) ? value : null;
}

export function resolveRelationSourceFingerprint(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const parsed = parseRelationSourceFingerprint(value);
  if (!parsed) throw new InvalidRelationSourceFingerprintError();
  return parsed;
}
