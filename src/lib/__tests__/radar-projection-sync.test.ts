const mockSend = jest.fn();

jest.mock('@/lib/inngest/send-client', () => ({
  inngest: { send: mockSend },
}));

import {
  createRadarProjectionEvent,
  requestRadarGraphProjection,
} from '../radar-projection-sync';

describe('radar projection handoff', () => {
  beforeEach(() => {
    mockSend.mockReset().mockResolvedValue({ ids: ['accepted-event'] });
  });

  it('builds one byte-stable event for repeated delivery of the same source version', () => {
    const radar = { id: 'radar-1', createdAt: 100, updatedAt: 200 };

    const first = createRadarProjectionEvent(radar);
    const replay = createRadarProjectionEvent({ ...radar });

    expect(replay).toEqual(first);
    expect(first).toEqual({
      id: expect.stringMatching(/^radar-sync-v1-[a-f0-9]{64}$/),
      name: 'app/radar.sync.requested',
      data: { radarId: 'radar-1', sourceUpdatedAt: 200, dispatchKey: 'source' },
    });
  });

  it('changes event identity only when the committed source version changes', () => {
    const created = createRadarProjectionEvent({ id: 'radar-1', updatedAt: 200 });
    const updated = createRadarProjectionEvent({ id: 'radar-1', updatedAt: 201 });

    expect(updated.id).not.toBe(created.id);
    expect(updated.data.sourceUpdatedAt).toBe(201);
  });

  it('uses a new identity for a later reconciliation attempt of the same source version', () => {
    const source = { id: 'radar-1', updatedAt: 200 };
    const initial = createRadarProjectionEvent(source);
    const firstRepair = createRadarProjectionEvent(source, 'reconcile:cron-1');
    const replayedRepair = createRadarProjectionEvent(source, 'reconcile:cron-1');
    const nextRepair = createRadarProjectionEvent(source, 'reconcile:cron-2');

    expect(replayedRepair).toEqual(firstRepair);
    expect(firstRepair.id).not.toBe(initial.id);
    expect(nextRepair.id).not.toBe(firstRepair.id);
    expect(nextRepair.data.sourceUpdatedAt).toBe(initial.data.sourceUpdatedAt);
  });

  it('collapses an accepted send whose acknowledgement was lost when replayed', async () => {
    const delivered = new Map<string, unknown>();
    let loseAcknowledgement = true;
    mockSend.mockImplementation(async (event: { id: string }) => {
      delivered.set(event.id, event);
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error('acknowledgement lost after acceptance');
      }
      return { ids: [event.id] };
    });
    const radar = { id: 'radar-ambiguous', updatedAt: 300 };

    await expect(requestRadarGraphProjection(radar)).rejects.toMatchObject({
      name: 'RadarProjectionDispatchError',
      radarId: 'radar-ambiguous',
      sourceUpdatedAt: 300,
    });
    await expect(requestRadarGraphProjection(radar)).resolves.toBeUndefined();

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[1][0]).toEqual(mockSend.mock.calls[0][0]);
    expect(delivered.size).toBe(1);
  });

  it('surfaces dispatch failure with the committed Radar as the retry anchor', async () => {
    mockSend.mockRejectedValueOnce(new Error('Inngest unavailable'));

    await expect(requestRadarGraphProjection({ id: 'radar-1', updatedAt: 200 })).rejects.toEqual(
      expect.objectContaining({
        name: 'RadarProjectionDispatchError',
        radarId: 'radar-1',
        sourceUpdatedAt: 200,
        message: expect.stringMatching(/saved in Firestore.*not acknowledged.*Do not recreate.*reconciliation/i),
      })
    );
  });

  it('treats an explicitly disabled zero-id send as an unacknowledged handoff', async () => {
    mockSend.mockResolvedValueOnce({ ids: [] });

    await expect(requestRadarGraphProjection({ id: 'radar-disabled', updatedAt: 201 })).rejects.toThrow(
      /accepted no event.*synchronization may be disabled/i
    );
  });

  it('rejects invalid identity/version inputs instead of creating colliding events', () => {
    expect(() => createRadarProjectionEvent({ id: '', updatedAt: 1 })).toThrow(/must not be empty/);
    expect(() => createRadarProjectionEvent({ id: 'radar-1', updatedAt: -1 })).toThrow(/invalid projection version/);
    expect(() => createRadarProjectionEvent({ id: 'radar-1', updatedAt: 1 }, '')).toThrow(/dispatch key/);
  });
});
