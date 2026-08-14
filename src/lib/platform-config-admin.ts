/**
 * @file lib/platform-config-admin.ts
 * @description Server-only admin-SDK twin of `platform-config.ts`.
 *
 * Inngest worker functions can't use the Firebase **client** SDK (no
 * persistent connection → `code: 'unavailable'`). `cleanup-archived-signals.ts`
 * read platform config via the client-SDK `getPlatformConfig`; this module
 * provides an admin-SDK implementation with identical doc path, default-config
 * fallback, return shape, and error behavior.
 *
 * Scope: only `adminGetPlatformConfig` — the sole platform-config function the
 * Inngest workers call. `updatePlatformConfig` / `resetPlatformConfig` are
 * write paths driven from the settings UI (client SDK) and have no worker
 * consumer, so they are intentionally not mirrored here.
 *
 * UI/client callers MUST keep importing `@/lib/platform-config`.
 *
 * @author Radarist Team
 * @created 2026-06-07
 */

import 'server-only';
import { db } from '@/lib/firebase-admin';
import { createLogger } from '@/lib/logger';
import {
  createDefaultPlatformConfig,
  isValidArchiveRetentionDays,
  normalizePlatformConfig,
  type PlatformConfig,
} from '@/lib/platform-config-schema';

const log = createLogger('platform-config-admin');

/**
 * Document path for platform config.
 *
 * Matches `CONFIG_DOC_PATH` in `platform-config.ts` ('settings/platform').
 */
const CONFIG_COLLECTION = 'settings';
const CONFIG_DOC_ID = 'platform';

/**
 * Get platform configuration from Firestore using the Admin SDK.
 * Returns default values only when no config exists. Read failures and an
 * invalid persisted retention policy throw so destructive workers fail closed.
 *
 * This is intentionally stricter than the client helper: the settings UI can
 * render defaults while recovering from corrupt data, but a cleanup worker
 * must not permanently delete data using a shorter fallback policy.
 *
 * @returns Promise resolving to PlatformConfig
 *
 * @example
 * ```typescript
 * import { adminGetPlatformConfig as getPlatformConfig } from '@/lib/platform-config-admin';
 * const config = await getPlatformConfig();
 * ```
 */
export async function adminGetPlatformConfig(): Promise<PlatformConfig> {
  try {
    const docSnap = await db.collection(CONFIG_COLLECTION).doc(CONFIG_DOC_ID).get();

    if (docSnap.exists) {
      const data = docSnap.data();
      if (!isValidArchiveRetentionDays(data?.archiveRetentionDays)) {
        throw new Error('Invalid persisted archiveRetentionDays; refusing destructive cleanup');
      }
      return normalizePlatformConfig(data);
    }

    // Return defaults if no config exists
    return createDefaultPlatformConfig();
  } catch (error) {
    log.error('Error fetching config', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}
