import { resolveBackgroundAutomationPolicy } from '@/lib/background-automation-policy';

describe('resolveBackgroundAutomationPolicy', () => {
  it('fails closed when configuration is missing or malformed', () => {
    for (const value of [undefined, null, {}, { sweep: {} }, { sweep: { enabled: 'true' } }]) {
      expect(resolveBackgroundAutomationPolicy(value)).toMatchObject({
        enabled: false,
        impulseSweepEnabled: false,
        signalFetchEnabled: false,
        linkerEnabled: false,
        discoveryEnabled: false,
      });
    }
  });

  it('uses sweep.enabled as the master switch and capability flags as narrower gates', () => {
    expect(
      resolveBackgroundAutomationPolicy({
        sweep: { enabled: true, maxActionsPerSweep: 4 },
        signalDetection: { enabled: true },
        linkerAgent: { enabled: false },
      })
    ).toEqual({
      enabled: true,
      impulseSweepEnabled: true,
      signalFetchEnabled: true,
      linkerEnabled: false,
      discoveryEnabled: true,
      maxActionsPerSweep: 4,
    });
  });

  it('rejects unsafe action caps instead of coercing them', () => {
    for (const maxActionsPerSweep of [0, 2.5, 21, '5']) {
      expect(
        resolveBackgroundAutomationPolicy({ sweep: { enabled: true, maxActionsPerSweep } }).maxActionsPerSweep
      ).toBe(10);
    }
  });
});
