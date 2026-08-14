/**
 * @file lib/document-type-labels.ts
 * @description Display labels for document types — single source of truth.
 *
 * Shared by the documents UI (DocumentTypeBadge renders these) and the
 * documents-page sort logic (the Type column sorts alphabetically by this
 * label, not by the raw type key). Deliberately dependency-free (no React,
 * no icons) so hooks can import it without dragging component modules in.
 */

import type { DocumentType } from '@/lib/types';

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  pdf: 'PDF',
  docx: 'DOCX',
  pptx: 'PPTX',
  url: 'URL',
  transcript: 'Transcript',
  markdown: 'Markdown',
  text: 'Text',
  'deep-research': 'Deep Research',
};

/**
 * Label for a document type with a graceful fallback to the raw type string
 * for unknown/legacy values (mirrors DocumentTypeBadge's fallback).
 */
export function documentTypeLabel(type: DocumentType): string {
  return DOCUMENT_TYPE_LABELS[type] ?? type;
}
