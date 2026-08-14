/**
 * @file lib/agent-run-usage.ts
 * @description ARUN-020 — the ONE authoritative usage snapshot for an
 * `AgentRun` document, and the ONE rule for reconciling it with a live SSE
 * heartbeat.
 *
 * `mission-usage.ts` already does this for `missions` docs. AgentRuns had no
 * equivalent, so four surfaces re-derived the same numbers inline and drifted
 * in two distinct ways:
 *
 *  1. **Terminal handoff.** A chat turn publishes its usage twice — once when
 *     the row is created and again once the durable receipts are known. Those
 *     two writes used two different bases, so the same run could publish 115
 *     tokens and then silently republish 109. Fixed at the source in
 *     `lib/ai/chat-accounting.ts` (both writes fold the same provider facts);
 *     `tokenUsageProvenance` is what makes the remaining honest cases —
 *     partially reported, wholly unreported — visible instead of silent.
 *  2. **In-flight lend.** `assembleRows` lends a live SSE `tokensUsed` into the
 *     LIST row via `Math.max`, but the run DETAIL read only the durable doc. An
 *     in-flight run therefore showed the live count in the list and the (lower,
 *     or unknown) persisted count in its detail. {@link reconcileRunTokens} is
 *     that lend, extracted so both surfaces apply it identically.
 *
 * Pure module — no Firebase/React imports — safe for client row mappers and the
 * admin-SDK aggregation code alike.
 */

/**
 * How much of a run's token usage the PROVIDER actually reported.
 *
 * - `provider-reported` — every provider response in the turn reported usage
 *   (a turn with no provider response at all is a real, reported zero).
 * - `partially-reported` — at least one response reported usage and at least
 *   one did not. The persisted total is a real measurement of the responses
 *   that reported, i.e. a lower bound, and is shown as a number.
 * - `unreported` — no response reported any usage. The token count is genuinely
 *   unknown; a persisted `{0,0}` here would read as a measured zero, so the
 *   snapshot surfaces `tokens: undefined` and renderers show "—".
 */
export type AgentRunUsageProvenance = 'provider-reported' | 'partially-reported' | 'unreported';

export interface AgentRunUsageSnapshot {
  /** Total persisted tokens, or undefined when nothing provable was recorded. */
  tokens: number | undefined;
  /** Zero-defaulted input tokens for additive aggregation. */
  input: number;
  /** Zero-defaulted output tokens for additive aggregation. */
  output: number;
  /** Absent on legacy rows written before provenance was recorded. */
  provenance: AgentRunUsageProvenance | undefined;
  /** True when the run's token total cannot be stated as a measurement. */
  unavailable: boolean;
  /**
   * True when the total is a proven LOWER BOUND rather than the whole turn —
   * some provider response in the run reported no usage at all. Distinct from
   * `unavailable`: the number is real, it is just not everything.
   */
  partiallyReported: boolean;
}

export interface AgentRunUsageInput {
  tokenUsage?: { input: number; output: number };
  tokenUsageProvenance?: AgentRunUsageProvenance;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * The single read rule for an AgentRun doc's usage.
 *
 * An ABSENT `tokenUsage` is unknown (legacy docs reach the client unvalidated,
 * so malformed counters are treated the same way). A persisted `{0,0}` is a
 * real measurement and stays 0 — unless the provenance proves the provider
 * reported nothing, in which case the zero is not a measurement at all.
 */
export function agentRunUsageSnapshot(run: AgentRunUsageInput): AgentRunUsageSnapshot {
  const provenance = run.tokenUsageProvenance;
  const raw = run.tokenUsage;
  const measured = raw !== undefined && nonNegativeFinite(raw.input) && nonNegativeFinite(raw.output);
  const input = measured ? raw.input : 0;
  const output = measured ? raw.output : 0;
  // `unreported` is the provider's own statement that it counted nothing. The
  // stored 0s exist only because the field is required; they are not a
  // measurement and must never render as "0 tokens".
  const unavailable = !measured || provenance === 'unreported';
  return {
    tokens: unavailable ? undefined : input + output,
    input,
    output,
    provenance,
    unavailable,
    partiallyReported: measured && provenance === 'partially-reported',
  };
}

/**
 * The ONE live-lend rule, shared by the Runs list (`assembleRows`) and the run
 * detail (`buildRunDetail`).
 *
 * A research/report mission doc only gets `tokenUsage` written at completion,
 * so its durable in-flight row reads unknown; MISSION-001 puts the real running
 * count on the SSE heartbeat. `max` never regresses a count the durable row
 * already has (e.g. the final total landing just before the last heartbeat),
 * and a durable row with NO count adopts the live one. When NEITHER side knows
 * a count the result stays unknown — never a fabricated 0.
 */
export function reconcileRunTokens(durable: number | undefined, live: number | undefined): number | undefined {
  if (durable === undefined && live === undefined) return undefined;
  return Math.max(durable ?? 0, live ?? 0);
}
