/**
 * @file lib/research/deep-research-progress.ts
 * @description PRODUCT-003 — provider-backed Deep Research plan/progress.
 *
 * A visible deep-research run took about nine minutes showing nothing but
 * "Processing". The Interactions API poll response actually carries progress
 * facts — the raw interaction `status` and the agent's own `steps[]` list —
 * and `pollDeepResearch` discarded all of them, keeping only completed/failed.
 *
 * The hard rule here is that ONLY provider-reported facts describe provider
 * progress. This module never invents a stage name, never computes a completion
 * percentage, and never estimates an ETA: the provider reports neither a total
 * step count nor a duration, so any percentage or "about N minutes left" would
 * be fabrication dressed as telemetry.
 *
 * Two things it DOES state that are not provider facts are labelled as the
 * app's own measurements, not the agent's: how many times we have polled, and
 * the bounded poll budget those polls run against. Both are true, both are
 * ours, and neither claims to know how far along the agent is.
 *
 * Pure module — no SDK, no Firebase — so every branch is directly testable.
 */

/** Retained provider steps. A long research run can emit many; the document
 * field is a UI summary, not an audit log. */
export const MAX_RETAINED_PROVIDER_STEPS = 20;

/** Hard cap on a provider-supplied step type, which is untrusted text. */
export const MAX_PROVIDER_STEP_TYPE_LENGTH = 64;

/**
 * Consecutive observations with no NEW provider step before the run is called
 * stalled. At the job's 15s poll interval this is two minutes — long enough
 * that an ordinary multi-minute research step does not trip it, short enough
 * that a wedged run stops looking healthy.
 */
export const DEEP_RESEARCH_STALL_OBSERVATIONS = 8;

/**
 * Persist a snapshot at least this often even when nothing changed, so an
 * operator watching a genuinely slow run sees the observation count advance
 * rather than a frozen card. At 15s polls this is one write per minute.
 */
export const DEEP_RESEARCH_PROGRESS_HEARTBEAT = 4;

/** One step the PROVIDER reported. `type` is absent when it reported none. */
export interface DeepResearchProviderStep {
  index: number;
  /** The provider's own step type, verbatim and bounded. Never synthesized. */
  type?: string;
}

/** One poll's worth of raw provider facts. */
export interface DeepResearchObservation {
  /** The RAW provider interaction status, verbatim. */
  providerStatus: string;
  /**
   * Provider-reported steps. ABSENT means the provider exposed no step list at
   * all — a different fact from an empty list (a run that has started but not
   * yet recorded a step). Optional rather than `| undefined` on purpose: this
   * value crosses an Inngest step boundary and a Firestore write, both of which
   * drop `undefined` properties, so absence is the only representation that
   * survives the round trip intact.
   */
  steps?: DeepResearchProviderStep[];
  observedAt: string;
}

export type DeepResearchTerminalState = 'completed' | 'failed' | 'timed-out';

export interface DeepResearchProgress {
  /** The interaction this progress belongs to — also the resume handle. */
  interactionId: string;
  /** The RAW provider status, verbatim. */
  providerStatus: string;
  /** Provider-reported step count. Absent when it reports no step list. */
  stepCount?: number;
  /** The retained tail of provider-reported steps. */
  steps: DeepResearchProviderStep[];
  /** True when the provider exposes no plan/progress structure for this run. */
  progressUnavailable: boolean;
  /** ISO-8601 instant of the observation this snapshot was built from. */
  observedAt: string;
  /** How many times WE have polled. An app measurement, not agent progress. */
  observations: number;
  /** Consecutive observations that saw no new provider step. */
  observationsWithoutNewStep: number;
  /**
   * True once {@link DEEP_RESEARCH_STALL_OBSERVATIONS} observations in a row
   * saw no new provider step. Always false when the provider reports no step
   * list: silence is not evidence of a stall, and claiming otherwise would be
   * the same fabrication this module exists to prevent.
   */
  stalled: boolean;
  /** The app's own bounded poll budget. NOT a provider estimate of remaining work. */
  poll: { iteration: number; max: number; intervalSeconds: number };
  /** Absent while the run is still in progress. */
  terminal?: { state: DeepResearchTerminalState; reason?: string };
  /**
   * True while the interaction can still be polled again by id — so a run that
   * exhausted OUR poll budget is visibly recoverable rather than simply failed.
   */
  resumable: boolean;
}

function boundedStepType(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_PROVIDER_STEP_TYPE_LENGTH);
}

/**
 * Read one poll's provider facts out of a raw Interactions-API interaction.
 *
 * Defensive by construction: the SDK's union type does not declare every field
 * across builds, and an unexpected shape must degrade to "no progress
 * reported" rather than throw inside the poll path or invent a status.
 */
export function readDeepResearchObservation(interaction: unknown, observedAt: string): DeepResearchObservation {
  const record = (interaction ?? {}) as Record<string, unknown>;
  const providerStatus = typeof record.status === 'string' && record.status.trim() ? record.status.trim() : 'unknown';
  const rawSteps = record.steps;
  if (!Array.isArray(rawSteps)) {
    return { providerStatus, observedAt };
  }
  const steps = rawSteps.map((step, index) => {
    const entry = (step ?? {}) as Record<string, unknown>;
    const type = boundedStepType(entry.type) ?? boundedStepType(entry.name);
    return type === undefined ? { index } : { index, type };
  });
  return { providerStatus, steps, observedAt };
}

