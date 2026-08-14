/**
 * Unit Tests for Candidate Verifier Module
 *
 * Tests:
 * - quickValidate function (pure, no mocking needed)
 * - preFilterCandidates function (pure, no mocking needed)
 *
 * @jest-environment node
 */

import { describe, it, expect } from "@jest/globals";
import { quickValidate, preFilterCandidates } from "../candidate-verifier";
import type { LinkerCandidate } from "@/lib/linker/types";

// ============================================================================
// TEST HELPERS
// ============================================================================

/**
 * Creates a mock LinkerCandidate for testing
 */
function createMockCandidate(
  overrides: Partial<LinkerCandidate> = {}
): LinkerCandidate {
  return {
    sourceId: "source-123",
    sourceType: "technology",
    sourceName: "React",
    targetId: "target-456",
    targetType: "company",
    targetName: "Meta",
    relationType: "vendor",
    confidence: 75,
    discoveryMethod: "heuristic",
    ...overrides,
  };
}

// ============================================================================
// quickValidate TESTS
// ============================================================================

describe("Candidate Verifier - quickValidate()", () => {
  describe("Valid Candidates", () => {
    it("should pass validation for a well-formed candidate", () => {
      const candidate = createMockCandidate();
      expect(quickValidate(candidate)).toBe(true);
    });

    it("should pass validation for different source and target types", () => {
      const candidate = createMockCandidate({
        sourceType: "signal",
        targetType: "technology",
        relationType: "mentions",
      });
      expect(quickValidate(candidate)).toBe(true);
    });

    it("should pass validation for same type but different IDs", () => {
      const candidate = createMockCandidate({
        sourceType: "technology",
        sourceId: "tech-1",
        sourceName: "React",
        targetType: "technology",
        targetId: "tech-2",
        targetName: "Vue",
        relationType: "uses",
      });
      expect(quickValidate(candidate)).toBe(true);
    });

    it("should pass validation for minimum acceptable confidence (20)", () => {
      const candidate = createMockCandidate({ confidence: 20 });
      expect(quickValidate(candidate)).toBe(true);
    });
  });

  describe("Invalid Candidates - Self-Reference", () => {
    it("should reject candidate where source and target are the same", () => {
      const candidate = createMockCandidate({
        sourceId: "same-id",
        sourceType: "technology",
        targetId: "same-id",
        targetType: "technology",
      });
      expect(quickValidate(candidate)).toBe(false);
    });
  });

  describe("Invalid Candidates - Low Confidence", () => {
    it("should reject candidate with confidence below 20", () => {
      const candidate = createMockCandidate({ confidence: 19 });
      expect(quickValidate(candidate)).toBe(false);
    });

    it("should reject candidate with zero confidence", () => {
      const candidate = createMockCandidate({ confidence: 0 });
      expect(quickValidate(candidate)).toBe(false);
    });

    it("should reject candidate with negative confidence", () => {
      const candidate = createMockCandidate({ confidence: -10 });
      expect(quickValidate(candidate)).toBe(false);
    });
  });

  describe("Invalid Candidates - Missing Names", () => {
    it("should reject candidate with empty source name", () => {
      const candidate = createMockCandidate({ sourceName: "" });
      expect(quickValidate(candidate)).toBe(false);
    });

    it("should reject candidate with empty target name", () => {
      const candidate = createMockCandidate({ targetName: "" });
      expect(quickValidate(candidate)).toBe(false);
    });
  });

  describe("Invalid Candidates - Duplicate Names", () => {
    it("should reject candidate where source and target have identical names", () => {
      const candidate = createMockCandidate({
        sourceName: "Same Name",
        targetName: "Same Name",
      });
      expect(quickValidate(candidate)).toBe(false);
    });

    it("should reject candidate where names differ only by case", () => {
      const candidate = createMockCandidate({
        sourceName: "REACT",
        targetName: "react",
      });
      expect(quickValidate(candidate)).toBe(false);
    });

    it("should reject candidate where names differ only by whitespace", () => {
      const candidate = createMockCandidate({
        sourceName: "  React  ",
        targetName: "React",
      });
      expect(quickValidate(candidate)).toBe(false);
    });
  });
});

// ============================================================================
// preFilterCandidates TESTS
// ============================================================================

describe("Candidate Verifier - preFilterCandidates()", () => {
  it("should return empty array for empty input", () => {
    const result = preFilterCandidates([]);
    expect(result).toEqual([]);
  });

  it("should keep all valid candidates", () => {
    const candidates = [
      createMockCandidate({ sourceId: "1", targetId: "a" }),
      createMockCandidate({ sourceId: "2", targetId: "b" }),
      createMockCandidate({ sourceId: "3", targetId: "c" }),
    ];

    const result = preFilterCandidates(candidates);
    expect(result.length).toBe(3);
  });

  it("should filter out self-referencing candidates", () => {
    const candidates = [
      createMockCandidate({ sourceId: "1", targetId: "a" }),
      createMockCandidate({
        sourceId: "same",
        targetId: "same",
        sourceType: "technology",
        targetType: "technology",
      }),
      createMockCandidate({ sourceId: "2", targetId: "b" }),
    ];

    const result = preFilterCandidates(candidates);
    expect(result.length).toBe(2);
    expect(result.find((c) => c.sourceId === "same")).toBeUndefined();
  });

  it("should filter out low confidence candidates", () => {
    const candidates = [
      createMockCandidate({ confidence: 75 }),
      createMockCandidate({ confidence: 15 }),
      createMockCandidate({ confidence: 50 }),
    ];

    const result = preFilterCandidates(candidates);
    expect(result.length).toBe(2);
    expect(result.every((c) => c.confidence >= 20)).toBe(true);
  });

  it("should filter out candidates with empty names", () => {
    const candidates = [
      createMockCandidate({ sourceName: "Valid" }),
      createMockCandidate({ sourceName: "" }),
      createMockCandidate({ targetName: "" }),
    ];

    const result = preFilterCandidates(candidates);
    expect(result.length).toBe(1);
    expect(result[0].sourceName).toBe("Valid");
  });

  it("should filter out candidates with duplicate names", () => {
    const candidates = [
      createMockCandidate({
        sourceName: "Different Source",
        targetName: "Different Target",
      }),
      createMockCandidate({ sourceName: "Same", targetName: "Same" }),
    ];

    const result = preFilterCandidates(candidates);
    expect(result.length).toBe(1);
    expect(result[0].sourceName).toBe("Different Source");
  });

  it("should handle mixed invalid candidates", () => {
    const candidates = [
      createMockCandidate({ sourceId: "valid", confidence: 80 }),
      createMockCandidate({ confidence: 10 }), // Low confidence
      createMockCandidate({ sourceName: "", targetName: "Target" }), // Empty name
      createMockCandidate({ sourceName: "X", targetName: "X" }), // Duplicate name
      createMockCandidate({
        sourceId: "self",
        targetId: "self",
        sourceType: "technology",
        targetType: "technology",
      }), // Self-reference
      createMockCandidate({ sourceId: "valid2", confidence: 60 }), // Valid
    ];

    const result = preFilterCandidates(candidates);
    expect(result.length).toBe(2);
    expect(result.map((c) => c.sourceId)).toEqual(["valid", "valid2"]);
  });

  it("should preserve candidate order for valid candidates", () => {
    const candidates = [
      createMockCandidate({ sourceId: "first" }),
      createMockCandidate({ sourceId: "second" }),
      createMockCandidate({ sourceId: "third" }),
    ];

    const result = preFilterCandidates(candidates);
    expect(result.map((c) => c.sourceId)).toEqual(["first", "second", "third"]);
  });
});
