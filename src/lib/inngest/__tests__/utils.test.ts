/**
 * Tests for lib/inngest/utils.ts — extractFailureEventData.
 *
 * Inngest v3 `onFailure` handlers receive the internal
 * `inngest/function.failed` event whose `data.event` holds the ORIGINAL
 * triggering event. 13 handlers used to read `event.data.<field>` directly
 * (always undefined); this helper is the shared fix (2026-06-10).
 */

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { extractFailureEventData, toMillis } from '../utils';

describe('extractFailureEventData', () => {
  it('unwraps the original event data from the Inngest v3 failure payload', () => {
    const failureEventData = {
      function_id: 'expand-signal',
      error: { message: 'boom' },
      event: { name: 'app/signal.expand.requested', data: { signalId: 'sig-42', options: { deep: true } } },
    };

    const data = extractFailureEventData<{ signalId?: string }>(failureEventData);
    expect(data.signalId).toBe('sig-42');
  });

  it('returns {} when the nested original event is absent (flat payload)', () => {
    // The OLD broken pattern read fields off this shape directly.
    expect(extractFailureEventData({ signalId: 'sig-42' })).toEqual({});
  });

  it('returns {} when the nested event has no data', () => {
    expect(extractFailureEventData({ event: { name: 'app/x' } })).toEqual({});
  });

  it('returns {} for null / undefined / non-object input', () => {
    expect(extractFailureEventData(null)).toEqual({});
    expect(extractFailureEventData(undefined)).toEqual({});
    expect(extractFailureEventData('nope')).toEqual({});
    expect(extractFailureEventData(42)).toEqual({});
  });

  it('supports the field-level "unknown" fallback used by onFailure handlers', () => {
    const data = extractFailureEventData<{ documentId?: string }>({ event: { data: {} } });
    expect(data.documentId || 'unknown').toBe('unknown');
  });
});

describe('toMillis (smoke)', () => {
  it('passes through numbers and converts serialized Firestore timestamps', () => {
    expect(toMillis(1700000000000)).toBe(1700000000000);
    expect(toMillis({ seconds: 1700000000, nanoseconds: 500000000 })).toBe(1700000000500);
  });
});
