/**
 * @file lib/__tests__/document-processing-policy.test.ts
 * @description UX-036 — the accepted / running / stalled contract behind Retry.
 *
 * The bug this policy exists to prevent: `processing` is written by a worker,
 * and a worker that dies between "accepted" and "terminal" leaves the document
 * claiming to be in flight forever. Without a time bound the UI shows a
 * permanent spinner and hides the only recovery action.
 */

import {
  PROCESSING_REQUEST_DEDUPE_MS,
  PROCESSING_STALE_MS,
  canRequestProcessing,
  describeProcessingState,
  hasReprocessableSource,
  isProcessingActive,
  isProcessingStalled,
} from '../document-processing-policy';

const NOW = 1_800_000_000_000;

describe('document processing policy (UX-036)', () => {
  describe('isProcessingActive', () => {
    it('is false for every non-processing status', () => {
      for (const status of ['uploaded', 'processed', 'failed', 'blocked'] as const) {
        expect(isProcessingActive({ status, updatedAt: NOW }, NOW)).toBe(false);
      }
    });

    it('is true while the enqueue is inside the staleness window', () => {
      expect(isProcessingActive({ status: 'processing', updatedAt: 0, processingRequestedAt: NOW - 60_000 }, NOW)).toBe(
        true
      );
    });

    it('is false once nothing has reported back inside the window', () => {
      expect(
        isProcessingActive(
          { status: 'processing', updatedAt: 0, processingRequestedAt: NOW - PROCESSING_STALE_MS - 1 },
          NOW
        )
      ).toBe(false);
    });

    it('IGNORES updatedAt, so an unrelated write cannot resurrect a dead run', () => {
      // Regression: liveness used max(processingRequestedAt, updatedAt), and
      // `updatedAt` is bumped by every document write — linking an entity
      // (updateLinkedEntityCount) made a run that died hours ago read as live
      // and hid the Retry action.
      expect(
        isProcessingActive(
          { status: 'processing', updatedAt: NOW - 1_000, processingRequestedAt: NOW - PROCESSING_STALE_MS - 1 },
          NOW
        )
      ).toBe(false);
    });

    it('reports an UNSTAMPED processing run as active, never stalled', () => {
      // Regression: deep research creates its document `processing` with no
      // stamp and writes nothing for up to 15 minutes while it polls. Calling
      // that stalled offered Retry, which marked the live run failed.
      expect(isProcessingActive({ status: 'processing', updatedAt: 0 }, NOW)).toBe(true);
      expect(isProcessingActive({ status: 'processing', updatedAt: NOW - PROCESSING_STALE_MS - 1 }, NOW)).toBe(true);
    });

    it('treats a non-positive stamp as no stamp', () => {
      expect(isProcessingActive({ status: 'processing', updatedAt: 0, processingRequestedAt: 0 }, NOW)).toBe(true);
    });
  });

  describe('isProcessingStalled', () => {
    it('is true only for an ACCEPTED processing run that stopped reporting', () => {
      expect(
        isProcessingStalled({ status: 'processing', processingRequestedAt: NOW - PROCESSING_STALE_MS - 1 }, NOW)
      ).toBe(true);
      expect(isProcessingStalled({ status: 'processing', processingRequestedAt: NOW }, NOW)).toBe(false);
      // No stamp: we have no evidence the run is dead, so we never say it is.
      expect(isProcessingStalled({ status: 'processing', updatedAt: 0 }, NOW)).toBe(false);
      expect(isProcessingStalled({ status: 'failed', updatedAt: 0 }, NOW)).toBe(false);
    });
  });

  describe('canRequestProcessing', () => {
    it('allows every terminal-ish status', () => {
      for (const status of ['uploaded', 'failed', 'blocked'] as const) {
        expect(canRequestProcessing({ status, updatedAt: NOW }, NOW)).toBe(true);
      }
    });

    it('deduplicates a terminal transition that completes before a concurrent request claims', () => {
      for (const status of ['uploaded', 'failed', 'blocked'] as const) {
        expect(
          canRequestProcessing(
            {
              status,
              processingRequestedAt: NOW - PROCESSING_REQUEST_DEDUPE_MS + 1,
            },
            NOW
          )
        ).toBe(false);
        expect(
          canRequestProcessing(
            {
              status,
              processingRequestedAt: NOW - PROCESSING_REQUEST_DEDUPE_MS,
            },
            NOW
          )
        ).toBe(true);
      }
    });

    it('refuses a live run so a second click cannot double-enqueue', () => {
      expect(canRequestProcessing({ status: 'processing', updatedAt: NOW }, NOW)).toBe(false);
    });

    it('allows recovery once an ACCEPTED run has gone stale', () => {
      expect(
        canRequestProcessing({ status: 'processing', processingRequestedAt: NOW - PROCESSING_STALE_MS - 1 }, NOW)
      ).toBe(true);
    });

    it('refuses an unstamped processing run no matter how old', () => {
      expect(canRequestProcessing({ status: 'processing', updatedAt: NOW - 10 * PROCESSING_STALE_MS }, NOW)).toBe(
        false
      );
    });

    it('refuses a processed document (nothing to recover)', () => {
      expect(canRequestProcessing({ status: 'processed', updatedAt: NOW }, NOW)).toBe(false);
    });
  });

  describe('describeProcessingState', () => {
    it('distinguishes running from stalled for the same status', () => {
      expect(describeProcessingState({ status: 'processing', processingRequestedAt: NOW }, NOW)).toEqual({
        label: 'Processing',
        tone: 'running',
      });
      expect(
        describeProcessingState({ status: 'processing', processingRequestedAt: NOW - PROCESSING_STALE_MS - 1 }, NOW)
      ).toEqual({ label: 'Stalled', tone: 'stalled' });
    });

    it('never reports a stalled run as failed', () => {
      // "Stalled" is an honest third answer: we do not know the work failed,
      // only that nothing came back. Calling it failed would be a claim we
      // cannot support.
      expect(
        describeProcessingState({ status: 'processing', processingRequestedAt: NOW - PROCESSING_STALE_MS - 1 }, NOW)
          .tone
      ).not.toBe('error');
    });

    it('maps the remaining statuses to their own tone', () => {
      expect(describeProcessingState({ status: 'uploaded', updatedAt: NOW }, NOW).tone).toBe('pending');
      expect(describeProcessingState({ status: 'processed', updatedAt: NOW }, NOW).tone).toBe('done');
      expect(describeProcessingState({ status: 'failed', updatedAt: NOW }, NOW).tone).toBe('error');
      expect(describeProcessingState({ status: 'blocked', updatedAt: NOW }, NOW).tone).toBe('blocked');
    });
  });

  /**
   * The second half of "may this be retried": a lifecycle state alone is not
   * enough. Offering Retry for a document with nothing to reprocess FROM could
   * only ever mark healthy in-flight work failed.
   */
  describe('hasReprocessableSource', () => {
    it('is true when stored bytes exist', () => {
      expect(hasReprocessableSource({ storageUrl: 'documents/a.pdf', originalUrl: undefined })).toBe(true);
    });

    it('is true when only a source URL exists', () => {
      expect(hasReprocessableSource({ storageUrl: '', originalUrl: 'https://example.com/a' })).toBe(true);
    });

    it('is false for an artifact that has neither (deep research mid-flight)', () => {
      expect(hasReprocessableSource({ storageUrl: '', originalUrl: undefined })).toBe(false);
      expect(hasReprocessableSource({ storageUrl: '   ', originalUrl: '  ' })).toBe(false);
    });
  });
});
