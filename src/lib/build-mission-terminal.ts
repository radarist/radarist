/**
 * Pure terminal classification for build sessions and supervisor stop gates.
 *
 * Provider result fields are evidence, not authority by themselves. In
 * particular, a high turn count is only a turn-limit stop when the provider
 * also emits an explicit turn-limit signature. Runtime failures always win
 * over that inference.
 */

export const BUILD_TERMINAL_REASONS = [
  'completed',
  'runtime-failure',
  'budget-exhausted',
  'turns-exhausted',
  'session-cap-exhausted',
  'review-failure',
  'cancelled',
] as const;

export type BuildTerminalReason = (typeof BUILD_TERMINAL_REASONS)[number];

export const BUILD_TERMINAL_BASES = [
  'completed-result',
  'session-timeout',
  'missing-result',
  'malformed-result',
  'invalid-launch-bound',
  'invalid-wrapper-exit',
  'nonzero-wrapper-exit',
  'provider-api-error',
  'provider-budget-limit',
  'provider-turn-limit',
  'provider-reported-error',
  'unexpected-result-subtype',
  'supervisor-runtime-failure',
  'supervisor-budget-limit',
  'supervisor-session-cap',
  'review-gate',
  'user-cancelled',
] as const;

export type BuildTerminalBasis = (typeof BUILD_TERMINAL_BASES)[number];

export interface BuildTerminalEvidence {
  source: 'session' | 'supervisor';
  subtype: string | null;
  isError: boolean | null;
  apiStatus: number | null;
  exitCode: number | null;
  resultExcerpt: string | null;
  observedTurns: number | null;
  launchedMaxTurns: number | null;
}

export interface BuildTerminalClassification {
  reason: BuildTerminalReason;
  basis: BuildTerminalBasis;
  evidence: BuildTerminalEvidence;
}

export interface BuildSessionTerminalInput {
  source: 'session';
  /** False when the bounded watcher timed out before a durable terminal result. */
  sessionDone: boolean;
  /** Wrapper/sidecar exit marker. Missing or non-zero is a runtime failure. */
  exitCode: unknown;
  /** Exact max-turn value supplied to this provider launch. */
  launchedMaxTurns: unknown;
  /** Raw or parsed provider result. Kept unknown so malformed results fail closed. */
  result: unknown;
}

export type BuildSupervisorTerminalReason =
  | 'runtime-failure'
  | 'budget-exhausted'
  | 'session-cap-exhausted'
  | 'review-failure'
  | 'cancelled';

export interface BuildSupervisorTerminalInput {
  source: 'supervisor';
  reason: BuildSupervisorTerminalReason;
}

export type BuildTerminalInput = BuildSessionTerminalInput | BuildSupervisorTerminalInput;

interface ParsedSessionResult {
  subtype: string;
  numTurns: number;
  isError: boolean | undefined;
  apiStatus: number | undefined;
  resultText: string | undefined;
}

const RESULT_EXCERPT_MAX_CHARS = 1_000;
const SUBTYPE_MAX_CHARS = 200;

function boundedText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\0/g, '').trim();
  return normalized ? normalized.slice(0, maxChars) : null;
}

function normalizedNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizedPositiveInteger(value: unknown): number | null {
  const normalized = normalizedNonNegativeInteger(value);
  return normalized !== null && normalized > 0 ? normalized : null;
}

