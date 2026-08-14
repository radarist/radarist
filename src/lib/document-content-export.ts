/**
 * @file lib/document-content-export.ts
 * @description The ONE way a document without stored bytes is turned into a
 * downloadable file.
 *
 * UX-060: the detail sheet composed its own three-line markdown stub (title +
 * description + metrics), labelled it "Download", and toasted "Document
 * downloaded" — for a URL document with 45 extracted chunks the user received
 * a file containing none of the document's content. The list, meanwhile,
 * disabled Download entirely for the same row.
 *
 * Both surfaces now ask `document-content-availability.ts` what may be
 * offered, and when the answer is "extracted text" or "details" they compose
 * the export here, from the REAL current-generation chunks. The label always
 * matches the bytes.
 */

import { getActiveChunksForDocument } from '@/lib/document-chunk-service';
import type { Document } from '@/lib/types';

/** Filename-safe slug derived from a document title. */
export function documentExportFilename(title: string, extension = 'md'): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'document';
  return `${slug}.${extension}`;
}

/**
 * Make a value safe to place in a markdown TABLE cell.
 *
 * `structuredMetrics` is free text copied verbatim from a build-mission
 * verdict, so a metric named `p95 | p99 latency` would otherwise emit extra
 * cells and shear the table; an embedded newline would end the row entirely.
 */
function escapeTableCell(value: string): string {
  return value.replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim();
}

/**
 * Compose the markdown header every composed export carries: what this file
 * is, where it came from, and — when relevant — the measured metrics. Kept
 * separate from the body so an export is never ONLY metadata when real text
 * exists.
 */
function buildHeader(document: Document): string[] {
  // A title containing newlines would silently split the H1 into body text.
  const lines: string[] = [`# ${document.title.replace(/\r?\n+/g, ' ').trim()}`];

  if (document.description) {
    lines.push('', document.description);
  }

  if (document.originalUrl) {
    lines.push('', `Source: ${document.originalUrl}`);
  }

  if (document.structuredMetrics && document.structuredMetrics.length > 0) {
    lines.push('', '## Measured metrics', '', '| Name | Value | Command |', '| --- | --- | --- |');
    for (const metric of document.structuredMetrics) {
      lines.push(
        `| ${escapeTableCell(metric.name)} | ${escapeTableCell(metric.value)} | ` +
          `${escapeTableCell(metric.command ?? '')} |`
      );
    }
  }

  return lines;
}

/**
 * Build the markdown export for a document that has no stored original.
 *
 * @param document - The document being exported.
 * @param extractedText - Joined current-generation chunk text (may be empty).
 * @returns Markdown containing the document's metadata AND its extracted text.
 */
export function buildDocumentExportMarkdown(document: Document, extractedText: string): string {
  const lines = buildHeader(document);

  const body = extractedText.trim();
  if (body) {
    lines.push('', '## Extracted text', '', body);
  } else {
    // Say so explicitly rather than shipping a file that silently looks
    // complete — this is the exact confusion the old stub created.
    lines.push('', '## Extracted text', '', '_No text has been extracted from this document yet._');
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Load the current-generation extracted text for a document.
 *
 * Reads through `getActiveChunksForDocument`, the same call the Preview dialog
 * makes, so an export and a preview of the same document can never show
 * different content.
 */
export async function loadDocumentExtractedText(documentId: string): Promise<string> {
  const chunks = await getActiveChunksForDocument(documentId);
  return chunks.map((chunk) => chunk.content).join('\n\n');
}

/**
 * Compose the full markdown export for a no-stored-file document, fetching
 * its extracted text.
 */
export async function composeDocumentExport(document: Document): Promise<{ filename: string; markdown: string }> {
  const extractedText = await loadDocumentExtractedText(document.id);
  return {
    filename: documentExportFilename(document.title),
    markdown: buildDocumentExportMarkdown(document, extractedText),
  };
}
