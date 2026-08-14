/**
 * @file pain-points-shared.ts
 * @description Pure, Firebase-free PainPoint boundary helpers shared by the
 * client-SDK reader (`pain-points.ts`) and the Admin-SDK twin
 * (`pain-points-admin.ts`), plus the net-new entity approval path.
 *
 * Why a shared module: the browser and Admin readers MUST expose one
 * consistent, render-safe `PainPoint` shape, and the triage approval writer
 * MUST emit a library-safe document. Centralizing these contracts here keeps the
 * client and server boundaries truthful and prevents the optional-chaining
 * workaround from being scattered through individual UI components.
 *
 * Truthfulness contract:
 *   - Missing required array fields default to `[]`, which is the legacy shape
 *     UX-059 repairs. Present-but-malformed fields fail closed instead of being
 *     silently rewritten and later persisted by a read/modify/write operation.
 *   - The exact retained legacy category `process` becomes `operational`.
 *     Matching remains case-sensitive; no arbitrary category is coerced.
 *   - Every required scalar is validated before the value is exposed as a
 *     `PainPoint`; arbitrary storage data is never double-cast into a domain
 *     object.
 *   - Triage approval uses the same defaults as the create form, and the
 *     approval UI resolves and displays those exact effective classifications
 *     before the reviewer approves them.
 */

import { z } from 'zod';
import type {
  PainPoint,
  PainPointSeverity,
  PainPointStatus,
  PainPointCategory,
} from '@/lib/types';

/**
 * Required `string[]` fields on a PainPoint. These are the fields that crash
 * render code (`array.length` / `array.includes`) when a legacy or sparse
 * document omits them.
 */
export const PAIN_POINT_ARRAY_FIELDS = [
  'affectedOrgUnitIds',
  'linkedPrototypeIds',
  'linkedTechnologyIds',
  'linkedInitiativeIds',
  'tags',
] as const;

/** Valid severity values (single source of truth for the writer coalescer). */
const VALID_SEVERITIES: ReadonlySet<PainPointSeverity> = new Set([
  'critical',
  'high',
  'medium',
  'low',
]);

/** Valid status values. */
const VALID_STATUSES: ReadonlySet<PainPointStatus> = new Set([
  'identified',
  'validated',
  'being_addressed',
  'resolved',
]);

/** Valid category values. */
const VALID_CATEGORIES: ReadonlySet<PainPointCategory> = new Set([
  'operational',
  'customer',
  'regulatory',
  'technical',
  'market',
  'financial',
  'talent',
  'other',
]);

const LEGACY_PAIN_POINT_CATEGORY_ALIASES = {
  process: 'operational',
} as const satisfies Readonly<Record<string, PainPointCategory>>;

type LegacyPainPointCategory = keyof typeof LEGACY_PAIN_POINT_CATEGORY_ALIASES;
type StoredPainPointCategory = PainPointCategory | LegacyPainPointCategory;

function normalizeStoredPainPointCategory(value: unknown): unknown {
  if (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(LEGACY_PAIN_POINT_CATEGORY_ALIASES, value)
  ) {
    return LEGACY_PAIN_POINT_CATEGORY_ALIASES[value as LegacyPainPointCategory];
  }
  return value;
}

/**
 * Return every retained storage spelling that belongs to one canonical
 * category. Firestore category queries must include these aliases or a row
 * that the shared read boundary can normalize would still be invisible.
 */
export function getStoredPainPointCategories(
  category: PainPointCategory,
): readonly StoredPainPointCategory[] {
  const legacyAliases = Object.entries(LEGACY_PAIN_POINT_CATEGORY_ALIASES)
    .filter(([, canonical]) => canonical === category)
    .map(([legacy]) => legacy as LegacyPainPointCategory);
  return [category, ...legacyAliases];
}

/**
 * Canonical new-pain-point defaults — identical to the create form's
 * `EMPTY_PAIN_POINT_FORM_VALUES` (`PainPointSheet.tsx`). A triage-approved
 * pain point IS a newly created pain point, so applying these defaults is the
 * documented product contract, not fabricated facts.
 */
export const DEFAULT_NEW_PAIN_POINT_SEVERITY: PainPointSeverity = 'medium';
export const DEFAULT_NEW_PAIN_POINT_STATUS: PainPointStatus = 'identified';
export const DEFAULT_NEW_PAIN_POINT_CATEGORY: PainPointCategory = 'operational';

const painPointSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.enum(['manual', 'interview', 'survey', 'agent', 'signal']),
    agentId: z.string().optional(),
    signalId: z.string().optional(),
    intervieweeRole: z.string().optional(),
    discoveredAt: z.number().finite(),
  }),
  z.object({
    type: z.literal('import'),
    importSource: z.string().optional(),
    createdAt: z.number().finite().optional(),
    discoveredAt: z.number().finite().optional(),
  }),
]);

/**
 * Stored-domain boundary. It mirrors every field in `PainPoint`, while allowing
 * additional forward-compatible storage fields. Only the five legacy list
 * fields and `description` may be absent and receive neutral values.
 */
const storedPainPointSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    slug: z.string().min(1),
    description: z.string().default(''),
    severity: z.enum(['critical', 'high', 'medium', 'low']),
    category: z.preprocess(
      normalizeStoredPainPointCategory,
      z.enum([
        'operational',
        'customer',
        'regulatory',
        'technical',
        'market',
        'financial',
        'talent',
        'other',
      ]),
    ),
    affectedOrgUnitIds: z.array(z.string()).default([]),
    status: z.enum(['identified', 'validated', 'being_addressed', 'resolved']),
    estimatedImpact: z.number().finite().optional(),
    actualImpact: z.number().finite().optional(),
    impactDescription: z.string().optional(),
    linkedPrototypeIds: z.array(z.string()).default([]),
    linkedTechnologyIds: z.array(z.string()).default([]),
    linkedInitiativeIds: z.array(z.string()).default([]),
    rootCauses: z.array(z.string()).optional(),
    source: painPointSourceSchema.optional(),
    tags: z.array(z.string()).default([]),
    identifiedAt: z.number().finite().optional(),
    validatedAt: z.number().finite().optional(),
    resolvedAt: z.number().finite().optional(),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
  })
  .passthrough();

/**
 * Coerce an unknown value into a clean `string[]`, preserving only string
 * entries and their exact ordering. Non-arrays yield `[]`; arrays with
 * non-string junk drop the junk rather than stringify it into a plausible tag.
 */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function coerceEnum<T extends string>(
  value: unknown,
  valid: ReadonlySet<T>,
  fallback: T,
): T {
  return typeof value === 'string' && valid.has(value as T) ? (value as T) : fallback;
}

export interface PainPointApprovalClassification {
  severity: PainPointSeverity;
  status: PainPointStatus;
  category: PainPointCategory;
  usesDefaultSeverity: boolean;
  usesDefaultStatus: boolean;
  usesDefaultCategory: boolean;
}

/**
 * Resolve the exact classifications approval will persist. This is exported so
 * the review UI and writer cannot disagree about implicit create-form defaults.
 */
export function resolvePainPointApprovalClassification(
  rawData: Record<string, unknown>,
): PainPointApprovalClassification {
  return {
    severity: coerceEnum(
      rawData.severity,
      VALID_SEVERITIES,
      DEFAULT_NEW_PAIN_POINT_SEVERITY,
    ),
    status: coerceEnum(
      rawData.status,
      VALID_STATUSES,
      DEFAULT_NEW_PAIN_POINT_STATUS,
    ),
    category: coerceEnum(
      rawData.category,
      VALID_CATEGORIES,
      DEFAULT_NEW_PAIN_POINT_CATEGORY,
    ),
    usesDefaultSeverity:
      typeof rawData.severity !== 'string' ||
      !VALID_SEVERITIES.has(rawData.severity as PainPointSeverity),
    usesDefaultStatus:
      typeof rawData.status !== 'string' ||
      !VALID_STATUSES.has(rawData.status as PainPointStatus),
    usesDefaultCategory:
      typeof rawData.category !== 'string' ||
      !VALID_CATEGORIES.has(rawData.category as PainPointCategory),
  };
}

/**
 * READ boundary — normalize a valid stored PainPoint row that may omit the five
 * legacy list fields. Missing lists become `[]`; malformed lists or invalid
 * required scalar facts fail closed. This prevents arbitrary storage data from
 * being advertised as a complete `PainPoint` and avoids silently erasing
 * malformed link facts during later read/modify/write operations.
 *
 * UX-067: a sparse/malformed row still fails the whole list closed (the
 * accepted UX-059 trade-off), but the thrown error carries a bounded,
 * operator-readable message. The raw Zod issue array — which names internal
 * field paths (`id`, `severity`, `createdAt`, …) and schema codes — is never
 * surfaced to the operator UI; it stays on the thrown error's `cause` for
 * server-side diagnostics only.
 */
export function normalizePainPointForRead(raw: unknown): PainPoint {
  try {
    // The schema exhaustively validates the current PainPoint contract; the cast
    // only bridges Zod's passthrough output type to the matching domain interface.
    return storedPainPointSchema.parse(raw) as PainPoint;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(
        'One or more pain point records are malformed and could not be loaded. If this persists, contact support.',
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * WRITE boundary — coalesce the assembled triage-approval payload into the
 * canonical library-safe PainPoint data for `adminCreateEntity`. Required array
 * fields default to `[]` (a newly approved pain point has no links yet) and
 * keep only string entries. Required enum fields honor an explicitly-provided
 * valid value and otherwise fall back to the new-pain-point defaults the create
 * form uses; a malformed enum is dropped, not coerced into a plausible fact.
 * `description` defaults to `''`. The returned object is suitable to pass
 * directly to `adminCreateEntity('painPoint', data)`.
 */
export function coalescePainPointApprovalData(
  rawData: Record<string, unknown>,
): Record<string, unknown> {
  const data: Record<string, unknown> = { ...rawData };
  const classification = resolvePainPointApprovalClassification(rawData);

  for (const field of PAIN_POINT_ARRAY_FIELDS) {
    data[field] = toStringArray(data[field]);
  }

  data.severity = classification.severity;
  data.status = classification.status;
  data.category = classification.category;

  if (typeof data.description !== 'string') {
    data.description = '';
  }

  return data;
}
