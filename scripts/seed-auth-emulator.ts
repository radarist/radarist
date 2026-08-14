#!/usr/bin/env npx tsx

import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import {
  buildDemoEnv,
  DEMO_USER_EMAIL,
  DEMO_USER_PASSWORD,
  DEMO_USER_UID,
  MANAGED_ENV_KEYS,
  envForChild,
  getFlagValue,
  parseProfileArg,
  readEnvFile,
  type EnvMap,
} from './lib/local-demo';

export interface SeedUser {
  email: string;
  password: string;
  /**
   * Pinned auth uid. Only the canonical demo user carries one — the demo seed
   * data (`scripts/seed-demo.ts`) is owned by `DEMO_USER_UID`, so the auth
   * account must have exactly that uid or the signed-in user does not own the
   * seeded missions/reports. E2E override users keep an emulator-random uid.
   */
  uid?: string;
}

export interface SeedPlan {
  projectId: string;
  users: SeedUser[];
}

/**
 * Merge local defaults with explicit command-level overrides.
 *
 * The E2E commands intentionally pin their emulator identity in the process
 * environment. Those values must win over stale personal `.env.local` values
 * or the seed and browser fixtures can create/sign in as different users.
 */
export function mergeSeedEnvironment(fileEnv: EnvMap, runtimeEnv: NodeJS.ProcessEnv): EnvMap {
  const merged = { ...fileEnv };
  for (const key of MANAGED_ENV_KEYS) {
    const value = runtimeEnv[key];
    if (typeof value === 'string') merged[key] = value;
  }
  return merged;
}

/**
 * Build the selected profile and then reapply explicit command-level managed
 * values. `buildDemoEnv` must defeat stale values from the profile's env file,
 * while `firebase emulators:exec` must still be able to assign a disposable
 * shifted host for an owned acceptance lane.
 */
export function resolveSeedEnvironment(
  args: string[],
  fileEnv: EnvMap,
  runtimeEnv: NodeJS.ProcessEnv,
): EnvMap {
  const profile = parseProfileArg(args);
  const profileEnv = buildDemoEnv(
    profile,
    mergeSeedEnvironment(fileEnv, runtimeEnv),
  );
  return mergeSeedEnvironment(profileEnv, runtimeEnv);
}

/**
 * Resolve which auth-emulator project namespace to seed.
 *
 * `--project <id>` pins the namespace. `npm run demo` needs this: demo:inner
 * runs seed-demo and the app against the hardcoded `demo-radarist` project,
 * while buildDemoEnv prefers `.env.local` — without the flag the auth user
 * lands in the `.env.local` project's namespace and login fails with
 * auth/user-not-found.
 */
export function resolveTargetProjectId(args: string[], env: EnvMap): string {
  return getFlagValue(args, '--project') || env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'demo-radarist';
}

/**
 * Resolve which users to create in the resolved project namespace.
 *
 * - The canonical DEMO_USER_EMAIL/DEMO_USER_PASSWORD user is ALWAYS seeded:
 *   the login page hardcodes those as the advertised "Fill demo credentials"
 *   values, regardless of any E2E_USER_* overrides in `.env.local`. Its uid is
 *   pinned to DEMO_USER_UID so the account owns the seeded demo content.
 * - When `.env.local` overrides E2E_USER_* with a different email, that user
 *   is seeded as well so Playwright runs keep working.
 * - When E2E_USER_EMAIL matches the canonical email but E2E_USER_PASSWORD
 *   differs, the override wins (the canonical user is seeded with the E2E
 *   password) — otherwise Playwright signs in with a password the emulator
 *   doesn't have. We warn loudly because the login page's advertised hint
 *   password will no longer match.
 */
