/**
 * @file AIContextProvider.pagetype.test.ts
 * @description AI-001 — table-driven route→AIPageType contract for
 * getPageTypeFromPath.
 *
 * The table below hardcodes ALL 42 page routes under src/app (excluding
 * /api). It is split by intent:
 *
 *   - MOUNTED_ROUTES: pages rendered inside AppLayoutV2/SmartLayout, where
 *     the AI Assistant is mounted. Each must classify to its deliberate
 *     AIPageType — never the 'dashboard' fallback (except /dashboard itself).
 *   - UNMOUNTED_ROUTES: redirect shims and public pages that never render
 *     the assistant. No classification is asserted for them — the table only
 *     pins that they are deliberately excluded from the mounted set.
 *
 * The filesystem-walking gate that keeps this inventory honest against new
 * routes is assistant-route-coverage.test.ts (AI-004); this file pins the
 * expected type per known route.
 */

// getPageTypeFromPath is pure, but importing the provider module pulls in
// next/navigation and the zustand ai-store — mock both so the import stays
// side-effect free.
jest.mock('next/navigation', () => ({ usePathname: jest.fn() }));
jest.mock('@/stores/ai-store', () => ({ useAIStore: jest.fn() }));

import { getPageTypeFromPath } from '../AIContextProvider';
import type { AIPageType } from '@/types/ai-assistant';

interface MountedRoute {
  path: string;
  expected: AIPageType;
}

/** Assistant-mounted routes (AppLayoutV2/SmartLayout) — 30 of the 42 pages. */
const MOUNTED_ROUTES: MountedRoute[] = [
  { path: '/dashboard', expected: 'dashboard' },
  // Radar (and its /visualizations alias, which re-exports the radar page)
  { path: '/radar', expected: 'radar' },
  { path: '/visualizations/radar', expected: 'radar' },
  // AI-001 — knowledge graph explorer
  { path: '/visualizations/graph', expected: 'knowledge-graph' },
  // AI-001 — output catalogs (detail routes share the list's type)
  { path: '/reports', expected: 'reports' },
  { path: '/reports/rep_123', expected: 'reports' },
  { path: '/artifacts', expected: 'artifacts' },
  { path: '/artifacts/art_123', expected: 'artifacts' },
  { path: '/infographics', expected: 'infographics' },
  { path: '/infographics/vis_123', expected: 'infographics' },
  // AI-001 — triage lanes with dedicated types
  { path: '/triage/assessment', expected: 'assessment-triage' },
  { path: '/triage/assessment/asm_123', expected: 'assessment-triage' },
  { path: '/triage/insights', expected: 'insights' },
  { path: '/triage/insights/ins_123', expected: 'insights' },
  // Pre-existing triage classifications
  { path: '/triage/signals', expected: 'signal-triage' },
  { path: '/triage/signals/sig_123', expected: 'signal-triage' },
  // Deliberate: /triage/relations keeps the relations-graph type (out of AI-001 scope)
  { path: '/triage/relations', expected: 'relations-graph' },
  // Agent run history
  { path: '/agents/runs', expected: 'agents' },
  { path: '/agents/runs/run_123', expected: 'agents' },
  // Library hub + entity lists
  { path: '/library', expected: 'library' },
  { path: '/library/companies', expected: 'entity-list' },
  { path: '/library/documents', expected: 'entity-list' },
  { path: '/library/initiatives', expected: 'entity-list' },
  { path: '/library/org-units', expected: 'entity-list' },
  { path: '/library/pain-points', expected: 'entity-list' },
  { path: '/library/prototypes', expected: 'entity-list' },
  { path: '/library/strategies', expected: 'entity-list' },
  { path: '/library/technologies', expected: 'entity-list' },
  { path: '/library/use-cases', expected: 'entity-list' },
  { path: '/settings', expected: 'settings' },
];

/**
 * Routes where the AI Assistant is NOT mounted — redirect shims and public
 * pages render outside AppLayoutV2/SmartLayout, so getPageTypeFromPath is
 * never called for them in production. Listed (not asserted) so the 42-route
 * inventory is complete and the exclusion is explicit.
 */
const UNMOUNTED_ROUTES: Array<{ path: string; reason: string }> = [
  { path: '/agents/assessment', reason: 'redirect shim → /triage/assessment' },
  { path: '/agents/linker', reason: 'redirect shim → /triage/relations' },
  { path: '/agents/signals', reason: 'redirect shim → /triage/signals' },
  { path: '/agents/signals/sig_123', reason: 'redirect shim → /triage/signals/[id]' },
  { path: '/briefing', reason: 'redirect shim → /triage/insights' },
  { path: '/briefing/ins_123', reason: 'redirect shim → /triage/insights/[id]' },
  { path: '/triage/entities', reason: 'redirect shim → /triage/assessment' },
  { path: '/login', reason: 'public page — no assistant layout' },
  { path: '/signup', reason: 'public page — no assistant layout' },
  { path: '/share/rad_123', reason: 'public share page — no assistant layout' },
  { path: '/share/report/rep_123', reason: 'public share page — no assistant layout' },
  { path: '/share/visualization/vis_123', reason: 'public share page — no assistant layout' },
];

describe('getPageTypeFromPath — dynamic-segment traps (adversarial #1)', () => {
  it('a slug/id CONTAINING a catalog word never shadows the owning surface', () => {
    expect(getPageTypeFromPath('/library/companies/reports-r-us')).toBe('entity-detail');
    expect(getPageTypeFromPath('/triage/signals/reportsXk9abc')).toBe('signal-triage');
    expect(getPageTypeFromPath('/library/companies/artifacts-inc')).toBe('entity-detail');
  });

  it('catalog list + detail routes still classify (segment-anchored)', () => {
    expect(getPageTypeFromPath('/reports')).toBe('reports');
    expect(getPageTypeFromPath('/reports/rep-123')).toBe('reports');
    expect(getPageTypeFromPath('/artifacts/m-9')).toBe('artifacts');
    expect(getPageTypeFromPath('/infographics/viz-1')).toBe('infographics');
  });
});

describe('getPageTypeFromPath — mounted route classification (AI-001)', () => {
  it.each(MOUNTED_ROUTES)('classifies $path as $expected', ({ path, expected }) => {
    expect(getPageTypeFromPath(path)).toBe(expected);
  });

  it('never falls back to dashboard for any mounted route except /dashboard', () => {
    const fallbacks = MOUNTED_ROUTES.filter(
      (r) => getPageTypeFromPath(r.path) === 'dashboard' && r.path !== '/dashboard'
    ).map((r) => r.path);
    expect(fallbacks).toEqual([]);
  });

  it('classifies the root path (next.config.ts redirects / → /dashboard) as dashboard', () => {
    expect(getPageTypeFromPath('/')).toBe('dashboard');
  });
});

describe('route inventory — table stays complete and unambiguous', () => {
  it('covers all 42 page routes exactly once (30 mounted + 12 unmounted)', () => {
    expect(MOUNTED_ROUTES).toHaveLength(30);
    expect(UNMOUNTED_ROUTES).toHaveLength(12);
    const all = [...MOUNTED_ROUTES.map((r) => r.path), ...UNMOUNTED_ROUTES.map((r) => r.path)];
    expect(new Set(all).size).toBe(42);
  });

  it('keeps the mounted and unmounted sets disjoint', () => {
    const mounted = new Set(MOUNTED_ROUTES.map((r) => r.path));
    const overlap = UNMOUNTED_ROUTES.filter((r) => mounted.has(r.path)).map((r) => r.path);
    expect(overlap).toEqual([]);
  });
});
