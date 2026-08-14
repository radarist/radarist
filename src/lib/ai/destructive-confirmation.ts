/**
 * Server-verified confirmation for consequential chat tools (#121).
 *
 * ## The problem this closes
 *
 * Destructive assistant tools (`deleteEntity`, `deleteRadar`, `deleteTechnology`,
 * `removeTechnologyFromRadar`) used to gate on a `confirmed: boolean` argument
 * that the MODEL sets. That is not a human-in-the-loop check: the model can set
 * `confirmed: true` on the very first call and delete data the user never saw a
 * prompt for. The "confirmation" was self-attested by the actor being confirmed.
 *
 * ## The mechanism — a two-turn handshake the SERVER enforces
 *
 * The gate keys an outstanding confirmation by **(userId, action fingerprint)**
 * and records the request id it was raised in. A chat HTTP request maps 1:1 to a
 * user turn, so:
 *
 * 1. **First call** (no pending, or pending raised in THIS request): the server
 *    records a pending confirmation for `(user, fingerprint)` stamped with the
 *    current request id and returns `{ ok: false }`. The tool refuses to execute
 *    and relays a "confirm?" prompt. A second call in the SAME request is refused
 *    the same way (`raisedRequestId === current`), so the model cannot
 *    self-confirm inside one turn's tool loop.
 * 2. **Redemption**: a later call for the same `(user, fingerprint)` whose request
 *    id DIFFERS from the one that raised it, and whose raw authenticated user
 *    message exactly matches the action-bound confirmation phrase. A retry, a
 *    negative response, or any unrelated later message cancels the pending action.
 *
 * The confirmation phrase is intentionally user-visible and deterministic, not
 * a secret bearer token. The model relays it, but cannot forge the raw current-user
 * message supplied by the authenticated chat route. Request-id separation still
 * prevents the model from redeeming it inside the tool loop that raised it.
 *
 * Fails **closed**: a missing/empty request id can never satisfy
 * `raisedRequestId !== current` (both compare as `''`), so it always re-prompts
 * rather than executing. One-time use; 5-minute TTL.
 *
 * ## Scope / residual
 *
 * The store is an in-process `Map` — correct for the single-process local
 * prototype. Paid dispatch tools reuse the same request-bound handshake with a
 * `CONFIRM SPEND ...` phrase and an SHA-256 fingerprint of the complete action.
 * A multi-instance hosted deployment would need a shared store
 * (Redis/Firestore); tracked as a hosted-hardening residual in
 * `docs/LIMITATIONS.md`. Machine callers (external MCP write-key, mission
 * agents) don't carry a request id and keep the legacy explicit-boolean gate —
 * see `confirmDestructiveAction`.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { PaidActionErrorReason } from '@/types/ai-assistant';

/** How long a raised confirmation stays redeemable. */
export const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

/**
 * How long a resolved (consumed/expired/cancelled) staged paid action leaves a
 * tombstone behind. Tombstones exist ONLY to let a late claim attempt report
 * WHY it failed (expiry vs replay vs cancellation) instead of one collapsed
 * refusal; they hold no redeemable state and are swept after this window.
 */
export const PAID_ACTION_TOMBSTONE_TTL_MS = 30 * 60 * 1000;
export const PAID_ACTION_SESSION_COOKIE = 'radarist-paid-action-session';

export const PAID_CHAT_TOOL_NAMES = [
  'startMission',
  'dispatchTechnologyEvaluation',
  'dispatchBuildMission',
  'iterateBuildArtifact',
] as const;
export type PaidChatToolName = (typeof PAID_CHAT_TOOL_NAMES)[number];
const paidChatToolNames = new Set<string>(PAID_CHAT_TOOL_NAMES);

interface PendingConfirmation {
  /** Request id (user turn) the confirmation was RAISED in. Redemption must differ. */
  raisedRequestId: string;
  /** Epoch ms after which the pending confirmation is dead. */
  expiresAt: number;
  /** Exact raw user message that redeems this action. */
  requiredPhrase: string;
  /** Opaque browser-chat session binding for paid actions. */
  sessionId?: string;
}

interface StagedPaidChatAction {
  userId: string;
  sessionId: string;
  raisedRequestId: string;
  confirmationPhrase: string;
  toolName: PaidChatToolName;
  argsJson: string;
  expiresAt: number;
}