export function resolveSeedPlan(args: string[], env: EnvMap): SeedPlan {
  const projectId = resolveTargetProjectId(args, env);
  const e2eEmail = env.E2E_USER_EMAIL || DEMO_USER_EMAIL;
  const e2ePassword = env.E2E_USER_PASSWORD || DEMO_USER_PASSWORD;

  let canonicalPassword = DEMO_USER_PASSWORD;
  if (e2eEmail === DEMO_USER_EMAIL && e2ePassword !== DEMO_USER_PASSWORD) {
    canonicalPassword = e2ePassword;
    console.warn(
      `[seed:auth] WARNING: E2E_USER_PASSWORD overrides the canonical demo user's password. ` +
        `Seeding ${DEMO_USER_EMAIL} with the E2E override — the login page's advertised ` +
        `hint password ("${DEMO_USER_PASSWORD}") will NOT match. Unset E2E_USER_PASSWORD ` +
        `in .env.local to restore the advertised credentials.`
    );
  }

  const users: SeedUser[] = [{ email: DEMO_USER_EMAIL, password: canonicalPassword, uid: DEMO_USER_UID }];
  if (e2eEmail !== DEMO_USER_EMAIL) {
    users.push({ email: e2eEmail, password: e2ePassword });
  }
  return { projectId, users };
}

async function ensureUser(auth: Auth, db: Firestore, { email, password, uid: pinnedUid }: SeedUser): Promise<void> {
  const profile = {
    displayName: 'Radarist Demo User',
    emailVerified: true,
    disabled: false,
  };

  let uid: string;
  try {
    const existing = await auth.getUserByEmail(email);

    if (pinnedUid && existing.uid !== pinnedUid) {
      // The account exists under a different (emulator-random) uid, so it
      // doesn't own the seeded demo content. Emulator-only script —
      // destructive-safe: delete and recreate with the pinned uid, and drop
      // the stale users/{old-uid} profile doc.
      await auth.deleteUser(existing.uid);
      await db.collection('users').doc(existing.uid).delete();
      const created = await auth.createUser({ uid: pinnedUid, email, password, ...profile });
      uid = created.uid;
      console.log(`[seed:auth] Recreated ${email} with pinned uid '${pinnedUid}' (was '${existing.uid}')`);
    } else {
      uid = existing.uid;
      await auth.updateUser(uid, { password, ...profile });
      console.log(`[seed:auth] Updated existing demo auth user ${email}`);
    }
  } catch (error: unknown) {
    if ((error as { code?: string })?.code !== 'auth/user-not-found') throw error;
    const created = await auth.createUser({
      ...(pinnedUid ? { uid: pinnedUid } : {}),
      email,
      password,
      ...profile,
    });
    uid = created.uid;
    console.log(`[seed:auth] Created demo auth user ${email}${pinnedUid ? ` (uid: ${pinnedUid})` : ''}`);
  }

  await db.collection('users').doc(uid).set(
    {
      email,
      displayName: 'Radarist Demo User',
      role: 'admin',
      demo: true,
      updatedAt: Date.now(),
      createdAt: Date.now(),
    },
    { merge: true }
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const profile = parseProfileArg(args);
  const env = resolveSeedEnvironment(
    args,
    readEnvFile(profile.envFile),
    process.env,
  );
  Object.assign(process.env, envForChild(env));

  // FIRST log line: make the target namespace visible before anything else —
  // seeding the wrong project namespace is the classic "login user-not-found"
  // failure when .env.local points at a different project than `npm run demo`.
  console.log(`[seed:auth] target project: ${resolveTargetProjectId(args, env)} (pass --project to override)`);

  const plan = resolveSeedPlan(args, env);
  const app = getApps().length > 0 ? getApps()[0] : initializeApp({ projectId: plan.projectId });
  const auth = getAuth(app);
  const db = getFirestore(app);

  for (const user of plan.users) {
    await ensureUser(auth, db, user);
  }

  // plan.users[0] is always the canonical user — print the password actually
  // seeded (the E2E override may have replaced the advertised default).
  console.log(
    `[seed:auth] Demo login ready: ${DEMO_USER_EMAIL} / ${plan.users[0].password} (project: ${plan.projectId})`
  );
}

// Only run when executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error('[seed:auth] Failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
