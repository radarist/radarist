/**
 * Bounded vocabularies shared by AI tool declarations and executors.
 *
 * These lists describe only the values supported by the corresponding tool
 * surfaces. They intentionally do not mirror every platform EntityType: adding
 * a domain type here is a product-contract change, not an automatic side effect
 * of extending the wider data model.
 */

import type { EntityType, SignalStatus } from '@/lib/types';

export const ASSERTION_ENTITY_TYPE_VALUES = [
  'technology',
  'company',
  'useCase',
  'prototype',
  'strategy',
  'signal',
  'orgUnit',
  'initiative',
  'painPoint',
] as const satisfies readonly EntityType[];

export type AssertionEntityType = (typeof ASSERTION_ENTITY_TYPE_VALUES)[number];

const ASSERTION_ENTITY_TYPE_ALIASES = {
  org_unit: 'orgUnit',
  pain_point: 'painPoint',
} as const satisfies Readonly<Record<string, AssertionEntityType>>;

export const SIGNAL_STATUS_VALUES = [
  'Detected',
  'Validated',
  'Approved',
  'Rejected',
  'Imported',
  'Archived',
] as const satisfies readonly SignalStatus[];

const assertionEntityTypeSet = new Set<string>(ASSERTION_ENTITY_TYPE_VALUES);
const signalStatusSet = new Set<string>(SIGNAL_STATUS_VALUES);

/**
 * Resolve the exact canonical assertion type or one of the two historical
 * snake-case aliases. Surrounding whitespace is harmless; case and punctuation
 * are otherwise significant so unknown model output fails closed.
 */
export function resolveAssertionEntityType(value: unknown): AssertionEntityType | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  const alias = ASSERTION_ENTITY_TYPE_ALIASES[normalized as keyof typeof ASSERTION_ENTITY_TYPE_ALIASES];
  if (alias) return alias;
  return assertionEntityTypeSet.has(normalized) ? (normalized as AssertionEntityType) : undefined;
}

/** Resolve an exact persisted signal status, allowing surrounding whitespace only. */
export function resolveSignalStatus(value: unknown): SignalStatus | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return signalStatusSet.has(normalized) ? (normalized as SignalStatus) : undefined;
}

export function assertionEntityTypeList(): string {
  return ASSERTION_ENTITY_TYPE_VALUES.join(', ');
}

export function signalStatusList(): string {
  return SIGNAL_STATUS_VALUES.join(', ');
}
