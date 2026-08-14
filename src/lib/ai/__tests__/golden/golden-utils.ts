/**
 * @file golden-utils.ts
 * @description Golden test utilities for AI tool testing
 *
 * Golden tests compare actual outputs against saved "golden" files.
 * This enables deterministic testing of AI tool responses.
 *
 * Usage:
 * - Run tests normally: `npm test`
 * - Update golden files: `UPDATE_GOLDEN=true npm test`
 *
 * @author Radarist Team
 * @created 2025-01-07
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

// ============================================================================
// Types
// ============================================================================

/**
 * Result of a golden test comparison.
 */
export interface GoldenComparisonResult {
  matches: boolean;
  expected: unknown;
  actual: unknown;
  diff?: string[];
}

/**
 * Golden test case definition.
 */
export interface GoldenTestCase<TInput, TOutput> {
  name: string;
  description?: string;
  input: TInput;
  expectedOutput: TOutput;
}

// ============================================================================
// Golden File Operations
// ============================================================================

/**
 * Resolves the path to a golden file.
 */
export function getGoldenPath(category: string, filename: string): string {
  return join(__dirname, "data", category, `${filename}.golden.json`);
}

/**
 * Loads a golden file. Returns null if file doesn't exist.
 */
export function loadGoldenFile<T>(
  category: string,
  filename: string
): T | null {
  const path = getGoldenPath(category, filename);

  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content) as T;
  } catch (error) {
    console.error(`Failed to load golden file: ${path}`, error);
    return null;
  }
}

/**
 * Saves a golden file.
 */
export function saveGoldenFile(
  category: string,
  filename: string,
  data: unknown
): void {
  const path = getGoldenPath(category, filename);
  const dir = dirname(path);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
  console.log(`✓ Updated golden file: ${path}`);
}

/**
 * Checks if golden file updates are enabled.
 */
export function shouldUpdateGolden(): boolean {
  return process.env.UPDATE_GOLDEN === "true";
}

// ============================================================================
// Comparison Utilities
// ============================================================================

/**
 * Deep compares two values and returns differences.
 */
export function deepCompare(
  expected: unknown,
  actual: unknown,
  path: string = ""
): string[] {
  const diffs: string[] = [];

  // Handle null/undefined
  if (expected === null || expected === undefined) {
    if (actual !== expected) {
      diffs.push(`${path}: expected ${expected}, got ${actual}`);
    }
    return diffs;
  }

  // Type mismatch
  if (typeof expected !== typeof actual) {
    diffs.push(`${path}: type mismatch (expected ${typeof expected}, got ${typeof actual})`);
    return diffs;
  }

  // Primitives
  if (typeof expected !== "object") {
    if (expected !== actual) {
      diffs.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
    return diffs;
  }

  // Arrays
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      diffs.push(`${path}: expected array, got ${typeof actual}`);
      return diffs;
    }

    if (expected.length !== (actual as unknown[]).length) {
      diffs.push(`${path}: array length mismatch (expected ${expected.length}, got ${(actual as unknown[]).length})`);
    }

    const maxLen = Math.max(expected.length, (actual as unknown[]).length);
    for (let i = 0; i < maxLen; i++) {
      diffs.push(
        ...deepCompare(expected[i], (actual as unknown[])[i], `${path}[${i}]`)
      );
    }
    return diffs;
  }

  // Objects
  const expectedObj = expected as Record<string, unknown>;
  const actualObj = actual as Record<string, unknown>;

  const allKeys = new Set([
    ...Object.keys(expectedObj),
    ...Object.keys(actualObj),
  ]);

  for (const key of allKeys) {
    const newPath = path ? `${path}.${key}` : key;

    if (!(key in expectedObj)) {
      diffs.push(`${newPath}: unexpected key in actual`);
      continue;
    }

    if (!(key in actualObj)) {
      diffs.push(`${newPath}: missing key in actual`);
      continue;
    }

    diffs.push(...deepCompare(expectedObj[key], actualObj[key], newPath));
  }

  return diffs;
}

/**
 * Compares actual output against golden file.
 */
