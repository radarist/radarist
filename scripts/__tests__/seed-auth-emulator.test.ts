/**
 * @file seed-auth-emulator.test.ts
 * @description Unit tests for the auth-seed plan resolution. Pins the contract
 * that the canonical demo user (advertised verbatim by the login page) is
 * always seeded with the pinned DEMO_USER_UID (so it owns the seeded demo
 * content), that --project overrides the .env.local-resolved namespace (the
 * `npm run demo` fix — without it the user lands in the wrong auth-emulator
 * project and login fails with auth/user-not-found), and that an E2E password
 * override on the canonical email is honored with a loud warning.
 */

// Mock firebase-admin so importing the script does not initialize the SDK.
jest.mock('firebase-admin/app', () => ({
  initializeApp: jest.fn(() => ({})),
  getApps: jest.fn(() => []),
}));
jest.mock('firebase-admin/auth', () => ({
  getAuth: jest.fn(() => ({})),
}));
jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => ({})),
}));

import {
  mergeSeedEnvironment,
  resolveSeedEnvironment,
  resolveSeedPlan,
  resolveTargetProjectId,
} from '../seed-auth-emulator';
import { DEMO_USER_EMAIL, DEMO_USER_PASSWORD, DEMO_USER_UID } from '../lib/local-demo';

describe('resolveSeedPlan', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('always includes the canonical demo user the login page advertises', () => {
    const plan = resolveSeedPlan([], {});
    expect(plan.users).toContainEqual({
      email: DEMO_USER_EMAIL,
      password: DEMO_USER_PASSWORD,
      uid: DEMO_USER_UID,
    });
  });

  it('pins the canonical user to DEMO_USER_UID and leaves the E2E user unpinned', () => {
    const plan = resolveSeedPlan([], {
      E2E_USER_EMAIL: 'someone@example.com',
      E2E_USER_PASSWORD: 'pw-override',
    });
    const canonical = plan.users.find((u) => u.email === DEMO_USER_EMAIL);
    const e2e = plan.users.find((u) => u.email === 'someone@example.com');
    expect(canonical?.uid).toBe(DEMO_USER_UID);
    expect(e2e?.uid).toBeUndefined();
  });

  it('uses --project over the env-resolved project id', () => {
    const plan = resolveSeedPlan(['--project', 'demo-radarist'], {
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'some-real-project',
    });
    expect(plan.projectId).toBe('demo-radarist');
  });

  it('supports --project=value form', () => {
    const plan = resolveSeedPlan(['--project=demo-radarist'], {
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'some-real-project',
    });
    expect(plan.projectId).toBe('demo-radarist');
  });

  it('falls back to the env project id, then demo-radarist', () => {
    expect(resolveSeedPlan([], { NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'p-1' }).projectId).toBe('p-1');
    expect(resolveSeedPlan([], {}).projectId).toBe('demo-radarist');
  });

  it('also seeds the E2E override user when it differs from the canonical user', () => {
    const plan = resolveSeedPlan([], {
      E2E_USER_EMAIL: 'someone@example.com',
      E2E_USER_PASSWORD: 'pw-override',
    });
    expect(plan.users).toEqual([
      { email: DEMO_USER_EMAIL, password: DEMO_USER_PASSWORD, uid: DEMO_USER_UID },
      { email: 'someone@example.com', password: 'pw-override' },
    ]);
  });

  it('seeds the canonical user exactly once when E2E creds match it', () => {
    const plan = resolveSeedPlan([], {
      E2E_USER_EMAIL: DEMO_USER_EMAIL,
      E2E_USER_PASSWORD: DEMO_USER_PASSWORD,
    });
    expect(plan.users).toHaveLength(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('honors an E2E password override on the canonical email and warns loudly', () => {
    const plan = resolveSeedPlan([], {
      E2E_USER_EMAIL: DEMO_USER_EMAIL,
      E2E_USER_PASSWORD: 'different-e2e-password',
    });
    expect(plan.users).toEqual([{ email: DEMO_USER_EMAIL, password: 'different-e2e-password', uid: DEMO_USER_UID }]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('will NOT match');
  });

  it('keeps the default (no override) case unchanged: advertised password, no warning', () => {
    const plan = resolveSeedPlan([], {});
    expect(plan.users).toEqual([{ email: DEMO_USER_EMAIL, password: DEMO_USER_PASSWORD, uid: DEMO_USER_UID }]);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('resolveTargetProjectId', () => {
  it('prefers --project, then env, then demo-radarist', () => {
    expect(resolveTargetProjectId(['--project', 'pinned'], { NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'env-p' })).toBe(
      'pinned'
    );
    expect(resolveTargetProjectId([], { NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'env-p' })).toBe('env-p');
    expect(resolveTargetProjectId([], {})).toBe('demo-radarist');
  });
});

describe('mergeSeedEnvironment', () => {
  it('lets explicit E2E command values override stale local-file credentials', () => {
    expect(
      mergeSeedEnvironment(
        {
          E2E_USER_EMAIL: 'personal@example.com',
          E2E_USER_PASSWORD: 'personal-password',
          NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'personal-project',
        },
        {
          E2E_USER_EMAIL: DEMO_USER_EMAIL,
          E2E_USER_PASSWORD: DEMO_USER_PASSWORD,
          NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-radarist',
        }
      )
    ).toEqual(
      expect.objectContaining({
        E2E_USER_EMAIL: DEMO_USER_EMAIL,
        E2E_USER_PASSWORD: DEMO_USER_PASSWORD,
        NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-radarist',
      })
    );
  });

  it('preserves local-file values when the command does not override them', () => {
    expect(mergeSeedEnvironment({ E2E_USER_EMAIL: 'personal@example.com' }, {})).toEqual({
      E2E_USER_EMAIL: 'personal@example.com',
    });
  });
});

describe('resolveSeedEnvironment', () => {
  it('keeps firebase emulators:exec shifted hosts authoritative over the selected profile', () => {
    const env = resolveSeedEnvironment(
      [],
      {
        FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      },
      {
        FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:19799',
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:19780',
        NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:19799',
        NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: '127.0.0.1:19780',
      },
    );

    expect(env.FIREBASE_AUTH_EMULATOR_HOST).toBe('127.0.0.1:19799');
    expect(env.FIRESTORE_EMULATOR_HOST).toBe('127.0.0.1:19780');
    expect(env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST).toBe(
      '127.0.0.1:19799',
    );
    expect(env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST).toBe(
      '127.0.0.1:19780',
    );
  });
});
