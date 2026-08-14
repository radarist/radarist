/**
 * @file document-preview.test.ts
 * @description Unit tests for the pure preview-strategy selector and the
 * exceljs cell formatter (both dependency-free in lib/document-preview.ts).
 *
 * Covers:
 * - The full strategy ladder (none / extracted-text / markdown / pdf / docx / xlsx)
 * - The >20 MB auto-fetch guard for docx/xlsx (boundary-exact)
 * - Legacy binary formats (.doc/.xls) and unknown types
 * - canPreview() enable/disable semantics for the row menus
 * - formatSheetCell() across the exceljs value-shape union
 */

import {
  resolvePreviewStrategy,
  canPreview,
  formatSheetCell,
  PREVIEW_MAX_AUTO_FETCH_BYTES,
  type PreviewStrategyInput,
} from '../document-preview';

// ============================================================================
// Helpers
// ============================================================================

function input(overrides: Partial<PreviewStrategyInput> = {}): PreviewStrategyInput {
  return {
    type: 'pdf',
    storageUrl: 'documents/123-abc-file.pdf',
    chunkCount: 5,
    fileSize: 1024,
    ...overrides,
  };
}

// ============================================================================
// resolvePreviewStrategy
// ============================================================================

describe('resolvePreviewStrategy', () => {
  describe('no-content / no-file ladder', () => {
    it('returns none when there is no stored file AND no chunks', () => {
      expect(resolvePreviewStrategy(input({ storageUrl: '', chunkCount: 0 }))).toEqual({ kind: 'none' });
      expect(resolvePreviewStrategy(input({ storageUrl: undefined, chunkCount: undefined }))).toEqual({
        kind: 'none',
      });
    });

    it('treats a whitespace-only storageUrl as no file', () => {
      expect(resolvePreviewStrategy(input({ storageUrl: '   ', chunkCount: 0 }))).toEqual({ kind: 'none' });
    });

    it('returns extracted-text (no-file) for URL documents with chunks', () => {
      expect(resolvePreviewStrategy(input({ type: 'url', storageUrl: '', chunkCount: 12 }))).toEqual({
        kind: 'extracted-text',
        reason: 'no-file',
      });
    });

    it('returns extracted-text (no-file) even for rich types when the file is missing', () => {
      // A pdf-typed doc whose upload never landed but whose chunks exist
      expect(resolvePreviewStrategy(input({ type: 'pdf', storageUrl: '', chunkCount: 3 }))).toEqual({
        kind: 'extracted-text',
        reason: 'no-file',
      });
    });
  });

  describe('rich renderers', () => {
    it('selects markdown for markdown documents with a file', () => {
      expect(resolvePreviewStrategy(input({ type: 'markdown' }))).toEqual({ kind: 'markdown' });
    });

    it('selects markdown for deep-research documents with a file', () => {
      expect(resolvePreviewStrategy(input({ type: 'deep-research' }))).toEqual({ kind: 'markdown' });
    });

    it('selects pdf for pdf documents with a file', () => {
      expect(resolvePreviewStrategy(input({ type: 'pdf' }))).toEqual({ kind: 'pdf' });
    });

    it('selects docx for docx documents under the size cap', () => {
      expect(resolvePreviewStrategy(input({ type: 'docx' }))).toEqual({ kind: 'docx' });
    });

    it('selects xlsx for xlsx documents under the size cap', () => {
      expect(resolvePreviewStrategy(input({ type: 'xlsx' }))).toEqual({ kind: 'xlsx' });
    });

    it('normalizes type casing and whitespace', () => {
      expect(resolvePreviewStrategy(input({ type: ' PDF ' }))).toEqual({ kind: 'pdf' });
      expect(resolvePreviewStrategy(input({ type: 'DOCX' }))).toEqual({ kind: 'docx' });
    });

    it('still previews a pdf even when chunkCount is zero (file is enough)', () => {
      expect(resolvePreviewStrategy(input({ type: 'pdf', chunkCount: 0 }))).toEqual({ kind: 'pdf' });
    });
  });

  describe('size guard (docx/xlsx only)', () => {
    it('allows files exactly at the cap', () => {
      expect(resolvePreviewStrategy(input({ type: 'docx', fileSize: PREVIEW_MAX_AUTO_FETCH_BYTES }))).toEqual({
        kind: 'docx',
      });
    });

    it('falls back to extracted-text (too-large) for docx above the cap', () => {
      expect(resolvePreviewStrategy(input({ type: 'docx', fileSize: PREVIEW_MAX_AUTO_FETCH_BYTES + 1 }))).toEqual({
        kind: 'extracted-text',
        reason: 'too-large',
      });
    });

    it('falls back to extracted-text (too-large) for xlsx above the cap', () => {
      expect(resolvePreviewStrategy(input({ type: 'xlsx', fileSize: PREVIEW_MAX_AUTO_FETCH_BYTES + 1 }))).toEqual({
        kind: 'extracted-text',
        reason: 'too-large',
      });
    });

    it('does NOT size-guard pdf (browser viewer streams it)', () => {
      expect(resolvePreviewStrategy(input({ type: 'pdf', fileSize: PREVIEW_MAX_AUTO_FETCH_BYTES * 2 }))).toEqual({
        kind: 'pdf',
      });
    });

    it('treats a missing fileSize as previewable (no guard trip)', () => {
      expect(resolvePreviewStrategy(input({ type: 'docx', fileSize: undefined }))).toEqual({ kind: 'docx' });
    });
  });

  describe('legacy and unsupported formats', () => {
    it('routes legacy .doc to extracted-text (legacy-format)', () => {
      expect(resolvePreviewStrategy(input({ type: 'doc' }))).toEqual({
        kind: 'extracted-text',
        reason: 'legacy-format',
      });
    });

    it('routes legacy binary .xls to extracted-text (legacy-format) — exceljs cannot parse it', () => {
      expect(resolvePreviewStrategy(input({ type: 'xls' }))).toEqual({
        kind: 'extracted-text',
        reason: 'legacy-format',
      });
    });

    it.each(['pptx', 'text', 'transcript', 'something-unknown', ''])(
      'routes %s to extracted-text (unsupported-type)',
      (type) => {
        expect(resolvePreviewStrategy(input({ type }))).toEqual({
          kind: 'extracted-text',
          reason: 'unsupported-type',
        });
      }
    );
  });
});

