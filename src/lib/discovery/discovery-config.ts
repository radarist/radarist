/**
 * @file discovery/discovery-config.ts
 * @description Single configuration seam for the discovery loop.
 *
 * Pure module — NO side-effecting imports — so it is safe to import at an Inngest
 * function's top level (where service modules would crash). Every field defaults
 * conservatively: the sweep AND the feedback write are both OFF by default
 * (`DISCOVERY_SWEEP_ENABLED` / `DISCOVERY_FEEDBACK_ENABLED`). The feedback flag is
 * separate so M0 can prove the write path with no reader steering (BIAS-FIX-1).
 *
 * Later discovery tasks append fields here rather than scattering env reads;
 * env is read at call time so runtime overrides take effect without a reload.
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** Parse a boolean flag; only the closed truthy-token set counts as true. */
function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return TRUTHY.has(raw.trim().toLowerCase());
}

/** Parse a positive integer; non-numeric or <= 0 falls back to the default. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Parse a float and clamp it into [0, 1]; non-numeric falls back. */
function envFloat01(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/** Parse a non-empty string; blank/undefined falls back. */
function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

/** Parse a comma-separated list; blank/undefined falls back. */
function envList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface DiscoveryConfig {
  /** Master gate — targeting + dispatch only run when true. Default false. */
  enabled: boolean;
  /** Gates ONLY the feedback write so M0 proves the write path with no reader steering. Default false. */
  feedbackEnabled: boolean;
  /** Gates the adjacent-topic discovery keyword lane in signal fetching. Default false; also requires feedbackEnabled (its suppression prerequisite). */
  adjacentDiscoveryEnabled: boolean;
  /** Gates deriving the InterestProfile from exploration (scout route + nightly cron). Default false. */
  deriveInterestEnabled: boolean;
  /** Gates net-new technology discovery (research → pending proposedEntities). Default false. */
  netNewEnabled: boolean;
  /** Max net-new entities proposed per dimension per sweep cycle. */
  maxNetNewPerCycle: number;
  /** Entity dimensions the scout discovers net-new (technology/useCase/painPoint/company). */
  netNewDimensions: string[];
  /**
   * Free-form interest label stored on the InterestProfile node. NB: this is NOT
   * the candidate scope — the selector scopes by `radarId` (joining radarPlacements).
   * Retained only as profile metadata.
   */
  vertical: string;
  /**
   * Radar the discovery selector scopes candidates to (joined via radarPlacements →
   * technologyId). Empty falls back to a config-default / sole radar in the sweep,
   * and the selector topic-ranks the whole collection if still unresolved.
   */
  radarId: string;
  /** Count-cap budget substitute: max evaluations dispatched per sweep cycle. */
  maxDispatchPerCycle: number;
  /** Max useCase (non-technology, secondary dimension) evaluations dispatched per cycle. Kept tiny. */
  maxUseCaseDispatchPerCycle: number;
  /** Skip a cycle when pending proposals already exceed this. */
  pendingProposalsCap: number;
  /** Per-user on-demand "Scout my radar" debounce window. */
  scoutDebounceMs: number;
  /** Source-rotation cap: max share of a dispatched cycle from one source. */
  maxSourceShare: number;
  /** Per-dimension cap: max share of a dispatched cycle from one entity type. */
  maxEntityTypeShare: number;
  /** MMR relevance/diversity tradeoff (1 = pure relevance, 0 = pure diversity). */
  mmrLambda: number;
  /** Cosine threshold above which two candidates are treated as duplicates. */
  dedupSimilarityThreshold: number;
  /** Exploration weight that keeps under-explored topics visible (anti-bias). */
  explorationRate: number;
  /** Min path confidence (hop1*hop2) for a 2-hop transitive candidate to survive. */
  twoHopConfidenceFloor: number;
  /**
   * Increment 2 (C4) — gates whether `syncRelationAsAssertion` resolves a
   * per-asserter reliability bonus and passes it into
   * `shouldMaterializeAssertion`'s gate check. Default false: flag off (or a
   * reliability read failure) always resolves to bonus 0, a byte-identical
   * baseline. Distinct from `feedbackEnabled`, which gates the OUTCOME WRITE
   * (`recordAsserterOutcome`) in the triage route — outcomes can accrue
   * while this flag is off; this flag only controls whether the accrued
   * history is consumed to shift the gate.
   */
  asserterReliabilityEnabled: boolean;
}

/** Resolve the discovery configuration from the environment (call-time). */
export function getDiscoveryConfig(): DiscoveryConfig {
  return {
    enabled: envFlag('DISCOVERY_SWEEP_ENABLED', false),
    feedbackEnabled: envFlag('DISCOVERY_FEEDBACK_ENABLED', false),
    adjacentDiscoveryEnabled: envFlag('DISCOVERY_ADJACENT_KEYWORDS', false),
    deriveInterestEnabled: envFlag('DISCOVERY_DERIVE_INTEREST', false),
    netNewEnabled: envFlag('DISCOVERY_NETNEW_ENABLED', false),
    maxNetNewPerCycle: envInt('DISCOVERY_MAX_NETNEW_PER_CYCLE', 3),
    netNewDimensions: envList('DISCOVERY_NETNEW_DIMENSIONS', ['technology', 'useCase', 'painPoint', 'company']),
    vertical: envString('DISCOVERY_VERTICAL', 'ai-ml-infra'),
    radarId: envString('DISCOVERY_RADAR_ID', ''),
    maxDispatchPerCycle: envInt('DISCOVERY_MAX_DISPATCH_PER_CYCLE', 2),
    maxUseCaseDispatchPerCycle: envInt('DISCOVERY_MAX_USECASE_DISPATCH_PER_CYCLE', 1),
    pendingProposalsCap: envInt('DISCOVERY_PENDING_PROPOSALS_CAP', 30),
    scoutDebounceMs: envInt('DISCOVERY_SCOUT_DEBOUNCE_MS', 4 * 60 * 60 * 1000),
    maxSourceShare: envFloat01('DISCOVERY_MAX_SOURCE_SHARE', 0.4),
    maxEntityTypeShare: envFloat01('DISCOVERY_MAX_ENTITY_TYPE_SHARE', 0.4),
    mmrLambda: envFloat01('DISCOVERY_MMR_LAMBDA', 0.7),
    dedupSimilarityThreshold: envFloat01('DISCOVERY_DEDUP_SIMILARITY_THRESHOLD', 0.85),
    explorationRate: envFloat01('DISCOVERY_EXPLORATION_RATE', 0.15),
    twoHopConfidenceFloor: envFloat01('DISCOVERY_TWO_HOP_CONFIDENCE_FLOOR', 0.6),
    asserterReliabilityEnabled: envFlag('ASSERTER_RELIABILITY_ENABLED', false),
  };
}
