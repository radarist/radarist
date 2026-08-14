/**
 * @file lib/ai/page-context.ts
 * @description Pure pathname → AIPageType classifier (AI-006).
 *
 * Extracted from AIContextProvider.tsx so non-React consumers — the
 * capability-catalog generator's "Assistant surface" section and the
 * assistant-route-coverage gate — can classify routes without importing a
 * 'use client' module. AIContextProvider re-exports this function, so the
 * provider remains the ergonomic import site for React code; THIS module is
 * the single source of truth for the classification.
 */

import type { AIPageType } from '@/types/ai-assistant';

/**
 * Extracts page type from pathname.
 *
 * Exported for tests (AI-001): the route→type table test and the
 * assistant-route-coverage gate both exercise this classifier directly.
 */
export function getPageTypeFromPath(pathname: string): AIPageType {
  // Dashboard
  if (pathname === '/' || pathname === '/dashboard') {
    return 'dashboard';
  }

  // Triage lanes with dedicated types (AI-001) — matched before the broader
  // '/relations' / '/signals' checks below so they can't be shadowed.
  if (pathname.includes('/triage/assessment')) {
    return 'assessment-triage';
  }
  if (pathname.includes('/triage/insights')) {
    return 'insights';
  }

  // Knowledge-graph explorer (AI-001) — matched on the full '/visualizations/graph'
  // segment (never bare 'graph', which would collide with '/infographics') and
  // before the '/radar' check so the sibling /visualizations/radar stays 'radar'.
  if (pathname.includes('/visualizations/graph')) {
    return 'knowledge-graph';
  }

  // Output catalogs (AI-001) — list + detail routes share one type.
  // Segment-anchored (not includes): these branches sit ahead of the legacy
  // chain, and a dynamic id/slug containing the word (e.g.
  // /library/companies/reports-r-us) must NOT be shadowed into a catalog type.
  if (/^\/reports(\/|$)/.test(pathname)) {
    return 'reports';
  }
  if (/^\/artifacts(\/|$)/.test(pathname)) {
    return 'artifacts';
  }
  if (/^\/infographics(\/|$)/.test(pathname)) {
    return 'infographics';
  }

  // Radar
  if (pathname.includes('/radar')) {
    return 'radar';
  }

  // Relations graph — deliberately also matches /triage/relations (out of scope for AI-001).
  if (pathname.includes('/relations')) {
    return 'relations-graph';
  }

  // Agents - check specific routes first
  if (pathname.includes('/agents')) {
    if (pathname.includes('/agents/create')) {
      return 'agent-create';
    }
    if (pathname.includes('/agents/signals')) {
      return 'signals'; // Signal triage under agents
    }
    if (pathname.includes('/agents/monitor')) {
      return 'agent-monitor';
    }
    if (pathname.includes('/agents/settings')) {
      return 'agent-settings';
    }
    return 'agents';
  }

  // Signals - canonical route is /triage/signals; this also matches nested signal pages
  // (the /agents/signals branch above is legacy and now server-redirects to /triage)
  if (pathname.includes('/signals')) {
    if (pathname.includes('/triage')) {
      return 'signal-triage';
    }
    return 'signals';
  }

  // Settings
  if (pathname.includes('/settings')) {
    return 'settings';
  }

  // Library pages - check for entity detail vs list
  if (pathname.includes('/library')) {
    // Check if viewing a specific entity
    const parts = pathname.split('/');
    // /library/companies/[id] pattern
    if (parts.length >= 4 && parts[3]) {
      return 'entity-detail';
    }
    // /library/companies pattern
    if (parts.length >= 3) {
      return 'entity-list';
    }
    return 'library';
  }

  // Default to dashboard for unknown pages
  return 'dashboard';
}
