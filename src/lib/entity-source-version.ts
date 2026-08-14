/**
 * @file lib/entity-source-version.ts
 * @description Domain-separated content fingerprint for a Firestore entity.
 *
 * `updatedAt` is not a safe version: several writers use a client clock, two
 * commits can share one millisecond, and legacy documents may omit it. Hashing
 * the canonical authoritative document is intentionally over-sensitive: a
 * non-projected metadata change can cause one harmless idempotent replay, but a
 * newly graph-driving field can never escape drift detection.
 */

import type { EntityType } from '@/lib/types';

export const ENTITY_SOURCE_FINGERPRINT_LENGTH = 64;
export const ENTITY_GRAPH_PROJECTION_FINGERPRINT_DOMAIN = 'radarist.entity-graph-projection';
export const ENTITY_GRAPH_PROJECTION_FINGERPRINT_SCHEMA_VERSION = 1;

const ENTITY_SOURCE_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export class InvalidEntitySourceFingerprintError extends Error {
  constructor() {
    super('Invalid entity source fingerprint');
    this.name = 'InvalidEntitySourceFingerprintError';
  }
}

function compareStableStrings(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function timestampToMillis(value: object): number | null {
  if (value instanceof Date) return value.getTime();
  if ('toMillis' in value && typeof (value as { toMillis: unknown }).toMillis === 'function') {
    const millis = (value as { toMillis: () => unknown }).toMillis();
    return typeof millis === 'number' && Number.isFinite(millis) ? millis : null;
  }
  const shape = value as {
    seconds?: unknown;
    _seconds?: unknown;
    nanoseconds?: unknown;
    _nanoseconds?: unknown;
  };
  const seconds = shape.seconds ?? shape._seconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  const nanoseconds = shape.nanoseconds ?? shape._nanoseconds ?? 0;
  if (typeof nanoseconds !== 'number' || !Number.isFinite(nanoseconds)) return null;
  return seconds * 1000 + Math.floor(nanoseconds / 1_000_000);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const millis = timestampToMillis(value);
    if (millis !== null) return millis;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => compareStableStrings(left, right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value === undefined ? null : value;
}

/** Normalize arrays whose writer treats them as graph sets. */
export function normalizeEntityGraphSet(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string'))].sort(compareStableStrings);
}

/** Canonical, domain-separated JSON envelope for one authoritative document. */
export function entitySourceFingerprintPayload(
  entityType: EntityType,
  entityId: string,
  entity: Record<string, unknown>
): string {
  return JSON.stringify(
    canonicalize({
      domain: ENTITY_GRAPH_PROJECTION_FINGERPRINT_DOMAIN,
      schemaVersion: ENTITY_GRAPH_PROJECTION_FINGERPRINT_SCHEMA_VERSION,
      entityType,
      entityId,
      source: entity,
    })
  );
}

export async function createEntitySourceFingerprint(
  entityType: EntityType,
  entityId: string,
  entity: Record<string, unknown>
): Promise<string> {
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') {
    throw new Error('Secure digest generation is unavailable');
  }
  const bytes = new TextEncoder().encode(entitySourceFingerprintPayload(entityType, entityId, entity));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function parseEntitySourceFingerprint(value: unknown): string | null {
  if (typeof value !== 'string' || value.length !== ENTITY_SOURCE_FINGERPRINT_LENGTH) return null;
  return ENTITY_SOURCE_FINGERPRINT_PATTERN.test(value) ? value : null;
}

export function resolveEntitySourceFingerprint(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = parseEntitySourceFingerprint(value);
  if (!parsed) throw new InvalidEntitySourceFingerprintError();
  return parsed;
}
