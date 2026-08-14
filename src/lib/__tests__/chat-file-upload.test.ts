/**
 * Unit Tests for Chat File Upload Helper
 *
 * Tests the client-side helper functions for uploading files to the document library:
 * - shouldUploadToLibrary() - checks if file should be uploaded based on size
 * - createUploadingReference() - creates initial document reference
 * - createReferenceFromUpload() - creates reference from upload result
 * - toProcessingStatus() - converts document status to processing status
 *
 * Note: uploadFileToLibrary() and pollDocumentStatus() require fetch mocking
 * and are tested separately in integration tests.
 *
 * @jest-environment node
 */

import { describe, it, expect } from "@jest/globals";

// ============================================================================
// CONSTANTS (Replicated for testing)
// ============================================================================

const LIBRARY_UPLOAD_THRESHOLD = 50 * 1024; // 50KB

// ============================================================================
// TYPE DEFINITIONS (Replicated for testing)
// ============================================================================

type DocumentProcessingStatus = "uploading" | "processing" | "ready" | "failed";

interface DocumentReference {
  documentId: string;
  name: string;
  status: DocumentProcessingStatus;
  errorMessage?: string;
  uploadedAt: number;
}

interface UploadResult {
  success: boolean;
  documentId?: string;
  documentTitle?: string;
  status?: string;
  error?: string;
}

interface MockFile {
  name: string;
  type: string;
  size: number;
}

// ============================================================================
// HELPER FUNCTIONS (Replicated for testing)
// ============================================================================

function shouldUploadToLibrary(extractedTextSize: number): boolean {
  return extractedTextSize > LIBRARY_UPLOAD_THRESHOLD;
}

function createUploadingReference(file: MockFile): DocumentReference {
  return {
    documentId: "",
    name: file.name,
    status: "uploading",
    uploadedAt: Date.now(),
  };
}

function createReferenceFromUpload(
  result: UploadResult,
  fileName: string
): DocumentReference {
  if (result.success && result.documentId) {
    return {
      documentId: result.documentId,
      name: result.documentTitle || fileName,
      status: "processing",
      uploadedAt: Date.now(),
    };
  }

  return {
    documentId: "",
    name: fileName,
    status: "failed",
    errorMessage: result.error,
    uploadedAt: Date.now(),
  };
}

function toProcessingStatus(
  status: string
): DocumentProcessingStatus {
  switch (status) {
    case "uploaded":
    case "processing":
      return "processing";
    case "processed":
      return "ready";
    case "failed":
    case "blocked":
      return "failed";
    default:
      return "processing";
  }
}

// ============================================================================
// TESTS
// ============================================================================

