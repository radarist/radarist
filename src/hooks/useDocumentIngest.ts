/**
 * @file useDocumentIngest.ts
 * @description React hook for document upload and entity extraction
 *
 * @author Radarist Team
 * @created 2025-11-28
 */

"use client";

import { useState, useCallback } from "react";
import { createLogger } from '@/lib/logger';

const log = createLogger('hooks/useDocumentIngest');
import { fetchWithAuth } from "@/lib/fetch-with-auth";
import type { SuggestedRelation } from "@/lib/auto-linker-utils";

/**
 * Supported file extensions
 */
export const SUPPORTED_EXTENSIONS = [".pdf", ".docx", ".pptx"];

/**
 * Max file size in bytes (10MB)
 */
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * Result of document ingestion
 */
export interface IngestionResult {
  fileName: string;
  fileSize: number;
  mimeType: string;
  pageCount?: number;
  textLength: number;
  extractedText: string;
  suggestions: SuggestedRelation[];
}

/**
 * Hook state
 */
interface UseDocumentIngestState {
  /** Whether upload/processing is in progress */
  isProcessing: boolean;
  /** Progress percentage (0-100) */
  progress: number;
  /** Current status message */
  status: string;
  /** Error message if any */
  error: string | null;
  /** Result of ingestion */
  result: IngestionResult | null;
}

/**
 * Hook for document upload and entity extraction
 */
export function useDocumentIngest() {
  const [state, setState] = useState<UseDocumentIngestState>({
    isProcessing: false,
    progress: 0,
    status: "",
    error: null,
    result: null });

  /**
   * Validates a file before upload
   */
  const validateFile = useCallback((file: File): string | null => {
    // Check file size
    if (file.size > MAX_FILE_SIZE) {
      return `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`;
    }

    // Check file extension
    const extension = "." + file.name.split(".").pop()?.toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(extension)) {
      return `Unsupported file type. Supported types: ${SUPPORTED_EXTENSIONS.join(", ")}`;
    }

    return null;
  }, []);

  /**
   * Process a document file
   */
  const processDocument = useCallback(async (file: File): Promise<void> => {
    // Validate
    const validationError = validateFile(file);
    if (validationError) {
      setState((prev) => ({
        ...prev,
        error: validationError,
        isProcessing: false }));
      return;
    }

    setState({
      isProcessing: true,
      progress: 10,
      status: "Uploading document...",
      error: null,
      result: null });

    try {
      // Create form data
      const formData = new FormData();
      formData.append("file", file);

      setState((prev) => ({
        ...prev,
        progress: 30,
        status: "Extracting text from document..." }));

      // Upload and process
      const response = await fetchWithAuth("/api/documents/ingest", {
        method: "POST",
        body: formData });

      setState((prev) => ({
        ...prev,
        progress: 70,
        status: "Analyzing content with AI..." }));

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to process document");
      }

      setState({
        isProcessing: false,
        progress: 100,
        status: "Complete!",
        error: null,
        result: {
          fileName: data.fileName,
          fileSize: data.fileSize,
          mimeType: data.mimeType,
          pageCount: data.pageCount,
          textLength: data.textLength,
          extractedText: data.extractedText,
          suggestions: data.suggestions } });
    } catch (error) {
      log.error('Document processing error', error instanceof Error ? error : new Error(String(error)));
      setState({
        isProcessing: false,
        progress: 0,
        status: "",
        error: error instanceof Error ? error.message : "Failed to process document",
        result: null });
    }
  }, [validateFile]);

  /**
   * Reset state
   */
  const reset = useCallback(() => {
    setState({
      isProcessing: false,
      progress: 0,
      status: "",
      error: null,
      result: null });
  }, []);

  return {
    ...state,
    processDocument,
    reset,
    validateFile };
}
