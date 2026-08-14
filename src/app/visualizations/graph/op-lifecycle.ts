/**
 * @file op-lifecycle.ts
 * @description GRAPH-055 — operation lifecycle tracker for the graph explorer.
 *
 * Every query/expand round trip is one identified operation. Beginning a new
 * operation SUPERSEDES the previous one: its AbortSignal fires and its
 * completions become stale (`isCurrent()` false), so a slow response can never
 * clobber a newer graph or cross-clear the busy indicator. `finish()` yields an
 * idempotent, phase-timed receipt for instrumentation — network (auth + fetch),
 * JSON parse, and state commit are timed separately so a stall is attributable
 * to a phase instead of an opaque 30-second spinner.
 *
 * Deliberately NOT a timeout: nothing here fires on elapsed time. Operations
 * end only on their own terminal path, supersession, or unmount abort.
 */

export type GraphOpKind = 'query' | 'expand';

export type GraphOpPhase = 'auth-network' | 'parse' | 'commit';

export type GraphOpOutcome = 'success' | 'error' | 'aborted' | 'superseded';

export interface GraphOpSnapshot {
  id: number;
  kind: GraphOpKind;
  phase: GraphOpPhase;
  startedAt: number;
}

export interface GraphOpReceipt {
  id: number;
  kind: GraphOpKind;
  outcome: GraphOpOutcome;
  totalMs: number;
  phaseMs: Partial<Record<GraphOpPhase, number>>;
  detail?: string;
}

export interface GraphOpController {
  id: number;
  kind: GraphOpKind;
  /** Fires when a newer operation supersedes this one (or on unmount abort). */
  signal: AbortSignal;
  /** Enter the next phase; the elapsed time is charged to the previous phase. */
  markPhase(phase: GraphOpPhase): void;
  /** False once a newer operation began or this operation finished. */
  isCurrent(): boolean;
  /**
   * Terminate the operation once; later calls return null. A plain `success`
   * on a superseded operation is coerced to `superseded` (its result was
   * discarded); explicit `error`/`aborted` outcomes are preserved.
   */
  finish(outcome: GraphOpOutcome, detail?: string): GraphOpReceipt | null;
}

export interface GraphOpTracker {
  /** Start a new operation, aborting + superseding any current one. */
  begin(kind: GraphOpKind): GraphOpController;
  /** Snapshot of the in-flight current operation, or null. */
  current(): GraphOpSnapshot | null;
  /** Abort the current operation's signal (unmount cleanup) without finishing it. */
  abortCurrent(reason: string): void;
}

interface InternalOp extends GraphOpController {
  snapshot: GraphOpSnapshot;
  abort(): void;
}

export function createGraphOpTracker(now: () => number = Date.now): GraphOpTracker {
  let nextId = 0;
  let current: InternalOp | null = null;

  const begin = (kind: GraphOpKind): GraphOpController => {
    if (current) {
      // Supersession is the only in-band cancellation: the newer operation now
      // owns the busy indicator and the previous one's completions are stale.
      const stale = current;
      current = null;
      stale.abort();
    }

    const id = ++nextId;
    const startedAt = now();
    const abortController = new AbortController();
    const snapshot: GraphOpSnapshot = { id, kind, phase: 'auth-network', startedAt };
    const phaseMs: Partial<Record<GraphOpPhase, number>> = {};
    let phaseStartedAt = startedAt;
    let finished = false;

    const op: InternalOp = {
      id,
      kind,
      signal: abortController.signal,
      snapshot,
      abort() {
        abortController.abort();
      },
      markPhase(phase: GraphOpPhase) {
        if (finished) return;
        const at = now();
        phaseMs[snapshot.phase] = (phaseMs[snapshot.phase] ?? 0) + (at - phaseStartedAt);
        phaseStartedAt = at;
        snapshot.phase = phase;
      },
      isCurrent() {
        return current === op;
      },
      finish(outcome: GraphOpOutcome, detail?: string): GraphOpReceipt | null {
        if (finished) return null;
        finished = true;
        const at = now();
        phaseMs[snapshot.phase] = (phaseMs[snapshot.phase] ?? 0) + (at - phaseStartedAt);
        const wasCurrent = current === op;
        if (wasCurrent) current = null;
        const effectiveOutcome: GraphOpOutcome = !wasCurrent && outcome === 'success' ? 'superseded' : outcome;
        return {
          id,
          kind,
          outcome: effectiveOutcome,
          totalMs: at - startedAt,
          phaseMs,
          ...(detail !== undefined ? { detail } : {}),
        };
      },
    };

    current = op;
    return op;
  };

  return {
    begin,
    current() {
      return current ? { ...current.snapshot } : null;
    },
    abortCurrent(_reason: string) {
      // Abort without unsetting `current`: the operation still owns its
      // terminal path (its catch/finally observes the abort and finishes).
      current?.abort();
    },
  };
}
