const mockSend = jest.fn();

jest.mock('@/lib/inngest/send-client', () => ({
  inngest: { send: mockSend },
}));

import { requestRadarGraphDeletion } from '../radar-deletion-sync';

describe('requestRadarGraphDeletion', () => {
  beforeEach(() => {
    mockSend.mockReset().mockResolvedValue({ ids: ['event-1'] });
  });

  it('sends the identifier-only radar graph deletion contract', async () => {
    await requestRadarGraphDeletion('radar-1', true);

    expect(mockSend).toHaveBeenCalledWith({
      name: 'app/radar.graph-delete.requested',
      data: { radarId: 'radar-1', cascade: true },
    });
  });

  it('propagates dispatch errors so callers can retain a retry anchor', async () => {
    mockSend.mockRejectedValueOnce(new Error('Inngest unavailable'));

    await expect(requestRadarGraphDeletion('radar-1', true)).rejects.toThrow('Inngest unavailable');
  });

  it('fails closed within the bounded window when the dispatch hangs', async () => {
    jest.useFakeTimers();
    try {
      // A dead/unreachable dev server can leave the SDK retrying long past any
      // UI wait. The handoff must reject in bounded time so the deletion route
      // can report retryable pre-commit truth instead of hanging.
      mockSend.mockImplementationOnce(() => new Promise(() => undefined));

      const pending = requestRadarGraphDeletion('radar-1', true);
      const assertion = expect(pending).rejects.toThrow(/handoff timed out.*safe to retry/i);
      await jest.advanceTimersByTimeAsync(15_000);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });
});
