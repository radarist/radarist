import { shouldUseFirebaseAdminEmulator } from '@/lib/firebase-admin-environment';

describe('shouldUseFirebaseAdminEmulator', () => {
  it.each([
    [{ NEXT_PUBLIC_USE_FIREBASE_EMULATOR: 'true' }, true],
    [{ FIRESTORE_EMULATOR_HOST: '127.0.0.1:18080' }, true],
    [
      {
        NEXT_PUBLIC_USE_FIREBASE_EMULATOR: 'false',
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:18080',
      },
      true,
    ],
    [{ NEXT_PUBLIC_USE_FIREBASE_EMULATOR: 'false' }, false],
    [{ FIRESTORE_EMULATOR_HOST: '   ' }, false],
    [{}, false],
  ])('resolves %o to %s', (env, expected) => {
    expect(shouldUseFirebaseAdminEmulator(env)).toBe(expected);
  });
});
