/**
 * @file cleanup-stuck-missions.test.ts
 * @description Tests for the H4+H8 mission lifecycle GC.
 *
 * Regression coverage for terminal-state repair and stale-mission cleanup.
 *
 * Without this job, missions whose run-agent-mission process died
 * mid-flight stay in `status='running'` forever — Inngest only fires
 * onFailure if the function THROWS, not if the worker is killed
 * (process death, OOM, deploy). Audit (2026-05-04) found 11 such
 * missions outstanding for >24h. The job scans Firestore for any
 * mission that's been running or pending past a threshold and
 * forces it into the terminal 'failed' state with a marker error.
 */

jest.mock('@/lib/missions', () => ({
  getStuckMissions: jest.fn(),
  markMissionStuck: jest.fn(),
}));

jest.mock('../../client', () => ({
  inngest: {
    createFunction: jest.fn((config, trigger, handler) => ({
      config,
      trigger,
      handler,
      execute: (data: unknown) =>
        handler({
          event: { data },
          step: { run: async (_name: string, fn: () => unknown) => fn() },
        }),
    })),
    send: jest.fn(),
  },
}));

import * as missions from '@/lib/missions';
import { cleanupStuckMissionsJob } from '../cleanup-stuck-missions';

const mockedGetStuck = missions.getStuckMissions as jest.Mock;
const mockedMarkStuck = missions.markMissionStuck as jest.Mock;

describe('cleanupStuckMissionsJob (H4 + H8)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedMarkStuck.mockResolvedValue(undefined);
  });

  it('marks each stuck mission as failed with a stuck marker', async () => {
    mockedGetStuck.mockResolvedValue([
      { id: 'm-1', status: 'running' },
      { id: 'm-2', status: 'pending' },
    ]);


    const r = await (cleanupStuckMissionsJob as any).execute({});

    expect(mockedGetStuck).toHaveBeenCalledTimes(1);
    // Default threshold = 24h.
    expect(mockedGetStuck).toHaveBeenCalledWith(24);
    expect(mockedMarkStuck).toHaveBeenCalledTimes(2);
    expect(mockedMarkStuck).toHaveBeenCalledWith('m-1', expect.stringContaining('24h'));
    expect(mockedMarkStuck).toHaveBeenCalledWith('m-2', expect.stringContaining('24h'));
    expect(r.cleaned).toBe(2);
    expect(r.thresholdHours).toBe(24);
  });

  it('returns cleaned=0 when no missions are stuck (idempotent run)', async () => {
    mockedGetStuck.mockResolvedValue([]);


    const r = await (cleanupStuckMissionsJob as any).execute({});

    expect(mockedMarkStuck).not.toHaveBeenCalled();
    expect(r.cleaned).toBe(0);
  });

  it('honours the thresholdHours override from the event payload', async () => {
    mockedGetStuck.mockResolvedValue([{ id: 'm-3', status: 'running' }]);


    const r = await (cleanupStuckMissionsJob as any).execute({ thresholdHours: 6 });

    expect(mockedGetStuck).toHaveBeenCalledWith(6);
    expect(mockedMarkStuck).toHaveBeenCalledWith('m-3', expect.stringContaining('6h'));
    expect(r.thresholdHours).toBe(6);
    expect(r.cleaned).toBe(1);
  });

  it('continues cleaning the rest when one mark fails (best-effort)', async () => {
    mockedGetStuck.mockResolvedValue([
      { id: 'm-a', status: 'running' },
      { id: 'm-b', status: 'running' },
      { id: 'm-c', status: 'running' },
    ]);
    mockedMarkStuck
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('firestore transient'))
      .mockResolvedValueOnce(undefined);


    const r = await (cleanupStuckMissionsJob as any).execute({});

    expect(mockedMarkStuck).toHaveBeenCalledTimes(3);
    // Two cleaned successfully, one error logged + counted.
    expect(r.cleaned).toBe(2);
    expect(r.failed).toBe(1);
  });
});
