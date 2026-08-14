/**
 * @file maintenance-pause.emulator.ts
 * @description OPS-001 acceptance against a real Firestore emulator: a paused
 * schedule window causes ZERO domain mutations and yields only a bounded
 * skipped-audit record; unpausing lets the SAME handler mutate — proving the
 * gate, not a broken handler, is what withheld the write.
 *
 * This file deliberately does not match the root Jest `*.test.ts` pattern. Run
 * it through `npm run test:emulator`, which owns ephemeral Auth/Firestore/
 * Storage emulators with Neo4j explicitly disabled. cleanup-archived-signals is
 * Firestore-only, so it exercises the full paused/active contrast without Neo4j.
 *
 * The Inngest client is mocked so `createFunction` yields a directly-invokable
 * handler and `send` is inert; Firestore admin writes remain real (emulator).
 */

jest.mock('@/lib/inngest/client', () => {
  const actual = jest.requireActual('@/lib/inngest/client');
  return {
    ...actual,
    inngest: {
      createFunction: (
        config: unknown,
        trigger: unknown,
        handler: (ctx: {
          event: { data: unknown };
          step: { run: (n: string, fn: () => unknown) => unknown };
        }) => unknown
      ) => ({
        config,
        trigger,
        handler,
        execute: (data: unknown) =>
          handler({ event: { data }, step: { run: async (_n: string, fn: () => unknown) => fn() } }),
      }),
      send: jest.fn(),
    },
  };
});

import { db as adminDb } from '@/lib/firebase-admin';
import { cleanupArchivedSignalsJob } from '@/lib/inngest/functions/cleanup-archived-signals';

if (process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR !== 'true') {
  throw new Error('maintenance-pause.emulator.ts must run with NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true');
}

const SIGNAL_ID = 'ops001-archived-signal';
// Archived far beyond any retention window (epoch+1s) so cleanup would delete it.
const ARCHIVED_AT = 1000;
const ORIGINAL_PAUSED = process.env.MAINTENANCE_PAUSED;

async function seedArchivedSignal(): Promise<void> {
  await adminDb
    .collection('signals')
    .doc(SIGNAL_ID)
    .set({
      id: SIGNAL_ID,
      title: 'OPS-001 disposable archived signal',
      status: 'Archived',
      detectedAt: ARCHIVED_AT,
      metadata: { archivedAt: ARCHIVED_AT },
    });
}

async function signalExists(): Promise<boolean> {
  const snap = await adminDb.collection('signals').doc(SIGNAL_ID).get();
  return snap.exists;
}

describe('OPS-001 — paused schedule window (emulator)', () => {
  afterEach(async () => {
    if (ORIGINAL_PAUSED === undefined) delete process.env.MAINTENANCE_PAUSED;
    else process.env.MAINTENANCE_PAUSED = ORIGINAL_PAUSED;
    await adminDb.collection('signals').doc(SIGNAL_ID).delete();
  });

  it('a paused cleanup run mutates nothing and returns a bounded skip record', async () => {
    await seedArchivedSignal();
    process.env.MAINTENANCE_PAUSED = 'true';

    const result = await (
      cleanupArchivedSignalsJob as unknown as { execute: (d: unknown) => Promise<unknown> }
    ).execute({});

    expect(result).toMatchObject({
      skipped: true,
      reason: 'maintenance-paused',
      functionId: 'cleanup-archived-signals',
    });
    // Zero domain mutation: the archived signal is untouched despite being far
    // past retention.
    expect(await signalExists()).toBe(true);
  });

  it('the SAME handler deletes the signal once unpaused (the gate was the only difference)', async () => {
    await seedArchivedSignal();
    process.env.MAINTENANCE_PAUSED = 'false';

    const result = (await (
      cleanupArchivedSignalsJob as unknown as { execute: (d: unknown) => Promise<unknown> }
    ).execute({})) as { success?: boolean; signalsDeleted?: number };

    expect(result.success).toBe(true);
    expect(result.signalsDeleted).toBeGreaterThanOrEqual(1);
    expect(await signalExists()).toBe(false);
  });
});
