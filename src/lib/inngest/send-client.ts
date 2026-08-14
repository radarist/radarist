/**
 * @file lib/inngest/send-client.ts
 * @description Client-safe, send-only Inngest instance.
 *
 * WHY THIS EXISTS (Next 16 turbopack boundary):
 * `@/lib/inngest/client` attaches `jobRunTrackingMiddleware`, which lazy-imports
 * `observability.ts` → `@/lib/firebase-admin` (`import 'server-only'`). Next 16's
 * turbopack traces `await import()` targets for `server-only` enforcement, so any
 * CLIENT-SAFE module that imports the full client to `.send()` an event drags
 * `firebase-admin` into the client bundle and 500s the page.
 *
 * This module builds a middleware-FREE Inngest instance with the same id / event
 * schema / event key, so `.send()` reaches the exact same Inngest environment and
 * the exact same served functions — WITHOUT pulling the observability chain into
 * the client graph. Middleware only runs during function EXECUTION (served via
 * `@/lib/inngest/client` at `/api/inngest`), never during `.send()`, so nothing is
 * lost.
 *
 * Rule of thumb:
 * - Client-safe SERVICES that only emit events  → import from THIS module.
 * - Function definitions (`createFunction`) + the serve endpoint → `./client`.
 */

import { EventSchemas, Inngest } from 'inngest';
import { createLogger } from '@/lib/logger';
import type { InngestEvents } from './client'; // type-only: erased at build, no runtime edge
import {
  isInngestEnvironmentConfigured,
  isInngestExplicitlyDisabled,
  isInngestUnitTestSendBlocked,
  withInngestKillSwitch,
  withInngestUnitTestGuard,
} from './configured';

const log = createLogger('inngest/send-client');

/**
 * Middleware-free Inngest client. Same id/schemas/eventKey as `./client` so
 * events land in the same environment and match the same served functions.
 */
export const inngest = new Inngest({
  id: 'radarist-innovation-platform',
  name: 'Radarist Innovation Platform',
  schemas: new EventSchemas().fromRecord<InngestEvents>(),
  eventKey: process.env.INNGEST_EVENT_KEY,
});

inngest.send = withInngestKillSwitch(
  withInngestUnitTestGuard(inngest.send.bind(inngest), isInngestUnitTestSendBlocked()),
  isInngestExplicitlyDisabled({
    INNGEST_ENABLED: process.env.INNGEST_ENABLED,
    NEXT_PUBLIC_INNGEST_ENABLED: process.env.NEXT_PUBLIC_INNGEST_ENABLED,
  })
);

/** Mirror of client.ts: only send when a dev URL or event key is present. */
export function isInngestConfigured(): boolean {
  return isInngestEnvironmentConfigured();
}

type AppEventPayload = Parameters<typeof inngest.send>[0];

/** Thin typed wrapper around `inngest.send` (throws on failure). */
export async function sendEvent<K extends keyof InngestEvents>(event: { name: K; data: InngestEvents[K]['data'] }) {
  return await inngest.send(event as AppEventPayload);
}

/**
 * Best-effort send: never throws, returns false when Inngest isn't configured or
 * the send fails. Mirrors `client.ts#safeSendEvent`.
 */
export async function safeSendEvent<K extends keyof InngestEvents>(
  event: { name: K; data: InngestEvents[K]['data'] },
  options: { silent?: boolean; logPrefix?: string } = {}
): Promise<boolean> {
  const { silent = false, logPrefix = '[Inngest]' } = options;
  if (!isInngestConfigured()) {
    if (!silent) log.debug('Skipping event - Inngest not configured', { eventName: event.name, logPrefix });
    return false;
  }
  try {
    await inngest.send(event as AppEventPayload);
    return true;
  } catch (error) {
    if (!silent) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.warn('Failed to send event', { eventName: event.name, errorMessage, logPrefix });
    }
    return false;
  }
}
