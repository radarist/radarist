/**
 * @file lib/verification-output-contract.ts
 * @description OBS-007 — the ONE versioned contract for Defense Minister
 * verification JobRun output.
 *
 * Three parties used to describe this payload independently, and they disagreed:
 *
 * - the producers (`verify-entity`, `verify-edge`) emit an integer confidence on
 *   the canonical 0-100 scale;
 * - the Jobs reader validated `score` as 0-1 and rejected the whole payload;
 * - the tests invented 0-1 fixtures, so every layer stayed green while the
 *   operator surface blanked facts that were sitting in Firestore.
 *
 * The fix is not a wider bound in the reader. It is a single module that both
 * produces and parses the payload, so the scale cannot fork again: producers
 * build output through `summarizeVerificationSources` /
 * `buildSmartEntityVerificationOutput`, and the reader parses it through
 * `parseVerificationOutput`. A test that fabricates a shape by hand is no longer
 * testing the contract.
 *
 * ## Independent fields
 *
 * `parseVerificationOutput` is deliberately NOT a whole-object `zod.parse`. A
 * single unreadable field must not erase lineage the record still proves: an
 * out-of-range score says nothing about whether `relationId` is a valid target
 * or whether a provider receipt exists. Fields are parsed one at a time; the
 * unreadable ones are named in `degradedFields` and every other fact survives.
 *
 * Whole-payload refusal is reserved for the two cases where mining the object at
 * all would be wrong: a hostile payload, and a terminal run whose output shares
 * no field with this contract.
 */

import { z } from 'zod';

/**
 * Bumped only on a breaking change to the payload shape. Recorded on produced
 * output so a future reader can tell which contract minted a stored row.
 */
export const VERIFICATION_OUTPUT_CONTRACT_VERSION = 1;

/** The canonical confidence scale. Integer 0-100, never a 0-1 fraction. */
export const VERIFICATION_SCORE_MIN = 0;
export const VERIFICATION_SCORE_MAX = 100;

/**
 * `verified` requires REPLICATION (VERIFY-001). Shared so the entity and edge
 * producers cannot drift into two different replication rules.
 */
export const MIN_CONFIRMING_FOR_VERIFIED = 2;

/** Bounds on surfaced strings, so a hostile record cannot inflate the read model. */
const MAX_ID_LENGTH = 200;
const MAX_VERIFIER_MODEL_LENGTH = 100;
const MAX_REASONING_LENGTH = 500;

export type VerificationVerdict = 'verified' | 'unverified' | 'disputed';
export type VerificationStrictness = 'lenient' | 'standard' | 'strict';

export interface VerificationSource {
  /** Free-form provenance label (url or check name); never surfaced raw. */
  label: string;
  verdict: 'confirming' | 'contradicting' | 'inconclusive';
}

/** The scalar verdict block both producers emit. */
export interface VerificationVerdictOutput {
  status: VerificationVerdict;
  score: number;
  sourcesChecked: number;
  sourcesConfirming: number;
  sourcesContradicting: number;
  verifierModel: string;
  reasoning: string;
  contractVersion: number;
}

/**
 * Derive the verdict block from decisive source checks.
 *
 * This is the production scoring rule for BOTH `verify-entity`'s active recheck
 * and `verify-edge` — previously duplicated byte-for-byte in each file. Score is
 * the confirming share of decisive checks on the 0-100 scale; an all-inconclusive
 * set is 50 (undetermined), not 0 (disputed).
 */
