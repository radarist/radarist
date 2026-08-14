/**
 * @file no-fossil-confidence-reader.test.ts
 * @description Static gate (Task 17 / B0, lands LAST): fails the suite if any
 * Cypher template literal under the scanned trees reads a raw `.confidence`
 * property without also honouring `effectiveConfidence`/`assertedConfidence`
 * — i.e., a "fossil" reader that was never repointed through the two-field
 * COALESCE chain.
 *
 * Scope: every `.ts` file (tests excluded) under `src/lib/graph`,
 * `src/lib/inngest/functions`, `src/app/api/graph`, plus retained public
 * observability scripts. Only TEMPLATE LITERAL text is scanned — the same
 * surface every writer/reader in this task actually touches Cypher through.
 *
 * Extraction is AST-based (TypeScript compiler), not regex-on-raw-source:
 * a naive backtick-pairing regex breaks on nested template literals (a
 * `${cond ? `a ${b}` : ''}` interpolation) and on backtick-quoted code
 * snippets living inside comments — both of which produced false positives
 * in this exact codebase during development. The TS AST naturally excludes
 * comments (they're trivia, not nodes) and correctly resolves nesting.
 *
 * A "violation" is a raw `.confidence` reference that:
 *   - is NOT part of a SET-style write (`r.confidence = ...`, not `==`) or a
 *     map-literal write (`confidence: $foo`) — those are the legitimate
 *     legacy-mirror writes every B0 writer still performs;
 *   - is NOT A1 vocabulary (`confidencePre100` / `confidenceScaleMigratedAt`)
 *     on the same line — the 0-100 scale-migration's own healing code;
 *   - does NOT have `effectiveConfidence` or `assertedConfidence` anywhere in
 *     the SAME template literal (a multi-line Cypher query that projects
 *     both fields as separate RETURN columns, or ORs both raw fields in one
 *     WHERE clause, is compliant even though any single line doesn't mention
 *     both keywords);
 *   - and is not covered by the ALLOWLIST below.
 */

import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '../../../..');

const SCAN_DIRS = ['src/lib/graph', 'src/lib/inngest/functions', 'src/app/api/graph'];
const SCAN_SCRIPTS = [
  'scripts/graph-benchmark.ts',
  'scripts/graph-health.ts',
];

// ============================================================================
// ALLOWLIST — files with a deliberate, reviewed reason to read raw
// `.confidence` without the two-field COALESCE. Bypasses the WHOLE file
// (the reasons below are file-scoped, not line-scoped); the second test
// below guards against an entry going stale (its pattern silently
// disappearing from the file it was written to protect).
// ============================================================================

interface AllowlistEntry {
  file: string;
  mustMatch: RegExp;
  reason: string;
}

const ALLOWLIST: AllowlistEntry[] = [
  {
    file: 'src/lib/graph/schema-migrations.ts',
    mustMatch: /WITH r\.confidence AS c/,
    reason:
      "A1's 2026-07-05-confidence-scale-0-100 migration (heal passes + census) reads raw r.confidence/c.confidence by design — it's the pre-B0 0-1-vs-0-100 healer, not a B0 reader honouring the two-field split.",
  },
  {
    file: 'scripts/graph-benchmark.ts',
    mustMatch: /r\.confidence IS NOT NULL AND r\.confidence > 0 AND r\.confidence <= 1/,
    reason:
      'The confidence-scale-leak probe intentionally ORs both raw fields across a multi-line WHERE — kept in the allowlist per the B0 design even though the whole-literal check already recognises it as compliant.',
  },
  {
    file: 'src/lib/graph/validation.ts',
    mustMatch: /'r\.confidence'/,
    reason:
      "orderBySchema's enum token — a plain string literal (not a template literal), never reachable by this scan, but the token's continued existence is what cypher-templates.ts's buildQuery maps to the COALESCE expression.",
  },
  {
    file: 'src/lib/graph/proactive-insights.ts',
    mustMatch: /obs\.confidence/,
    reason:
      'obs.confidence is an :Observation node score (0-1 agent-observation confidence) — a different domain entirely from the Relation Write Contract confidence this task governs.',
  },
  {
    file: 'src/lib/graph/dot-connector.ts',
    mustMatch: /obs\.confidence/,
    reason: 'Same :Observation-domain reasoning as proactive-insights.ts.',
  },
];