// Module-level store, keyed by `${userId}\u0000${fingerprint}` — one outstanding
// confirmation per (user, exact action).
const store = new Map<string, PendingConfirmation>();
const stagedPaidActions = new Map<string, StagedPaidChatAction>();

/**
 * Tombstone for a staged paid action that is no longer redeemable. Records the
 * exact terminal outcome so a later claim of the same phrase can name WHY it
 * fails (expiry vs replay vs cancellation) instead of one collapsed refusal.
 * Holds no redeemable state — the frozen args are gone; only the label remains.
 */
interface ResolvedPaidChatAction {
  userId: string;
  sessionId: string;
  confirmationPhrase: string;
  outcome: 'consumed' | 'expired' | 'cancelled';
  /** Epoch ms after which the tombstone itself is swept. */
  sweepAt: number;
}

const resolvedPaidActions = new Map<string, ResolvedPaidChatAction>();

/**
 * AI-043 — mint a SERVER-CONTROLLED review decision-attempt identity.
 *
 * This is minted ONCE by `prepareCompanyReviewDecision` (per arm) and RETURNED to
 * the caller, which carries it into `recordCompanyReviewDecision` and re-supplies it
 * verbatim on any retry. It is therefore the durable idempotency key, and — unlike a
 * value derived from the confirming request id — an exact retry on a NEW turn, after
 * the process-local confirmation state was cleared, still carries the SAME identity
 * and so reaches the SAME durable event to replay it (no reconfirmation, no
 * duplicate). Each arm mints a fresh identity, so a genuinely new confirmation of an
 * identical decision (approve → reject → approve) gets a distinct id and a distinct
 * event — preserving the latest-wins history. It is random + server-issued, so the
 * model cannot forge it; and because a fresh, not-yet-recorded identity still passes
 * through the two-turn human gate, forging one can never bypass confirmation.
 */
export function mintReviewAttemptId(): string {
  // `att-` + 32 hex = 36 chars, within the schema's url-safe `{8,128}` bound.
  return `att-${randomUUID().replace(/-/g, '')}`;
}

/** Composite key: a NUL separator can't collide with a userId or a fingerprint. */
function pendingKey(userId: string, fingerprint: string, sessionId?: string): string {
  return `${userId}\u0000${sessionId ?? ''}\u0000${fingerprint}`;
}

function stagedPaidActionKey(userId: string, sessionId: string, confirmationPhrase: string): string {
  return `${userId}\u0000${sessionId}\u0000${confirmationPhrase}`;
}

/** Replace a staged paid action with its terminal-outcome tombstone. */
function resolveStagedPaidAction(
  key: string,
  staged: StagedPaidChatAction,
  outcome: ResolvedPaidChatAction['outcome'],
  now: number
): void {
  stagedPaidActions.delete(key);
  resolvedPaidActions.set(key, {
    userId: staged.userId,
    sessionId: staged.sessionId,
    confirmationPhrase: staged.confirmationPhrase,
    outcome,
    sweepAt: now + PAID_ACTION_TOMBSTONE_TTL_MS,
  });
}

/** Drop expired entries so the map can't grow unbounded across a long session. */
function sweepExpired(now: number): void {
  for (const [key, pending] of store) {
    if (pending.expiresAt <= now) store.delete(key);
  }
  for (const [key, staged] of stagedPaidActions) {
    if (staged.expiresAt <= now) resolveStagedPaidAction(key, staged, 'expired', now);
  }
  for (const [key, resolved] of resolvedPaidActions) {
    if (resolved.sweepAt <= now) resolvedPaidActions.delete(key);
  }
}

export interface ConfirmationGateInput {
  /** Stable serialized id of the exact destructive action and ordered arguments. */
  fingerprint: string;
  /** Current request id (one per user turn). Absent/empty for machine callers. */
  requestId?: string;
  /** Authenticated user id; falls back to `'anonymous'`. */
  userId?: string;
  /** Raw current-user message from the authenticated chat request. */
  confirmationText?: string;
  /** Opaque server-issued browser-chat session id for paid actions. */
  sessionId?: string;
}

export type ConfirmationGateResult = { ok: true } | { ok: false; reason: 'raised' | 'same_turn' | 'not_confirmed' };

