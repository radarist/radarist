/**
 * @file user-profile.ts
 * @description Server-only reader for the operator owner profile
 * (`users/{uid}`). UX-062: the sidebar binds the visible identity to this
 * canonical record rather than the Firebase Auth `displayName`, which carries
 * the seeded `Radarist Demo User` label and is therefore not a trustworthy
 * signal of the actual authenticated account.
 *
 * Owner-scoped by construction: callers pass the verified uid from the auth
 * token; this module never accepts a client-supplied identity.
 */

import 'server-only';

import { db } from '@/lib/firebase-admin';
import { createLogger } from '@/lib/logger';

const log = createLogger('user-profile');

const COLLECTION = 'users';

/** Normalized owner profile — only the fields an identity surface needs. */
export interface OwnerProfile {
  uid: string;
  displayName: string | null;
  email: string | null;
  photoURL: string | null;
}

/** Coerce an unknown stored value to a trimmed string or null. */
function asStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Read the `users/{uid}` owner profile. Returns `null` when no profile doc
 * exists (e.g. a fresh email signup that has not been seeded); the caller
 * falls back to the Firebase Auth email identity in that case. Stored fields
 * are coerced defensively so a malformed legacy doc can never surface a
 * non-string to the UI.
 */
export async function getOwnerProfile(uid: string): Promise<OwnerProfile | null> {
  try {
    const snap = await db.collection(COLLECTION).doc(uid).get();
    if (!snap.exists) {
      return null;
    }
    const data = snap.data() ?? {};
    return {
      uid,
      displayName: asStringOrNull(data.displayName),
      email: asStringOrNull(data.email),
      photoURL: asStringOrNull(data.photoURL),
    };
  } catch (error) {
    log.error('Error reading owner profile', error instanceof Error ? error : new Error(String(error)), { uid });
    throw new Error(`Failed to read owner profile: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
