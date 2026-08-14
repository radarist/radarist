/**
 * @file lib/document-preview.ts
 * @description Pure renderer-selection logic for the document Preview dialog.
 *
 * Maps a document's shape (type + stored file + extracted chunks + size) to
 * ONE preview strategy. Deliberately dependency-free (no React, no Firebase,
 * no converters) so the selection semantics are unit-testable in isolation
 * and importable from both the dialog and the row-menu enable/disable check.
 *
 * Strategy ladder (first match wins):
 * 1. No stored file AND no extracted chunks → `none` (Preview disabled).
 * 2. No stored file (URL docs, failed uploads) → `extracted-text` from chunks.
 * 3. markdown / deep-research → `markdown` (react-markdown render of the file).
 * 4. pdf → `pdf` (browser-native viewer in an iframe).
 * 5. docx → `docx` (mammoth → sandboxed iframe), unless the file exceeds the
 *    auto-fetch cap → `extracted-text` with a `too-large` reason.
 * 6. xlsx → `xlsx` (exceljs first-worksheet table), same size cap.
 * 7. Legacy binary formats (.doc, .xls — exceljs/mammoth cannot parse them)
 *    → `extracted-text` with a `legacy-format` reason.
 * 8. Everything else (pptx, text, transcript, unknown/legacy types)
 *    → `extracted-text` with an `unsupported-type` reason.
 *
 * Runtime failures (fetch/convert errors) also fall back to extracted text —
 * that path lives in the dialog component, not here, because it depends on
 * I/O outcomes rather than document shape.
 */

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Files larger than this are not auto-fetched for client-side conversion
 * (docx/xlsx). Converting a 20+ MB office file in the main thread would
 * freeze the tab; the dialog shows extracted text + a download hint instead.
 */
export const PREVIEW_MAX_AUTO_FETCH_BYTES = 20 * 1024 * 1024;

/** Max worksheet rows rendered in the xlsx preview table. */
export const PREVIEW_MAX_SHEET_ROWS = 200;

// ============================================================================
// TYPES
// ============================================================================

/** Why the preview fell back to extracted text (drives the honest user note). */
export type PreviewFallbackReason =
  | 'no-file' // no stored file — URL documents, or uploads that never landed
  | 'too-large' // stored file exceeds PREVIEW_MAX_AUTO_FETCH_BYTES
  | 'legacy-format' // .doc/.xls binaries that no in-bundle converter can parse
  | 'unsupported-type'; // pptx/text/transcript/unknown — no rich renderer

export type PreviewStrategy =
  | { kind: 'markdown' }
  | { kind: 'pdf' }
  | { kind: 'docx' }
  | { kind: 'xlsx' }
  | { kind: 'extracted-text'; reason: PreviewFallbackReason }
  | { kind: 'none' };

/**
 * The minimal document shape the selector needs. `type` is a plain string
 * (not `DocumentType`) on purpose: Firestore can hold legacy values like
 * 'doc'/'xls' that predate the current enum — documentTypeLabel() has the
 * same fallback for exactly this reason.
 */
export interface PreviewStrategyInput {
  type: string;
  storageUrl?: string;
  chunkCount?: number;
  fileSize?: number;
}

// ============================================================================
// STRATEGY SELECTION
// ============================================================================

/**
 * Resolve which renderer the Preview dialog should use for a document.
 * Pure function of document shape — see the module docblock for the ladder.
 */
export function resolvePreviewStrategy(input: PreviewStrategyInput): PreviewStrategy {
  const hasFile = !!input.storageUrl?.trim();
  const hasChunks = (input.chunkCount ?? 0) > 0;

  if (!hasFile && !hasChunks) {
    return { kind: 'none' };
  }

  if (!hasFile) {
    return { kind: 'extracted-text', reason: 'no-file' };
  }

  const tooLarge = (input.fileSize ?? 0) > PREVIEW_MAX_AUTO_FETCH_BYTES;
  const type = (input.type ?? '').trim().toLowerCase();

  switch (type) {
    case 'markdown':
    case 'deep-research':
      return { kind: 'markdown' };
    case 'pdf':
      return { kind: 'pdf' };
    case 'docx':
      return tooLarge ? { kind: 'extracted-text', reason: 'too-large' } : { kind: 'docx' };
    case 'xlsx':
      return tooLarge ? { kind: 'extracted-text', reason: 'too-large' } : { kind: 'xlsx' };
    case 'doc':
    case 'xls':
      // Legacy binary Office formats: mammoth only reads OOXML .docx and
      // exceljs only reads OOXML .xlsx — neither parses the old binary
      // containers, so the pipeline's extracted text is the honest preview.
      return { kind: 'extracted-text', reason: 'legacy-format' };
    default:
      return { kind: 'extracted-text', reason: 'unsupported-type' };
  }
}

/** True when the Preview menu item should be enabled for this document. */
export function canPreview(input: PreviewStrategyInput): boolean {
  return resolvePreviewStrategy(input).kind !== 'none';
}

// ============================================================================
// XLSX CELL FORMATTING
// ============================================================================

/**
 * Render an exceljs cell value as display text. exceljs cell values are a
 * union of primitives and object shapes ({ richText }, { text, hyperlink },
 * { formula, result }, { error }, Date) — this normalizes them all without
 * importing exceljs (pure shape checks, unit-testable without the library).
 */
export function formatSheetCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Rich text: { richText: [{ text }, …] }
    if (Array.isArray(obj.richText)) {
      return obj.richText.map((part) => formatSheetCell((part as Record<string, unknown>)?.text)).join('');
    }
    // Formula: { formula, result } — show the computed result, not the formula
    if ('formula' in obj || 'sharedFormula' in obj) {
      return formatSheetCell(obj.result);
    }
    // Hyperlink: { text, hyperlink }
    if ('hyperlink' in obj) {
      return formatSheetCell(obj.text ?? obj.hyperlink);
    }
    // Error cell: { error: '#REF!' }
    if ('error' in obj) {
      return String(obj.error ?? '');
    }
    return String(value);
  }

  return String(value);
}
