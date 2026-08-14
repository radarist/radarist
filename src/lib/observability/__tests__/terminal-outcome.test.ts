/**
 * @jest-environment node
 *
 * OBS-001 / GRAPH-030 / OBS-004 / ARUN-030 — the shared terminal-outcome
 * vocabulary. Every assertion here defends a property some store previously got
 * wrong on its own:
 *
 * - a partial mission must not read as a clean success (Mission encodes it as
 *   `status: 'completed'` + `partial: true`);
 * - an aggregate over zero children must have NO outcome, because defaulting to
 *   success is exactly how a sweep with two failed paid children reported
 *   success;
 * - a `skipped` no-op must enter neither side of a success rate.
 */

import {
  DECIDED_DOMAIN_OUTCOMES,
  DOMAIN_OUTCOMES,
  DOMAIN_OUTCOME_SEVERITY,
  agentRunStatusForDomainOutcome,
  describeDomainOutcome,
  domainOutcomeFromBuildTerminalReason,
  domainOutcomeFromMissionFailureCode,
  domainOutcomeFromMissionTerminal,
  isDecidedDomainOutcome,
  isDomainOutcome,
  isUnsuccessfulDomainOutcome,
  rollUpChildOutcomes,
  worstDomainOutcome,
  type DomainOutcome,
} from '../terminal-outcome';

describe('DomainOutcome vocabulary', () => {
  it('recognises exactly the declared outcomes and nothing else', () => {
    for (const outcome of DOMAIN_OUTCOMES) expect(isDomainOutcome(outcome)).toBe(true);
    for (const bogus of ['completed', 'error', 'ok', 'SUCCESS', '', null, undefined, 7, {}]) {
      expect(isDomainOutcome(bogus)).toBe(false);
    }
  });

  it('assigns every outcome a distinct severity so aggregation is total', () => {
    const ranks = DOMAIN_OUTCOMES.map((o) => DOMAIN_OUTCOME_SEVERITY[o]);
    expect(new Set(ranks).size).toBe(DOMAIN_OUTCOMES.length);
    expect(Object.keys(DOMAIN_OUTCOME_SEVERITY).sort()).toEqual([...DOMAIN_OUTCOMES].sort());
  });

  it('describes and maps every outcome (no unhandled member)', () => {
    for (const outcome of DOMAIN_OUTCOMES) {
      expect(describeDomainOutcome(outcome).length).toBeGreaterThan(0);
      expect(['success', 'failure', 'skipped']).toContain(agentRunStatusForDomainOutcome(outcome));
    }
  });

  it('keeps skipped and cancelled out of both sides of a success rate', () => {
    expect(isDecidedDomainOutcome('skipped')).toBe(false);
    expect(isDecidedDomainOutcome('cancelled')).toBe(false);
    expect(isUnsuccessfulDomainOutcome('skipped')).toBe(false);
    expect(isUnsuccessfulDomainOutcome('cancelled')).toBe(false);
    expect(DECIDED_DOMAIN_OUTCOMES).toEqual(
      expect.arrayContaining(['success', 'partial', 'failed', 'preflight-failed', 'provider-fatal'])
    );
  });

  it('counts every refusal flavour as unsuccessful delivery', () => {
    expect(isUnsuccessfulDomainOutcome('failed')).toBe(true);
    expect(isUnsuccessfulDomainOutcome('preflight-failed')).toBe(true);
    expect(isUnsuccessfulDomainOutcome('provider-fatal')).toBe(true);
    expect(isUnsuccessfulDomainOutcome('partial')).toBe(false);
  });
});

describe('worstDomainOutcome', () => {
  it('has NO outcome for an empty set rather than defaulting to success', () => {
    expect(worstDomainOutcome([])).toBeUndefined();
  });

  it('lets a single failure dominate a batch of successes', () => {
    expect(worstDomainOutcome(['success', 'success', 'failed'])).toBe('failed');
  });

  it('ranks a real partial delivery above a batch of no-ops', () => {
    expect(worstDomainOutcome(['skipped', 'skipped', 'partial'])).toBe('partial');
  });

  it('prefers the non-retryable classification over a generic failure', () => {
    expect(worstDomainOutcome(['provider-fatal', 'cancelled'])).toBe('provider-fatal');
    expect(worstDomainOutcome(['failed', 'provider-fatal'])).toBe('failed');
  });
});

