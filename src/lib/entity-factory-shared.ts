/**
 * @file entity-factory-shared.ts
 * @description Runtime-neutral entity identity and uniqueness primitives.
 *
 * This module must stay free of Firebase client/admin imports so browser and
 * server factories can share one configuration and the same error classes
 * without crossing their runtime boundary.
 */

import { ENTITY_COLLECTIONS } from '@/lib/entity-collections';

/** Error thrown when an entity violates its configured uniqueness rule. */
export class DuplicateEntityError extends Error {
  public readonly entityType: string;
  public readonly field: string;
  public readonly value: string;
  public readonly existingId: string;

  constructor(entityType: string, field: string, value: string, existingId: string) {
    super(`${entityType} with ${field} "${value}" already exists (ID: ${existingId})`);
    this.name = 'DuplicateEntityError';
    this.entityType = entityType;
    this.field = field;
    this.value = value;
    this.existingId = existingId;
  }
}

/** Error thrown when entity configuration is invalid or missing. */
export class EntityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntityConfigError';
  }
}

export interface EntityConfig {
  collection: string;
  uniqueField: string;
  scopeField?: string;
  idPrefix: string;
  nameField: 'name' | 'title';
}

export interface CreateEntityOptions {
  upsert?: boolean;
  scope?: string;
  skipUniquenessCheck?: boolean;
  graphSync?: 'best-effort' | 'required';
}

export interface CreateEntityResult<T> {
  entity: T;
  created: boolean;
  existingId?: string;
}

export interface EntityExistsResult {
  exists: boolean;
  id?: string;
  slug?: string;
}

/** Configuration for every entity type handled by the shared factory. */
export const ENTITY_CONFIGS: Record<string, EntityConfig> = {
  prototype: {
    collection: ENTITY_COLLECTIONS.prototype,
    uniqueField: 'slug',
    idPrefix: 'proto',
    nameField: 'name',
  },
  signal: {
    collection: ENTITY_COLLECTIONS.signal,
    uniqueField: 'slug',
    idPrefix: 'signal',
    nameField: 'title',
  },
  company: {
    collection: ENTITY_COLLECTIONS.company,
    uniqueField: 'slug',
    idPrefix: 'company',
    nameField: 'name',
  },
  useCase: {
    collection: ENTITY_COLLECTIONS.useCase,
    uniqueField: 'slug',
    idPrefix: 'usecase',
    nameField: 'title',
  },
  strategy: {
    collection: ENTITY_COLLECTIONS.strategy,
    uniqueField: 'slug',
    idPrefix: 'strategy',
    nameField: 'name',
  },
  initiative: {
    collection: ENTITY_COLLECTIONS.initiative,
    uniqueField: 'slug',
    idPrefix: 'initiative',
    nameField: 'name',
  },
  painPoint: {
    collection: ENTITY_COLLECTIONS.painPoint,
    uniqueField: 'slug',
    idPrefix: 'painpoint',
    nameField: 'title',
  },
  orgUnit: {
    collection: ENTITY_COLLECTIONS.orgUnit,
    uniqueField: 'slug',
    idPrefix: 'orgunit',
    nameField: 'name',
  },
  technology: {
    collection: ENTITY_COLLECTIONS.technology,
    uniqueField: 'slug',
    idPrefix: 'tech',
    nameField: 'name',
  },
  radarPlacement: {
    collection: ENTITY_COLLECTIONS.radarPlacement,
    uniqueField: 'technologyId',
    scopeField: 'radarId',
    idPrefix: 'placement',
    nameField: 'name',
  },
};

export type EntityType = keyof typeof ENTITY_CONFIGS;

/** Generate the canonical URL-safe slug used by both factory runtimes. */
export function generateSlug(name: string): string {
  if (!name || typeof name !== 'string') return '';

  return name
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 100);
}

/** Generate the canonical timestamp/random entity ID. */
export function generateEntityId(prefix: string = 'entity'): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 9);
  return `${prefix}-${timestamp}-${random}`;
}
