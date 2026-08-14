/**
 * @file lib/__tests__/fetch-with-auth.test.ts
 * @description Unit tests for fetchWithAuth utility
 *
 * Tests:
 * - Injects auth token when user is logged in
 * - Proceeds without token when user is not logged in
 * - Preserves existing headers
 * - Does not override manually set Authorization headers
 * - Handles getIdToken failure gracefully
 *
 * @jest-environment jsdom
 */

// ============================================================================
// Mocks
// ============================================================================

const mockGetIdToken = jest.fn();
const mockAuth: {
  currentUser: { getIdToken: typeof mockGetIdToken } | null;
  authStateReady: jest.Mock<Promise<void>, []>;
} = {
  currentUser: null,
  authStateReady: jest.fn().mockResolvedValue(undefined),
};
const mockGetAuth = jest.fn(() => mockAuth);

jest.mock('firebase/auth', () => ({
  getAuth: () => mockGetAuth(),
}));

const mockResponse = { ok: true, json: () => Promise.resolve({}) };
const mockFetch = jest.fn().mockResolvedValue(mockResponse);
global.fetch = mockFetch;

import { fetchWithAuth } from '../fetch-with-auth';

// ============================================================================
// Tests
// ============================================================================

describe('fetchWithAuth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.authStateReady.mockResolvedValue(undefined);
    mockGetIdToken.mockResolvedValue('mock-firebase-token-12345');
    mockFetch.mockResolvedValue(mockResponse);
  });

  it('should inject Authorization header when user is logged in', async () => {
    Object.defineProperty(mockAuth, 'currentUser', {
      value: { getIdToken: mockGetIdToken },
      writable: true,
      configurable: true,
    });

    await fetchWithAuth('/api/trends?keyword=AI');

    expect(mockGetIdToken).toHaveBeenCalled();
    expect(mockAuth.authStateReady).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/trends?keyword=AI',
      expect.objectContaining({
        headers: expect.any(Headers),
      })
    );

    const headers = mockFetch.mock.calls[0][1].headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer mock-firebase-token-12345');
  });

  it('should proceed without token when user is not logged in', async () => {
    Object.defineProperty(mockAuth, 'currentUser', {
      value: null,
      writable: true,
      configurable: true,
    });

    await fetchWithAuth('/api/search?q=test');

    expect(mockAuth.authStateReady).toHaveBeenCalledTimes(1);

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/search?q=test',
      expect.objectContaining({
        headers: expect.any(Headers),
      })
    );

    const headers = mockFetch.mock.calls[0][1].headers as Headers;
    expect(headers.has('Authorization')).toBe(false);
  });

  it('should preserve existing headers', async () => {
    Object.defineProperty(mockAuth, 'currentUser', {
      value: { getIdToken: mockGetIdToken },
      writable: true,
      configurable: true,
    });

    await fetchWithAuth('/api/signals/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 'test' }),
    });

    const headers = mockFetch.mock.calls[0][1].headers as Headers;
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Authorization')).toBe('Bearer mock-firebase-token-12345');
  });

  it('should not override manually set Authorization header', async () => {
    Object.defineProperty(mockAuth, 'currentUser', {
      value: { getIdToken: mockGetIdToken },
      writable: true,
      configurable: true,
    });

    await fetchWithAuth('/api/mcp/keys', {
      headers: { Authorization: 'Bearer custom-token' },
    });

    expect(mockGetIdToken).not.toHaveBeenCalled();
    expect(mockAuth.authStateReady).not.toHaveBeenCalled();

    const headers = mockFetch.mock.calls[0][1].headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer custom-token');
  });

  it('should handle getIdToken failure gracefully', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

    Object.defineProperty(mockAuth, 'currentUser', {
      value: { getIdToken: jest.fn().mockRejectedValue(new Error('Token expired')) },
      writable: true,
      configurable: true,
    });

    await fetchWithAuth('/api/trends');

    // Should still make the fetch call, just without auth
    expect(mockFetch).toHaveBeenCalled();
    const headers = mockFetch.mock.calls[0][1].headers as Headers;
    expect(headers.has('Authorization')).toBe(false);

    consoleSpy.mockRestore();
  });

  it('should pass through all fetch options', async () => {
    Object.defineProperty(mockAuth, 'currentUser', {
      value: null,
      writable: true,
      configurable: true,
    });

    const controller = new AbortController();
    await fetchWithAuth('/api/agents/stats', {
      signal: controller.signal,
      method: 'GET',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/agents/stats',
      expect.objectContaining({
        signal: controller.signal,
        method: 'GET',
      })
    );
  });

  it('rejects with AbortError before any auth work when the signal is already aborted', async () => {
    Object.defineProperty(mockAuth, 'currentUser', {
      value: { getIdToken: mockGetIdToken },
      writable: true,
      configurable: true,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(fetchWithAuth('/api/graph/query', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(mockAuth.authStateReady).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects with AbortError when the signal fires during a hung auth restoration', async () => {
    Object.defineProperty(mockAuth, 'currentUser', {
      value: { getIdToken: mockGetIdToken },
      writable: true,
      configurable: true,
    });
    // A persisted-session restoration that never settles — the GRAPH-055 stick path.
    mockAuth.authStateReady.mockImplementationOnce(() => new Promise<void>(() => undefined));
    const controller = new AbortController();

    const pending = fetchWithAuth('/api/graph/query', { signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('keeps the no-signal path unchanged (token injected, no abort machinery)', async () => {
    Object.defineProperty(mockAuth, 'currentUser', {
      value: { getIdToken: mockGetIdToken },
      writable: true,
      configurable: true,
    });

    await fetchWithAuth('/api/graph/query', { method: 'POST' });

    const headers = mockFetch.mock.calls[0][1].headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer mock-firebase-token-12345');
  });

  it('logs a slow-auth diagnostic when token acquisition exceeds the threshold', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
    Object.defineProperty(mockAuth, 'currentUser', {
      value: { getIdToken: mockGetIdToken },
      writable: true,
      configurable: true,
    });
    // Advance the clock INSIDE the auth wait so the measured span provably
    // covers authStateReady (a start-capture moved after the wait reads the
    // already-advanced clock → delta 0 → this test fails).
    let clock = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    mockAuth.authStateReady.mockImplementationOnce(async () => {
      clock += 2_500;
    });

    await fetchWithAuth('/api/graph/query');

    expect(mockFetch).toHaveBeenCalled();
    const warned = consoleSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(warned).toContain('slow auth token acquisition before fetch');
    nowSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('waits for persisted auth restoration before reading currentUser', async () => {
    Object.defineProperty(mockAuth, 'currentUser', {
      value: null,
      writable: true,
      configurable: true,
    });
    mockAuth.authStateReady.mockImplementationOnce(async () => {
      mockAuth.currentUser = { getIdToken: mockGetIdToken };
    });

    await fetchWithAuth('/api/visualizations');

    expect(mockAuth.authStateReady).toHaveBeenCalledTimes(1);
    expect(mockGetIdToken).toHaveBeenCalledTimes(1);
    const headers = mockFetch.mock.calls[0][1].headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer mock-firebase-token-12345');
  });
});
