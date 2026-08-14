/**
 * @file lib/signal-fetchers/__tests__/base-fetcher.test.ts
 * @description Unit tests for `bestMatchedKeyword` and the `metadata.matchedKeyword`
 * stamp added to `BaseFetcher.convertToSignal` (Task S12.4) — attributes a fetched
 * signal back to the keyword that produced it, so the discovery lane can key
 * feedback (like/dislike) on the right topic.
 */

// base-fetcher imports generateSlug from entity-factory, which pulls in the
// Firebase client SDK — mock it to break the initialization chain.
jest.mock('@/lib/entity-factory', () => ({
  generateSlug: jest.fn((name: string) => String(name).toLowerCase().replace(/\s+/g, '-')),
}));

import {
  BaseFetcher,
  PermanentSourceError,
  bestMatchedKeyword,
  isPermanentHttpStatus,
  type FetchSignalsParams,
  type RawSignalItem,
} from '../base-fetcher';
import type { Signal } from '@/lib/types';

// Trivial concrete subclass exposing the protected convertToSignal for testing.
class TestFetcher extends BaseFetcher {
  protected readonly source = 'news' as const;
  protected async fetchFromSource(): Promise<RawSignalItem[]> {
    return [];
  }
  async convert(item: RawSignalItem, params?: FetchSignalsParams) {
    return this.convertToSignal(item, params);
  }
  // Expose the protected retry so its no-retry-on-permanent contract is testable.
  runRetry<T>(fn: () => Promise<T>, maxRetries = 3, delayMs = 1): Promise<T> {
    return this.retry(fn, maxRetries, delayMs);
  }
}

// A fetcher whose source call throws whatever the test supplies, so we can
// assert the failure result carries the permanent flag end to end.
class ThrowingFetcher extends BaseFetcher {
  protected readonly source = 'github' as const;
  constructor(private readonly error: Error) {
    super();
  }
  protected async fetchFromSource(): Promise<RawSignalItem[]> {
    return this.retry(async () => {
      throw this.error;
    });
  }
}

// Fetcher subclass that returns raw items with caller-controlled relevance
// scores (keyed by RawSignalItem.id), so the minRelevance filter (base-fetcher.ts:174-177)
// can be exercised deterministically without depending on keyword-match scoring.
class ScoredTestFetcher extends BaseFetcher {
  protected readonly source = 'news' as const;
  constructor(private readonly scores: Record<string, number>) {
    super();
  }
  protected async fetchFromSource(): Promise<RawSignalItem[]> {
    return Object.keys(this.scores).map((id) => makeItem({ id, title: `Item ${id}` }));
  }
  protected async convertToSignal(item: RawSignalItem, params?: FetchSignalsParams): Promise<Signal> {
    const signal = await super.convertToSignal(item, params);
    return { ...signal, relevanceScore: this.scores[item.id] };
  }
}