function toWellFormedText(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index] + value[index + 1];
        index += 1;
      } else {
        result += '\ufffd';
      }
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      result += '\ufffd';
    } else {
      result += value[index];
    }
  }
  return result;
}

/** Reject missing, altered, or ill-formed identifiers before they reach a gate. */
export function normalizeDestructiveIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!value || value !== value.trim() || value !== toWellFormedText(value)) return undefined;
  return value;
}

/** Build an unambiguous fingerprint for an action and its ordered arguments. */
export function destructiveActionFingerprint(
  action: string,
  ...components: readonly (string | number | boolean)[]
): string {
  return `${action}:${JSON.stringify(components)}`;
}

/** Exact action-bound phrase the user must send on a later chat turn. */
export function destructiveConfirmationPhrase(fingerprint: string): string {
  return `CONFIRM DELETE ${encodeURIComponent(toWellFormedText(fingerprint))}`;
}

function stableSerialize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `string:${JSON.stringify(toWellFormedText(value))}`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Paid action fingerprints require finite numbers');
    return `number:${Object.is(value, -0) ? '-0' : String(value)}`;
  }
  if (typeof value === 'boolean') return `boolean:${String(value)}`;
  if (Array.isArray(value)) return `array:[${value.map(stableSerialize).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(toWellFormedText(key))}:${stableSerialize(record[key])}`);
    return `object:{${entries.join(',')}}`;
  }
  throw new Error(`Unsupported paid action fingerprint value: ${typeof value}`);
}

/** Accept only opaque server-issued identifiers suitable for a bounded cookie/key. */
export function normalizePaidActionSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) return undefined;
  return value;
}

/**
 * Compact, deterministic fingerprint for an exact paid action payload.
 *
 * The digest keeps the user-visible confirmation phrase short even when the
 * build brief is tens of thousands of characters. Stable key ordering avoids
 * treating JSON object insertion order as part of the authorization contract.
 */
export function paidActionFingerprint(action: string, payload: unknown): string {
  const normalizedAction = normalizeDestructiveIdentifier(action);
  if (!normalizedAction) throw new Error('Paid action fingerprint requires a valid action name');
  const digest = createHash('sha256').update(stableSerialize(payload), 'utf8').digest('hex');
  return `${normalizedAction}:${digest}`;
}

function formatUsd(amountUsd: number): string {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error('Paid action confirmation requires a positive finite USD amount');
  }
  const scaled = amountUsd * 100;
  const nearestInteger = Math.round(scaled);
  const floatingPointTolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4;
  const cents = Math.abs(scaled - nearestInteger) <= floatingPointTolerance ? nearestInteger : Math.ceil(scaled);
  const rounded = cents / 100;
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
}

/** Exact action- and cap-bound phrase the user must send on a later turn. */
export function paidActionConfirmationPhrase(fingerprint: string, amountUsd: number): string {
  return `CONFIRM SPEND ${formatUsd(amountUsd)} ${encodeURIComponent(toWellFormedText(fingerprint))}`;
}

/** True for anything that looks like an attempted paid-action authorization. */
export function isPaidActionConfirmationAttempt(value: string): boolean {
  return /^\s*confirm\s+spend\b/i.test(value);
}

function paidPhraseFingerprint(confirmationPhrase: string): string | undefined {
  const match = /^CONFIRM SPEND \$(\d+(?:\.\d{1,2})?) ([^\s]+)$/.exec(confirmationPhrase);
  if (!match || !Number.isFinite(Number(match[1])) || Number(match[1]) <= 0) return undefined;
  try {
    return decodeURIComponent(match[2]);
  } catch {
    return undefined;
  }
}

export interface StagePaidChatActionInput {
  userId: string;
  sessionId: string;
  requestId: string;
  confirmationPhrase: string;
  toolName: string;
  args: Record<string, unknown>;
}

/**
 * Freeze the exact server-refused paid tool call for model-free redemption.
 * The refusal phrase already contains the action fingerprint; validating its
 * tool-name prefix prevents a staged result from being retargeted.
 */
