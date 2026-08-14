/**
 * @file lib/inngest/domain-outcome.ts
 * @description OBS-001 — the seam that lets an Inngest function tell the
 * transport layer how its BUSINESS work ended, separately from whether the run
 * itself finished.
 *
 * **The bug this closes.** `jobRunTrackingMiddleware`'s `finished` hook writes
 * `status: 'completed'` whenever `result.error === undefined`. That is a correct
 * statement about the transport and a false one about the work: in the TEST-027
 * evidence the Creator run was recorded transport-completed while its canonical
 * Mission and AgentRun were `failed` and no Report existed. `/api/agents/stats`
 * then counted that row in its success numerator.
 *
 * **The fix is a declaration, not an inference.** The middleware cannot look at
 * an arbitrary return value and know what "success" means for that function —
 * guessing is how the lie got there. So a function that owns a business outcome
 * attaches one explicitly:
 *
 * ```ts
 * return declareDomainOutcome(
 *   { missionId, duration },
 *   { outcome: 'failed', reason: 'no-deliverable' }
 * );
 * ```
 *
 * The declaration travels inside the returned data under a reserved key, so it
 * needs no SDK support and no change to any function's signature. The
 * middleware strips it before persisting `output`, so the recorded output shape
 * is unchanged for existing readers (e.g. the Defense Minister join, which
 * parses `verify-entity`/`verify-edge` outputs by schema).
 *
 * **Undeclared is a first-class state.** A function that declares nothing gets
 * `source: 'undeclared'` and NO `outcome`. Consumers must render that as
 * "outcome not declared" — never as success. That default is what makes this
 * safe to land incrementally: the ~64 registered functions that never declare
 * anything stop being counted as business successes the moment this ships,
 * without touching one of them.
 */

import { isDomainOutcome, type DomainOutcome } from '@/lib/observability/terminal-outcome';

/**
 * Reserved key carrying the declaration inside an Inngest function's return
 * value. Double-underscored and namespaced so it cannot collide with a domain
 * field, and stripped from the persisted `output` by `splitDomainOutcome`.
 */
export const DOMAIN_OUTCOME_FIELD = '__domainOutcome' as const;

/** Bound on the free-text reason so a provider error can never bloat the record. */
export const MAX_DOMAIN_OUTCOME_REASON_LENGTH = 200;

/**
 * Where a persisted domain outcome came from. Provenance is persisted alongside
 * the outcome because "the function said it failed" and "the function never
 * said anything" are different facts that must not be renderable as the same
 * pill.
 *
 * - `declared` — the function itself declared this outcome. Authoritative.
 * - `transport-failure` — the run threw and exhausted its retries. The business
 *   work provably did not deliver, so `failed` is *entailed*, not guessed.
 * - `transport-cancellation` — Inngest cancelled the run server-side; the SDK
 *   was never re-entered, so no declaration was possible (ARUN-023).
 * - `transport-interrupted` — the runtime died and the queue state was lost
 *   (LOCAL-013). The business outcome is genuinely UNKNOWABLE, so this source
 *   carries no outcome at all.
 * - `undeclared` — the run finished cleanly and declared nothing.
 * - `reconciled` — a later terminal writer (`onFailure`) read the canonical
 *   persisted store and refined a transport entailment, e.g. proving a throw was
 *   a preflight refusal that spent nothing. Outranks every `transport-*` source
 *   and is outranked by `declared`.
 */
export const DOMAIN_OUTCOME_SOURCES = [
  'declared',
  'reconciled',
  'transport-failure',
  'transport-cancellation',
  'transport-interrupted',
  'undeclared',
] as const;

export type DomainOutcomeSource = (typeof DOMAIN_OUTCOME_SOURCES)[number];

export function isDomainOutcomeSource(value: unknown): value is DomainOutcomeSource {
  return typeof value === 'string' && (DOMAIN_OUTCOME_SOURCES as readonly string[]).includes(value);
}

export interface DomainOutcomeDeclaration {
  outcome: DomainOutcome;
  /**
   * Short machine-ish token explaining the outcome (`'no-deliverable'`,
   * `'children-failed'`, `'superseded-attempt'`). Bounded and sanitised: it is
   * an operator diagnostic, not a place to echo provider prose or user input.
   */
  reason?: string;
}

