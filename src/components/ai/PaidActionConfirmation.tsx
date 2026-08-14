/**
 * @file PaidActionConfirmation.tsx
 * @description Contained confirmation card for a server-staged paid action (UX-045).
 *
 * Renders the exact server-issued spend phrase in a contained monospace block
 * with the authorized amount, a live countdown to the server-side expiry, and
 * explicit actions: "Confirm $N" submits the phrase as the user's exact next
 * chat turn, "Copy phrase" copies it for manual sending. After expiry (or a
 * typed server refusal — replay, session mismatch, restart loss) the card
 * flips to a terminal state that explains what happened and offers restaging.
 *
 * One-time/session-bound enforcement stays entirely server-side; this card
 * only mirrors the lifecycle it is told about.
 *
 * @author Radarist Team
 * @created 2026-07-17
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, BadgeDollarSign, Check, CheckCircle2, Copy, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { PaidActionErrorReason, PendingPaidActionState } from '@/types/ai-assistant';

export interface PaidActionSubmitPayload {
  /** Exact text to send as the user's next chat message. */
  text: string;
  /** Whether this submission redeems the phrase or restages the action. */
  kind: 'confirm' | 'restage';
}

interface PaidActionConfirmationProps {
  action: PendingPaidActionState;
  /** Disables the buttons while a chat turn is already in flight. */
  busy?: boolean;
  /** Submit `payload.text` as the user's exact next chat message. */
  onSubmitMessage?: (payload: PaidActionSubmitPayload) => void;
}

/**
 * `$31` for whole dollars, `$31.50` otherwise — byte-identical to the server's
 * `formatUsd` in `destructive-confirmation.ts` (server-only module, so the
 * normalization is mirrored here rather than imported). Fractional cents round
 * conservatively UPWARD past floating-point tolerance ($31.001 → $31.01), so
 * the displayed cap never understates what the authoritative phrase authorizes.
 */
export function formatUsdAmount(amountUsd: number): string {
  const scaled = amountUsd * 100;
  const nearestInteger = Math.round(scaled);
  const floatingPointTolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4;
  const cents = Math.abs(scaled - nearestInteger) <= floatingPointTolerance ? nearestInteger : Math.ceil(scaled);
  const rounded = cents / 100;
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
}

/** `4:32`-style minutes:seconds remaining (floored at 0:00). */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** What the terminal card tells the user per typed refusal reason. */
const REASON_LABELS: Record<PaidActionErrorReason, string> = {
  expired: 'This phrase expired before it was accepted. Nothing was dispatched.',
  already_used: 'This phrase was already used — each phrase authorizes exactly one dispatch.',
  cancelled: 'This confirmation was cancelled by a later message. Nothing was dispatched.',
  wrong_session: 'This phrase belongs to a different chat session. Nothing was dispatched.',
  not_found: 'This confirmation was lost — the server may have restarted. Nothing was dispatched.',
  invalid: 'This phrase is no longer valid. Nothing was dispatched.',
  same_turn: 'This phrase must be sent as its own message on your next turn.',
};

/**
 * Contained paid-action confirmation card rendered inside an assistant bubble.
 * Width-safe down to 320px: the phrase block wraps with `break-all` and the
 * action row wraps, so the card never forces horizontal overflow.
 */