function normalizedExitCode(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function resultRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rawApiStatus(record: Record<string, unknown> | null): unknown {
  return record?.apiErrorStatus ?? record?.apiStatus;
}

function rawObservedTurns(record: Record<string, unknown> | null): unknown {
  return record?.numTurns ?? record?.observedTurns;
}

function evidenceForSession(input: BuildSessionTerminalInput): BuildTerminalEvidence {
  const record = resultRecord(input.result);
  const rawIsError = record?.isError;
  const rawStatus = rawApiStatus(record);
  return {
    source: 'session',
    subtype: boundedText(record?.subtype, SUBTYPE_MAX_CHARS),
    isError: typeof rawIsError === 'boolean' ? rawIsError : null,
    apiStatus: normalizedNonNegativeInteger(rawStatus),
    exitCode: normalizedExitCode(input.exitCode),
    resultExcerpt: boundedText(record?.resultText, RESULT_EXCERPT_MAX_CHARS),
    observedTurns: normalizedNonNegativeInteger(rawObservedTurns(record)),
    launchedMaxTurns: normalizedPositiveInteger(input.launchedMaxTurns),
  };
}

function parseSessionResult(value: unknown): ParsedSessionResult | null {
  const record = resultRecord(value);
  if (!record) return null;

  const subtype = boundedText(record.subtype, SUBTYPE_MAX_CHARS);
  const numTurns = normalizedNonNegativeInteger(rawObservedTurns(record));
  if (!subtype || numTurns === null) return null;
  if (record.isError !== undefined && typeof record.isError !== 'boolean') return null;
  const status = rawApiStatus(record);
  if (status !== undefined && normalizedNonNegativeInteger(status) === null) return null;
  if (record.resultText !== undefined && typeof record.resultText !== 'string') return null;

  return {
    subtype,
    numTurns,
    isError: record.isError as boolean | undefined,
    apiStatus: status === undefined ? undefined : normalizedNonNegativeInteger(status)!,
    resultText: record.resultText as string | undefined,
  };
}

function normalizedSignature(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function hasTurnLimitSignature(result: ParsedSessionResult): boolean {
  const subtype = normalizedSignature(result.subtype);
  const subtypeSignal =
    /(?:^|_)(?:max(?:imum)?_?turns?|turn_?limit)(?:_|$)/.test(subtype) &&
    /(?:error|exhaust|exceed|limit|max|reach)/.test(subtype);
  if (subtypeSignal) return true;
  if (result.isError !== true || !result.resultText) return false;
  const text = result.resultText;
  return (
    /\b(?:reached|hit|exceeded|exhausted)\b.{0,80}\b(?:max(?:imum)?(?: number of)? turns?|turn limit)\b/i.test(
      text
    ) ||
    /\b(?:max(?:imum)?(?: number of)? turns?|turn limit)\b.{0,80}\b(?:reached|hit|exceeded|exhausted)\b/i.test(
      text
    )
  );
}

function hasBudgetLimitSignature(result: ParsedSessionResult): boolean {
  const subtype = normalizedSignature(result.subtype);
  const subtypeSignal =
    /(?:^|_)(?:max(?:imum)?_?budget|budget_?(?:limit|cap|exhausted|exceeded))(?:_|$)/.test(subtype) &&
    /(?:error|exhaust|exceed|limit|max|reach)/.test(subtype);
  if (subtypeSignal) return true;
  if (result.isError !== true || !result.resultText) return false;
  const text = result.resultText;
  return (
    /\b(?:reached|hit|exceeded|exhausted)\b.{0,80}\b(?:max(?:imum)? budget|budget (?:limit|cap))\b/i.test(
      text
    ) ||
    /\b(?:max(?:imum)? budget|budget (?:limit|cap))\b.{0,80}\b(?:reached|hit|exceeded|exhausted)\b/i.test(
      text
    )
  );
}

function classifySession(input: BuildSessionTerminalInput): BuildTerminalClassification {
  const evidence = evidenceForSession(input);
  if (!input.sessionDone) return { reason: 'runtime-failure', basis: 'session-timeout', evidence };
  if (input.result === null || input.result === undefined) {
    return { reason: 'runtime-failure', basis: 'missing-result', evidence };
  }

  const result = parseSessionResult(input.result);
  if (!result) return { reason: 'runtime-failure', basis: 'malformed-result', evidence };
  if (evidence.launchedMaxTurns === null) {
    return { reason: 'runtime-failure', basis: 'invalid-launch-bound', evidence };
  }
  if (evidence.exitCode === null) {
    return { reason: 'runtime-failure', basis: 'invalid-wrapper-exit', evidence };
  }
  if (evidence.exitCode !== 0) {
    return { reason: 'runtime-failure', basis: 'nonzero-wrapper-exit', evidence };
  }

  // Any provider API status is stronger evidence of a transport/configuration
  // failure than a coincidental turn count at the configured boundary.
  if (result.apiStatus !== undefined) {
    return { reason: 'runtime-failure', basis: 'provider-api-error', evidence };
  }
  if (hasBudgetLimitSignature(result)) {
    return { reason: 'budget-exhausted', basis: 'provider-budget-limit', evidence };
  }
  if (hasTurnLimitSignature(result) && result.numTurns >= evidence.launchedMaxTurns) {
    return { reason: 'turns-exhausted', basis: 'provider-turn-limit', evidence };
  }
  if (result.isError === true) {
    return { reason: 'runtime-failure', basis: 'provider-reported-error', evidence };
  }
  if (normalizedSignature(result.subtype) === 'success') {
    return { reason: 'completed', basis: 'completed-result', evidence };
  }
  return { reason: 'runtime-failure', basis: 'unexpected-result-subtype', evidence };
}

function classifySupervisor(input: BuildSupervisorTerminalInput): BuildTerminalClassification {
  const evidence: BuildTerminalEvidence = {
    source: 'supervisor',
    subtype: null,
    isError: null,
    apiStatus: null,
    exitCode: null,
    resultExcerpt: null,
    observedTurns: null,
    launchedMaxTurns: null,
  };
  switch (input.reason) {
    case 'runtime-failure':
      return { reason: input.reason, basis: 'supervisor-runtime-failure', evidence };
    case 'budget-exhausted':
      return { reason: input.reason, basis: 'supervisor-budget-limit', evidence };
    case 'session-cap-exhausted':
      return { reason: input.reason, basis: 'supervisor-session-cap', evidence };
    case 'review-failure':
      return { reason: input.reason, basis: 'review-gate', evidence };
    case 'cancelled':
      return { reason: input.reason, basis: 'user-cancelled', evidence };
  }
}

export function classifyBuildTerminal(input: BuildTerminalInput): BuildTerminalClassification {
  return input.source === 'session' ? classifySession(input) : classifySupervisor(input);
}
