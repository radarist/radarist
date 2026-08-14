/**
 * Stall detection: hash the normalized failing-check output after each
 * session. Two identical hashes in a row → escalate the model; three →
 * pause for a human (Phase 2 wires the gate). The thresholds come from
 * BuildConfig.stall.
 */
import { createHash } from 'crypto';

export type StallDecision = 'continue' | 'escalate' | 'pause';

export class StallTracker {
  private lastHash: string | null = null;
  private identicalCount = 0;

  constructor(
    private readonly escalateAfter: number,
    private readonly pauseAfter: number
  ) {}

  /**
   * Record the failure fingerprint of a finished session (empty string =
   * no failures, resets the streak) and return the decision.
   */
  record(failureFingerprintInput: string): StallDecision {
    if (!failureFingerprintInput) {
      this.lastHash = null;
      this.identicalCount = 0;
      return 'continue';
    }
    const hash = createHash('sha256').update(failureFingerprintInput).digest('hex');
    this.identicalCount = hash === this.lastHash ? this.identicalCount + 1 : 1;
    this.lastHash = hash;
    if (this.identicalCount >= this.pauseAfter) return 'pause';
    if (this.identicalCount >= this.escalateAfter) return 'escalate';
    return 'continue';
  }

  get currentHash(): string | null {
    return this.lastHash;
  }
  get streak(): number {
    return this.identicalCount;
  }

  /** Rehydrate from persisted mission state (Phase 2 resume path). */
  static fromPersisted(
    escalateAfter: number,
    pauseAfter: number,
    lastHash: string | null,
    streak: number
  ): StallTracker {
    const tracker = new StallTracker(escalateAfter, pauseAfter);
    tracker.lastHash = lastHash;
    tracker.identicalCount = streak;
    return tracker;
  }
}