export function summarizeVerificationSources(
  sources: readonly VerificationSource[],
  verifierModel: string
): VerificationVerdictOutput {
  const sourcesConfirming = sources.filter((s) => s.verdict === 'confirming').length;
  const sourcesContradicting = sources.filter((s) => s.verdict === 'contradicting').length;
  const decisive = sourcesConfirming + sourcesContradicting;
  const score = decisive > 0 ? Math.round((sourcesConfirming / decisive) * 100) : 50;
  // VERIFY-001 — a single confirming check scores 100 on ratio alone. Without a
  // second independent source it can be 'unverified' at most.
  const replicated = sourcesConfirming >= MIN_CONFIRMING_FOR_VERIFIED;
  const status: VerificationVerdict = score >= 80 && replicated ? 'verified' : score >= 50 ? 'unverified' : 'disputed';

  return {
    status,
    score,
    sourcesChecked: sources.length,
    sourcesConfirming,
    sourcesContradicting,
    verifierModel,
    reasoning: `${sourcesConfirming}/${decisive} decisive sources confirm; ${sources.length} total checked${
      score >= 80 && !replicated ? ' (held at unverified: single unreplicated source)' : ''
    }`,
    contractVersion: VERIFICATION_OUTPUT_CONTRACT_VERSION,
  };
}

export interface SmartAggregateScore {
  status: VerificationVerdict;
  score: number;
  observationCount: number;
  weightedConfirming: number;
  weightedContradicting: number;
}

/**
 * Build the verdict block for the observation-aggregation path.
 *
 * Source counts here are decay-weighted and therefore legitimately FRACTIONAL
 * (e.g. 2.75 confirming). Any consumer that validates these as integers rejects
 * correct production output — which is exactly what the Jobs reader used to do.
 */
export function buildSmartEntityVerificationOutput(
  aggregate: SmartAggregateScore
): VerificationVerdictOutput & { strictnessLevel: VerificationStrictness } {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    status: aggregate.status,
    score: aggregate.score,
    sourcesChecked: aggregate.observationCount,
    sourcesConfirming: round2(aggregate.weightedConfirming),
    sourcesContradicting: round2(aggregate.weightedContradicting),
    verifierModel: 'defense-minister-smart-v1',
    reasoning:
      `Aggregated ${aggregate.observationCount} observations (decay-weighted): ` +
      `confirming=${aggregate.weightedConfirming}, contradicting=${aggregate.weightedContradicting}`,
    strictnessLevel: 'standard',
    contractVersion: VERIFICATION_OUTPUT_CONTRACT_VERSION,
  };
}

export const VERIFICATION_OUTPUT_FIELDS = [
  'entityId',
  'relationId',
  'sourceEntityId',
  'targetEntityId',
  'status',
  'score',
  'verifierModel',
  'reasoning',
  'sourcesChecked',
  'sourcesConfirming',
  'sourcesContradicting',
  'strictnessLevel',
] as const;

export type VerificationOutputFieldName = (typeof VERIFICATION_OUTPUT_FIELDS)[number];

export interface VerificationOutputFields {
  entityId?: string;
  relationId?: string;
  sourceEntityId?: string;
  targetEntityId?: string;
  status?: VerificationVerdict;
  score?: number;
  verifierModel?: string;
  sourcesChecked?: number;
  sourcesConfirming?: number;
  sourcesContradicting?: number;
  strictnessLevel?: VerificationStrictness;
}

export type VerificationOutputRefusal = 'hostile-output' | 'malformed-output';

export type VerificationOutputParse =
  | {
      ok: true;
      fields: VerificationOutputFields;
      /** Present-but-unreadable fields, named so the UI can say WHAT degraded. */
      degradedFields: VerificationOutputFieldName[];
    }
  | { ok: false; reason: VerificationOutputRefusal };

const idSchema = z.string().min(1).max(MAX_ID_LENGTH);
const verdictSchema = z.enum(['verified', 'unverified', 'disputed']);
/** Canonical 0-100. Not `.int()`: a stored non-integer is in-range, not a lie. */
const scoreSchema = z.number().finite().min(VERIFICATION_SCORE_MIN).max(VERIFICATION_SCORE_MAX);
/** Deliberately NOT `.int()` — smart-path weights are fractional by design. */
const weightedCountSchema = z.number().finite().nonnegative();
const checkedCountSchema = z.number().int().nonnegative();