export function stagePaidChatAction(input: StagePaidChatActionInput): boolean {
  const now = Date.now();
  sweepExpired(now);
  const sessionId = normalizePaidActionSessionId(input.sessionId);
  const fingerprint = paidPhraseFingerprint(input.confirmationPhrase);
  if (
    !input.userId ||
    !sessionId ||
    !input.requestId ||
    !paidChatToolNames.has(input.toolName) ||
    !fingerprint ||
    !fingerprint.startsWith(`${input.toolName}:`) ||
    !new RegExp(`^${input.toolName}:[a-f0-9]{64}$`).test(fingerprint) ||
    typeof input.args !== 'object' ||
    input.args === null ||
    Array.isArray(input.args)
  ) {
    return false;
  }

  let argsJson: string;
  try {
    argsJson = JSON.stringify(input.args);
    if (!argsJson || argsJson.length > 250_000) return false;
    const parsed = JSON.parse(argsJson) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  } catch {
    return false;
  }

  const key = stagedPaidActionKey(input.userId, sessionId, input.confirmationPhrase);
  // A fresh staging supersedes any terminal record of an earlier same-phrase run.
  resolvedPaidActions.delete(key);
  const existing = stagedPaidActions.get(key);
  const expiresAt = now + CONFIRMATION_TTL_MS;
  if (existing) {
    const identical =
      existing.raisedRequestId === input.requestId &&
      existing.toolName === input.toolName &&
      existing.argsJson === argsJson;
    if (!identical) return false;
    existing.expiresAt = expiresAt;
    store.set(pendingKey(input.userId, fingerprint, sessionId), {
      raisedRequestId: input.requestId,
      expiresAt,
      requiredPhrase: input.confirmationPhrase,
      sessionId,
    });
    return true;
  }

  // Provider synthesis can take most of the original confirmation TTL. The
  // phrase becomes user-visible only now, so refresh the matching gate and the
  // frozen call to one shared expiry. The route invokes this only for a
  // server-produced paid-tool refusal whose phrase/tool prefix was validated
  // above; provider text cannot create an entry.
  store.set(pendingKey(input.userId, fingerprint, sessionId), {
    raisedRequestId: input.requestId,
    expiresAt,
    requiredPhrase: input.confirmationPhrase,
    sessionId,
  });
  stagedPaidActions.set(key, {
    userId: input.userId,
    sessionId,
    raisedRequestId: input.requestId,
    confirmationPhrase: input.confirmationPhrase,
    toolName: input.toolName as PaidChatToolName,
    argsJson,
    expiresAt,
  });
  return true;
}

export type ClaimStagedPaidChatActionResult =
  | { ok: true; toolName: PaidChatToolName; args: Record<string, unknown> }
  | { ok: false; reason: PaidActionErrorReason };

/**
 * Peek at a live staged paid action (no consumption). Lets the chat route
 * surface the exact server-side expiry alongside the staged phrase so the UI
 * can render a real deadline instead of guessing one.
 */
export function peekStagedPaidChatAction(input: {
  userId: string;
  sessionId: string;
  confirmationPhrase: string;
}): { toolName: PaidChatToolName; expiresAt: number } | undefined {
  const now = Date.now();
  sweepExpired(now);
  const sessionId = normalizePaidActionSessionId(input.sessionId);
  if (!input.userId || !sessionId) return undefined;
  const staged = stagedPaidActions.get(stagedPaidActionKey(input.userId, sessionId, input.confirmationPhrase));
  if (!staged || staged.expiresAt <= now) return undefined;
  return { toolName: staged.toolName, expiresAt: staged.expiresAt };
}

/**
 * Why this exact (user, session, phrase) has no live staged action. Checked in
 * authority order: an exact terminal tombstone beats the cross-session scan —
 * a phrase consumed HERE is 'already_used' even if another session also staged
 * it. Every reason fails closed; they differ only in what the user is told.
 */
function claimFailureReason(userId: string, sessionId: string, confirmationPhrase: string): PaidActionErrorReason {
  const resolved = resolvedPaidActions.get(stagedPaidActionKey(userId, sessionId, confirmationPhrase));
  if (resolved) {
    return resolved.outcome === 'consumed' ? 'already_used' : resolved.outcome;
  }
  for (const staged of stagedPaidActions.values()) {
    if (
      staged.userId === userId &&
      staged.confirmationPhrase === confirmationPhrase &&
      staged.sessionId !== sessionId
    ) {
      return 'wrong_session';
    }
  }
  for (const other of resolvedPaidActions.values()) {
    if (other.userId === userId && other.confirmationPhrase === confirmationPhrase && other.sessionId !== sessionId) {
      return 'wrong_session';
    }
  }
  return 'not_found';
}

