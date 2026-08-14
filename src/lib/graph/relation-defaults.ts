import { config } from '@/lib/config';

export interface RelationDefaultsInput {
  source: 'user' | 'agent' | 'system';
  assertedBy: string;
  confidence?: number;
  overrides?: Record<string, unknown>;
}

export interface RelationDefaults {
  relationId: string;
  t_observed: string;
  t_valid: string;
  t_invalidated: string | null;
  aiSuggested: boolean;
  confidence: number;
  /**
   * B0 two-field confidence authority: the asserter's claimed value, minted
   * equal to `confidence` and refreshed on every re-sync (never coalesced).
   */
  assertedConfidence: number;
  /**
   * B0 two-field confidence authority: the system's belief. Minted equal to
   * `confidence` on first write; writers must `coalesce(existing, incoming)`
   * on re-sync so a later recalibration is never clobbered.
   */
  effectiveConfidence: number;
  claimStatus: 'curated' | 'proposed' | 'rejected' | 'derived';
  assertedBy: string;
  createdAt: number;
  [extra: string]: unknown;
}

/**
 * The default confidence to mint for a relation with no explicit value.
 *
 * Task 16 (A1): confidence used to be minted on a 0-1 scale (0.5 / 1.0) while
 * the rest of the contract (Relation.confidence, the Relation Write Contract
 * gate, shouldMaterializeAssertion) is 0-100. `scale100` defaults to the
 * `confidenceScale100Enabled` kill-switch so every caller flips together.
 */
export function defaultRelationConfidence(
  aiSuggested: boolean,
  scale100: boolean = config.flags.confidenceScale100Enabled
): number {
  if (scale100) return aiSuggested ? 50 : 100;
  return aiSuggested ? 0.5 : 1.0;
}

/**
 * Normalize a legacy 0-1 display-scale confidence to the 0-100 contract.
 * Values already on the 0-100 scale (or anything outside (0,1]) pass through
 * unchanged — this is a one-way heal, not a clamp.
 */
export function normalizeConfidence100(value: number): number {
  if (value > 0 && value <= 1) return Math.round(value * 100);
  return value;
}

export function buildRelationDefaults(input: RelationDefaultsInput): RelationDefaults {
  const now = new Date().toISOString();
  const aiSuggested = input.source === 'agent';
  // B0: mint confidence, assertedConfidence, and effectiveConfidence from the
  // SAME resolved value — the two-field split starts life as a no-op (both
  // fields agree with the legacy field); divergence only happens later via a
  // recalibration writer that coalesces effectiveConfidence instead of
  // overwriting it.
  const resolvedConfidence = input.confidence ?? defaultRelationConfidence(aiSuggested);
  const base: RelationDefaults = {
    relationId: `rel-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    t_observed: now,
    t_valid: now,
    t_invalidated: null,
    aiSuggested,
    confidence: resolvedConfidence,
    assertedConfidence: resolvedConfidence,
    effectiveConfidence: resolvedConfidence,
    claimStatus: aiSuggested ? 'proposed' : 'curated',
    assertedBy: input.assertedBy,
    createdAt: Date.now(),
  };
  return { ...base, ...(input.overrides ?? {}) };
}
