/**
 * @file maintenance-policy.test.ts
 * @description Locks the OPS-001 maintenance-pause contract: default paused for
 * the local release, active under test, explicit env always wins, and the
 * skipped-audit record is fixed-shape and bounded.
 */

import { isMaintenancePaused, maintenanceSkip, MAINTENANCE_SKIP_REASON } from '../maintenance-policy';

describe('isMaintenancePaused', () => {
  it('defaults to PAUSED for the local release (unset, non-test env)', () => {
    expect(isMaintenancePaused({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isMaintenancePaused({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isMaintenancePaused({} as NodeJS.ProcessEnv)).toBe(true);
  });

  it('defaults to ACTIVE under test so ambient-handler suites run', () => {
    expect(isMaintenancePaused({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('honors an explicit truthy MAINTENANCE_PAUSED even under test', () => {
    for (const v of ['true', '1', 'yes', 'on', 'TRUE', ' On ']) {
      expect(isMaintenancePaused({ NODE_ENV: 'test', MAINTENANCE_PAUSED: v } as NodeJS.ProcessEnv)).toBe(true);
    }
  });

  it('honors an explicit falsy MAINTENANCE_PAUSED even in production', () => {
    for (const v of ['false', '0', 'no', 'off', 'FALSE']) {
      expect(isMaintenancePaused({ NODE_ENV: 'production', MAINTENANCE_PAUSED: v } as NodeJS.ProcessEnv)).toBe(false);
    }
  });

  it('supports the IMPULSE_ alias', () => {
    expect(isMaintenancePaused({ NODE_ENV: 'test', IMPULSE_MAINTENANCE_PAUSED: 'true' } as NodeJS.ProcessEnv)).toBe(
      true
    );
    expect(
      isMaintenancePaused({ NODE_ENV: 'production', IMPULSE_MAINTENANCE_PAUSED: 'false' } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  it('lets the primary key win over the alias', () => {
    expect(
      isMaintenancePaused({
        NODE_ENV: 'production',
        MAINTENANCE_PAUSED: 'false',
        IMPULSE_MAINTENANCE_PAUSED: 'true',
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });
});

describe('maintenanceSkip', () => {
  it('returns a fixed-shape bounded record with the function id and canonical reason', () => {
    const result = maintenanceSkip('reconcile-firestore-neo4j');
    expect(result).toEqual({
      skipped: true,
      reason: MAINTENANCE_SKIP_REASON,
      functionId: 'reconcile-firestore-neo4j',
      at: expect.any(String),
    });
    expect(result.reason).toBe('maintenance-paused');
    expect(() => new Date(result.at).toISOString()).not.toThrow();
  });
});