const FIELD_SCHEMAS: Record<VerificationOutputFieldName, z.ZodTypeAny> = {
  entityId: idSchema,
  relationId: idSchema,
  sourceEntityId: idSchema,
  targetEntityId: idSchema,
  status: verdictSchema,
  score: scoreSchema,
  verifierModel: z.string().min(1).max(MAX_VERIFIER_MODEL_LENGTH),
  reasoning: z.string().max(MAX_REASONING_LENGTH),
  sourcesChecked: checkedCountSchema,
  sourcesConfirming: weightedCountSchema,
  sourcesContradicting: weightedCountSchema,
  strictnessLevel: z.enum(['lenient', 'standard', 'strict']),
};

/** Fields an `entity` payload may carry; an edge id on an entity run is not its target. */
const ENTITY_FIELDS = new Set<VerificationOutputFieldName>([
  'entityId',
  'status',
  'score',
  'verifierModel',
  'reasoning',
  'sourcesChecked',
  'sourcesConfirming',
  'sourcesContradicting',
  'strictnessLevel',
]);

const EDGE_FIELDS = new Set<VerificationOutputFieldName>([
  'relationId',
  'sourceEntityId',
  'targetEntityId',
  'status',
  'score',
  'verifierModel',
  'reasoning',
  'sourcesChecked',
  'sourcesConfirming',
  'sourcesContradicting',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const HOSTILE_KEY_MARKERS = ['$', '__proto__', 'constructor', '<script', 'javascript:'];
const HOSTILE_VALUE_MARKERS = ['<script', 'javascript:'];

/**
 * Fail-closed screen for payloads that must never be mined for lineage.
 *
 * Prototype-pollution keys and injection markers disqualify the WHOLE object:
 * once a record is hostile, a field that happens to validate is not evidence.
 */
export function isHostileVerificationOutput(output: Record<string, unknown>): boolean {
  if (Object.keys(output).some((k) => HOSTILE_KEY_MARKERS.some((m) => k.includes(m)))) return true;
  for (const value of Object.values(output)) {
    if (typeof value === 'string' && HOSTILE_VALUE_MARKERS.some((m) => value.includes(m))) return true;
  }
  return false;
}

export interface ParseVerificationOutputOptions {
  /**
   * True when the JobRun reached a terminal transport status. A terminal run
   * whose output shares no field with this contract is genuinely unreadable; a
   * still-running run simply has not written one yet.
   */
  terminal: boolean;
}

/**
 * Parse a stored verification output field by field.
 *
 * Never throws. Returns every field it can prove, names the ones it cannot, and
 * refuses the payload as a whole only when mining it would be unsafe or
 * meaningless.
 */
export function parseVerificationOutput(
  output: unknown,
  kind: 'entity' | 'edge',
  options: ParseVerificationOutputOptions
): VerificationOutputParse {
  // An absent output is not a malformed one — a queued or running job has none.
  if (output === undefined || output === null) {
    return { ok: true, fields: {}, degradedFields: [] };
  }
  if (!isPlainObject(output)) {
    return { ok: false, reason: 'malformed-output' };
  }
  if (isHostileVerificationOutput(output)) {
    return { ok: false, reason: 'hostile-output' };
  }

  const allowed = kind === 'entity' ? ENTITY_FIELDS : EDGE_FIELDS;
  const present = VERIFICATION_OUTPUT_FIELDS.filter((f) => allowed.has(f) && output[f] !== undefined);

  if (options.terminal && present.length === 0) {
    return { ok: false, reason: 'malformed-output' };
  }

  const fields: VerificationOutputFields = {};
  const degradedFields: VerificationOutputFieldName[] = [];

  for (const field of present) {
    const result = FIELD_SCHEMAS[field].safeParse(output[field]);
    if (result.success) {
      // Each key is a literal from VERIFICATION_OUTPUT_FIELDS, validated above.
      (fields as Record<string, unknown>)[field] = result.data;
    } else {
      degradedFields.push(field);
    }
  }

  return { ok: true, fields, degradedFields };
}
