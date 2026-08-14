/**
 * ARUN-028 — post-research handoff durability against a real Firestore
 * emulator. Provider calls and the Inngest transport are controlled seams;
 * transactions, queries, completed-artifact inspection, and debt clearing are
 * the production implementations.
 */

let mockFailDebtWrite = false;
const mockInngestSend = jest.fn();
const mockDeepResearch = jest.fn();

jest.mock('@/lib/inngest/client', () => ({
  __esModule: true,
  inngest: {
    createFunction: jest.fn(
      (
        config: Record<string, unknown>,
        _trigger: unknown,
        handler: (input: {
          event: { data: Record<string, unknown> };
          step: { run: <T>(name: string, operation: () => T | Promise<T>) => Promise<T> };
        }) => Promise<unknown>
      ) => ({
        config,
        execute: (data: Record<string, unknown>) =>
          handler({
            event: { data },
            step: { run: async <T>(_name: string, operation: () => T | Promise<T>) => operation() },
          }),
      })
    ),
    send: (...args: unknown[]) => mockInngestSend(...args),
  },
}));

jest.mock('@/ai/flows/deep-research', () => ({
  __esModule: true,
  deepResearchStructured: (...args: unknown[]) => mockDeepResearch(...args),
}));

jest.mock('@/lib/entity-sync-server', () => ({
  __esModule: true,
  triggerEntityGraphSyncBestEffortServer: jest.fn(async () => ({ acknowledged: true, anchorRecorded: false })),
}));

jest.mock('@/lib/technology-research-admin', () => {
  const actual = jest.requireActual('@/lib/technology-research-admin') as typeof import('@/lib/technology-research-admin');
  return {
    __esModule: true,
    ...actual,
    recordPendingSnapshotRefresh: (...args: Parameters<typeof actual.recordPendingSnapshotRefresh>) => {
      if (mockFailDebtWrite) {
        throw new actual.PendingSnapshotRefreshPersistenceError(args[0], args[1], new Error('injected outage'));
      }
      return actual.recordPendingSnapshotRefresh(...args);
    },
  };
});

import { db } from '@/lib/firebase-admin';
import {
  clearPendingSnapshotRefresh,
  listTechnologiesWithPendingSnapshotRefresh,
  recordPendingSnapshotRefresh,
} from '@/lib/technology-research-admin';
import { replayPendingSnapshotRefreshesJob } from '@/lib/inngest/functions/replay-pending-snapshot-refreshes';
import { runDeepResearchJob } from '@/lib/inngest/functions/run-deep-research';

const RUN_ACCEPTANCE = process.env.RESEARCH_HANDOFF_DURABILITY_EMULATOR === '1';
if (RUN_ACCEPTANCE) {
  if (!process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.startsWith('demo-')) {
    throw new Error('Research handoff acceptance requires a disposable demo-* Firebase project');
  }
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')) {
    throw new Error('Research handoff acceptance requires a loopback Firestore emulator');
  }
}