describe('rollUpChildOutcomes', () => {
  it('reports no outcome when nothing was dispatched', () => {
    expect(rollUpChildOutcomes({ dispatched: 0, outcomes: [] })).toEqual({ outcome: undefined, complete: true });
  });

  it('marks the rollup incomplete while a dispatched child has not settled', () => {
    expect(rollUpChildOutcomes({ dispatched: 2, outcomes: [] })).toEqual({ outcome: undefined, complete: false });
  });

  // The exact OBS-004 evidence shape: two paid children, both failed.
  it('reports a fully failed child batch as failed, never success', () => {
    expect(rollUpChildOutcomes({ dispatched: 2, outcomes: ['failed', 'failed'] })).toEqual({
      outcome: 'failed',
      complete: true,
    });
  });

  it('degrades an all-success but unsettled batch to partial', () => {
    expect(rollUpChildOutcomes({ dispatched: 3, outcomes: ['success', 'success'] })).toEqual({
      outcome: 'partial',
      complete: false,
    });
  });

  it('keeps a settled all-success batch at success', () => {
    expect(rollUpChildOutcomes({ dispatched: 2, outcomes: ['success', 'success'] })).toEqual({
      outcome: 'success',
      complete: true,
    });
  });

  it('does not soften an unsettled batch that already contains a failure', () => {
    expect(rollUpChildOutcomes({ dispatched: 4, outcomes: ['success', 'failed'] })).toEqual({
      outcome: 'failed',
      complete: false,
    });
  });
});

describe('domainOutcomeFromMissionTerminal', () => {
  it('reports a checkpoint-recovered mission as partial, not success', () => {
    // Mission stores partial recovery as completed + partial:true. Reading
    // `status` alone is what made a timed-out mission look clean.
    expect(domainOutcomeFromMissionTerminal({ status: 'completed', partial: true })).toBe('partial');
  });

  it('maps clean terminal states', () => {
    expect(domainOutcomeFromMissionTerminal({ status: 'completed' })).toBe('success');
    expect(domainOutcomeFromMissionTerminal({ status: 'failed' })).toBe('failed');
    expect(domainOutcomeFromMissionTerminal({ status: 'cancelled' })).toBe('cancelled');
  });

  it('has no outcome for a non-terminal or unknown status', () => {
    expect(domainOutcomeFromMissionTerminal({ status: 'running' })).toBeUndefined();
    expect(domainOutcomeFromMissionTerminal({ status: 'pending' })).toBeUndefined();
    expect(domainOutcomeFromMissionTerminal({ status: undefined })).toBeUndefined();
  });

  it('refines a preflight refusal so unspent work is not read as a burned failure', () => {
    expect(domainOutcomeFromMissionTerminal({ status: 'failed', failureCode: 'mcp-preflight-failed' })).toBe(
      'preflight-failed'
    );
    expect(domainOutcomeFromMissionTerminal({ status: 'failed', failureCode: 'mcp-base-url-missing' })).toBe(
      'preflight-failed'
    );
  });

  it('never guesses a category from an unrecognised failure code', () => {
    expect(domainOutcomeFromMissionFailureCode('mcp-something-new-and-paid')).toBeUndefined();
    expect(domainOutcomeFromMissionFailureCode('')).toBeUndefined();
    expect(domainOutcomeFromMissionFailureCode(null)).toBeUndefined();
    expect(domainOutcomeFromMissionTerminal({ status: 'failed', failureCode: 'totally-unknown' })).toBe('failed');
  });

  it('lets partial win over a failed status (recovered output is real)', () => {
    expect(domainOutcomeFromMissionTerminal({ status: 'failed', partial: true })).toBe('partial');
  });
});

describe('domainOutcomeFromBuildTerminalReason', () => {
  it('maps the build supervisor vocabulary onto the shared one', () => {
    expect(domainOutcomeFromBuildTerminalReason('completed')).toBe('success');
    expect(domainOutcomeFromBuildTerminalReason('cancelled')).toBe('cancelled');
    expect(domainOutcomeFromBuildTerminalReason('runtime-failure')).toBe('failed');
    expect(domainOutcomeFromBuildTerminalReason('review-failure')).toBe('failed');
  });

  it('treats supervisor exhaustion as partial, because the workspace is retained', () => {
    expect(domainOutcomeFromBuildTerminalReason('budget-exhausted')).toBe('partial');
    expect(domainOutcomeFromBuildTerminalReason('turns-exhausted')).toBe('partial');
    expect(domainOutcomeFromBuildTerminalReason('session-cap-exhausted')).toBe('partial');
  });

  it('has no outcome for an unknown reason', () => {
    expect(domainOutcomeFromBuildTerminalReason('who-knows')).toBeUndefined();
    expect(domainOutcomeFromBuildTerminalReason(undefined)).toBeUndefined();
  });
});

describe('agentRunStatusForDomainOutcome', () => {
  it('keeps partial in the success column (the row also carries partial:true)', () => {
    expect(agentRunStatusForDomainOutcome('partial')).toBe('success');
  });

  it('puts every non-delivery outcome in the failure column', () => {
    const failures: DomainOutcome[] = ['failed', 'cancelled', 'preflight-failed', 'provider-fatal'];
    for (const outcome of failures) expect(agentRunStatusForDomainOutcome(outcome)).toBe('failure');
  });

  it('keeps an honest no-op out of the success column', () => {
    expect(agentRunStatusForDomainOutcome('skipped')).toBe('skipped');
  });
});
