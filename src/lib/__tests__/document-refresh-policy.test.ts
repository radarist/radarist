/**
 * @jest-environment node
 *
 * Tests for document-refresh-policy — the pure, time-bounded concurrency
 * guard shared by the refresh API route, the Inngest admin helper
 * (startDocumentRefresh), and the documents UI (spinner state).
 *
 * The invariant under test: `refreshInProgress: true` only counts as active
 * while the document was touched within REFRESH_STALE_MS. A flag left behind
 * by a crashed worker (stale updatedAt) must NOT block future refreshes.
 */

import { isRefreshActive, REFRESH_STALE_MS } from '../document-refresh-policy';

const NOW = 1_750_000_000_000;

describe('document-refresh-policy', () => {
  describe('isRefreshActive', () => {
    it('returns false when refreshInProgress is false', () => {
      expect(isRefreshActive({ refreshInProgress: false, updatedAt: NOW }, NOW)).toBe(false);
    });

    it('returns false when refreshInProgress is undefined', () => {
      expect(isRefreshActive({ refreshInProgress: undefined, updatedAt: NOW }, NOW)).toBe(false);
    });

    it('returns true when the flag is set and the doc was touched just now', () => {
      expect(isRefreshActive({ refreshInProgress: true, updatedAt: NOW }, NOW)).toBe(true);
    });

    it('returns true just inside the staleness window', () => {
      const justInside = NOW - (REFRESH_STALE_MS - 1);
      expect(isRefreshActive({ refreshInProgress: true, updatedAt: justInside }, NOW)).toBe(true);
    });

    it('returns false exactly at the staleness boundary', () => {
      const atBoundary = NOW - REFRESH_STALE_MS;
      expect(isRefreshActive({ refreshInProgress: true, updatedAt: atBoundary }, NOW)).toBe(false);
    });

    it('returns false for a stuck flag from a crashed run (very stale)', () => {
      const monthsOld = NOW - 90 * 24 * 60 * 60 * 1000;
      expect(isRefreshActive({ refreshInProgress: true, updatedAt: monthsOld }, NOW)).toBe(false);
    });

    it('treats a missing updatedAt as stale (never trust an undated flag)', () => {
      expect(isRefreshActive({ refreshInProgress: true, updatedAt: undefined as unknown as number }, NOW)).toBe(false);
    });

    it('defaults the clock to Date.now()', () => {
      expect(isRefreshActive({ refreshInProgress: true, updatedAt: Date.now() })).toBe(true);
      expect(isRefreshActive({ refreshInProgress: true, updatedAt: Date.now() - REFRESH_STALE_MS - 1 })).toBe(false);
    });
  });
});
