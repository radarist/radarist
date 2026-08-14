/**
 * @jest-environment node
 */

import { describeLocalLogin, listLocalAuthAccountEmails } from '../lib/local-auth-accounts';

const SEEDED = {
  seeded: true,
  expectedEmail: 'demo@radarist.local',
  expectedPassword: 'radarist-demo-password',
} as const;

describe('describeLocalLogin', () => {
  it('advertises credentials only when this launcher just seeded them', () => {
    const advertisement = describeLocalLogin(SEEDED);
    expect(advertisement.kind).toBe('seeded');
    expect(advertisement.advertisesPassword).toBe(true);
    expect(advertisement.line).toBe('demo@radarist.local / radarist-demo-password');
  });

  it('never prints a password for a restored workspace, even when the account exists', () => {
    const advertisement = describeLocalLogin({
      ...SEEDED,
      seeded: false,
      restoredEmails: ['demo@radarist.local', 'other@radarist.local'],
    });
    expect(advertisement.kind).toBe('restored-match');
    expect(advertisement.advertisesPassword).toBe(false);
    expect(advertisement.line).toContain('demo@radarist.local');
    // The restored password came from the checkpoint, not from .env.local, so
    // the configured password must never appear anywhere in the banner.
    expect(advertisement.line).not.toContain(SEEDED.expectedPassword);
  });

  it('matches restored accounts case-insensitively and prints the stored casing', () => {
    const advertisement = describeLocalLogin({
      ...SEEDED,
      seeded: false,
      expectedEmail: 'DEMO@Radarist.Local',
      restoredEmails: ['demo@radarist.local'],
    });
    expect(advertisement.kind).toBe('restored-match');
    expect(advertisement.line).toContain('demo@radarist.local');
  });

  it('reports the accounts that do exist when the expected one is absent', () => {
    const advertisement = describeLocalLogin({
      ...SEEDED,
      seeded: false,
      restoredEmails: ['a@radarist.local', 'b@radarist.local'],
    });
    expect(advertisement.kind).toBe('restored-other');
    expect(advertisement.advertisesPassword).toBe(false);
    expect(advertisement.line).toContain('a@radarist.local');
    expect(advertisement.line).toContain('b@radarist.local');
    expect(advertisement.line).not.toContain(SEEDED.expectedPassword);
  });

  it('bounds how many restored accounts it lists', () => {
    const advertisement = describeLocalLogin({
      ...SEEDED,
      seeded: false,
      restoredEmails: ['a@x.local', 'b@x.local', 'c@x.local', 'd@x.local', 'e@x.local'],
    });
    expect(advertisement.kind).toBe('restored-other');
    expect(advertisement.line).toContain('(+2 more)');
    expect(advertisement.line).not.toContain('d@x.local');
  });

  it('says so plainly when the restored workspace has no accounts', () => {
    const advertisement = describeLocalLogin({ ...SEEDED, seeded: false, restoredEmails: [] });
    expect(advertisement.kind).toBe('restored-empty');
    expect(advertisement.advertisesPassword).toBe(false);
    expect(advertisement.line).not.toContain(SEEDED.expectedEmail);
  });

  it('degrades to an explicitly unknown banner when inspection failed', () => {
    const advertisement = describeLocalLogin({ ...SEEDED, seeded: false, restoredEmails: undefined });
    expect(advertisement.kind).toBe('restored-unknown');
    expect(advertisement.advertisesPassword).toBe(false);
    expect(advertisement.line).not.toContain(SEEDED.expectedPassword);
  });

  it('never advertises a password on any non-seeded path', () => {
    const restoredCases: ReadonlyArray<readonly string[] | undefined> = [
      undefined,
      [],
      ['demo@radarist.local'],
      ['someone@else.local'],
    ];
    for (const restoredEmails of restoredCases) {
      const advertisement = describeLocalLogin({ ...SEEDED, seeded: false, restoredEmails });
      expect(advertisement.advertisesPassword).toBe(false);
      expect(advertisement.line).not.toContain(SEEDED.expectedPassword);
    }
  });
});

describe('listLocalAuthAccountEmails', () => {
  it('refuses a non-loopback host before touching any SDK', async () => {
    await expect(listLocalAuthAccountEmails('auth.example.com:9099', 'demo-radarist')).rejects.toThrow(
      /loopback emulator and demo-\* project/
    );
  });

  it('refuses a non-demo project before touching any SDK', async () => {
    await expect(listLocalAuthAccountEmails('127.0.0.1:9099', 'production-radarist')).rejects.toThrow(
      /loopback emulator and demo-\* project/
    );
  });

  it('refuses an out-of-range inspection limit', async () => {
    await expect(listLocalAuthAccountEmails('127.0.0.1:9099', 'demo-radarist', 0)).rejects.toThrow(
      /between 1 and 1000/
    );
    await expect(listLocalAuthAccountEmails('127.0.0.1:9099', 'demo-radarist', 5_000)).rejects.toThrow(
      /between 1 and 1000/
    );
  });
});
