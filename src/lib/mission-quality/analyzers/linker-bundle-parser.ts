/**
 * @file lib/linker-bundle-parser.ts
 * @description Extract + Zod-parse linker's structured edge bundle.
 */

import { linkerBundleSchema, type LinkerBundle } from '../../schemas/linker-bundle';

const FENCED_JSON_BLOCK_RE = /```json\s*\n([\s\S]*?)\n```/g;

const BUNDLE_MARKER_PATTERNS = [/\bedges\b.*\bevidence\b/i, /\bsourceEntityName\b/i, /\btargetEntityName\b/i];

export type ParseResult = { ok: true; bundle: LinkerBundle } | { ok: false; error: string };

export function containsLinkerBundleMarker(prompt: string): boolean {
  return BUNDLE_MARKER_PATTERNS.some((re) => re.test(prompt));
}

export function parseLinkerBundle(result: string): ParseResult {
  FENCED_JSON_BLOCK_RE.lastIndex = 0;

  let lastBlock: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = FENCED_JSON_BLOCK_RE.exec(result)) !== null) {
    lastBlock = match[1];
  }

  if (lastBlock === null) {
    return { ok: false, error: 'no fenced ```json block in linker output' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(lastBlock);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `linker bundle json parse failed: ${msg}` };
  }

  const zodResult = linkerBundleSchema.safeParse(parsed);
  if (!zodResult.success) {
    const firstIssue = zodResult.error.issues[0];
    const path = firstIssue.path.join('.');
    return {
      ok: false,
      error: `linker bundle schema violation at ${path || '<root>'}: ${firstIssue.message}`,
    };
  }

  return { ok: true, bundle: zodResult.data };
}
