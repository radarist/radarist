/**
 * @file lib/signal-fetchers/__tests__/patents-fetcher.test.ts
 * @description Unit tests for the PatentsView patents fetcher.
 *
 * The legacy api.patentsview.org endpoint was retired (301-redirects to an
 * HTML page), so the `patents` source is disabled by default in the system
 * config. These tests lock in the honest-failure behavior: when the source IS
 * explicitly enabled and the endpoint fails, the fetcher logs a warn-level
 * pointer to docs/LIMITATIONS.md and BaseFetcher reports success: false.
 */

// Mock the logger so we can assert on the retired-endpoint pointer. The warn
// spy is created inside the hoisted factory and retrieved via requireMock to
// avoid the TDZ on module-scope consts.
jest.mock('@/lib/logger', () => {
  const warn = jest.fn();
  return {
    __mockWarn: warn,
    createLogger: jest.fn(() => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn,
      error: jest.fn(),
    })),
  };
});

// base-fetcher imports generateSlug from entity-factory, which pulls in the
// Firebase client SDK — mock it to break the initialization chain.
jest.mock('@/lib/entity-factory', () => ({
  generateSlug: jest.fn((name: string) => String(name).toLowerCase().replace(/\s+/g, '-')),
}));

import { PatentsFetcher } from '../patents-fetcher';

const { __mockWarn: mockWarn } = jest.requireMock('@/lib/logger') as { __mockWarn: jest.Mock };

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const PARAMS = { keywords: ['quantum'], timeRangeDays: 7, maxSignals: 5 };
const POINTER = 'PatentsView legacy endpoint retired — see docs/LIMITATIONS.md';
const LEGACY_ENDPOINT = 'https://api.patentsview.org/patents/query';

describe('PatentsFetcher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Fake timers so the retry exponential backoff doesn't slow the suite.
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('logs the retired-endpoint pointer at warn and returns success:false when the endpoint serves HTML', async () => {
    // Production failure mode: fetch follows the 301 redirect to an HTML page,
    // res.ok is true, but res.json() throws on the non-JSON body.
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    });

    const fetcher = new PatentsFetcher();
    const promise = fetcher.fetch(PARAMS);
    await jest.runAllTimersAsync(); // flush retry backoff delays
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.signals).toEqual([]);
    expect(result.error).toContain('Unexpected token');
    expect(mockWarn).toHaveBeenCalledWith(
      POINTER,
      expect.objectContaining({
        endpoint: LEGACY_ENDPOINT,
        error: expect.stringContaining('Unexpected token'),
      })
    );
  });

  it('logs the pointer when the endpoint responds with a non-ok status', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 301,
      statusText: 'Moved Permanently',
      json: async () => ({}),
    });

    const fetcher = new PatentsFetcher();
    const promise = fetcher.fetch(PARAMS);
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.signals).toEqual([]);
    expect(mockWarn).toHaveBeenCalledWith(
      POINTER,
      expect.objectContaining({
        endpoint: LEGACY_ENDPOINT,
        error: expect.stringContaining('301'),
      })
    );
  });

  it('OPS-002: a retired-endpoint failure is permanent and is NOT retried every cycle', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 301,
      statusText: 'Moved Permanently',
      headers: new Headers({ 'content-type': 'text/html' }),
      json: async () => ({}),
      text: async () => '<!DOCTYPE html>',
    });

    const fetcher = new PatentsFetcher();
    const promise = fetcher.fetch(PARAMS);
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.permanent).toBe(true);
    // The retired endpoint must be hit at most once, not the 3× retry storm.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('OPS-002: an HTML body served with 200 is a permanent contract failure (no retry)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
      text: async () => '<!DOCTYPE html>',
    });

    const fetcher = new PatentsFetcher();
    const promise = fetcher.fetch(PARAMS);
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.permanent).toBe(true);
    // The content-type guard catches the HTML body before json() is attempted.
    expect(result.error).toContain('non-JSON body');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(POINTER, expect.objectContaining({ endpoint: LEGACY_ENDPOINT }));
  });

  it('still parses patents normally when the endpoint returns valid JSON (behavior preserved)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        patents: [
          {
            patent_id: 'p1',
            patent_title: 'Quantum widget',
            patent_abstract: 'A quantum widget for quantum things.',
            patent_date: '2026-06-01',
            patent_number: 'US12345678',
            assignees: [{ assignee_organization: 'Acme Corp' }],
            inventors: [{ inventor_first_name: 'Ada', inventor_last_name: 'Lovelace' }],
          },
        ],
        count: 1,
        total_patent_count: 1,
      }),
    });

    const fetcher = new PatentsFetcher();
    const promise = fetcher.fetch(PARAMS);
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].url).toBe('https://patents.google.com/patent/US12345678');
    expect(mockWarn).not.toHaveBeenCalledWith(POINTER, expect.anything());
  });
});