export function PaidActionConfirmation({ action, busy, onSubmitMessage }: PaidActionConfirmationProps) {
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);

  // Rapid double-click guard: a second click can land before the parent's
  // isLoading state propagates back as `busy`, which would submit the phrase
  // twice. The ref blocks re-entry synchronously (state alone is async); the
  // mirrored state disables the buttons visually. The guard releases when the
  // turn settles (`busy` returns false) so a failed turn stays retryable —
  // server-side one-time redemption remains the real enforcement either way.
  const submitGuardRef = useRef(false);
  const [submitLocked, setSubmitLocked] = useState(false);
  useEffect(() => {
    if (!busy && submitGuardRef.current) {
      submitGuardRef.current = false;
      setSubmitLocked(false);
    }
  }, [busy]);
  const submitOnce = (payload: PaidActionSubmitPayload) => {
    if (busy || submitGuardRef.current) return;
    submitGuardRef.current = true;
    setSubmitLocked(true);
    onSubmitMessage?.(payload);
  };

  const terminalOutcome = action.outcome;
  const failureReason = terminalOutcome !== undefined && terminalOutcome !== 'confirmed' ? terminalOutcome : undefined;
  const remainingMs = Math.max(0, action.expiresAt - nowTs);
  const expiredByClock = terminalOutcome === undefined && remainingMs <= 0;
  const isActive = terminalOutcome === undefined && !expiredByClock;

  // Tick the countdown while the phrase is live; the effect re-runs when the
  // card turns terminal (outcome set or clock expiry) and clears the interval.
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => setNowTs(Date.now()), 500);
    return () => clearInterval(id);
  }, [isActive]);

  // Transient "Copied" feedback on the copy button.
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(id);
  }, [copied]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(action.confirmationPhrase);
      setCopied(true);
    } catch {
      // Clipboard unavailable (permissions/insecure context) — the phrase is
      // visible and selectable in the block above, so fail quietly.
    }
  };

  const amountLabel = formatUsdAmount(action.amountUsd);
  const deadlineLabel = new Date(action.expiresAt).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const canRestage = typeof action.restageMessage === 'string' && action.restageMessage.length > 0;

  return (
    <div
      data-testid="paid-action-confirmation"
      className="mt-2 w-full min-w-0 max-w-full space-y-2 overflow-hidden rounded-md border border-border bg-background/60 p-3"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <BadgeDollarSign className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="min-w-0 break-words">Paid action — authorize up to {amountLabel}</span>
      </div>

      <p className="text-xs text-muted-foreground break-words">
        Confirming sends the exact phrase below as your next message to authorize{' '}
        <span className="font-mono break-all">{action.toolName}</span>. Nothing runs and nothing is charged until you
        confirm.
      </p>

      <code
        data-testid="paid-action-phrase"
        className="block w-full max-w-full whitespace-pre-wrap break-all rounded bg-muted px-2 py-1.5 font-mono text-xs"
      >
        {action.confirmationPhrase}
      </code>

      {isActive && (
        <p data-testid="paid-action-countdown" className="text-xs text-muted-foreground" aria-live="polite">
          Expires in <span className="font-medium tabular-nums">{formatCountdown(remainingMs)}</span>
          <span className="tabular-nums"> (at {deadlineLabel})</span> — one-time use, this chat session only.
        </p>
      )}

      {terminalOutcome === 'confirmed' && (
        <p
          data-testid="paid-action-status"
          className="flex items-start gap-1.5 text-xs text-muted-foreground break-words"
        >
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Phrase submitted — this confirmation has been used and cannot authorize another dispatch.</span>
        </p>
      )}

      {(expiredByClock || failureReason !== undefined) && (
        <p data-testid="paid-action-status" className="flex items-start gap-1.5 text-xs text-destructive break-words">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            {failureReason !== undefined
              ? REASON_LABELS[failureReason]
              : `This phrase expired at ${deadlineLabel}. Nothing was dispatched.`}
          </span>
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {isActive && (
          <>
            <Button
              type="button"
              size="sm"
              className="h-7 text-xs"
              data-testid="paid-action-confirm"
              disabled={busy || submitLocked}
              onClick={() => submitOnce({ text: action.confirmationPhrase, kind: 'confirm' })}
            >
              Confirm {amountLabel}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              data-testid="paid-action-copy"
              onClick={handleCopy}
            >
              {copied ? <Check className="mr-1 h-3 w-3" /> : <Copy className="mr-1 h-3 w-3" />}
              {copied ? 'Copied' : 'Copy phrase'}
            </Button>
          </>
        )}
        {(expiredByClock || failureReason !== undefined) && canRestage && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            data-testid="paid-action-restage"
            disabled={busy || submitLocked}
            onClick={() => submitOnce({ text: action.restageMessage as string, kind: 'restage' })}
          >
            <RefreshCw className="mr-1 h-3 w-3" />
            Request a new phrase
          </Button>
        )}
      </div>
    </div>
  );
}