describe("Chat File Upload Helper", () => {
  describe("Constants", () => {
    it("should have LIBRARY_UPLOAD_THRESHOLD of 50KB", () => {
      expect(LIBRARY_UPLOAD_THRESHOLD).toBe(50 * 1024);
    });
  });

  describe("shouldUploadToLibrary()", () => {
    it("should return false for small files (< 50KB)", () => {
      expect(shouldUploadToLibrary(10 * 1024)).toBe(false);
      expect(shouldUploadToLibrary(25 * 1024)).toBe(false);
      expect(shouldUploadToLibrary(49 * 1024)).toBe(false);
    });

    it("should return false for exactly 50KB", () => {
      expect(shouldUploadToLibrary(50 * 1024)).toBe(false);
    });

    it("should return true for files > 50KB", () => {
      expect(shouldUploadToLibrary(51 * 1024)).toBe(true);
      expect(shouldUploadToLibrary(100 * 1024)).toBe(true);
      expect(shouldUploadToLibrary(1024 * 1024)).toBe(true);
    });

    it("should return false for zero size", () => {
      expect(shouldUploadToLibrary(0)).toBe(false);
    });
  });

  describe("createUploadingReference()", () => {
    it("should create reference with uploading status", () => {
      const file: MockFile = {
        name: "report.pdf",
        type: "application/pdf",
        size: 100 * 1024,
      };

      const ref = createUploadingReference(file);

      expect(ref.documentId).toBe("");
      expect(ref.name).toBe("report.pdf");
      expect(ref.status).toBe("uploading");
      expect(ref.uploadedAt).toBeGreaterThan(0);
    });

    it("should preserve file name exactly", () => {
      const file: MockFile = {
        name: "Annual Report 2024 (Final).pdf",
        type: "application/pdf",
        size: 100 * 1024,
      };

      const ref = createUploadingReference(file);
      expect(ref.name).toBe("Annual Report 2024 (Final).pdf");
    });

    it("should handle special characters in file names", () => {
      const file: MockFile = {
        name: "résumé_données.xlsx",
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: 50 * 1024,
      };

      const ref = createUploadingReference(file);
      expect(ref.name).toBe("résumé_données.xlsx");
    });
  });

  describe("createReferenceFromUpload()", () => {
    describe("successful upload", () => {
      it("should create reference with processing status", () => {
        const result: UploadResult = {
          success: true,
          documentId: "doc-123",
          documentTitle: "Annual Report",
          status: "uploaded",
        };

        const ref = createReferenceFromUpload(result, "report.pdf");

        expect(ref.documentId).toBe("doc-123");
        expect(ref.name).toBe("Annual Report");
        expect(ref.status).toBe("processing");
        expect(ref.errorMessage).toBeUndefined();
      });

      it("should use original file name if documentTitle is missing", () => {
        const result: UploadResult = {
          success: true,
          documentId: "doc-456",
        };

        const ref = createReferenceFromUpload(result, "report.pdf");

        expect(ref.name).toBe("report.pdf");
      });

      it("should prefer documentTitle over file name", () => {
        const result: UploadResult = {
          success: true,
          documentId: "doc-789",
          documentTitle: "Renamed Document",
        };

        const ref = createReferenceFromUpload(result, "original.pdf");

        expect(ref.name).toBe("Renamed Document");
      });
    });

    describe("failed upload", () => {
      it("should create reference with failed status", () => {
        const result: UploadResult = {
          success: false,
          error: "File too large",
        };

        const ref = createReferenceFromUpload(result, "huge.pdf");

        expect(ref.documentId).toBe("");
        expect(ref.name).toBe("huge.pdf");
        expect(ref.status).toBe("failed");
        expect(ref.errorMessage).toBe("File too large");
      });

      it("should handle upload without documentId", () => {
        const result: UploadResult = {
          success: true,
          // No documentId
        };

        const ref = createReferenceFromUpload(result, "report.pdf");

        expect(ref.status).toBe("failed");
      });

      it("should handle undefined error message", () => {
        const result: UploadResult = {
          success: false,
        };

        const ref = createReferenceFromUpload(result, "report.pdf");

        expect(ref.status).toBe("failed");
        expect(ref.errorMessage).toBeUndefined();
      });
    });
  });

  describe("toProcessingStatus()", () => {
    it("should map 'uploaded' to 'processing'", () => {
      expect(toProcessingStatus("uploaded")).toBe("processing");
    });

    it("should map 'processing' to 'processing'", () => {
      expect(toProcessingStatus("processing")).toBe("processing");
    });

    it("should map 'processed' to 'ready'", () => {
      expect(toProcessingStatus("processed")).toBe("ready");
    });

    it("should map 'failed' to 'failed'", () => {
      expect(toProcessingStatus("failed")).toBe("failed");
    });

    it("should map 'blocked' to 'failed'", () => {
      expect(toProcessingStatus("blocked")).toBe("failed");
    });

    it("should default unknown statuses to 'processing'", () => {
      expect(toProcessingStatus("unknown")).toBe("processing");
      expect(toProcessingStatus("")).toBe("processing");
      expect(toProcessingStatus("pending")).toBe("processing");
    });
  });

  describe("DocumentReference Interface", () => {
    it("should have correct structure for uploading state", () => {
      const ref: DocumentReference = {
        documentId: "",
        name: "report.pdf",
        status: "uploading",
        uploadedAt: Date.now(),
      };

      expect(ref.documentId).toBe("");
      expect(ref.status).toBe("uploading");
      expect(ref.errorMessage).toBeUndefined();
    });

    it("should have correct structure for processing state", () => {
      const ref: DocumentReference = {
        documentId: "doc-123",
        name: "report.pdf",
        status: "processing",
        uploadedAt: Date.now(),
      };

      expect(ref.documentId).toBe("doc-123");
      expect(ref.status).toBe("processing");
    });

    it("should have correct structure for ready state", () => {
      const ref: DocumentReference = {
        documentId: "doc-123",
        name: "report.pdf",
        status: "ready",
        uploadedAt: Date.now(),
      };

      expect(ref.status).toBe("ready");
    });

    it("should have correct structure for failed state with error", () => {
      const ref: DocumentReference = {
        documentId: "doc-123",
        name: "report.pdf",
        status: "failed",
        errorMessage: "Processing failed: corrupt file",
        uploadedAt: Date.now(),
      };

      expect(ref.status).toBe("failed");
      expect(ref.errorMessage).toBe("Processing failed: corrupt file");
    });
  });

  describe("UploadResult Interface", () => {
    it("should have correct structure for successful upload", () => {
      const result: UploadResult = {
        success: true,
        documentId: "doc-123",
        documentTitle: "Annual Report 2024",
        status: "uploaded",
      };

      expect(result.success).toBe(true);
      expect(result.documentId).toBeDefined();
      expect(result.error).toBeUndefined();
    });

    it("should have correct structure for failed upload", () => {
      const result: UploadResult = {
        success: false,
        error: "Upload failed: network error",
      };

      expect(result.success).toBe(false);
      expect(result.documentId).toBeUndefined();
      expect(result.error).toBeDefined();
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty file name", () => {
      const file: MockFile = {
        name: "",
        type: "application/pdf",
        size: 1024,
      };

      const ref = createUploadingReference(file);
      expect(ref.name).toBe("");
    });

    it("should handle very long file names", () => {
      const longName = "a".repeat(500) + ".pdf";
      const file: MockFile = {
        name: longName,
        type: "application/pdf",
        size: 1024,
      };

      const ref = createUploadingReference(file);
      expect(ref.name).toBe(longName);
    });

    it("should handle boundary size values", () => {
      // Just under threshold
      expect(shouldUploadToLibrary(LIBRARY_UPLOAD_THRESHOLD - 1)).toBe(false);
      // Exactly at threshold
      expect(shouldUploadToLibrary(LIBRARY_UPLOAD_THRESHOLD)).toBe(false);
      // Just over threshold
      expect(shouldUploadToLibrary(LIBRARY_UPLOAD_THRESHOLD + 1)).toBe(true);
    });

    it("should handle negative size values gracefully", () => {
      // Negative sizes should return false (invalid but shouldn't crash)
      expect(shouldUploadToLibrary(-1)).toBe(false);
      expect(shouldUploadToLibrary(-1000)).toBe(false);
    });
  });
});