/**
 * Sanitise a declared reason: collapse whitespace, drop control characters, and
 * bound the length. Returns `undefined` for anything that reduces to empty, so
 * an empty string is never persisted as a meaningful reason.
 */
export function normalizeDomainOutcomeReason(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Escaped rather than literal control bytes: embedding real NUL/0x1F characters
  // in source makes the file read as binary to grep and other line-oriented tools.
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.slice(0, MAX_DOMAIN_OUTCOME_REASON_LENGTH);
}

/**
 * Attach a business-outcome declaration to an Inngest function's return value.
 *
 * `data` is spread first so the declaration always wins — a function cannot
 * accidentally shadow its own declaration with a domain field of the same name.
 */
export function declareDomainOutcome<T extends Record<string, unknown>>(
  data: T,
  declaration: DomainOutcomeDeclaration
): T & { [DOMAIN_OUTCOME_FIELD]: DomainOutcomeDeclaration } {
  const reason = normalizeDomainOutcomeReason(declaration.reason);
  return {
    ...data,
    [DOMAIN_OUTCOME_FIELD]: {
      outcome: declaration.outcome,
      ...(reason ? { reason } : {}),
    },
  };
}

/**
 * Read a declaration out of an arbitrary Inngest return value.
 *
 * Fail-closed: an unrecognised outcome string, a non-object envelope, or a
 * missing field all yield `undefined`. A malformed declaration must degrade to
 * *undeclared*, never to a coerced success.
 */
export function readDomainOutcomeDeclaration(data: unknown): DomainOutcomeDeclaration | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const envelope = (data as Record<string, unknown>)[DOMAIN_OUTCOME_FIELD];
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) return undefined;
  const outcome = (envelope as Record<string, unknown>).outcome;
  if (!isDomainOutcome(outcome)) return undefined;
  const reason = normalizeDomainOutcomeReason((envelope as Record<string, unknown>).reason);
  return { outcome, ...(reason ? { reason } : {}) };
}

/**
 * Split a return value into the declaration and the output to persist.
 *
 * The reserved key is removed from `output` so `JobRun.output` keeps exactly
 * the shape existing readers already parse. A non-object return value (a
 * scalar, an array, `undefined`) carries no declaration and passes through
 * untouched for the caller's own wrapping rules.
 */
export function splitDomainOutcome(data: unknown): {
  declaration: DomainOutcomeDeclaration | undefined;
  output: unknown;
} {
  const declaration = readDomainOutcomeDeclaration(data);
  if (declaration === undefined) return { declaration: undefined, output: data };
  const rest = { ...(data as Record<string, unknown>) };
  delete rest[DOMAIN_OUTCOME_FIELD];
  return { declaration, output: rest };
}

/**
 * The domain fields to persist on a `JobRun`, resolved from a transport event.
 *
 * One function, four call sites (`recordJobComplete`, `recordJobFailure`,
 * `recordJobCancelled`, interrupted-run recovery) so the transport→domain
 * mapping cannot fork into four hand-rolled copies that drift.
 */
export function resolveJobRunDomainFields(input: {
  transport: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  declaration?: DomainOutcomeDeclaration | undefined;
}): { domainOutcome?: DomainOutcome; domainOutcomeSource: DomainOutcomeSource; domainOutcomeReason?: string } {
  // A declaration always wins when present: the function observed its own work,
  // the transport only observed its own delivery. This matters for the
  // checkpoint-recovery case, where a run legitimately declares `partial` and
  // then throws during final persistence — the recovered output is real.
  if (input.declaration) {
    return {
      domainOutcome: input.declaration.outcome,
      domainOutcomeSource: 'declared',
      ...(input.declaration.reason ? { domainOutcomeReason: input.declaration.reason } : {}),
    };
  }

  switch (input.transport) {
    case 'failed':
      return { domainOutcome: 'failed', domainOutcomeSource: 'transport-failure' };
    case 'cancelled':
      return { domainOutcome: 'cancelled', domainOutcomeSource: 'transport-cancellation' };
    case 'interrupted':
      // Deliberately NO outcome: the runtime died mid-run with the queue state
      // gone, so whether the work delivered is unknowable. Inventing `failed`
      // here would be the same class of lie in the opposite direction.
      return { domainOutcomeSource: 'transport-interrupted' };
    case 'completed':
      return { domainOutcomeSource: 'undeclared' };
  }
}
