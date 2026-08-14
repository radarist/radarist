/**
 * Redacting support-bundle collector (SEC-013).
 *
 * A secret-bearing runtime trace can sit in a location an operator would sweep
 * into a support bundle. Redacting at the logger protects new writes; this
 * module also protects export, so there is a sanctioned way to package
 * diagnostics that cannot emit a credential even if one reached disk some other
 * way (a third-party tool's log, an older file written before the fix).
 *
 * The contract is fail-closed: every collected file is redacted, then the
 * redacted result is re-scanned, and the bundle is REFUSED if anything
 * credential-shaped survived. A refusal names the file and the finding kind —
 * never the value.
 */
import * as fs from 'fs';
import * as path from 'path';

import { assertRedactedForExport, findSurvivingSecrets, redactText } from '@/lib/redaction';
import type { RedactionOptions, SecretFinding } from '@/lib/redaction';

/** Largest single file included. Beyond this only the tail is collected. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface SupportBundleEntry {
  /** Path as presented in the bundle (relative to the project root when possible). */
  label: string;
  /** Redacted contents. */
  content: string;
  /** Bytes read from disk before redaction. */
  sourceBytes: number;
  /** True when only the tail of an oversized file was collected. */
  truncated: boolean;
}

export interface SupportBundleResult {
  entries: SupportBundleEntry[];
  /** Files that were requested but could not be read, with the reason. */
  skipped: Array<{ label: string; reason: string }>;
}

/** Read the tail of a file, bounded by {@link MAX_FILE_BYTES}. */
function readBounded(filePath: string): { text: string; sourceBytes: number; truncated: boolean } {
  const stat = fs.statSync(filePath);
  if (stat.size <= MAX_FILE_BYTES) {
    return { text: fs.readFileSync(filePath, 'utf-8'), sourceBytes: stat.size, truncated: false };
  }
  const handle = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES);
    fs.readSync(handle, buffer, 0, MAX_FILE_BYTES, stat.size - MAX_FILE_BYTES);
    return { text: buffer.toString('utf-8'), sourceBytes: stat.size, truncated: true };
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * Collect and redact the requested files.
 *
 * A file that cannot be read is recorded in `skipped` rather than throwing: a
 * missing `logs/agent.log` on a fresh checkout must not prevent an operator from
 * bundling everything else.
 */
export function collectSupportBundle(
  filePaths: readonly string[],
  options?: RedactionOptions & { rootDir?: string }
): SupportBundleResult {
  const rootDir = options?.rootDir ?? process.cwd();
  const entries: SupportBundleEntry[] = [];
  const skipped: Array<{ label: string; reason: string }> = [];

  for (const filePath of filePaths) {
    const absolute = path.resolve(rootDir, filePath);
    const label = path.relative(rootDir, absolute) || path.basename(absolute);
    try {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        skipped.push({ label, reason: 'refused: symlink' });
        continue;
      }
      if (!stat.isFile()) {
        skipped.push({ label, reason: 'refused: not a regular file' });
        continue;
      }
      const { text, sourceBytes, truncated } = readBounded(absolute);
      // The file-size bound belongs to this collector, not to `redactText`,
      // whose much smaller default is sized for individual log VALUES. Left at
      // the default it would silently re-truncate — from the FRONT — and drop
      // the newest lines, which are the ones an operator filed the bundle for.
      const content = redactText(text, { ...options, maxStringLength: MAX_FILE_BYTES });
      entries.push({ label, content, sourceBytes, truncated });
    } catch (err) {
      skipped.push({ label, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { entries, skipped };
}

/** Render the bundle as one plain-text document with per-file headers. */
export function renderSupportBundle(result: SupportBundleResult, generatedAt: string): string {
  const lines: string[] = [
    '# Radarist support bundle',
    `# generated: ${generatedAt}`,
    '# Every file below has been redacted (SEC-013) and re-scanned before export.',
    '',
  ];
  for (const entry of result.entries) {
    lines.push(
      `===== ${entry.label} (${entry.sourceBytes} bytes${entry.truncated ? ', tail only' : ''}) =====`,
      entry.content,
      ''
    );
  }
  if (result.skipped.length > 0) {
    lines.push('===== skipped =====');
    for (const item of result.skipped) lines.push(`${item.label}: ${item.reason}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** A per-file view of what survived redaction. Values are never included. */
export interface SupportBundleAudit {
  label: string;
  findings: SecretFinding[];
}

/** Re-scan each redacted entry. An empty result means the bundle is safe. */
export function auditSupportBundle(result: SupportBundleResult, options?: RedactionOptions): SupportBundleAudit[] {
  return result.entries
    .map((entry) => ({ label: entry.label, findings: findSurvivingSecrets(entry.content, options) }))
    .filter((audit) => audit.findings.length > 0);
}

/**
 * Write the bundle, or refuse.
 *
 * The rendered document is asserted clean as a whole — not just per entry — so a
 * credential introduced by the rendering itself (a header, a skipped-file
 * reason) is caught too. On refusal nothing is written.
 */
export function writeSupportBundle(
  result: SupportBundleResult,
  outputPath: string,
  generatedAt: string,
  options?: RedactionOptions
): { outputPath: string; bytes: number } {
  const audits = auditSupportBundle(result, options);
  if (audits.length > 0) {
    const summary = audits
      .map((audit) => `${audit.label} (${audit.findings.map((f) => `${f.kind}×${f.occurrences}`).join(', ')})`)
      .join('; ');
    throw new Error(
      `Refusing to write the support bundle: ${audits.length} file(s) still contain credential-shaped data — ` +
        `${summary}. The values are intentionally not reproduced. Extend the redaction rules in ` +
        `src/lib/redaction.ts before exporting.`
    );
  }

  const document = renderSupportBundle(result, generatedAt);
  assertRedactedForExport(document, path.basename(outputPath), options);

  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, document, { encoding: 'utf-8', mode: 0o600 });
  return { outputPath, bytes: Buffer.byteLength(document, 'utf-8') };
}

/** Diagnostic files an operator normally wants, relative to the project root. */
export const DEFAULT_SUPPORT_FILES: readonly string[] = ['logs/agent.log'];