// ============================================================================
// canPreview
// ============================================================================

describe('canPreview', () => {
  it('is false only when there is neither a file nor chunks', () => {
    expect(canPreview(input({ storageUrl: '', chunkCount: 0 }))).toBe(false);
    expect(canPreview(input({ storageUrl: '', chunkCount: undefined }))).toBe(false);
  });

  it('is true with a file but no chunks', () => {
    expect(canPreview(input({ chunkCount: 0 }))).toBe(true);
  });

  it('is true with chunks but no file (URL documents)', () => {
    expect(canPreview(input({ type: 'url', storageUrl: '', chunkCount: 4 }))).toBe(true);
  });
});

// ============================================================================
// formatSheetCell
// ============================================================================

describe('formatSheetCell', () => {
  it('renders empty string for null/undefined', () => {
    expect(formatSheetCell(null)).toBe('');
    expect(formatSheetCell(undefined)).toBe('');
  });

  it('passes through strings and stringifies numbers/booleans', () => {
    expect(formatSheetCell('hello')).toBe('hello');
    expect(formatSheetCell(42.5)).toBe('42.5');
    expect(formatSheetCell(false)).toBe('false');
    expect(formatSheetCell(0)).toBe('0');
  });

  it('renders dates as ISO date (no time)', () => {
    expect(formatSheetCell(new Date(Date.UTC(2026, 5, 9)))).toBe('2026-06-09');
  });

  it('joins rich-text runs', () => {
    expect(formatSheetCell({ richText: [{ text: 'Hello ' }, { text: 'World' }] })).toBe('Hello World');
  });

  it('shows the computed result for formula cells', () => {
    expect(formatSheetCell({ formula: 'A1+B1', result: 7 })).toBe('7');
    expect(formatSheetCell({ sharedFormula: 'A1+B1', result: 'sum' })).toBe('sum');
    // Formula with no cached result renders empty rather than the formula text
    expect(formatSheetCell({ formula: 'A1+B1' })).toBe('');
  });

  it('prefers display text for hyperlink cells, falling back to the URL', () => {
    expect(formatSheetCell({ text: 'Radarist', hyperlink: 'https://example.com' })).toBe('Radarist');
    expect(formatSheetCell({ hyperlink: 'https://example.com' })).toBe('https://example.com');
  });

  it('renders error cells as their error code', () => {
    expect(formatSheetCell({ error: '#REF!' })).toBe('#REF!');
  });
});
