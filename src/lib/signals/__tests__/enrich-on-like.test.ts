jest.mock('server-only', () => ({}));

const mockGetSignalById = jest.fn();
const mockGetSignals = jest.fn();
const mockUpdateSignal = jest.fn();
jest.mock('@/lib/signals-admin', () => ({
  __esModule: true,
  adminGetSignalById: (...a: unknown[]) => mockGetSignalById(...a),
  adminGetSignals: (...a: unknown[]) => mockGetSignals(...a),
  adminUpdateSignal: (...a: unknown[]) => mockUpdateSignal(...a),
}));

const mockSafeSendEvent = jest.fn().mockResolvedValue(true);
jest.mock('@/lib/inngest/client', () => ({
  __esModule: true,
  safeSendEvent: (...a: unknown[]) => mockSafeSendEvent(...a),
}));

const mockExpandSignal = jest.fn().mockResolvedValue({ success: true, signalId: 'sig-1' });
jest.mock('@/lib/signals/expand-signal', () => ({
  __esModule: true,
  expandSignal: (...a: unknown[]) => mockExpandSignal(...a),
}));

// enrich-on-like now also links the signal after expansion; mock the linker helper
// so this suite doesn't drag in the real linker/admin-SDK chain.
const mockLinkSignalNow = jest.fn().mockResolvedValue({ candidates: 0, verified: 0, created: 0 });
jest.mock('@/lib/signals/link-signal', () => ({
  __esModule: true,
  linkSignalNow: (...a: unknown[]) => mockLinkSignalNow(...a),
}));

import { queueEnrichOnLike, runBatchEnrichLikedSignals, signalEnrichOnLikeMode } from '../enrich-on-like';

const signal = (over: Record<string, unknown> = {}) => ({
  id: 'sig-1',
  title: 'A signal',
  status: 'Approved',
  ...over,
});

describe('enrich-on-like — mode + idempotency (no double token spend)', () => {
  const ORIG = process.env.SIGNAL_ENRICH_ON_LIKE;
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SIGNAL_ENRICH_ON_LIKE;
  });
  afterAll(() => {
    if (ORIG === undefined) delete process.env.SIGNAL_ENRICH_ON_LIKE;
    else process.env.SIGNAL_ENRICH_ON_LIKE = ORIG;
  });

  it('defaults to online mode', () => {
    expect(signalEnrichOnLikeMode()).toBe('online');
  });

  it('ONLINE + not-expanded → marks in-flight + emits the expand event', async () => {
    mockGetSignalById.mockResolvedValue(signal());
    const r = await queueEnrichOnLike('sig-1');
    expect(r).toEqual({ queued: true, reason: 'queued' });
    // marked in-flight BEFORE expanding (so a rapid re-like skips)
    expect(mockUpdateSignal).toHaveBeenCalledWith(
      'sig-1',
      expect.objectContaining({ metadata: expect.objectContaining({ expansionQueuedAt: expect.any(Number) }) })
    );
    // ONLINE enriches DIRECTLY (the proven path), not via an Inngest event.
    expect(mockExpandSignal).toHaveBeenCalledWith('sig-1');
    expect(mockSafeSendEvent).not.toHaveBeenCalled();
  });

  it('ALREADY-EXPANDED → skip, NO expand, NO tokens (the like-an-already-full-signal case)', async () => {
    mockGetSignalById.mockResolvedValue(signal({ expandedContent: { expandedAt: 123 } }));
    const r = await queueEnrichOnLike('sig-1');
    expect(r).toEqual({ queued: false, reason: 'already-expanded' });
    expect(mockExpandSignal).not.toHaveBeenCalled();
    expect(mockUpdateSignal).not.toHaveBeenCalled();
  });

  it('IN-FLIGHT (recent expansionQueuedAt, no result yet) → skip, no double-spend on rapid re-likes', async () => {
    mockGetSignalById.mockResolvedValue(signal({ metadata: { expansionQueuedAt: Date.now() - 1000 } }));
    const r = await queueEnrichOnLike('sig-1');
    expect(r).toEqual({ queued: false, reason: 'in-flight' });
    expect(mockExpandSignal).not.toHaveBeenCalled();
  });

  it('a STALE marker (older than the in-flight window) does NOT block a fresh enrichment', async () => {
    mockGetSignalById.mockResolvedValue(signal({ metadata: { expansionQueuedAt: Date.now() - 60 * 60 * 1000 } }));
    const r = await queueEnrichOnLike('sig-1');
    expect(r.queued).toBe(true);
    expect(mockExpandSignal).toHaveBeenCalled();
  });

  it('OFF mode → disabled, no work', async () => {
    process.env.SIGNAL_ENRICH_ON_LIKE = 'off';
    const r = await queueEnrichOnLike('sig-1');
    expect(r).toEqual({ queued: false, reason: 'disabled' });
    expect(mockGetSignalById).not.toHaveBeenCalled();
  });

  it('BATCH mode → deferred (no immediate emit; the cron handles it)', async () => {
    process.env.SIGNAL_ENRICH_ON_LIKE = 'batch';
    mockGetSignalById.mockResolvedValue(signal());
    const r = await queueEnrichOnLike('sig-1');
    expect(r).toEqual({ queued: false, reason: 'batch-deferred' });
    expect(mockSafeSendEvent).not.toHaveBeenCalled();
  });

  it('not-found → reason not-found', async () => {
    mockGetSignalById.mockResolvedValue(null);
    expect((await queueEnrichOnLike('nope')).reason).toBe('not-found');
  });

  describe('runBatchEnrichLikedSignals', () => {
    it('only runs in batch mode (no-op otherwise)', async () => {
      // default = online
      const r = await runBatchEnrichLikedSignals();
      expect(r.queued).toBe(0);
      expect(mockGetSignals).not.toHaveBeenCalled();
    });

    it('in batch mode, enriches Approved-but-unexpanded signals and skips expanded ones', async () => {
      process.env.SIGNAL_ENRICH_ON_LIKE = 'batch';
      mockGetSignals.mockResolvedValue([
        signal({ id: 'a', status: 'Approved' }), // eligible
        signal({ id: 'b', status: 'Approved', expandedContent: { expandedAt: 1 } }), // already full → skip
        signal({ id: 'c', status: 'Detected' }), // not approved → skip
      ]);
      const r = await runBatchEnrichLikedSignals();
      expect(r.queued).toBe(1);
      expect(mockSafeSendEvent).toHaveBeenCalledTimes(1);
      expect(mockSafeSendEvent).toHaveBeenCalledWith(
        { name: 'app/signal.expand.requested', data: { signalId: 'a' } },
        expect.any(Object)
      );
    });
  });
});
