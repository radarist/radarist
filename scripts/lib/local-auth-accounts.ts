import { randomUUID } from 'crypto';
import { assertLoopbackCheckpointTarget } from './local-checkpoint-barrier';

export const MAX_ADVERTISED_LOCAL_ACCOUNTS = 3;
export const MAX_INSPECTED_LOCAL_ACCOUNTS = 100;

export type LocalLoginAdvertisementKind =
  'seeded' | 'restored-match' | 'restored-other' | 'restored-empty' | 'restored-unknown';

export interface LocalLoginAdvertisement {
  readonly kind: LocalLoginAdvertisementKind;
  readonly line: string;
  /** True only when this launcher itself just set the advertised password. */
  readonly advertisesPassword: boolean;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Describe the login the operator can actually use.
 *
 * A seeding start has just created the advertised account with the advertised
 * password, so it may print both. A restored start reseeds nothing: the
 * accounts are whatever the checkpoint captured, and their passwords are
 * whatever they were when captured — which need not match the current
 * `.env.local`. Advertising a `.env.local` password against restored state is
 * therefore a claim this launcher cannot support, so it is never printed.
 */
export function describeLocalLogin(input: {
  readonly seeded: boolean;
  readonly expectedEmail: string;
  readonly expectedPassword: string;
  /** Emails observed in restored Auth state; `undefined` when uninspectable. */
  readonly restoredEmails?: readonly string[];
}): LocalLoginAdvertisement {
  if (input.seeded) {
    return {
      kind: 'seeded',
      line: `${input.expectedEmail} / ${input.expectedPassword}`,
      advertisesPassword: true,
    };
  }

  if (!input.restoredEmails) {
    return {
      kind: 'restored-unknown',
      line: 'restored workspace — accounts could not be inspected; sign in with an account this workspace already had',
      advertisesPassword: false,
    };
  }

  const expected = normalizeEmail(input.expectedEmail);
  const match = input.restoredEmails.find((email) => normalizeEmail(email) === expected);
  if (match) {
    return {
      kind: 'restored-match',
      line: `${match} (restored account — its password came from the checkpoint, not .env.local)`,
      advertisesPassword: false,
    };
  }

  if (input.restoredEmails.length === 0) {
    return {
      kind: 'restored-empty',
      line: 'restored workspace has no Auth accounts — start a fresh profile if you need seeded credentials',
      advertisesPassword: false,
    };
  }

  const shown = input.restoredEmails.slice(0, MAX_ADVERTISED_LOCAL_ACCOUNTS);
  const remaining = input.restoredEmails.length - shown.length;
  return {
    kind: 'restored-other',
    line:
      `${input.expectedEmail} is not in the restored workspace; available: ${shown.join(', ')}` +
      `${remaining > 0 ? ` (+${remaining} more)` : ''}`,
    advertisesPassword: false,
  };
}

/**
 * List Auth accounts from a loopback emulator. Built lazily, behind the same
 * loopback/`demo-*` guard the checkpoint barrier uses, so importing this module
 * can never reach a live project.
 */
export async function listLocalAuthAccountEmails(
  host: string,
  projectId: string,
  limit: number = MAX_INSPECTED_LOCAL_ACCOUNTS
): Promise<string[]> {
  assertLoopbackCheckpointTarget(host, projectId);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('Local Auth account inspection limit must be between 1 and 1000.');
  }
  process.env.FIREBASE_AUTH_EMULATOR_HOST = host;

  const [{ initializeApp, deleteApp }, { getAuth }] = await Promise.all([
    import('firebase-admin/app'),
    import('firebase-admin/auth'),
  ]);
  const app = initializeApp({ projectId }, `radarist-auth-inspect-${process.pid}-${randomUUID()}`);
  try {
    const page = await getAuth(app).listUsers(limit);
    return page.users
      .map((user) => user.email)
      .filter((email): email is string => typeof email === 'string' && email.length > 0)
      .sort((left, right) => left.localeCompare(right));
  } finally {
    await deleteApp(app);
  }
}
