/** @jest-environment node */

import {
  DISCONNECTED_ENTITY_WARN_MIN_TOTAL,
  DISCONNECTED_ENTITY_WARN_RATE,
  evaluateDisconnectedEntityRates,
  measuredRatio,
} from '../lib/graph-health-diagnostics';

describe('graph health diagnostics', () => {
  it('reports unmeasurable coverage as null instead of a vacuous 100%', () => {
    expect(measuredRatio(0, 0)).toBeNull();
    expect(measuredRatio(9, 10)).toBe(0.9);
  });

  it('uses a material default threshold for disconnected entity warnings', () => {
    expect(DISCONNECTED_ENTITY_WARN_RATE).toBe(0.5);
    expect(DISCONNECTED_ENTITY_WARN_MIN_TOTAL).toBe(10);
  });

  it('warns with counts for material disconnected-entity backlogs', () => {
    const warnings = evaluateDisconnectedEntityRates([
      { label: 'Signal', total: 100, disconnected: 80, rate: 0.8 },
      { label: 'Company', total: 100, disconnected: 5, rate: 0.05 },
    ]);

    expect(warnings).toEqual([
      expect.stringContaining('Signal 80.0% (80/100)'),
    ]);
    expect(warnings[0]).toContain('Informational only');
    expect(warnings[0]).not.toContain('Company');
  });

  it('does not warn for tiny samples or a rate exactly at the threshold', () => {
    expect(
      evaluateDisconnectedEntityRates([
        { label: 'Prototype', total: 8, disconnected: 8, rate: 1 },
        { label: 'UseCase', total: 10, disconnected: 5, rate: 0.5 },
      ])
    ).toEqual([]);
  });

  it('sorts warnings by descending rate', () => {
    const [warning] = evaluateDisconnectedEntityRates([
      { label: 'UseCase', total: 20, disconnected: 12, rate: 0.6 },
      { label: 'PainPoint', total: 20, disconnected: 18, rate: 0.9 },
    ]);

    expect(warning.indexOf('PainPoint')).toBeLessThan(warning.indexOf('UseCase'));
  });
});