export interface DeepResearchProgressContext {
  interactionId: string;
  /** Zero-based poll index, as the job counts them. */
  pollIteration: number;
  maxPollIterations: number;
  pollIntervalSeconds: number;
  terminal?: { state: DeepResearchTerminalState; reason?: string };
}

/**
 * Fold one observation into the running snapshot.
 *
 * `previous` must come from the prior poll's MEMOIZED step result, never from a
 * mutated closure — an Inngest replay re-executes the loop body and would
 * otherwise restart the stall counter from zero.
 */
export function nextDeepResearchProgress(
  previous: DeepResearchProgress | undefined,
  observation: DeepResearchObservation,
  context: DeepResearchProgressContext
): DeepResearchProgress {
  const stepCount = observation.steps?.length;
  const progressUnavailable = observation.steps === undefined;
  // `-1` as the floor makes the two "no prior count" cases behave correctly: a
  // first observation, and a run whose provider only STARTS reporting steps
  // partway through (that transition is progress, not another stalled check).
  const sawNewStep = stepCount !== undefined && stepCount > (previous?.stepCount ?? -1);
  const observationsWithoutNewStep = progressUnavailable
    ? 0
    : sawNewStep
      ? 0
      : (previous?.observationsWithoutNewStep ?? 0) + 1;

  return {
    interactionId: context.interactionId,
    providerStatus: observation.providerStatus,
    ...(stepCount === undefined ? {} : { stepCount }),
    // Keep the most recent steps: the tail is what a reader watching a live run
    // is actually looking at, and the head is unchanging history.
    steps: (observation.steps ?? []).slice(-MAX_RETAINED_PROVIDER_STEPS),
    progressUnavailable,
    observedAt: observation.observedAt,
    observations: (previous?.observations ?? 0) + 1,
    observationsWithoutNewStep,
    stalled: !progressUnavailable && observationsWithoutNewStep >= DEEP_RESEARCH_STALL_OBSERVATIONS,
    poll: {
      iteration: context.pollIteration + 1,
      max: context.maxPollIterations,
      intervalSeconds: context.pollIntervalSeconds,
    },
    ...(context.terminal ? { terminal: context.terminal } : {}),
    // A completed or failed interaction is settled; anything else — including a
    // run that exhausted OUR poll budget — can still be polled again by id.
    resumable: context.terminal?.state !== 'completed' && context.terminal?.state !== 'failed',
  };
}

/**
 * Whether this snapshot is worth a Firestore write.
 *
 * Writing every poll would cost 60 writes per research run to restate the same
 * facts. A material change is a new provider status, a new provider step count,
 * a change in whether progress is reported at all, a stall transition, or a
 * terminal state — plus a once-a-minute heartbeat so a genuinely slow run still
 * visibly advances.
 */
export function shouldPersistDeepResearchProgress(
  previous: DeepResearchProgress | undefined,
  next: DeepResearchProgress
): boolean {
  if (!previous) return true;
  if (next.terminal !== undefined) return true;
  if (previous.providerStatus !== next.providerStatus) return true;
  if (previous.stepCount !== next.stepCount) return true;
  if (previous.progressUnavailable !== next.progressUnavailable) return true;
  if (previous.stalled !== next.stalled) return true;
  return next.observations % DEEP_RESEARCH_PROGRESS_HEARTBEAT === 0;
}

/**
 * The owner-facing summary of a progress snapshot.
 *
 * Every branch states only what is known. There is deliberately no percentage
 * and no ETA: the provider reports neither a total step count nor a duration,
 * so both would be invented.
 */
export function describeDeepResearchProgress(progress: DeepResearchProgress): {
  headline: string;
  detail: string;
  tone: 'running' | 'stalled' | 'unavailable' | 'done' | 'error';
} {
  const polled = `${progress.poll.iteration} of ${progress.poll.max} checks (${progress.poll.intervalSeconds}s apart)`;

  if (progress.terminal?.state === 'completed') {
    return {
      headline: 'Research completed',
      detail:
        progress.stepCount === undefined
          ? `The provider reported no step detail for this run. Observed over ${polled}.`
          : `The provider reported ${progress.stepCount} ${progress.stepCount === 1 ? 'step' : 'steps'}.`,
      tone: 'done',
    };
  }

  if (progress.terminal?.state === 'failed') {
    return {
      headline: 'Research failed',
      detail: progress.terminal.reason ?? `The provider ended this run as "${progress.providerStatus}".`,
      tone: 'error',
    };
  }

  if (progress.terminal?.state === 'timed-out') {
    return {
      headline: 'Stopped polling — this run outlasted our poll budget',
      detail: `The provider last reported "${progress.providerStatus}" after ${polled}. The research task may still be running; it can be checked again using interaction ${progress.interactionId}.`,
      tone: 'error',
    };
  }

  if (progress.progressUnavailable) {
    return {
      headline: 'Progress detail unavailable',
      detail: `The provider reports status "${progress.providerStatus}" but no plan or step detail for this run. Observed over ${polled}.`,
      tone: 'unavailable',
    };
  }

  if (progress.stalled) {
    return {
      headline: 'No new provider step recently',
      detail: `Still "${progress.providerStatus}" with ${progress.stepCount} ${
        progress.stepCount === 1 ? 'step' : 'steps'
      } reported, unchanged across the last ${progress.observationsWithoutNewStep} checks.`,
      tone: 'stalled',
    };
  }

  return {
    headline: `${progress.stepCount ?? 0} provider ${progress.stepCount === 1 ? 'step' : 'steps'} reported`,
    detail: `Provider status "${progress.providerStatus}". Observed over ${polled}.`,
    tone: 'running',
  };
}
