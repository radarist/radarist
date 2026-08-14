/**
 * Tests for the F2 community-report refresh Inngest handler.
 */

jest.mock('@/lib/graph/community-reports', () => ({
  buildCommunityReports: jest.fn(),
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

import * as cr from '@/lib/graph/community-reports';
import { refreshCommunityReportsJob } from '../refresh-community-reports';

const mockedBuild = cr.buildCommunityReports as jest.Mock;

describe('refreshCommunityReportsJob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('invokes buildCommunityReports with defaults and returns the counts', async () => {
    mockedBuild.mockResolvedValue({
      reports: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }],
      modularity: 0.65,
      durationMs: 1234,
    });


    const r = await (refreshCommunityReportsJob as any).execute({});
    expect(mockedBuild).toHaveBeenCalledWith({ topN: 10, minSize: 5, dryRun: false });
    expect(r.reportCount).toBe(3);
    expect(r.modularity).toBe(0.65);
  });

  it('honours event overrides (topN, minSize, dryRun)', async () => {
    mockedBuild.mockResolvedValue({ reports: [], modularity: null, durationMs: 100 });


    const r = await (refreshCommunityReportsJob as any).execute({ topN: 3, minSize: 10, dryRun: true });
    expect(mockedBuild).toHaveBeenCalledWith({ topN: 3, minSize: 10, dryRun: true });
    expect(r.reportCount).toBe(0);
    expect(r.dryRun).toBe(true);
  });
});
