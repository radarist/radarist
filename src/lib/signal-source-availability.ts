/**
 * @file signal-source-availability.ts
 * @description Canonical "can this signal source actually produce signals right
 * now?" truth, and the derivation of persisted-vs-effective per-source state
 * used by Settings (SETTINGS-003). PURE module — zero imports beyond the
 * equally-pure `signal-source-defaults` — so it is safe to use in client
 * components, Inngest workers, and standalone scripts.
 *
 * "Available" here means "produces real signals", not merely "has a fetcher":
 * - `patents` has a fetcher but the USPTO PatentsView legacy endpoint is
 *   retired, so every fetch fails permanently (OPS-002) → unavailable.
 * - `funding`/`trends` have no registered fetcher → inert → unavailable.
 * An upgraded store can still persist any of these as enabled; this module lets
 * Settings show the honest effective state and reset to supported defaults.
 */

import { DEFAULT_SIGNAL_SOURCES, type SignalSourceDefaults } from './signal-source-defaults';

export type SignalSourceKey = keyof SignalSourceDefaults;

export interface SourceAvailability {
  /** Human-facing source name for the Settings UI. */
  label: string;
  /** True only when enabling the source produces real signals. */
  available: boolean;
  /** Actionable explanation, shown when the source is unavailable. */
  reason: string;
}

/**
 * The single source of truth for per-source availability. Keys mirror
 * `SignalSourceDefaults` exactly (enforced by a test).
 */
export const SIGNAL_SOURCE_AVAILABILITY: Record<SignalSourceKey, SourceAvailability> = {
  papers: {
    label: 'Research papers',
    available: true,
    reason: 'Keyless research adapter (arXiv and related).',
  },
  news: {
    label: 'News',
    available: true,
    reason: 'Keyless news/RSS adapter.',
  },
  github: {
    label: 'GitHub',
    available: true,
    reason: 'Keyless GitHub REST search (contract-bounded).',
  },
  hackernews: {
    label: 'Hacker News',
    available: true,
    reason: 'Keyless Hacker News (Algolia) adapter.',
  },
  sec: {
    label: 'SEC EDGAR',
    available: true,
    reason: 'Keyless SEC EDGAR adapter (opt-in; off by default).',
  },
  patents: {
    label: 'Patents',
    available: false,
    reason:
      'The USPTO PatentsView legacy endpoint was retired and returns no data. ' +
      'Migrating to the search.patentsview.org API needs a new (free) API key, so the source is unavailable here.',
  },
  funding: {
    label: 'Funding',
    available: false,
    reason: 'Requires a paid API (e.g. Crunchbase/PitchBook) and has no registered fetcher, so it produces no signals.',
  },
  trends: {
    label: 'Trends',
    available: false,
    reason: 'No fetcher is registered, so enabling it is inert and produces no signals.',
  },
};

/** All source keys, in the availability table's declared order (available first). */
export const SIGNAL_SOURCE_KEYS = Object.keys(SIGNAL_SOURCE_AVAILABILITY) as SignalSourceKey[];

export interface EffectiveSourceState {
  source: SignalSourceKey;
  label: string;
  /** What the stored configuration says (with the supported default filled in when absent). */
  persisted: boolean;
  /** Whether the source can actually produce signals right now. */
  available: boolean;
  /** The honest running state: `persisted && available`. */
  effective: boolean;
  /** Present only when the source is unavailable — the actionable reason. */
  reason?: string;
}

type PersistedSources = Partial<Record<SignalSourceKey, boolean>> | undefined | null;

/**
 * Derive the persisted-vs-effective state for every source. A source absent
 * from an older persisted doc falls back to its supported default, so upgraded
 * stores render honestly without a migration.
 */
export function computeEffectiveSourceStates(persisted: PersistedSources): EffectiveSourceState[] {
  const sources = persisted ?? {};
  return SIGNAL_SOURCE_KEYS.map((source) => {
    const availability = SIGNAL_SOURCE_AVAILABILITY[source];
    const persistedOn = sources[source] ?? DEFAULT_SIGNAL_SOURCES[source];
    const effective = persistedOn && availability.available;
    return {
      source,
      label: availability.label,
      persisted: persistedOn,
      available: availability.available,
      effective,
      ...(availability.available ? {} : { reason: availability.reason }),
    };
  });
}

/** Sources the stored config has enabled that cannot actually produce signals. */
export function listEnabledUnavailableSources(persisted: PersistedSources): SignalSourceKey[] {
  return computeEffectiveSourceStates(persisted)
    .filter((s) => s.persisted && !s.available)
    .map((s) => s.source);
}

/** True when at least one enabled source cannot produce signals. */
export function hasEnabledUnavailableSources(persisted: PersistedSources): boolean {
  return listEnabledUnavailableSources(persisted).length > 0;
}

/**
 * The supported-defaults target for the guarded reset: a fresh copy of the
 * canonical defaults (every unavailable source disabled). Pure and idempotent.
 */
export function supportedDefaultSources(): SignalSourceDefaults {
  return { ...DEFAULT_SIGNAL_SOURCES };
}