function makeItem(overrides: Partial<RawSignalItem> = {}): RawSignalItem {
  return {
    id: '1',
    title: 'A generic title',
    description: 'A generic description',
    url: 'https://example.com/a',
    date: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

describe('bestMatchedKeyword', () => {
  it('returns the title match when the title and description match different keywords', () => {
    const result = bestMatchedKeyword(
      'RAG Pipelines are having a moment',
      'This piece also touches on Vector Databases',
      ['Vector Databases', 'RAG Pipelines']
    );
    expect(result).toBe('RAG Pipelines');
  });

  it('returns the description-only match when the title has no match', () => {
    const result = bestMatchedKeyword('A generic title', 'This piece covers Vector Databases in depth', [
      'Vector Databases',
    ]);
    expect(result).toBe('Vector Databases');
  });

  it('returns undefined when no keyword matches', () => {
    const result = bestMatchedKeyword('A generic title', 'and a generic description', ['Quantum Computing']);
    expect(result).toBeUndefined();
  });

  it('preserves the original casing of the matched keyword in the return value', () => {
    const result = bestMatchedKeyword('vector databases are booming', 'desc', ['Vector Databases']);
    expect(result).toBe('Vector Databases');
  });
});

describe('isPermanentHttpStatus', () => {
  it.each([400, 401, 403, 404, 410, 422, 451])('classifies %i as a permanent contract failure', (status) => {
    expect(isPermanentHttpStatus(status)).toBe(true);
  });

  it.each([408, 429, 500, 502, 503, 504])('classifies %i as transient (retryable)', (status) => {
    expect(isPermanentHttpStatus(status)).toBe(false);
  });

  it('never classifies a successful or redirect status as permanent', () => {
    expect(isPermanentHttpStatus(200)).toBe(false);
    expect(isPermanentHttpStatus(301)).toBe(false);
  });
});

describe('BaseFetcher.retry — permanent vs transient', () => {
  it('retries a transient error up to maxRetries times', async () => {
    const fetcher = new TestFetcher();
    let attempts = 0;
    await expect(
      fetcher.runRetry(async () => {
        attempts += 1;
        throw new Error('transient 503');
      }, 3)
    ).rejects.toThrow('transient 503');
    expect(attempts).toBe(3);
  });

  it('does NOT retry a PermanentSourceError — it fails fast on the first attempt', async () => {
    const fetcher = new TestFetcher();
    let attempts = 0;
    await expect(
      fetcher.runRetry(async () => {
        attempts += 1;
        throw new PermanentSourceError('retired endpoint');
      }, 3)
    ).rejects.toBeInstanceOf(PermanentSourceError);
    expect(attempts).toBe(1);
  });

  it('resolves normally when a transient error clears before the cap', async () => {
    const fetcher = new TestFetcher();
    let attempts = 0;
    const value = await fetcher.runRetry(async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('flaky');
      return 'ok';
    }, 3);
    expect(value).toBe('ok');
    expect(attempts).toBe(2);
  });
});

describe('BaseFetcher.fetch — permanent-failure result flag', () => {
  it('marks the failure result permanent so the caller can stop retrying every cycle', async () => {
    const fetcher = new ThrowingFetcher(new PermanentSourceError('GitHub 422: query invalid'));
    const result = await fetcher.fetch({ keywords: ['x'], timeRangeDays: 7, maxSignals: 5 });
    expect(result.success).toBe(false);
    expect(result.permanent).toBe(true);
    expect(result.error).toContain('422');
  });

  it('leaves a transient failure retryable (permanent flag falsy)', async () => {
    const fetcher = new ThrowingFetcher(new Error('network reset'));
    const result = await fetcher.fetch({ keywords: ['x'], timeRangeDays: 7, maxSignals: 5 });
    expect(result.success).toBe(false);
    expect(result.permanent).toBeFalsy();
  });
});

describe('BaseFetcher.convertToSignal — metadata.matchedKeyword stamp', () => {
  it('stamps metadata.matchedKeyword when a keyword matches the title', async () => {
    const fetcher = new TestFetcher();
    const signal = await fetcher.convert(makeItem({ title: 'Vector Databases are booming' }), {
      keywords: ['Vector Databases'],
      timeRangeDays: 7,
      maxSignals: 10,
    });
    expect(signal.metadata?.matchedKeyword).toBe('Vector Databases');
  });

  it('omits metadata.matchedKeyword entirely when no keyword matches', async () => {
    const fetcher = new TestFetcher();
    const signal = await fetcher.convert(makeItem(), {
      keywords: ['Quantum Computing'],
      timeRangeDays: 7,
      maxSignals: 10,
    });
    expect(signal.metadata?.matchedKeyword).toBeUndefined();
    expect('matchedKeyword' in (signal.metadata ?? {})).toBe(false);
  });
});

describe('BaseFetcher.fetch — minRelevance validation and filtering (0-100 scale)', () => {
  it('accepts minRelevance boundaries 0, 50 and 100 on the 0-100 scale', async () => {
    const fetcher = new TestFetcher();
    for (const minRelevance of [0, 50, 100]) {
      const result = await fetcher.fetch({
        keywords: ['test'],
        timeRangeDays: 7,
        maxSignals: 10,
        minRelevance,
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects minRelevance above 100', async () => {
    const fetcher = new TestFetcher();
    const result = await fetcher.fetch({
      keywords: ['test'],
      timeRangeDays: 7,
      maxSignals: 10,
      minRelevance: 101,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Min relevance must be between 0 and 100');
  });

  it('filters converted signals below minRelevance (0-100 data scale)', async () => {
    const fetcher = new ScoredTestFetcher({ '1': 40, '2': 80 });
    const result = await fetcher.fetch({
      keywords: ['test'],
      timeRangeDays: 7,
      maxSignals: 10,
      minRelevance: 50,
    });
    expect(result.success).toBe(true);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].relevanceScore).toBe(80);
  });
});
