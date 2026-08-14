'use client';

/**
 * @file components/library/documents/DocumentPreviewDialog.tsx
 * @description Large dialog that previews a document by type:
 *
 * - markdown / deep-research → react-markdown + remark-gfm (same setup as
 *   the AI chat — see AIMessage.tsx).
 * - pdf → browser-native viewer in an <iframe> (file fetched through the
 *   authed download API, served to the iframe as a blob object URL).
 * - docx → mammoth convertToHtml, rendered inside a SANDBOXED iframe via
 *   srcDoc (sandbox="" — no scripts, no same-origin) so untrusted document
 *   HTML never enters the app DOM.
 * - xlsx → exceljs, first worksheet as a table (capped rows, honest note).
 * - everything else / any failure → extracted-text fallback from the
 *   documentChunks pipeline ("what the AI sees").
 *
 * Heavy converters (mammoth, exceljs) are dynamically imported inside the
 * strategy branches so they never enter the main bundle; this component
 * itself is loaded with next/dynamic from the documents page.
 *
 * Renderer selection is pure logic in @/lib/document-preview — see that
 * module for the strategy ladder.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import { AlertCircle, Download, ScanText } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';

import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { getActiveChunksForDocument } from '@/lib/document-chunk-service';
import { formatSheetCell, PREVIEW_MAX_SHEET_ROWS, type PreviewFallbackReason } from '@/lib/document-preview';
import {
  resolveDocumentContentAvailability,
  type DocumentContentAvailability,
} from '@/lib/document-content-availability';
import { documentTypeLabel } from '@/lib/document-type-labels';
import { formatFileSize } from '@/hooks/useDocumentsPage';
import { createLogger } from '@/lib/logger';
import type { Document } from '@/lib/types';

const log = createLogger('components/DocumentPreviewDialog');

// ============================================================================
// TYPES
// ============================================================================

interface DocumentPreviewDialogProps {
  document: Document;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Reuses the existing download handler so the hint buttons actually work. */
  onDownload?: (doc: Document) => void;
}

type PreviewContent =
  | { kind: 'markdown'; markdown: string }
  | { kind: 'pdf'; objectUrl: string }
  | { kind: 'docx'; srcDoc: string }
  | { kind: 'xlsx'; sheetName: string; rows: string[][]; totalRows: number; truncated: boolean }
  | { kind: 'extracted-text'; text: string; note?: string };

type PreviewState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; content: PreviewContent }
  | { phase: 'error'; message: string };

// ============================================================================
// FALLBACK NOTES (honest, user-facing)
// ============================================================================

const FALLBACK_NOTES: Record<PreviewFallbackReason, string | undefined> = {
  // URL docs and chunk-only docs land here by design — no note needed, the
  // "what the AI sees" header already explains what's shown.
  'no-file': undefined,
  'too-large': 'File is too large to preview in the browser (>20 MB) — showing extracted text instead.',
  'legacy-format': 'This legacy format cannot be rendered in the browser — showing extracted text instead.',
  'unsupported-type': 'No inline viewer for this format — showing extracted text instead.',
};

const FETCH_FAILED_NOTE =
  'Could not fetch the original file (network or storage error) — showing extracted text instead.';
const CONVERT_FAILED_NOTE = 'Could not render the original file — showing extracted text instead.';

// ============================================================================
// DOCX SANDBOX DOCUMENT
// ============================================================================

/**
 * Wraps mammoth's HTML output in a minimal standalone document for the
 * sandboxed iframe. The iframe has no same-origin access, so it cannot read
 * the app's CSS variables — theme colors are baked in as hex (the one place
 * the semantic-colors rule cannot reach; the surrounding dialog stays
 * theme-aware via Tailwind tokens).
 */
