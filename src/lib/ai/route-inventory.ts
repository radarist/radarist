/**
 * @file lib/ai/route-inventory.ts
 * @description Shared static route walker (AI-006). Node-only (uses fs).
 *
 * Walks every `src/app/**‍/page.tsx` (excluding /api) and buckets each route:
 *
 *   - redirect shim  — the page body calls `redirect(...)`; never renders,
 *     so the assistant never sees its pathname;
 *   - assistant-mounted — the page (or the module it re-exports, e.g.
 *     /visualizations/radar → /radar) imports AppLayoutV2/SmartLayout;
 *   - public/unmounted — neither of the above.
 *
 * Consumed by BOTH the assistant-route-coverage CI gate
 * (src/contexts/__tests__/assistant-route-coverage.test.ts) and the
 * capability-catalog generator's "Assistant surface" section
 * (scripts/generate-capability-catalog.ts) so the two can never fork.
 * Do NOT import from client/runtime code — this module reads the filesystem.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface RouteBuckets {
  /** Routes whose page mounts the assistant layout (AppLayoutV2/SmartLayout). */
  mounted: string[];
  /** Redirect shims — the page body only calls redirect(). */
  shims: string[];
  /** Neither mounted nor a shim (public/unmounted pages). */
  unmounted: string[];
}

function walkPages(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'api' || entry.name === 'node_modules') continue;
      walkPages(full, out);
    } else if (entry.name === 'page.tsx') {
      out.push(full);
    }
  }
  return out;
}

/** Strip block + line comments so docstrings don't count as usage. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/** /abs/.../src/app/reports/[id]/page.tsx → '/reports/[id]' */
function routeOf(appRoot: string, pageFile: string): string {
  const rel = path.relative(appRoot, path.dirname(pageFile));
  return '/' + rel.split(path.sep).join('/').replace(/^\.$/, '');
}

/** Substitute dynamic segments with a concrete sample so includes() sees a real pathname. */
export function concretePath(route: string): string {
  return route.replace(/\[[^\]]+\]/g, 'sample-id');
}

/** True when the page body calls next/navigation's redirect(). */
function isRedirectShim(code: string): boolean {
  return /\bredirect\(/.test(code);
}

/**
 * True when the page mounts the assistant layout. Follows one level of
 * `export { default } from '...'` re-exports (e.g. /visualizations/radar
 * re-exports /radar) before giving up.
 */
function mountsAssistantLayout(
  srcRoot: string,
  pageFile: string,
  code: string,
  assertReadable?: (absolutePath: string) => void
): boolean {
  if (/AppLayoutV2|SmartLayout/.test(code)) return true;
  const reExport = code.match(/export\s*\{\s*default\s*\}\s*from\s*['"]([^'"]+)['"]/);
  if (!reExport) return false;
  const spec = reExport[1];
  const base = spec.startsWith('@/') ? path.join(srcRoot, spec.slice(2)) : path.resolve(path.dirname(pageFile), spec);
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, path.join(base, 'page.tsx')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      assertReadable?.(candidate);
      return /AppLayoutV2|SmartLayout/.test(stripComments(fs.readFileSync(candidate, 'utf8')));
    }
  }
  return false;
}

/**
 * Scan the app tree and bucket every page route.
 *
 * @param srcRoot absolute path to `<repo>/src` (the app tree is `<srcRoot>/app`).
 */
export function scanRouteInventory(
  srcRoot: string,
  assertReadable?: (absolutePath: string) => void
): RouteBuckets {
  const appRoot = path.join(srcRoot, 'app');
  const buckets: RouteBuckets = { mounted: [], shims: [], unmounted: [] };
  for (const pageFile of walkPages(appRoot)) {
    assertReadable?.(pageFile);
    const route = routeOf(appRoot, pageFile);
    const code = stripComments(fs.readFileSync(pageFile, 'utf8'));
    // Mount check FIRST: a page that renders the assistant layout is never a
    // shim, even if it also calls redirect() for an inline auth guard —
    // shim-first bucketing would silently drop it out of the gate.
    if (mountsAssistantLayout(srcRoot, pageFile, code, assertReadable)) {
      buckets.mounted.push(route);
    } else if (isRedirectShim(code)) {
      buckets.shims.push(route);
    } else {
      buckets.unmounted.push(route);
    }
  }
  return buckets;
}
