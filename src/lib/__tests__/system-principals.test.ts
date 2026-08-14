/**
 * @file system-principals.test.ts
 * @description Locks the ARUN-005 principal-union contract: the union is
 * exactly uid + the three compiled-in system principals — never another
 * human user, never client-extensible.
 */
import {
  SYSTEM_PRINCIPAL,
  SYSTEM_SWEEP_PRINCIPAL,
  SYSTEM_DISCOVERY_PRINCIPAL,
  SYSTEM_PRINCIPALS,
  isSystemPrincipal,
  observabilityPrincipals,
} from '../system-principals';

describe('system-principals', () => {
  it('exposes exactly the three principals autonomous writers stamp', () => {
    expect(SYSTEM_PRINCIPALS).toEqual(['system', 'system-sweep', 'system-discovery']);
    expect(SYSTEM_PRINCIPAL).toBe('system');
    expect(SYSTEM_SWEEP_PRINCIPAL).toBe('system-sweep');
    expect(SYSTEM_DISCOVERY_PRINCIPAL).toBe('system-discovery');
  });

  it('isSystemPrincipal accepts only the compiled-in set', () => {
    expect(isSystemPrincipal('system')).toBe(true);
    expect(isSystemPrincipal('system-sweep')).toBe(true);
    expect(isSystemPrincipal('system-discovery')).toBe(true);
    expect(isSystemPrincipal('user-123')).toBe(false);
    expect(isSystemPrincipal('system-other')).toBe(false); // no prefix matching
    expect(isSystemPrincipal('')).toBe(false);
    expect(isSystemPrincipal(null)).toBe(false);
    expect(isSystemPrincipal(undefined)).toBe(false);
  });

  it('union is uid + system principals — never any other human user', () => {
    expect(observabilityPrincipals('user-abc')).toEqual(['user-abc', 'system', 'system-sweep', 'system-discovery']);
  });

  it('union deduplicates when the caller itself is a system principal', () => {
    expect(observabilityPrincipals('system-sweep')).toEqual(['system', 'system-sweep', 'system-discovery']);
  });

  it('union stays within the Firestore in-filter limit', () => {
    expect(observabilityPrincipals('user-abc').length).toBeLessThanOrEqual(10);
  });
});
