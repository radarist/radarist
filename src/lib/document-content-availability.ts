/**
 * @file lib/document-content-availability.ts
 * @description The ONE contract that answers "what content does this document
 * actually have, and what may the user do with it?".
 *
 * UX-060 root cause: four surfaces answered that question independently and
 * disagreed on the same row.
 *
 *   - table / grid row menu  → Download enabled iff `storageUrl` is truthy,
 *                              Preview enabled iff `canPreview(doc)`
 *   - detail sheet footer    → Download ALWAYS enabled; with no stored file it
 *                              silently shipped a synthesized title-only
 *                              markdown stub and toasted success
 *   - preview dialog         → re-read the real chunks and could report
 *                              "No extracted text yet" for the same document
 *   - download API           → the only real authority, and it 404s whenever
 *                              `storageUrl` does not resolve to bytes
 *
 * This module collapses that into one pure function. It deliberately reuses
 * `resolvePreviewStrategy` from `document-preview.ts` rather than re-deriving
 * previewability, so the preview ladder cannot fork into two copies.
 *
 * Four DISTINCT things are kept distinct on purpose — the ledger item asks for
 * exactly this, and collapsing any pair is what produced the original lies:
 *
 *   1. stored bytes      (`storageUrl`)  — a file we can stream back verbatim
 *   2. extracted chunks  (`chunkCount`)  — the text the AI actually sees
 *   3. a source URL      (`originalUrl`) — an external page we do NOT host
 *   4. structured detail (`structuredMetrics`) — measured evaluation output
 *
 * Dependency-free apart from the preview ladder and types: importable from
 * client components, server routes and tests alike.
 */

import { resolvePreviewStrategy, type PreviewStrategy } from '@/lib/document-preview';

// ============================================================================
// TYPES
// ============================================================================

/** What the Download action can honestly do for a document. */
export type DocumentDownloadKind =
  /** Stream the stored original bytes through the authenticated download API. */
  | 'original'
  /** Compose a markdown export from the extracted chunk text (+ known detail). */
  | 'extracted-text'
  /** Compose a markdown export from structured detail only — no body text exists. */
  | 'details'
  /** Nothing to hand the user. */
  | 'unavailable';

export interface DocumentDownloadContract {
  kind: DocumentDownloadKind;
  /** Whether the control may be clicked. */
  enabled: boolean;
  /** Button/menu label — says what the user will actually receive. */
  label: string;
  /** Tooltip / secondary line explaining the label (always populated). */
  hint: string;
}

export interface DocumentPreviewContract {
  enabled: boolean;
  /** Tooltip for the control, whether enabled or not. */
  hint: string;
  /** The resolved renderer, so callers never re-derive it. */
  strategy: PreviewStrategy;
}

export interface DocumentSourceContract {
  /** Whether an external source URL exists and can be opened. */
  available: boolean;
  url?: string;
  hint: string;
}

export interface DocumentContentAvailability {
  /** Bytes exist in Storage (or the Firestore fallback). */
  hasStoredFile: boolean;
  /** The processing pipeline recorded extracted chunks for this document. */
  hasExtractedText: boolean;
  /** An external source URL is recorded (URL documents). */
  hasSourceUrl: boolean;
  /** Structured measured detail exists (evaluation artifacts). */
  hasStructuredDetail: boolean;
  download: DocumentDownloadContract;
  preview: DocumentPreviewContract;
  source: DocumentSourceContract;
  /**
   * Honest one-line explanation when the document carries no readable content
   * at all; `null` whenever something IS available. Surfaces render this
   * instead of inventing their own empty-state copy.
   */
  emptyStateReason: string | null;
}

/**
 * The minimal document shape the contract needs. `type` stays a plain string
 * for the same reason `PreviewStrategyInput.type` does: Firestore holds legacy
 * values ('doc', 'xls') that predate the current enum.
 */
export interface DocumentContentInput {
  type: string;
  storageUrl?: string;
  originalUrl?: string;
  chunkCount?: number;
  fileSize?: number;
  structuredMetrics?: unknown[];
}

// ============================================================================
// COPY
// ============================================================================

const PREVIEW_HINT_ENABLED = 'Preview document';
const PREVIEW_HINT_DISABLED = 'Nothing to preview — no stored file and no extracted text';

const DOWNLOAD_HINT_ORIGINAL = 'Download the stored original file';
const DOWNLOAD_HINT_EXTRACTED = 'No stored file — downloads the extracted text the AI reads';
const DOWNLOAD_HINT_DETAILS = 'No stored file and no extracted text — downloads the recorded details';
const DOWNLOAD_HINT_UNAVAILABLE = 'Nothing to download — this document has no stored file and no extracted text';

const SOURCE_HINT_AVAILABLE = 'Open the original source URL in a new tab';
const SOURCE_HINT_MISSING = 'No source URL recorded for this document';

const EMPTY_STATE_URL =
  'Nothing has been extracted from this source yet — retry processing to fetch and extract its content.';
const EMPTY_STATE_FILE = 'This document has no stored file and no extracted text.';

// ============================================================================
// CONTRACT
// ============================================================================

/**
 * Resolve every content-availability answer for a document from one input.
 *
 * Pure: no I/O, no SDK. Callers that need the actual bytes/text still go
 * through the download API or the chunk service — this decides only what may
 * be offered and how it must be labelled.
 */
export function resolveDocumentContentAvailability(input: DocumentContentInput): DocumentContentAvailability {
  const hasStoredFile = !!input.storageUrl?.trim();
  const hasExtractedText = (input.chunkCount ?? 0) > 0;
  const hasSourceUrl = !!input.originalUrl?.trim();
  const hasStructuredDetail = (input.structuredMetrics?.length ?? 0) > 0;

  const strategy = resolvePreviewStrategy({
    type: input.type,
    storageUrl: input.storageUrl,
    chunkCount: input.chunkCount,
    fileSize: input.fileSize,
  });

  const download: DocumentDownloadContract = hasStoredFile
    ? { kind: 'original', enabled: true, label: 'Download original', hint: DOWNLOAD_HINT_ORIGINAL }
    : hasExtractedText
      ? {
          kind: 'extracted-text',
          enabled: true,
          label: 'Download extracted text',
          hint: DOWNLOAD_HINT_EXTRACTED,
        }
      : hasStructuredDetail
        ? { kind: 'details', enabled: true, label: 'Download details', hint: DOWNLOAD_HINT_DETAILS }
        : { kind: 'unavailable', enabled: false, label: 'Download', hint: DOWNLOAD_HINT_UNAVAILABLE };

  const previewEnabled = strategy.kind !== 'none';

  return {
    hasStoredFile,
    hasExtractedText,
    hasSourceUrl,
    hasStructuredDetail,
    download,
    preview: {
      enabled: previewEnabled,
      hint: previewEnabled ? PREVIEW_HINT_ENABLED : PREVIEW_HINT_DISABLED,
      strategy,
    },
    source: hasSourceUrl
      ? { available: true, url: input.originalUrl?.trim(), hint: SOURCE_HINT_AVAILABLE }
      : { available: false, hint: SOURCE_HINT_MISSING },
    emptyStateReason:
      hasStoredFile || hasExtractedText || hasStructuredDetail
        ? null
        : hasSourceUrl
          ? EMPTY_STATE_URL
          : EMPTY_STATE_FILE,
  };
}
