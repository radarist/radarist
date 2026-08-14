/**
 * @file signal-source-defaults.ts
 * @description Canonical default enablement for the six external signal
 * sources. PURE module — zero imports — so it is safe to use anywhere:
 * client components, Inngest workers (no firebase client-SDK chain), and
 * standalone tsx scripts.
 *
 * Single source of truth consumed by:
 * - `src/lib/system-config.ts` — DEFAULT_CONFIG.signalDetection.sources
 * - `src/lib/inngest/functions/fetch-signals.ts` — missing-config fallback
 * - `src/lib/inngest/functions/daily-pipeline.ts` — missing-config fallback
 * - `scripts/seed-emulator.ts` — seeded system-config document
 *
 * Before this module existed each site hand-rolled its own copy and they
 * drifted (the Inngest fallbacks enabled `funding`, which requires a paid
 * API; the emulator seed disabled `trends`). Keep all changes here.
 */

/** Shape mirrors `SignalDetectionConfig['sources']` (src/lib/types/agents.ts). */
export interface SignalSourceDefaults {
  patents: boolean;
  papers: boolean;
  news: boolean;
  funding: boolean;
  github: boolean;
  trends: boolean;
  hackernews: boolean;
  sec: boolean;
}

/**
 * Default per-source enablement for signal detection.
 * Spread into config objects (`{ ...DEFAULT_SIGNAL_SOURCES }`) — the object
 * is frozen so accidental in-place mutation throws in strict mode.
 */
export const DEFAULT_SIGNAL_SOURCES: Readonly<SignalSourceDefaults> = Object.freeze({
  // PatentsView legacy endpoint (api.patentsview.org) retired — every fetch
  // fails. Disabled until the search.patentsview.org migration lands.
  // See docs/LIMITATIONS.md.
  patents: false,
  papers: true,
  news: true,
  funding: false, // Requires paid API, disabled by default
  github: true,
  trends: false, // No fetcher is registered yet; enabling it would be inert
  hackernews: true, // Keyless HN Algolia — default ON
  sec: false, // SEC EDGAR — specialized, opt-in (default OFF)
});
