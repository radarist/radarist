/**
 * @file assistant-route-coverage.test.ts
 * @description AI-004 — CI gate: no page route may silently fall back to the
 * 'dashboard' AI page type.
 *
 * Modelled on src/lib/inngest/__tests__/event-contract.test.ts: statically
 * walks every src/app page.tsx (excluding /api), buckets each route as
 *
 *   - redirect shim  — the page body calls `redirect(...)`; never renders,
 *     so the assistant never sees its pathname;
 *   - assistant-mounted — the page (or the module it re-exports, e.g.
 *     /visualizations/radar → /radar) imports AppLayoutV2/SmartLayout;
 *   - public/unmounted — neither of the above; must be on the commented
 *     PUBLIC_UNMOUNTED allowlist, otherwise the test fails (a new page must
 *     either mount the assistant layout or be explicitly allowlisted);
 *
 * and FAILS if any assistant-mounted route's pathname classifies to
 * 'dashboard' via getPageTypeFromPath unless it is literally /dashboard.
 * Adding a future route without a deliberate AIPageType branch breaks CI here.
 */

import * as fs from 'fs';
import * as path from 'path';

// getPageTypeFromPath is pure; mock the provider module's runtime deps so the
// import has no side effects (same pattern as AIContextProvider.pagetype.test.ts).
jest.mock('next/navigation', () => ({ usePathname: jest.fn(), redirect: jest.fn() }));
jest.mock('@/stores/ai-store', () => ({ useAIStore: jest.fn() }));

import { getPageTypeFromPath } from '../AIContextProvider';
import { concretePath, scanRouteInventory, type RouteBuckets } from '@/lib/ai/route-inventory';

// ---------------------------------------------------------------------------
// Allowlists — every entry needs a justification comment.
// ---------------------------------------------------------------------------

/**
 * Pages that deliberately do NOT mount the assistant layout. A page that is
 * neither a redirect shim nor assistant-mounted must appear here, or the
 * test fails — forcing an explicit decision for every new public page.
 */
const PUBLIC_UNMOUNTED = new Set<string>([
  '/login', // public auth page — renders outside AppLayoutV2
  '/signup', // public auth page — renders outside AppLayoutV2
  '/share/[radarId]', // public share surface — no app chrome, no assistant
  '/share/report/[id]', // public share surface — no app chrome, no assistant
  '/share/visualization/[id]', // public share surface — no app chrome, no assistant
]);

/**
 * Route-level redirects declared in next.config.ts (async redirects()).
 * Hardcoded here because next.config.ts is not importable from Jest; kept in
 * sync manually — these sources have no page.tsx today, so they only matter
 * as documentation of why e.g. '/' never renders a page.
 */
const NEXT_CONFIG_REDIRECT_SOURCES = new Set<string>([
  '/', // → /dashboard
  '/signals', // → /triage/signals
  '/library/signals', // → /triage/signals
  '/agents', // → /agents/runs
  '/triage', // → /triage/signals
  '/visualizations', // → /visualizations/radar
]);

// ---------------------------------------------------------------------------
// Static scanner — shared with the capability-catalog generator (AI-006).
// The walker lives in src/lib/ai/route-inventory.ts so this gate and the
// generator's "Assistant surface" section can never fork; this test keeps only
// the gate POLICY (allowlists + assertions).
// ---------------------------------------------------------------------------

const SRC_ROOT = path.resolve(__dirname, '..', '..'); // <repo>/src

function scan(): RouteBuckets {
  return scanRouteInventory(SRC_ROOT);
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

describe('assistant route coverage gate (repo-wide static scan, AI-004)', () => {
  const buckets = scan();

  it('sanity: the scanner sees a non-trivial route surface', () => {
    // Guards against a silent scanner regression (wrong root, bad regex)
    // that would make the gate below pass vacuously.
    expect(buckets.mounted.length).toBeGreaterThanOrEqual(25);
    expect(buckets.shims.length).toBeGreaterThanOrEqual(5);
    expect(buckets.mounted).toContain('/dashboard');
    expect(buckets.mounted).toContain('/visualizations/radar'); // re-export followed
    expect(buckets.shims).toContain('/briefing');
    // The config redirect list documents sources without page files — none of
    // them may grow a page.tsx without revisiting this gate.
    const all = [...buckets.mounted, ...buckets.shims, ...buckets.unmounted];
    const collisions = all.filter((r) => NEXT_CONFIG_REDIRECT_SOURCES.has(r));
    expect(collisions).toEqual([]);
  });

  it('every non-mounted, non-shim page is on the commented PUBLIC_UNMOUNTED allowlist', () => {
    const unexplained = buckets.unmounted.filter((r) => !PUBLIC_UNMOUNTED.has(r)).sort();
    expect(unexplained).toEqual([]);
  });

  it('allowlist stays honest: no stale PUBLIC_UNMOUNTED entries', () => {
    const present = new Set(buckets.unmounted);
    const stale = [...PUBLIC_UNMOUNTED].filter((r) => !present.has(r)).sort();
    expect(stale).toEqual([]);
  });

  it('hardcoded next.config.ts redirect list stays honest (no drift either direction)', () => {
    const configSource = fs.readFileSync(path.join(process.cwd(), 'next.config.ts'), 'utf8');
    for (const source of NEXT_CONFIG_REDIRECT_SOURCES) {
      expect(configSource).toContain(`'${source}'`);
    }
    // reverse direction: every source inside the redirects() block is in our
    // list. Scope to that block — headers()/rewrites() also declare source:.
    const redirectsBlock = configSource.slice(configSource.indexOf('async redirects()'));
    const declared = [...redirectsBlock.matchAll(/source:\s*'([^']+)'/g)].map((m) => m[1]);
    const missing = declared.filter((s) => !NEXT_CONFIG_REDIRECT_SOURCES.has(s)).sort();
    expect(missing).toEqual([]);
  });

  it('no assistant-mounted route classifies to the dashboard fallback (except /dashboard)', () => {
    const fallbacks = buckets.mounted
      .filter((route) => route !== '/dashboard')
      .filter((route) => getPageTypeFromPath(concretePath(route)) === 'dashboard')
      .sort();
    expect(fallbacks).toEqual([]);
  });
});