const ALLOWLISTED_FILES = new Set(ALLOWLIST.map((e) => e.file));

// ============================================================================
// FILE DISCOVERY
// ============================================================================

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...listTsFiles(full));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts')) continue;
    out.push(full);
  }
  return out;
}

function scannedFiles(): string[] {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) files.push(...listTsFiles(path.join(ROOT, dir)));
  for (const script of SCAN_SCRIPTS) files.push(path.join(ROOT, script));
  return files;
}

// ============================================================================
// TEMPLATE-LITERAL EXTRACTION (AST-based — see file header for why)
// ============================================================================

/**
 * Returns the literal-text portions of every template literal in the file
 * (NoSubstitutionTemplateLiteral and TemplateExpression), one string per
 * template. Interpolated expressions (`${...}`) are replaced with a single
 * space — their own text is irrelevant to a Cypher-property-read scan and
 * splicing them out prevents an interpolation boundary from gluing two
 * unrelated identifiers together.
 */
function extractTemplateLiterals(fileName: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const literals: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isNoSubstitutionTemplateLiteral(node)) {
      literals.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const span of node.templateSpans) {
        text += ' ' + span.literal.text;
      }
      literals.push(text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return literals;
}

// ============================================================================
// VIOLATION DETECTION
// ============================================================================

const RAW_CONFIDENCE_READ = /\b[a-zA-Z_]\w*\.confidence\b/;
const WRITE_SET = /\.confidence\s*=(?!=)/; // r.confidence = ... (SET, not ==)
const WRITE_MAP_LITERAL = /confidence\s*:\s*\$/; // { confidence: $foo } map-literal write
const A1_VOCAB = /confidencePre100|confidenceScaleMigratedAt/;
const TWO_FIELD_VOCAB = /effectiveConfidence|assertedConfidence/;

interface Violation {
  relPath: string;
  line: string;
}

function findViolations(): Violation[] {
  const violations: Violation[] = [];

  for (const file of scannedFiles()) {
    const relPath = path.relative(ROOT, file).split(path.sep).join('/');
    if (ALLOWLISTED_FILES.has(relPath)) continue;

    const source = fs.readFileSync(file, 'utf8');
    const literals = extractTemplateLiterals(file, source);

    for (const literal of literals) {
      const literalIsCompliant = TWO_FIELD_VOCAB.test(literal);
      for (const line of literal.split('\n')) {
        if (!RAW_CONFIDENCE_READ.test(line)) continue;
        if (WRITE_SET.test(line) || WRITE_MAP_LITERAL.test(line)) continue;
        if (A1_VOCAB.test(line)) continue;
        if (literalIsCompliant) continue;
        violations.push({ relPath, line: line.trim() });
      }
    }
  }

  return violations;
}

// ============================================================================
// TESTS
// ============================================================================

describe('no-fossil confidence-reader static gate (Task 17 B0)', () => {
  it('every raw .confidence read in a Cypher template literal honours effectiveConfidence/assertedConfidence (or is a write, A1 vocabulary, or allowlisted)', () => {
    const violations = findViolations();
    if (violations.length > 0) {
      const report = violations.map((v) => `  ${v.relPath}: ${v.line}`).join('\n');
      throw new Error(
        `Found ${violations.length} confidence-reader fossil(s) not repointed through the two-field COALESCE:\n${report}`
      );
    }
    expect(violations).toEqual([]);
  });

  it('every allowlist entry still matches its file (no stale allowlist)', () => {
    const stale: string[] = [];
    for (const entry of ALLOWLIST) {
      const fullPath = path.join(ROOT, entry.file);
      let source: string;
      try {
        source = fs.readFileSync(fullPath, 'utf8');
      } catch {
        stale.push(`${entry.file}: file no longer exists`);
        continue;
      }
      if (!entry.mustMatch.test(source)) {
        stale.push(`${entry.file}: mustMatch ${entry.mustMatch} no longer found`);
      }
    }
    expect(stale).toEqual([]);
  });
});