function buildDocxSrcDoc(bodyHtml: string, isDark: boolean): string {
  const c = isDark
    ? { bg: '#0c0a09', fg: '#e7e5e4', muted: '#a8a29e', border: '#44403c' }
    : { bg: '#ffffff', fg: '#1c1917', muted: '#57534e', border: '#d6d3d1' };

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background: ${c.bg}; color: ${c.fg};
         margin: 0 auto; max-width: 72ch; padding: 24px 28px; line-height: 1.65; font-size: 14px; }
  h1, h2, h3, h4 { line-height: 1.3; }
  a { color: inherit; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th, td { border: 1px solid ${c.border}; padding: 4px 8px; text-align: left; }
  blockquote { border-left: 3px solid ${c.border}; margin-left: 0; padding-left: 12px; color: ${c.muted}; }
  pre, code { font-family: ui-monospace, monospace; font-size: 13px; }
</style>
</head>
<body>${bodyHtml}</body>
</html>`;
}

// ============================================================================
// LOADERS
// ============================================================================

/** Joined non-archived chunk text, ordered by chunkIndex (client SDK read). */
async function loadExtractedText(documentId: string): Promise<string> {
  const chunks = await getActiveChunksForDocument(documentId);
  return chunks.map((chunk) => chunk.content).join('\n\n');
}

/** Fetch the stored file through the authed download API (same path Download uses). */
async function fetchDocumentFile(documentId: string): Promise<Response> {
  const response = await fetchWithAuth(`/api/documents/download?id=${encodeURIComponent(documentId)}`);
  if (!response.ok) {
    throw new Error(`Download API returned ${response.status}`);
  }
  return response;
}

async function convertDocx(arrayBuffer: ArrayBuffer, isDark: boolean): Promise<PreviewContent> {
  // Dynamic import keeps mammoth out of the main bundle. Webpack resolves
  // mammoth's package `browser` field to the browser build (same code path
  // as mammoth/mammoth.browser, but with type declarations intact).
  const mammothModule = await import('mammoth');
  const mammoth = mammothModule.default ?? mammothModule;
  const result = await mammoth.convertToHtml({ arrayBuffer });
  return { kind: 'docx', srcDoc: buildDocxSrcDoc(result.value, isDark) };
}

async function convertXlsx(arrayBuffer: ArrayBuffer): Promise<PreviewContent> {
  // Dynamic import keeps exceljs out of the main bundle (webpack resolves
  // its `browser` field to the bundled browser build). The `default ??`
  // dance covers both CJS-interop shapes the bundle can produce.
  const excelModule = await import('exceljs');
  const ExcelNs = excelModule.default ?? excelModule;
  const workbook = new ExcelNs.Workbook();
  await workbook.xlsx.load(arrayBuffer);

  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new Error('Workbook contains no worksheets');
  }

  const rows: string[][] = [];
  let maxColumns = 0;
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    if (rows.length >= PREVIEW_MAX_SHEET_ROWS) return;
    // row.values is 1-indexed and sparse — Array.from materializes holes as
    // undefined so empty cells render as '' instead of collapsing columns.
    const values = Array.from((row.values as unknown[]).slice(1), (value) => formatSheetCell(value));
    maxColumns = Math.max(maxColumns, values.length);
    rows.push(values);
  });
  // Pad short rows so the table grid stays rectangular.
  const padded = rows.map((row) =>
    row.length < maxColumns ? [...row, ...Array<string>(maxColumns - row.length).fill('')] : row
  );

  const totalRows = worksheet.actualRowCount;
  return {
    kind: 'xlsx',
    sheetName: worksheet.name,
    rows: padded,
    totalRows,
    truncated: totalRows > padded.length,
  };
}

// ============================================================================
// COMPONENT
// ============================================================================

export function DocumentPreviewDialog({ document, open, onOpenChange, onDownload }: DocumentPreviewDialogProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  // UX-060: the dialog no longer resolves the preview ladder on its own — it
  // reads the SAME availability contract the row menu, the grid card and the
  // detail sheet use, so what the dialog offers can never contradict what the
  // launcher promised.
  const availability = useMemo(
    () =>
      resolveDocumentContentAvailability({
        type: document.type,
        storageUrl: document.storageUrl,
        originalUrl: document.originalUrl,
        chunkCount: document.chunkCount,
        fileSize: document.fileSize,
        structuredMetrics: document.structuredMetrics,
      }),
    [
      document.type,
      document.storageUrl,
      document.originalUrl,
      document.chunkCount,
      document.fileSize,
      document.structuredMetrics,
    ]
  );
  const strategy = availability.preview.strategy;

  const [state, setState] = useState<PreviewState>({ phase: 'idle' });
  // PDF previews mint a blob object URL — track it so close/unmount revokes it.
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      setState({ phase: 'idle' });
      return;
    }

    let cancelled = false;
    const documentId = document.id;

    const finish = (next: PreviewState) => {
      if (!cancelled) setState(next);
    };

    /** Terminal fallback: extracted chunk text with an honest note. */
    const fallBackToExtractedText = async (note?: string) => {
      try {
        const text = await loadExtractedText(documentId);
        finish({ phase: 'ready', content: { kind: 'extracted-text', text, note } });
      } catch (error) {
        log.error('Failed to load extracted text', error instanceof Error ? error : new Error(String(error)), {
          documentId,
        });
        finish({ phase: 'error', message: 'Could not load a preview or the extracted text for this document.' });
      }
    };

    const load = async () => {
      setState({ phase: 'loading' });

      if (strategy.kind === 'none') {
        // Defensive — the launcher is disabled for this case. The message is
        // the contract's own empty-state copy so the dialog and the tooltip
        // that led here say the same thing.
        finish({
          phase: 'error',
          message: availability.emptyStateReason ?? 'This document has no stored file and no extracted text to preview.',
        });
        return;
      }

      if (strategy.kind === 'extracted-text') {
        await fallBackToExtractedText(FALLBACK_NOTES[strategy.reason]);
        return;
      }

      // File-backed strategies: fetch through the authed download API (same
      // origin — no CORS exposure to the storage host; auth header injected).
      let response: Response;
      try {
        response = await fetchDocumentFile(documentId);
      } catch (error) {
        log.warn('Preview file fetch failed, falling back to extracted text', {
          documentId,
          error: String(error),
        });
        await fallBackToExtractedText(FETCH_FAILED_NOTE);
        return;
      }

      try {
        switch (strategy.kind) {
          case 'markdown': {
            const markdown = await response.text();
            finish({ phase: 'ready', content: { kind: 'markdown', markdown } });
            return;
          }
          case 'pdf': {
            const blob = await response.blob();
            const objectUrl = URL.createObjectURL(blob);
            if (cancelled) {
              URL.revokeObjectURL(objectUrl);
              return;
            }
            objectUrlRef.current = objectUrl;
            finish({ phase: 'ready', content: { kind: 'pdf', objectUrl } });
            return;
          }
          case 'docx': {
            const arrayBuffer = await response.arrayBuffer();
            finish({ phase: 'ready', content: await convertDocx(arrayBuffer, isDark) });
            return;
          }
          case 'xlsx': {
            const arrayBuffer = await response.arrayBuffer();
            finish({ phase: 'ready', content: await convertXlsx(arrayBuffer) });
            return;
          }
        }
      } catch (error) {
        log.warn('Preview conversion failed, falling back to extracted text', {
          documentId,
          strategy: strategy.kind,
          error: String(error),
        });
        await fallBackToExtractedText(CONVERT_FAILED_NOTE);
      }
    };

    load();

    return () => {
      cancelled = true;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
    // isDark is intentionally omitted from the deps: a theme flip mid-preview
    // shouldn't refetch the file; the next open picks up the new theme.
  }, [open, document.id, strategy, availability.emptyStateReason]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl h-[85vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="border-b border-border px-6 py-4 shrink-0">
          <DialogTitle className="truncate pr-8" title={document.title}>
            {document.title}
          </DialogTitle>
          <DialogDescription>
            {documentTypeLabel(document.type)}
            {document.fileSize ? ` · ${formatFileSize(document.fileSize)}` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 flex flex-col">
          {state.phase === 'loading' || state.phase === 'idle' ? (
            <PreviewSkeleton />
          ) : state.phase === 'error' ? (
            <PreviewError
              message={state.message}
              document={document}
              availability={availability}
              onDownload={onDownload}
            />
          ) : (
            <PreviewBody
              content={state.content}
              document={document}
              availability={availability}
              onDownload={onDownload}
            />
          )}
        </div>

        <DialogFooter className="border-t border-border px-6 py-3 shrink-0">
          <PreviewDownloadButton document={document} availability={availability} onDownload={onDownload} />
          <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// SUBVIEWS
// ============================================================================

function PreviewSkeleton() {
  return (
    <div className="p-6 space-y-3" data-testid="preview-skeleton">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

/**
 * UX-060: every download affordance in this dialog used to be gated on
 * `!!document.storageUrl` and hard-labelled "original", so a URL document with
 * extracted text was offered nothing while the detail sheet offered a stub.
 * One contract, one label, everywhere.
 */
function PreviewDownloadButton({
  document,
  availability,
  onDownload,
  label,
}: {
  document: Document;
  availability: DocumentContentAvailability;
  onDownload?: (doc: Document) => void;
  label?: string;
}) {
  if (!onDownload || !availability.download.enabled) return null;

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => onDownload(document)}
      title={availability.download.hint}
      data-testid="preview-download"
    >
      <Download className="mr-2 h-4 w-4" />
      {label ?? availability.download.label}
    </Button>
  );
}

function PreviewError({
  message,
  document,
  availability,
  onDownload,
}: {
  message: string;
  document: Document;
  availability: DocumentContentAvailability;
  onDownload?: (doc: Document) => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <AlertCircle className="h-8 w-8 text-muted-foreground" />
      <p className="text-sm text-muted-foreground max-w-md">{message}</p>
      <PreviewDownloadButton
        document={document}
        availability={availability}
        onDownload={onDownload}
        label={`${availability.download.label} instead`}
      />
    </div>
  );
}

function PreviewBody({
  content,
  document,
  availability,
  onDownload,
}: {
  content: PreviewContent;
  document: Document;
  availability: DocumentContentAvailability;
  onDownload?: (doc: Document) => void;
}) {
  switch (content.kind) {
    case 'markdown':
      return (
        <ScrollArea className="flex-1 min-h-0">
          <div
            className={
              // Same markdown styling stack as the AI chat (AIMessage.tsx).
              'p-6 text-sm prose prose-sm dark:prose-invert max-w-none ' +
              'prose-headings:font-semibold prose-strong:font-semibold prose-strong:text-inherit'
            }
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                code: ({ children, className }) => {
                  const isBlock = className?.includes('language-');
                  return isBlock ? (
                    <code className="block bg-muted/50 rounded p-2 text-xs overflow-x-auto">{children}</code>
                  ) : (
                    <code className="bg-muted/50 rounded px-1 py-0.5 text-xs">{children}</code>
                  );
                },
                a: ({ href, children }) => (
                  <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                    {children}
                  </a>
                ),
                table: ({ children }) => (
                  <div className="overflow-x-auto my-2 rounded border border-border">
                    <table className="min-w-full text-sm">{children}</table>
                  </div>
                ),
                thead: ({ children }) => <thead className="bg-muted/50 border-b border-border">{children}</thead>,
                tr: ({ children }) => <tr className="border-b border-border last:border-0">{children}</tr>,
                th: ({ children }) => (
                  <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">{children}</th>
                ),
                td: ({ children }) => <td className="px-3 py-1.5">{children}</td>,
              }}
            >
              {content.markdown}
            </ReactMarkdown>
          </div>
        </ScrollArea>
      );

    case 'pdf':
      return (
        <iframe
          src={content.objectUrl}
          title={`Preview of ${document.title}`}
          className="h-full w-full flex-1 border-0 bg-muted/20"
        />
      );

    case 'docx':
      return (
        // SECURITY: sandbox="" (no allow-scripts, no allow-same-origin) —
        // mammoth output is untrusted document HTML and must never execute
        // or touch the app origin.
        <iframe
          sandbox=""
          srcDoc={content.srcDoc}
          title={`Preview of ${document.title}`}
          className="h-full w-full flex-1 border-0"
          data-testid="docx-preview-frame"
        />
      );

    case 'xlsx':
      return (
        <div className="flex flex-1 min-h-0 flex-col">
          <div className="flex items-center justify-between gap-2 border-b border-border px-6 py-2 text-xs text-muted-foreground shrink-0">
            <span className="truncate">Worksheet: {content.sheetName}</span>
            {content.truncated && (
              <span>
                Showing first {content.rows.length} of {content.totalRows} rows
              </span>
            )}
          </div>
          <ScrollArea className="flex-1 min-h-0">
            <Table>
              <TableBody>
                {content.rows.map((row, rowIndex) => (
                  <TableRow key={rowIndex} className="border-b border-border/40">
                    {row.map((cell, cellIndex) => (
                      <TableCell key={cellIndex} className="px-3 py-1.5 text-xs whitespace-nowrap">
                        {cell}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
        </div>
      );

    case 'extracted-text':
      return (
        <div className="flex flex-1 min-h-0 flex-col">
          <div className="flex items-center gap-2 border-b border-border px-6 py-2 text-xs text-muted-foreground shrink-0">
            <ScanText className="h-3.5 w-3.5 shrink-0" />
            <span>Extracted text preview — this is what the AI sees</span>
          </div>
          {content.note && (
            <p className="border-b border-border bg-muted/40 px-6 py-2 text-xs text-muted-foreground shrink-0">
              {content.note}
            </p>
          )}
          {content.text.trim() ? (
            <ScrollArea className="flex-1 min-h-0">
              <pre
                data-testid="preview-extracted-text"
                className="whitespace-pre-wrap break-words p-6 font-sans text-sm leading-relaxed text-foreground"
              >
                {content.text}
              </pre>
            </ScrollArea>
          ) : (
            <div
              className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center"
              data-testid="preview-empty"
            >
              <p className="text-sm text-muted-foreground max-w-md">
                No extracted text yet — process the document to extract its content.
              </p>
              <PreviewDownloadButton
                document={document}
                availability={availability}
                onDownload={onDownload}
                label={`${availability.download.label} instead`}
              />
            </div>
          )}
        </div>
      );
  }
}
