/**
 * @file lib/__tests__/agent-run-usage.test.ts
 * @description ARUN-020 — the ONE AgentRun usage read rule and the ONE live
 * token lend. Pure derivations, so they get direct coverage rather than only
 * indirect page-mount coverage.
 */

import { agentRunUsageSnapshot, reconcileRunTokens } from '@/lib/agent-run-usage';

describe('agentRunUsageSnapshot', () => {
  it('sums a provider-reported measurement', () => {
    const snapshot = agentRunUsageSnapshot({
      tokenUsage: { input: 100, output: 9 },
      tokenUsageProvenance: 'provider-reported',
    });
    expect(snapshot).toMatchObject({
      tokens: 109,
      input: 100,
      output: 9,
      unavailable: false,
      partiallyReported: false,
    });
  });

  it('keeps a persisted zero when the provider genuinely reported zero', () => {
    const snapshot = agentRunUsageSnapshot({
      tokenUsage: { input: 0, output: 0 },
      tokenUsageProvenance: 'provider-reported',
    });
    expect(snapshot.tokens).toBe(0);
    expect(snapshot.unavailable).toBe(false);
  });

  it('never states a count the provider never reported', () => {
    // The stored {0,0} exists only because tokenUsage is a required field.
    const snapshot = agentRunUsageSnapshot({
      tokenUsage: { input: 0, output: 0 },
      tokenUsageProvenance: 'unreported',
    });
    expect(snapshot.tokens).toBeUndefined();
    expect(snapshot.unavailable).toBe(true);
  });

  it('states a partially-reported total as a marked lower bound, not an exact figure', () => {
    const snapshot = agentRunUsageSnapshot({
      tokenUsage: { input: 100, output: 9 },
      tokenUsageProvenance: 'partially-reported',
    });
    expect(snapshot.tokens).toBe(109);
    expect(snapshot.unavailable).toBe(false);
    expect(snapshot.partiallyReported).toBe(true);
  });

  it('treats an absent tokenUsage as unknown, never as zero', () => {
    const snapshot = agentRunUsageSnapshot({});
    expect(snapshot.tokens).toBeUndefined();
    expect(snapshot.unavailable).toBe(true);
    expect(snapshot.input).toBe(0);
    expect(snapshot.output).toBe(0);
  });

  it('reads a legacy row with no provenance from its stored counters', () => {
    const snapshot = agentRunUsageSnapshot({ tokenUsage: { input: 7, output: 3 } });
    expect(snapshot.tokens).toBe(10);
    expect(snapshot.provenance).toBeUndefined();
    expect(snapshot.unavailable).toBe(false);
  });

  it.each([
    ['NaN', Number.NaN],
    ['negative', -1],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('fails a %s persisted counter closed rather than rendering it', (_label, bad) => {
    // Legacy docs reach the client without schema validation
    // (normalizeAgentRunForRead does not validate tokenUsage).
    const snapshot = agentRunUsageSnapshot({ tokenUsage: { input: bad as number, output: 5 } });
    expect(snapshot.tokens).toBeUndefined();
    expect(snapshot.unavailable).toBe(true);
  });
});

describe('reconcileRunTokens', () => {
  it('lends the live heartbeat count to a durable row that has none', () => {
    expect(reconcileRunTokens(undefined, 115)).toBe(115);
  });

  it('never regresses a durable count the row already has', () => {
    expect(reconcileRunTokens(120, 115)).toBe(120);
  });

  it('takes the higher of the two', () => {
    expect(reconcileRunTokens(100, 115)).toBe(115);
  });

  it('stays unknown when neither side knows a count — never a fabricated 0', () => {
    expect(reconcileRunTokens(undefined, undefined)).toBeUndefined();
  });

  it('keeps a real durable zero when no heartbeat has spoken', () => {
    expect(reconcileRunTokens(0, undefined)).toBe(0);
  });
});
