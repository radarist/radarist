/**
 * @file cleanup-zombie-episodes.test.ts
 * @description Tests for the zombie-Episode cleanup Inngest handler.
 */

jest.mock('@/lib/graph/episodes', () => ({
  abandonStaleEpisodes: jest.fn(),
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

import * as episodes from '@/lib/graph/episodes';
import { cleanupZombieEpisodesJob } from '../cleanup-zombie-episodes';

const mockedAbandon = episodes.abandonStaleEpisodes as jest.Mock;

describe('cleanupZombieEpisodesJob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls abandonStaleEpisodes with the default 6h age and returns the count', async () => {
    mockedAbandon.mockResolvedValue(4);


    const r = await (cleanupZombieEpisodesJob as any).execute({});

    expect(mockedAbandon).toHaveBeenCalledWith(6);
    expect(r.abandoned).toBe(4);
    expect(r.minAgeHours).toBe(6);
  });

  it('honours the minAgeHours override from the event payload', async () => {
    mockedAbandon.mockResolvedValue(2);


    const r = await (cleanupZombieEpisodesJob as any).execute({ minAgeHours: 1 });

    expect(mockedAbandon).toHaveBeenCalledWith(1);
    expect(r.abandoned).toBe(2);
    expect(r.minAgeHours).toBe(1);
  });

  it('returns abandoned=0 when no episodes are stale', async () => {
    mockedAbandon.mockResolvedValue(0);


    const r = await (cleanupZombieEpisodesJob as any).execute({});

    expect(r.abandoned).toBe(0);
  });
});
