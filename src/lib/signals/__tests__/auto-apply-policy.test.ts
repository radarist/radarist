import type { Signal } from '@/lib/types';
import {
  evaluateSignalAutoApply,
  isSignalAutopilotEnabled,
  parseSignalAutoApproveThreshold,
  signalAutoApplyFingerprint,
} from '../auto-apply-policy';

function qualifiedSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'sig-1',
    title: 'Grounded technology signal',
    source: 'Original source',
    url: 'https://original.example/story',
    status: 'Validated',
    expandedContent: {
      entityProfile: {
        type: 'technology',
        summary: 'A sufficiently detailed technology summary.',
        keyFacts: ['Fact'],
        recentDevelopments: ['Development'],
      },
      sources: [
        { title: 'Second source', url: 'https://evidence.example/story', verdict: 'confirming' },
      ],
      expandedAt: 1_700_000_000_000,
      expansionModel: 'test-model',
      expansionDuration: 10,
    },
    trustScore: {
      overall: 90,
      breakdown: { sourceReliability: 90, dataCompleteness: 90, corroboration: 90, aiConfidence: 90 },
      factors: ['grounded'],
    },
    ...overrides,
  } as Signal;
}

describe('parseSignalAutoApproveThreshold', () => {
  it.each([
    [{}, 85],
    [{ SIGNAL_AUTO_APPROVE_THRESHOLD: '0' }, 0],
    [{ SIGNAL_AUTO_APPROVE_THRESHOLD: '100' }, 100],
    [{ IMPULSE_SIGNAL_AUTO_APPROVE_THRESHOLD: '42' }, 42],
    [
      { SIGNAL_AUTO_APPROVE_THRESHOLD: '91', IMPULSE_SIGNAL_AUTO_APPROVE_THRESHOLD: '12' },
      91,
    ],
  ])('parses %p as %p', (env, expected) => {
    expect(parseSignalAutoApproveThreshold(env)).toBe(expected);
  });

  it.each(['-1', '0.5', '01', '85x', '', ' 85 ', '101'])('rejects %j', (value) => {
    expect(parseSignalAutoApproveThreshold({ SIGNAL_AUTO_APPROVE_THRESHOLD: value })).toBeNull();
  });
});

describe('isSignalAutopilotEnabled', () => {
  it('honors the alias only when the primary setting is absent', () => {
    expect(isSignalAutopilotEnabled({ IMPULSE_SIGNAL_AUTOPILOT_ENABLED: 'true' })).toBe(true);
  });

  it('lets an explicit primary false disable a stale true alias', () => {
    expect(
      isSignalAutopilotEnabled({
        SIGNAL_AUTOPILOT_ENABLED: 'false',
        IMPULSE_SIGNAL_AUTOPILOT_ENABLED: 'true',
      })
    ).toBe(false);
  });
});

describe('evaluateSignalAutoApply', () => {
  it('accepts a current technology expansion with two confirming URL identities', () => {
    expect(evaluateSignalAutoApply(qualifiedSignal(), 85)).toEqual({
      eligible: true,
      reason: 'eligible',
      confirmingSourceCount: 2,
    });
  });

  it.each(['company', 'trend'] as const)('rejects the unsupported %s entity type', (type) => {
    const signal = qualifiedSignal();
    signal.expandedContent!.entityProfile!.type = type;
    expect(evaluateSignalAutoApply(signal, 85).reason).toBe('unsupported-entity-type');
  });

  it.each(['Rejected', 'Archived', 'Imported'] as const)('rejects terminal status %s', (status) => {
    expect(evaluateSignalAutoApply(qualifiedSignal({ status }), 85).reason).toBe('ineligible-status');
  });

  it('rejects one-source evidence even when the cached score is high', () => {
    const signal = qualifiedSignal();
    signal.expandedContent!.sources = [];
    expect(evaluateSignalAutoApply(signal, 85).reason).toBe('insufficient-confirming-sources');
  });
});

describe('signalAutoApplyFingerprint', () => {
  it('is deterministic and changes with decision-bearing expansion state', () => {
    const signal = qualifiedSignal();
    const first = signalAutoApplyFingerprint(signal);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(signalAutoApplyFingerprint(qualifiedSignal())).toBe(first);

    signal.trustScore = { ...signal.trustScore!, overall: 89 };
    expect(signalAutoApplyFingerprint(signal)).not.toBe(first);
  });

  it.each([
    ['signal identity', (signal: Signal) => ({ ...signal, id: 'sig-2' })],
    ['title', (signal: Signal) => ({ ...signal, title: 'Edited title' })],
    ['description', (signal: Signal) => ({ ...signal, description: 'Edited description' })],
    [
      'materialized creator',
      (signal: Signal) => ({ ...signal, metadata: { ...signal.metadata, agentId: 'different-agent' } }),
    ],
  ] as const)('binds the %s used by the Technology mutation', (_label, mutate) => {
    const signal = qualifiedSignal({ description: 'Original description', metadata: { agentId: 'agent-a' } });
    expect(signalAutoApplyFingerprint(mutate(signal) as Signal)).not.toBe(signalAutoApplyFingerprint(signal));
  });
});
