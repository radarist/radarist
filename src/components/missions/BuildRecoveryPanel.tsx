'use client';

import { FormEvent, useId, useState } from 'react';
import { AlertTriangle, HardDrive, RotateCw, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  DEFAULT_RECOVERY_ADDITIONAL_TURNS,
  MAX_RECOVERY_ADDITIONAL_TURNS,
  buildRecoveryEligibility,
  resolveRecoveryTurnLimit,
  terminalRecoveryFromMission,
} from '@/lib/build-mission-recovery';
import { useResumeBuildArtifact } from '@/hooks/queries/useBuildMissions';
import type { ResumeBuildArtifactConfirmation, ResumeBuildArtifactSuccess } from '@/hooks/queries/useBuildMissions';
import type { Mission } from '@/lib/schemas/mission';
import type { BuildTerminalReason } from '@/lib/schemas/mission-build';

const MAX_RECOVERY_TOP_UP_USD = 150;

const TERMINAL_REASON_LABEL: Record<BuildTerminalReason, string> = {
  'turns-exhausted': 'Builder turn limit reached',
  'budget-exhausted': 'Budget authority exhausted',
  'session-cap-exhausted': 'Session limit reached',
  'runtime-failure': 'Builder runtime failed',
  'review-failure': 'Independent review did not pass',
  cancelled: 'Build was cancelled',
};