export function compareWithGolden<T>(
  category: string,
  filename: string,
  actual: T
): GoldenComparisonResult {
  const expected = loadGoldenFile<T>(category, filename);

  if (expected === null) {
    // No golden file exists
    if (shouldUpdateGolden()) {
      saveGoldenFile(category, filename, actual);
      return {
        matches: true,
        expected: actual,
        actual,
      };
    }

    return {
      matches: false,
      expected: null,
      actual,
      diff: [`Golden file not found. Run with UPDATE_GOLDEN=true to create.`],
    };
  }

  const diff = deepCompare(expected, actual);

  if (diff.length > 0 && shouldUpdateGolden()) {
    saveGoldenFile(category, filename, actual);
    return {
      matches: true,
      expected: actual,
      actual,
    };
  }

  return {
    matches: diff.length === 0,
    expected,
    actual,
    diff: diff.length > 0 ? diff : undefined,
  };
}

// ============================================================================
// Jest Matchers
// ============================================================================

/**
 * Custom Jest matcher for golden file comparison.
 *
 * Usage in test:
 * ```typescript
 * expect(actual).toMatchGoldenFile('tools', 'search-entities-basic');
 * ```
 */
export function toMatchGoldenFile(
  actual: unknown,
  category: string,
  filename: string
): jest.CustomMatcherResult {
  const result = compareWithGolden(category, filename, actual);

  if (result.matches) {
    return {
      pass: true,
      message: () => `Expected output not to match golden file ${category}/${filename}`,
    };
  }

  return {
    pass: false,
    message: () => {
      const diffLines = result.diff?.join("\n  ") || "Unknown difference";
      return `Output does not match golden file ${category}/${filename}:\n  ${diffLines}`;
    },
  };
}

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a golden test suite for a set of test cases.
 *
 * Usage:
 * ```typescript
 * runGoldenTests('search-entities', testCases, async (input) => {
 *   return await executeTool({ name: 'searchEntities', args: input });
 * });
 * ```
 */
export async function runGoldenTests<TInput, TOutput>(
  category: string,
  cases: GoldenTestCase<TInput, TOutput>[],
  executor: (input: TInput) => Promise<TOutput>
): Promise<void> {
  for (const testCase of cases) {
    const actual = await executor(testCase.input);
    const result = compareWithGolden(category, testCase.name, actual);

    if (!result.matches) {
      throw new Error(
        `Golden test failed for "${testCase.name}":\n` +
        (result.diff?.join("\n") || "Unknown difference")
      );
    }
  }
}

/**
 * Filters output to only include stable fields for golden comparison.
 * Removes timestamps, IDs, and other non-deterministic values.
 */
export function normalizeForGolden<T extends Record<string, unknown>>(
  data: T,
  options: {
    removeFields?: string[];
    normalizeTimestamps?: boolean;
    normalizeIds?: boolean;
  } = {}
): T {
  const {
    removeFields = [],
    normalizeTimestamps = true,
    normalizeIds = true,
  } = options;

  const result: Record<string, unknown> = { ...data };

  // Remove specified fields
  for (const field of removeFields) {
    delete result[field];
  }

  // Normalize timestamps
  if (normalizeTimestamps) {
    for (const key of Object.keys(result)) {
      if (
        key.endsWith("At") ||
        key.endsWith("Date") ||
        key === "timestamp" ||
        key === "created" ||
        key === "updated"
      ) {
        result[key] = "<TIMESTAMP>";
      }
    }
  }

  // Normalize IDs
  if (normalizeIds) {
    for (const key of Object.keys(result)) {
      if (key === "id" || key.endsWith("Id")) {
        const val = result[key];
        if (typeof val === "string" && val.length > 10) {
          result[key] = "<ID>";
        }
      }
    }
  }

  // Recursively normalize nested objects
  for (const key of Object.keys(result)) {
    if (typeof result[key] === "object" && result[key] !== null) {
      if (Array.isArray(result[key])) {
        result[key] = (result[key] as unknown[]).map((item) =>
          typeof item === "object" && item !== null
            ? normalizeForGolden(item as Record<string, unknown>, options)
            : item
        );
      } else {
        result[key] = normalizeForGolden(
          result[key] as Record<string, unknown>,
          options
        );
      }
    }
  }

  return result as T;
}