interface ExecutableJob {
  execute(data: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const RUN_PREFIX = `arun028-${Date.now()}`;
const ownedIds = new Set<string>();

function technologyRef(id: string) {
  ownedIds.add(id);
  return db.collection('technologies').doc(id);
}

async function seedTechnology(id: string, values: Record<string, unknown> = {}): Promise<void> {
  await technologyRef(id).set({
    name: `Technology ${id}`,
    description: 'Disposable research-handoff acceptance entity.',
    category: 'other',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...values,
  });
}

afterEach(async () => {
  mockFailDebtWrite = false;
  for (const id of ownedIds) await db.collection('technologies').doc(id).delete();
  for (const id of ownedIds) expect((await db.collection('technologies').doc(id).get()).exists).toBe(false);
  ownedIds.clear();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockInngestSend.mockResolvedValue({ ids: ['accepted-event'] });
  mockDeepResearch.mockResolvedValue({
    summary: 'Deterministic deep-research fixture.',
    keyInsights: ['One bounded insight'],
    sources: ['https://example.com/research'],
    lastResearched: Date.now(),
  });
});

(RUN_ACCEPTANCE ? describe : describe.skip)('ARUN-028 real Firestore handoff durability', () => {
  it('persists/query-lists debt and only the exact attempt token can clear it', async () => {
    const id = `${RUN_PREFIX}-transactions`;
    await seedTechnology(id, { researchStatus: 'completed', researchStartedAt: 101 });

    await recordPendingSnapshotRefresh(id, 101, new Error('first failure'));
    await recordPendingSnapshotRefresh(id, 101, new Error('second failure'));
    expect(await listTechnologiesWithPendingSnapshotRefresh(10)).toContainEqual({ id, attemptToken: 101 });
    expect((await technologyRef(id).get()).data()?.pendingSnapshotRefresh).toMatchObject({
      attemptToken: 101,
      attempts: 2,
      lastError: 'second failure',
    });

    await recordPendingSnapshotRefresh(id, 202);
    expect(await clearPendingSnapshotRefresh(id, 101)).toBe(false);
    expect((await technologyRef(id).get()).data()?.pendingSnapshotRefresh).toMatchObject({ attemptToken: 202 });
    expect(await clearPendingSnapshotRefresh(id, 202)).toBe(true);
    expect((await technologyRef(id).get()).data()?.pendingSnapshotRefresh).toBeUndefined();
  });

  it('retains debt on an empty event acknowledgement and clears it after an accepted replay', async () => {
    const id = `${RUN_PREFIX}-replay`;
    await seedTechnology(id, { researchStatus: 'completed', researchStartedAt: 303 });
    await recordPendingSnapshotRefresh(id, 303, new Error('dispatch disabled'));

    mockInngestSend.mockResolvedValueOnce({ ids: [] });
    const replayJob = replayPendingSnapshotRefreshesJob as unknown as ExecutableJob;
    await expect(replayJob.execute({})).resolves.toEqual({ replayed: 0, cleared: 0, failed: 1 });
    expect((await technologyRef(id).get()).data()?.pendingSnapshotRefresh).toBeDefined();

    mockInngestSend.mockResolvedValueOnce({ ids: ['replay-accepted'] });
    await expect(replayJob.execute({})).resolves.toEqual({ replayed: 1, cleared: 1, failed: 0 });
    expect((await technologyRef(id).get()).data()?.pendingSnapshotRefresh).toBeUndefined();
  });

  it('preserves completed research and retries only the handoff after a debt-write outage', async () => {
    const id = `${RUN_PREFIX}-write-outage`;
    const attempt = 404;
    await seedTechnology(id, { researchStatus: 'pending', researchStartedAt: attempt });

    mockInngestSend.mockRejectedValueOnce(new Error('Inngest unavailable'));
    mockFailDebtWrite = true;
    const researchJob = runDeepResearchJob as unknown as ExecutableJob;
    await expect(researchJob.execute({ technologyId: id, triggeredAt: attempt })).rejects.toThrow(
      'Could not persist snapshot-refresh recovery debt'
    );

    const completed = (await technologyRef(id).get()).data();
    expect(completed).toMatchObject({
      researchStatus: 'completed',
      researchStartedAt: attempt,
      deepResearch: { summary: 'Deterministic deep-research fixture.' },
    });
    expect(completed?.pendingSnapshotRefresh).toBeUndefined();
    expect(mockDeepResearch).toHaveBeenCalledTimes(1);

    mockFailDebtWrite = false;
    mockInngestSend.mockResolvedValueOnce({ ids: ['retry-accepted'] });
    await expect(researchJob.execute({ technologyId: id, triggeredAt: attempt })).resolves.toMatchObject({
      success: true,
      resumedHandoff: true,
    });
    expect(mockDeepResearch).toHaveBeenCalledTimes(1);
    expect((await technologyRef(id).get()).data()?.researchStatus).toBe('completed');
  });
});