function formatUsd(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(2)}` : 'Unavailable';
}

function isRecoveryCandidate(mission: Mission): boolean {
  return (
    mission.kind === 'build' &&
    mission.buildMode === 'limitless' &&
    mission.status === 'failed' &&
    mission.buildPhase !== 'published' &&
    !mission.artifact
  );
}

export function BuildRecoveryPanel({ mission }: { mission: Mission }) {
  const resume = useResumeBuildArtifact();
  const headingId = useId();
  const turnsId = useId();
  const budgetId = useId();
  const confirmationId = useId();
  const [turns, setTurns] = useState(String(DEFAULT_RECOVERY_ADDITIONAL_TURNS));
  const [budgetTopUp, setBudgetTopUp] = useState('0');
  const [confirmation, setConfirmation] = useState<ResumeBuildArtifactConfirmation | null>(null);
  const [confirmationInput, setConfirmationInput] = useState('');
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [success, setSuccess] = useState<ResumeBuildArtifactSuccess | null>(null);

  if (!isRecoveryCandidate(mission)) return null;

  const eligibility = buildRecoveryEligibility(mission);
  const terminal = eligibility.eligible ? eligibility.terminal : terminalRecoveryFromMission(mission);
  const parsedTurns = Number(turns);
  const parsedTopUp = budgetTopUp.trim() === '' ? 0 : Number(budgetTopUp);
  const requestedTurnBound = resolveRecoveryTurnLimit(parsedTurns);
  const validTopUp = Number.isFinite(parsedTopUp) && parsedTopUp >= 0 && parsedTopUp <= MAX_RECOVERY_TOP_UP_USD;
  const confirmationReady = !confirmation || confirmationInput === confirmation.confirmationPhrase;
  const accounting = mission.buildCostAccounting;

  const clearPendingAuthorization = () => {
    setConfirmation(null);
    setConfirmationInput('');
    setSubmissionError(null);
    setSuccess(null);
    resume.reset();
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmissionError(null);
    setSuccess(null);

    if (requestedTurnBound === null) {
      setSubmissionError(`Additional turns must be a whole number from 1 to ${MAX_RECOVERY_ADDITIONAL_TURNS}.`);
      return;
    }
    if (!validTopUp) {
      setSubmissionError(`Optional budget authority must be between $0 and $${MAX_RECOVERY_TOP_UP_USD}.`);
      return;
    }
    if (confirmation && !confirmationReady) {
      setSubmissionError('Enter the confirmation phrase exactly as shown before authorizing spend.');
      return;
    }

    try {
      const result = await resume.mutateAsync({
        missionId: mission.id,
        additionalTurns: requestedTurnBound,
        additionalBudgetUsd: parsedTopUp,
        ...(confirmation ? { confirmationText: confirmationInput } : {}),
      });
      if ('requiresConfirmation' in result) {
        setConfirmation(result);
        setConfirmationInput('');
        return;
      }
      setConfirmation(null);
      setConfirmationInput('');
      setSuccess(result);
    } catch (error) {
      setSubmissionError(error instanceof Error ? error.message : 'Could not resume the retained build.');
    }
  };

  const retainedState = mission.sandbox
    ? mission.sandbox.state === 'destroyed'
      ? `Reclaimed · ${mission.sandbox.volumeName}`
      : `Retained · ${mission.sandbox.volumeName}`
    : 'Unavailable';

  return (
    <section
      className="space-y-4 rounded-md border border-border p-4"
      aria-labelledby={headingId}
      data-testid="build-recovery-panel"
    >
      <div className="flex items-start gap-3">
        <RotateCw className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div>
          <h2 id={headingId} className="text-sm font-semibold">
            Recover retained Limitless build
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Continue the same goal in the retained workspace. Turn authority and budget authority are separate.
          </p>
        </div>
      </div>

      <dl className="grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Terminal reason</dt>
          <dd className="mt-0.5 font-medium">{TERMINAL_REASON_LABEL[terminal.reason]}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Retained phase</dt>
          <dd className="mt-0.5 font-mono">{terminal.phase}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Prior builder turn bound</dt>
          <dd className="mt-0.5">{terminal.maxTurns ?? 'Unavailable'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Workspace volume</dt>
          <dd className="mt-0.5 break-all" data-testid="recovery-volume-state">
            {retainedState}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Current cap</dt>
          <dd className="mt-0.5">{formatUsd(mission.budget?.capUsd)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Settled actual</dt>
          <dd className="mt-0.5">{formatUsd(accounting?.settledActualUsd)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Estimated usage</dt>
          <dd className="mt-0.5">{formatUsd(accounting?.estimatedUsd)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Active reserved</dt>
          <dd className="mt-0.5">{formatUsd(accounting?.activeReservedUsd)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Unsettled maximum</dt>
          <dd className="mt-0.5">{formatUsd(accounting?.unsettledMaximumUsd)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Maximum exposure</dt>
          <dd className="mt-0.5">{formatUsd(accounting?.maximumExposureUsd)}</dd>
        </div>
      </dl>

      <div className="flex items-start gap-2 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p>A fresh independent reviewer must run and pass before this build can publish.</p>
      </div>

      {!eligibility.eligible ? (
        <div className="flex items-start gap-2 text-sm text-destructive" role="status" data-testid="recovery-unavailable">
          <HardDrive className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>{eligibility.error}</p>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={onSubmit} noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={turnsId}>Additional builder turns</Label>
              <Input
                id={turnsId}
                type="number"
                min="1"
                max={MAX_RECOVERY_ADDITIONAL_TURNS}
                step="1"
                value={turns}
                disabled={resume.isPending}
                aria-describedby={`${turnsId}-help`}
                onChange={(event) => {
                  setTurns(event.target.value);
                  clearPendingAuthorization();
                }}
              />
              <p id={`${turnsId}-help`} className="text-xs text-muted-foreground">
                New session bound: {requestedTurnBound ?? 'Invalid'} turns. Allowed range: 1–
                {MAX_RECOVERY_ADDITIONAL_TURNS}.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor={budgetId}>Optional budget top-up (USD)</Label>
              <Input
                id={budgetId}
                type="number"
                min="0"
                max={MAX_RECOVERY_TOP_UP_USD}
                step="0.01"
                value={budgetTopUp}
                disabled={resume.isPending}
                aria-describedby={`${budgetId}-help`}
                onChange={(event) => {
                  setBudgetTopUp(event.target.value);
                  clearPendingAuthorization();
                }}
              />
              <p id={`${budgetId}-help`} className="text-xs text-muted-foreground">
                Leave at $0 for turns-only recovery. Any positive amount requires exact confirmation.
              </p>
            </div>
          </div>

          {confirmation && (
            <div className="space-y-3 rounded-md border border-amber-500/50 bg-amber-500/5 p-3" role="status">
              <div className="flex items-start gap-2 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
                <div className="min-w-0 space-y-1">
                  <p className="font-medium">Explicit spend authorization required</p>
                  <p className="text-xs text-muted-foreground">
                    Enter this exact server-issued phrase. Nothing has been dispatched yet.
                  </p>
                  <code className="block break-all rounded bg-muted px-2 py-1 text-xs" data-testid="recovery-confirmation-phrase">
                    {confirmation.confirmationPhrase}
                  </code>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor={confirmationId}>Spend confirmation phrase</Label>
                <Input
                  id={confirmationId}
                  value={confirmationInput}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={resume.isPending}
                  aria-describedby={`${confirmationId}-help`}
                  onChange={(event) => {
                    setConfirmationInput(event.target.value);
                    setSubmissionError(null);
                  }}
                />
                <p id={`${confirmationId}-help`} className="text-xs text-muted-foreground">
                  The phrase is bound to this mission, turn request, budget amount, account, and browser session.
                </p>
              </div>
            </div>
          )}

          {submissionError && (
            <p className="text-sm text-destructive" role="alert" data-testid="recovery-error">
              {submissionError}
            </p>
          )}
          {success && (
            <p className="text-sm text-primary" role="status" data-testid="recovery-success">
              Recovery dispatched with a {success.authorizedMaxTurns}-turn builder bound and a {formatUsd(success.capUsd)}
              total cap.
            </p>
          )}

          <Button type="submit" size="sm" disabled={resume.isPending || !confirmationReady}>
            <RotateCw className="h-4 w-4" aria-hidden="true" />
            {resume.isPending
              ? 'Resuming…'
              : confirmation
                ? 'Confirm and resume'
                : parsedTopUp > 0
                  ? 'Request spend confirmation'
                  : 'Resume with additional turns'}
          </Button>
        </form>
      )}
    </section>
  );
}
