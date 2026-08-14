/**
 * @file effective-model.ts
 * @description AI-029 — resolve which model actually served a request.
 *
 * The requested model string is an intent, not a fact. A provider may route
 * an alias or a preview id to a different concrete model, so recording the
 * request as if it were the response makes run history, per-model usage
 * breakdowns, and cost attribution quietly wrong.
 *
 * Gemini reports the served model as `usageMetadata`-adjacent
 * `response.modelVersion`, prefixed `models/` in some SDK shapes. Normalize to
 * the bare id so it matches the rate-card key space, and bound the length the
 * way the AgentRun schema bounds `model` (200 chars) so a malformed provider
 * value can't be persisted whole.
 */

const MAX_MODEL_ID_LENGTH = 200;

/**
 * The provider's own model id, normalized — or `undefined` when it reported
 * nothing usable. Use this when the caller needs to KNOW whether the provider
 * spoke (e.g. to keep the requested model as a separate fact); use
 * {@link resolveEffectiveModel} when a string is required either way.
 */
export function readProviderModel(providerModel: unknown): string | undefined {
  if (typeof providerModel !== 'string') return undefined;
  const normalized = providerModel.trim().replace(/^models\//, '');
  if (!normalized) return undefined;
  return normalized.slice(0, MAX_MODEL_ID_LENGTH);
}

/**
 * The model to RECORD for an operation: the provider's reported model when it
 * gave one, else the requested model.
 *
 * @param requestedModel - what the caller asked for
 * @param providerModel - what the provider says it served (may be absent)
 */
export function resolveEffectiveModel(requestedModel: string, providerModel: unknown): string {
  return readProviderModel(providerModel) ?? requestedModel;
}
