/** Runtime-only Firebase Admin environment decisions. */
export type FirebaseAdminEnvironment = Readonly<{
  NEXT_PUBLIC_USE_FIREBASE_EMULATOR?: string;
  FIRESTORE_EMULATOR_HOST?: string;
}>;

export function shouldUseFirebaseAdminEmulator(
  env: FirebaseAdminEnvironment
): boolean {
  return (
    env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR === 'true' ||
    Boolean(env.FIRESTORE_EMULATOR_HOST?.trim())
  );
}
