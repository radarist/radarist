/**
 * @file lib/__tests__/document-content-availability.test.ts
 * @description UX-060 — the ONE contract for preview / extracted-text /
 * download availability.
 *
 * The bug it replaces: four surfaces derived the answer independently. The row
 * menu disabled Download whenever `storageUrl` was empty; the detail sheet
 * enabled it unconditionally and shipped a title-only markdown stub; the
 * preview dialog re-read chunks and could report "No extracted text" for the
 * same document; the Chunks tab was gated on `status === 'processed'`.
 *
 * Every case below is a document shape that used to get inconsistent answers.
 */

import { resolveDocumentContentAvailability } from '../document-content-availability';
import { isActiveChunk, filterActiveChunks } from '../document-chunk-activity';

describe('resolveDocumentContentAvailability (UX-060)', () => {
  it('offers the stored original when bytes exist', () => {
    const result = resolveDocumentContentAvailability({
      type: 'pdf',
      storageUrl: 'documents/a.pdf',
      chunkCount: 4,
    });

    expect(result.hasStoredFile).toBe(true);
    expect(result.download).toMatchObject({ kind: 'original', enabled: true, label: 'Download original' });
    expect(result.preview.enabled).toBe(true);
    expect(result.emptyStateReason).toBeNull();
  });

  /**
   * THE regression: a processed URL document. No stored bytes, but real
   * extracted text. The row disabled Download; the sheet offered a stub.
   */
  it('offers the extracted text for a URL document with chunks but no stored file', () => {
    const result = resolveDocumentContentAvailability({
      type: 'url',
      storageUrl: '',
      originalUrl: 'https://example.com/a',
      chunkCount: 12,
    });

    expect(result.hasStoredFile).toBe(false);
    expect(result.hasExtractedText).toBe(true);
    expect(result.download).toMatchObject({ kind: 'extracted-text', enabled: true });
    expect(result.download.label).toBe('Download extracted text');
    expect(result.preview.enabled).toBe(true);
    expect(result.emptyStateReason).toBeNull();
  });

  it('treats a whitespace-only storageUrl as no stored file', () => {
    const result = resolveDocumentContentAvailability({ type: 'pdf', storageUrl: '   ', chunkCount: 3 });

    expect(result.hasStoredFile).toBe(false);
    expect(result.download.kind).toBe('extracted-text');
  });

  it('falls back to structured detail when there is no file and no text', () => {
    const result = resolveDocumentContentAvailability({
      type: 'markdown',
      storageUrl: '',
      chunkCount: 0,
      structuredMetrics: [{ name: 'latency', value: '12ms' }],
    });

    expect(result.hasStructuredDetail).toBe(true);
    expect(result.download).toMatchObject({ kind: 'details', enabled: true, label: 'Download details' });
    expect(result.emptyStateReason).toBeNull();
  });

  it('disables Download with a reason when there is genuinely nothing to hand over', () => {
    const result = resolveDocumentContentAvailability({ type: 'markdown', storageUrl: '', chunkCount: 0 });

    expect(result.download).toMatchObject({ kind: 'unavailable', enabled: false });
    expect(result.download.hint).toMatch(/no stored file and no extracted text/i);
    expect(result.preview.enabled).toBe(false);
    expect(result.emptyStateReason).toBe('This document has no stored file and no extracted text.');
  });

  it('gives an empty URL document a recovery-oriented reason instead of a dead end', () => {
    const result = resolveDocumentContentAvailability({
      type: 'url',
      storageUrl: '',
      originalUrl: 'https://example.com/a',
      chunkCount: 0,
    });

    expect(result.emptyStateReason).toMatch(/retry processing to fetch and extract/i);
    expect(result.source).toMatchObject({ available: true, url: 'https://example.com/a' });
  });

  it('never enables Download while reporting nothing to preview, or the reverse', () => {
    // The two controls previously used different predicates, which is how the
    // same row could disable Download and enable Preview on a URL document.
    const shapes = [
      { type: 'pdf', storageUrl: 'documents/a.pdf', chunkCount: 0 },
      { type: 'url', storageUrl: '', originalUrl: 'https://example.com/a', chunkCount: 5 },
      { type: 'url', storageUrl: '', originalUrl: 'https://example.com/a', chunkCount: 0 },
      { type: 'markdown', storageUrl: '', chunkCount: 0 },
    ];

    for (const shape of shapes) {
      const result = resolveDocumentContentAvailability(shape);
      const hasContent = result.hasStoredFile || result.hasExtractedText;
      expect(result.preview.enabled).toBe(hasContent);
      // Download may additionally be enabled by structured detail, but it can
      // never be DISABLED while previewable content exists.
      if (hasContent) expect(result.download.enabled).toBe(true);
    }
  });

  it('always populates a hint for both controls, enabled or not', () => {
    for (const shape of [
      { type: 'pdf', storageUrl: 'documents/a.pdf' },
      { type: 'markdown', storageUrl: '', chunkCount: 0 },
    ]) {
      const result = resolveDocumentContentAvailability(shape);
      expect(result.download.hint.length).toBeGreaterThan(0);
      expect(result.preview.hint.length).toBeGreaterThan(0);
    }
  });

  it('reuses the preview ladder rather than re-deriving it', () => {
    expect(resolveDocumentContentAvailability({ type: 'pdf', storageUrl: 'a.pdf' }).preview.strategy).toEqual({
      kind: 'pdf',
    });
    expect(resolveDocumentContentAvailability({ type: 'url', storageUrl: '', chunkCount: 2 }).preview.strategy).toEqual(
      { kind: 'extracted-text', reason: 'no-file' }
    );
  });
});

describe('isActiveChunk / filterActiveChunks (UX-060)', () => {
  it('treats a MISSING archived flag as active', () => {
    // Firestore `!=` filters skip documents without the field, and the chunk
    // pipeline never wrote it — so every real chunk was invisible to readers.
    expect(isActiveChunk({})).toBe(true);
  });

  it('treats an explicit false as active and an explicit true as archived', () => {
    expect(isActiveChunk({ archived: false })).toBe(true);
    expect(isActiveChunk({ archived: true })).toBe(false);
  });

  it('keeps the current generation and drops archived ones', () => {
    expect(filterActiveChunks([{ archived: true }, { archived: false }, {}])).toEqual([{ archived: false }, {}]);
  });
});