/**
 * Atomically consume one exact staged call on a later turn in the same session.
 * Failures carry a typed reason (expiry vs replay vs session mismatch vs
 * restart loss) so the route can answer with a specific, restage-ready refusal
 * instead of one collapsed 409. Every failure path remains fail-closed.
 */
export function claimStagedPaidChatAction(input: {
  userId: string;
  sessionId: string;
  requestId: string;
  confirmationText: string;
}): ClaimStagedPaidChatActionResult {
  const now = Date.now();
  sweepExpired(now);
  const sessionId = normalizePaidActionSessionId(input.sessionId);
  if (!input.userId || !sessionId || !input.requestId || !paidPhraseFingerprint(input.confirmationText)) {
    return { ok: false, reason: 'invalid' };
  }

  const key = stagedPaidActionKey(input.userId, sessionId, input.confirmationText);
  const staged = stagedPaidActions.get(key);
  if (!staged) {
    return { ok: false, reason: claimFailureReason(input.userId, sessionId, input.confirmationText) };
  }
  if (staged.raisedRequestId === input.requestId) {
    return { ok: false, reason: 'same_turn' };
  }
  if (staged.expiresAt <= now) {
    // sweepExpired already tombstones expired entries; kept as a local guard.
    resolveStagedPaidAction(key, staged, 'expired', now);
    return { ok: false, reason: 'expired' };
  }

  // Consume before execution. A retry can never duplicate paid work after an
  // ambiguous downstream failure; the user must deliberately stage again.
  resolveStagedPaidAction(key, staged, 'consumed', now);
  try {
    const args = JSON.parse(staged.argsJson) as Record<string, unknown>;
    return { ok: true, toolName: staged.toolName, args };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

function requireExactConfirmation(
  input: ConfirmationGateInput,
  requiredPhrase: string,
  opts?: { armOnly?: boolean }
): ConfirmationGateResult {
  const now = Date.now();
  sweepExpired(now);

  const userId = input.userId ?? 'anonymous';
  const requestId = input.requestId ?? '';
  const sessionId = normalizePaidActionSessionId(input.sessionId);
  const key = pendingKey(userId, input.fingerprint, sessionId);

  // A pending action without a request boundary could later be redeemed by a
  // real request. Refuse without storing anything so missing context can never
  // manufacture the first half of a confirmation handshake.
  if (!requestId) return { ok: false, reason: 'same_turn' };

  // Arm-only (the "prepare" step): unconditionally (re)raise a pending for the
  // CURRENT request and return without ever inspecting `confirmationText`, so
  // preparing can never redeem or cancel an existing pending — it only stages one.
  if (!opts?.armOnly) {
    const pending = store.get(key);
    if (pending && pending.expiresAt > now) {
      if (requestId && pending.raisedRequestId !== requestId) {
        store.delete(key);
        if (input.confirmationText === pending.requiredPhrase && pending.requiredPhrase === requiredPhrase) {
          return { ok: true };
        }
        return { ok: false, reason: 'not_confirmed' };
      }
      return { ok: false, reason: 'same_turn' };
    }
  }

  store.set(key, {
    raisedRequestId: requestId,
    expiresAt: now + CONFIRMATION_TTL_MS,
    requiredPhrase,
    ...(sessionId ? { sessionId } : {}),
  });
  return { ok: false, reason: 'raised' };
}

/**
 * Arm (stage) a human-confirmation pending for a review decision — the "prepare"
 * step — WITHOUT redeeming or cancelling anything and WITHOUT the human-only record
 * gate. Returns whether a fresh pending is now armed for this exact decision so a
 * later turn can redeem it. It fails closed (armed:false) when there is no request
 * boundary, so a machine caller with no turn context can never manufacture an arm.
 * The caller MUST inspect `armed` — preparing does not report success on a no-op.
 */
export function armReviewConfirmation(input: { fingerprint: string; userId?: string; requestId?: string }): {
  armed: boolean;
} {
  const phrase = reviewConfirmationPhrase(input.fingerprint);
  const gate = requireExactConfirmation(
    { fingerprint: input.fingerprint, requestId: input.requestId, userId: input.userId },
    phrase,
    { armOnly: true }
  );
  // With armOnly the gate never redeems (never `ok:true`); it either raised a fresh
  // pending or fail-closed with no request boundary. Narrow before reading `reason`.
  return { armed: !gate.ok && gate.reason === 'raised' };
}

/**
 * Core gate. Returns `{ ok: true }` only when a confirmation previously raised
 * for the same `(user, fingerprint)` is redeemed on a LATER request. Every other
 * path raises (or keeps) the pending confirmation and returns `ok: false` — the
 * caller must NOT execute.
 *
 * Exported for unit testing; tools should call {@link confirmDestructiveAction}.
 */
export function requireConfirmation(input: ConfirmationGateInput): ConfirmationGateResult {
  return requireExactConfirmation(input, destructiveConfirmationPhrase(input.fingerprint));
}

/**
 * Observe every authenticated chat turn, including turns where the model never
 * calls a destructive tool. A pending action survives only when the immediate
 * later raw user message is its exact phrase; unrelated and negative turns
 * cancel it at the route boundary instead of relying on model behavior.
 */
export function observeDestructiveConfirmationTurn(input: {
  userId?: string;
  requestId?: string;
  confirmationText?: string;
  sessionId?: string;
}): void {
  const now = Date.now();
  sweepExpired(now);

  const userId = input.userId ?? 'anonymous';
  const requestId = input.requestId ?? '';
  const sessionId = normalizePaidActionSessionId(input.sessionId);
  if (!requestId) return;

  const prefix = `${userId}\u0000`;
  for (const [key, pending] of store) {
    if (!key.startsWith(prefix) || pending.raisedRequestId === requestId) continue;
    if (pending.sessionId && pending.sessionId !== sessionId) continue;
    if (input.confirmationText !== pending.requiredPhrase) {
      store.delete(key);
    }
  }

  for (const [key, staged] of stagedPaidActions) {
    if (staged.userId !== userId || staged.sessionId !== sessionId || staged.raisedRequestId === requestId) {
      continue;
    }
    if (input.confirmationText !== staged.confirmationPhrase) {
      resolveStagedPaidAction(key, staged, 'cancelled', now);
    }
  }
}

/** Test-only: clear all outstanding confirmations. */
export function _resetConfirmationStore(): void {
  store.clear();
  stagedPaidActions.clear();
  resolvedPaidActions.clear();
}

/** Refusal payload placed on a destructive tool's `data` when confirmation is pending. */
export interface DestructiveGateRefusal {
  requiresConfirmation: true;
  /** Instruction for the model: what to tell the user + how to proceed. */
  message: string;
}

export interface DestructiveGateInput {
  /** Stable serialized id of the exact destructive action and ordered arguments. */
  fingerprint: string;
  /** Human-readable action for the prompt, e.g. `delete company "Acme"`. */
  summary: string;
  /** `args.confirmed` — the legacy explicit boolean (machine callers only). */
  confirmed?: boolean;
  /** Trust boundary: only `'human'` gets the server-verified two-turn handshake. */
  principal?: 'human' | 'machine';
  /** Authenticated chat user id. */
  userId?: string;
  /** Current request id (one per user turn). */
  requestId?: string;
  /** Raw current-user message, set only by the authenticated chat boundary. */
  confirmationText?: string;
}

export type DestructiveGateResult = { ok: true } | { ok: false; error: string; data: DestructiveGateRefusal };

export interface PaidGateRefusal {
  requiresConfirmation: true;
  confirmationPhrase: string;
  amountUsd: number;
  message: string;
}

export interface PaidGateInput {
  /** SHA-256 fingerprint returned by {@link paidActionFingerprint}. */
  fingerprint: string;
  /** Human-readable action for the refusal, without the dollar amount. */
  summary: string;
  /** Maximum spend authorized by the action. */
  amountUsd: number;
  /** Explicit authorization for deliberate non-chat callers only. */
  confirmed?: boolean;
  principal?: 'human' | 'machine';
  userId?: string;
  requestId?: string;
  confirmationText?: string;
  sessionId?: string;
}

export type PaidGateResult = { ok: true } | { ok: false; error: string; data: PaidGateRefusal };

/**
 * Server-enforced two-turn authorization for actions that incur external spend.
 * Interactive chat ignores model-provided `confirmed:true`; machine callers
 * must opt in with it explicitly because they have no authenticated user turn.
 */
export function confirmPaidAction(input: PaidGateInput): PaidGateResult {
  const phrase = paidActionConfirmationPhrase(input.fingerprint, input.amountUsd);
  if (input.principal === 'human') {
    const sessionId = normalizePaidActionSessionId(input.sessionId);
    if (!sessionId) {
      const message =
        'A secure paid-action chat session is unavailable. Nothing was dispatched and no spend was started. ' +
        'Reload the assistant and stage the action again.';
      return {
        ok: false,
        error: message,
        data: { requiresConfirmation: true, confirmationPhrase: phrase, amountUsd: input.amountUsd, message },
      };
    }
    const gate = requireExactConfirmation(
      {
        fingerprint: input.fingerprint,
        requestId: input.requestId,
        userId: input.userId,
        confirmationText: input.confirmationText,
        sessionId,
      },
      phrase
    );
    if (gate.ok) return { ok: true };

    const firstAsk =
      `Authorization required before I ${input.summary} (up to ${formatUsd(input.amountUsd)}). ` +
      `Ask the user to reply with exactly "${phrase}" and STOP. Do not call this tool again this turn. ` +
      `Only after that exact phrase arrives in their NEXT message may you re-issue the identical tool call.`;
    const sameTurn =
      `This paid action was already staged in the same turn; a model retry is not user authorization. ` +
      `Stop and ask the user to send exactly "${phrase}" in a new message.`;
    const notConfirmed =
      `The latest user message did not exactly authorize ${input.summary}. Nothing was dispatched and no ` +
      `spend was started. Stage the exact action again if the user still wants it.`;
    const message = gate.reason === 'same_turn' ? sameTurn : gate.reason === 'not_confirmed' ? notConfirmed : firstAsk;
    return {
      ok: false,
      error: message,
      data: { requiresConfirmation: true, confirmationPhrase: phrase, amountUsd: input.amountUsd, message },
    };
  }

  if (input.confirmed === true) return { ok: true };
  const message =
    `This paid action requires explicit machine authorization (set confirmed: true) before I ` +
    `${input.summary} (up to ${formatUsd(input.amountUsd)}).`;
  return {
    ok: false,
    error: message,
    data: { requiresConfirmation: true, confirmationPhrase: phrase, amountUsd: input.amountUsd, message },
  };
}

/**
 * Single gate every destructive tool calls before mutating. Routes by trust
 * boundary:
 *
 * - **Human (interactive chat)** → server-verified two-turn handshake
 *   ({@link requireConfirmation}). The model cannot self-confirm; a real user
 *   turn must occur between prompt and execution. The model just re-issues the
 *   exact action-bound phrase and re-issues the same call only after that phrase
 *   arrives as the next raw user message.
 * - **Machine (external MCP write-key, mission agent)** → the legacy explicit
 *   `confirmed: true` boolean. These callers have no per-turn request id and act
 *   deliberately; preserving their gate avoids regressing missions/MCP.
 */
export function confirmDestructiveAction(input: DestructiveGateInput): DestructiveGateResult {
  if (input.principal === 'human') {
    const gate = requireConfirmation({
      fingerprint: input.fingerprint,
      requestId: input.requestId,
      userId: input.userId,
      confirmationText: input.confirmationText,
    });
    if (gate.ok) return { ok: true };

    const phrase = destructiveConfirmationPhrase(input.fingerprint);
    const firstAsk =
      `Confirmation required before I ${input.summary}. This is permanent. Ask the user to reply ` +
      `with exactly "${phrase}" and STOP — do not call this tool again this turn. Only after that ` +
      `exact phrase arrives in their NEXT message should you re-issue the same tool call.`;
    const sameTurn =
      `You already asked to ${input.summary} this turn — that is not a real user confirmation. ` +
      `Stop calling this tool now and ask the user to reply with exactly "${phrase}" on a new message.`;
    const notConfirmed =
      `The user's latest message did not exactly confirm ${input.summary}. Nothing was deleted and the ` +
      `pending action was cancelled. If they still want this action, start a new confirmation request.`;

    const message = gate.reason === 'same_turn' ? sameTurn : gate.reason === 'not_confirmed' ? notConfirmed : firstAsk;
    return { ok: false, error: message, data: { requiresConfirmation: true, message } };
  }

  // Machine caller: legacy explicit-boolean gate.
  if (input.confirmed === true) return { ok: true };
  const machineMsg = `This destructive action requires confirmation (set confirmed: true) — ${input.summary}.`;
  return { ok: false, error: machineMsg, data: { requiresConfirmation: true, message: machineMsg } };
}

// ============================================================================
// AI-043 — company source-review decision confirmation
// ============================================================================

/**
 * Exact action-bound fingerprint for recording a company source-review decision.
 * Binds the company, artifact kind/version, whole-draft digest, the exact area
 * and its digest, the verdict, and the normalized note — so a confirmation
 * authorizes ONE exact decision against ONE exact draft version, and a changed
 * digest/version/decision needs a fresh confirmation.
 */
export function reviewDecisionFingerprint(input: {
  companyId: string;
  artifactKind: string;
  artifactVersion: string;
  draftDigest: string;
  area: string;
  areaDigest: string;
  decision: string;
  note?: string;
}): string {
  return destructiveActionFingerprint(
    'review',
    input.companyId,
    input.artifactKind,
    input.artifactVersion,
    input.draftDigest,
    input.area,
    input.areaDigest,
    input.decision,
    input.note ?? ''
  );
}

/** Exact phrase the user must send on a later turn to record a review decision. */
export function reviewConfirmationPhrase(fingerprint: string): string {
  return `CONFIRM REVIEW ${encodeURIComponent(toWellFormedText(fingerprint))}`;
}

export interface ReviewGateInput {
  /** Fingerprint from {@link reviewDecisionFingerprint}. */
  fingerprint: string;
  /** Human-readable decision for the prompt, e.g. `approve "Company size"`. */
  summary: string;
  /** Trust boundary: only `'human'` may record; a machine caller may only list/prepare. */
  principal?: 'human' | 'machine';
  userId?: string;
  requestId?: string;
  confirmationText?: string;
}

/**
 * The gate's result. The idempotency identity is NOT minted here — it is the
 * server-controlled attempt id minted at prepare and carried by the caller (see
 * {@link mintReviewAttemptId}). The gate's sole job is to authorize (or refuse) a
 * fresh confirmation.
 */
export type ReviewGateResult = { ok: true } | { ok: false; error: string; data: DestructiveGateRefusal };

/**
 * Human-authority gate for recording a company source-review decision. Machine
 * principals (external MCP write-key, mission agents) can NEVER record — they may
 * only list or prepare. A human must send the exact action-bound phrase on a
 * LATER turn than the one that raised it (request-id separation), so the model
 * cannot self-confirm in the same turn, and generic text ("looks good"), an old
 * message, or a confirmation issued for another action never authorizes it. It
 * only AUTHORIZES a fresh confirmation; the durable idempotency identity is the
 * prepare-minted attempt id the caller carries.
 */
export function confirmReviewDecision(input: ReviewGateInput): ReviewGateResult {
  if (input.principal !== 'human') {
    const machineMsg =
      'Recording a source-review decision requires an interactive human confirmation; a machine or agent ' +
      'caller may only list or prepare a decision, never record one.';
    return { ok: false, error: machineMsg, data: { requiresConfirmation: true, message: machineMsg } };
  }
  const phrase = reviewConfirmationPhrase(input.fingerprint);
  const gate = requireExactConfirmation(
    {
      fingerprint: input.fingerprint,
      requestId: input.requestId,
      userId: input.userId,
      confirmationText: input.confirmationText,
    },
    phrase
  );
  if (gate.ok) return { ok: true };

  const firstAsk =
    `Confirmation required before I record "${input.summary}". Ask the user to reply with exactly ` +
    `"${phrase}" and STOP — do not call this tool again this turn. Only after that exact phrase arrives in ` +
    `their NEXT message should you re-issue the identical tool call.`;
  const sameTurn =
    `You already staged "${input.summary}" this turn — a model retry is not a user confirmation. Stop and ask ` +
    `the user to reply with exactly "${phrase}" in a new message.`;
  const notConfirmed =
    `The user's latest message did not exactly confirm "${input.summary}". Nothing was recorded. Start a new ` +
    `confirmation if they still want it.`;
  const message = gate.reason === 'same_turn' ? sameTurn : gate.reason === 'not_confirmed' ? notConfirmed : firstAsk;
  return { ok: false, error: message, data: { requiresConfirmation: true, message } };
}
