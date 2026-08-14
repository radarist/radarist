/**
 * @file lib/mission-lineage-reconciliation.ts
 * @description ARUN-030 — classify a terminal mission's lineage completeness
 * WITHOUT fabricating success.
 *
 * The row's hard requirement: *"Reconciliation must distinguish truly missing
 * lineage from intentionally non-agent work without fabricating success."*
 *
 * The distinction is load-bearing because the two look identical to a naive
 * counter. Both a `scout` mission and a `build-runtime` mission can terminate with
 * no `AgentReflection` — but only one of those is a defect:
 *
 * - a scout mission has a reflection stage, so a missing reflection is LOST DATA;
 * - the build supervisor has no reflection stage, and a build refused before its
 *   first sandbox session has nothing to reflect on, so a missing reflection is
 *   BY DESIGN.
 *
 * Collapsing them into one "missing lineage: 2" number is how a reconciliation
 * report becomes noise nobody acts on — and worse, how someone eventually
 * "resolves" it by writing the records that are absent, i.e. fabricating a
 * lineage claim. This module reports; it never writes.
 *
 * Pure and dependency-free so it can be unit-tested exhaustively and reused by a
 * script, an API route, or a health gate without dragging in Firestore or Neo4j.
 */

import { isNonAgentRuntime } from '@/lib/build-runtime-identity';
import { isDomainOutcome, type DomainOutcome } from '@/lib/observability/terminal-outcome';

/** What a mission's lineage looks like across the stores, as OBSERVED. */
export interface ObservedMissionLineage {
  missionId: string;
  /** Canonical mission identity. `kind: 'build'` ⇒ the build runtime. */
  kind?: string;
  agent?: string;
  status?: string;
  partial?: boolean;
  /** Number of sandbox sessions a build recorded. Absent for non-build missions. */
  sessions?: number;
  /** Presence of each lineage record. */
  firestoreAgentRun: boolean;
  neo4jEpisode: boolean;
  neo4jReflection: boolean;
  /** The Episode's stamped canonical outcome, when it carries one. */
  episodeOutcome?: unknown;
  /** The Reflection's success claim, when one exists. */
  reflectionSuccess?: boolean;
}

/** Why a lineage record is legitimately absent. */
export type LineageExemption =
  /** Non-agent runtime: the build supervisor has no reflection stage. */
  | 'non-agent-runtime'
  /** Nothing ever ran, so there is nothing to reflect on. */
  | 'no-session-executed'
  /** The mission has not reached a terminal state; lineage is not due yet. */
  | 'not-terminal';

export interface MissionLineageVerdict {
  missionId: string;
  /**
   * - `complete`   — every record this mission is DUE has been observed.
   * - `exempt`     — a record is absent, and legitimately so. Reported, not counted
   *                  as a defect.
   * - `incomplete` — a record this mission is due is genuinely missing.
   * - `divergent`  — every record exists but they DISAGREE about the outcome. The
   *                  worst state, and the one GRAPH-030 exists to prevent: a
   *                  reader consulting two stores gets two answers.
   */
  verdict: 'complete' | 'exempt' | 'incomplete' | 'divergent';
  /** Records that are due and missing. Empty unless `incomplete`. */
  missing: Array<'firestoreAgentRun' | 'neo4jEpisode' | 'neo4jReflection'>;
  /** Records legitimately absent, with the reason. */
  exemptions: Array<{ record: 'neo4jReflection'; reason: LineageExemption }>;
  /** Specific outcome disagreements. Empty unless `divergent`. */
  divergences: string[];
  /** The canonical outcome the mission's own fields imply, when terminal. */
  canonicalOutcome?: DomainOutcome;
}

const TERMINAL_MISSION_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * Classify one mission's lineage.
 *
 * Never writes, never repairs, and never upgrades a verdict on the strength of a
 * guess: an absent record is either DUE (→ `incomplete`) or EXEMPT (→ reported with
 * its reason). There is no third branch in which it becomes acceptable silently.
 */
export function classifyMissionLineage(observed: ObservedMissionLineage): MissionLineageVerdict {
  const verdict: MissionLineageVerdict = {
    missionId: observed.missionId,
    verdict: 'complete',
    missing: [],
    exemptions: [],
    divergences: [],
  };

  // A non-terminal mission owes nothing yet. Reporting its absent lineage as a
  // defect would make every in-flight run look broken.
  if (!TERMINAL_MISSION_STATUSES.has(observed.status ?? '')) {
    verdict.verdict = 'exempt';
    verdict.exemptions.push({ record: 'neo4jReflection', reason: 'not-terminal' });
    return verdict;
  }

  const canonicalOutcome = canonicalOutcomeFor(observed);
  if (canonicalOutcome) verdict.canonicalOutcome = canonicalOutcome;

  // ── Records every terminal mission owes ──────────────────────────────────
  if (!observed.firestoreAgentRun) verdict.missing.push('firestoreAgentRun');
  if (!observed.neo4jEpisode) verdict.missing.push('neo4jEpisode');

  // ── The reflection, which is conditional ─────────────────────────────────
  if (!observed.neo4jReflection) {
    const exemption = reflectionExemption(observed);
    if (exemption) verdict.exemptions.push({ record: 'neo4jReflection', reason: exemption });
    else verdict.missing.push('neo4jReflection');
  }

  // ── Cross-store agreement (GRAPH-030) ────────────────────────────────────
  // Checked even when something is missing, because a divergence among the records
  // that DO exist is still the most actionable finding.
  if (canonicalOutcome && observed.neo4jEpisode && isDomainOutcome(observed.episodeOutcome)) {
    if (observed.episodeOutcome !== canonicalOutcome) {
      verdict.divergences.push(
        `Episode outcome '${observed.episodeOutcome}' disagrees with the canonical '${canonicalOutcome}'`
      );
    }
  }
  if (canonicalOutcome && observed.neo4jReflection && observed.reflectionSuccess !== undefined) {
    const expected = canonicalOutcome === 'success' || canonicalOutcome === 'partial';
    if (observed.reflectionSuccess !== expected) {
      verdict.divergences.push(
        `Reflection success=${observed.reflectionSuccess} disagrees with the canonical '${canonicalOutcome}'`
      );
    }
  }

  // Precedence: a divergence outranks incompleteness. Two stores that confidently
  // disagree actively mislead a reader, whereas a missing record merely withholds.
  if (verdict.divergences.length > 0) verdict.verdict = 'divergent';
  else if (verdict.missing.length > 0) verdict.verdict = 'incomplete';
  else if (verdict.exemptions.length > 0) verdict.verdict = 'exempt';
  else verdict.verdict = 'complete';

  return verdict;
}

/**
 * Why a missing reflection is legitimate, or `undefined` when it is a real gap.
 *
 * Order matters: the runtime check comes first because it is a property of the
 * mission KIND, and holds regardless of how many sessions ran.
 */
function reflectionExemption(observed: ObservedMissionLineage): LineageExemption | undefined {
  if (observed.kind === 'build' || isNonAgentRuntime(observed.agent)) return 'non-agent-runtime';
  if (observed.sessions === 0) return 'no-session-executed';
  return undefined;
}

/** The canonical outcome implied by the mission's own persisted fields. */
function canonicalOutcomeFor(observed: ObservedMissionLineage): DomainOutcome | undefined {
  if (observed.partial === true) return 'partial';
  switch (observed.status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return undefined;
  }
}

export interface MissionLineageReport {
  inspected: number;
  complete: number;
  exempt: number;
  incomplete: number;
  divergent: number;
  /** The verdicts that need action, most severe first. */
  actionable: MissionLineageVerdict[];
}

/**
 * Summarise a batch of verdicts.
 *
 * `actionable` carries divergences before incompletenesses, and EXCLUDES exempt
 * rows entirely — the whole point of the classification is that an exempt row is
 * not work. Its count is still reported so the exemption rate stays visible: an
 * unexpectedly large `exempt` figure is itself a signal that the exemption rules
 * are too generous.
 */
export function summarizeMissionLineage(verdicts: readonly MissionLineageVerdict[]): MissionLineageReport {
  const divergent = verdicts.filter((v) => v.verdict === 'divergent');
  const incomplete = verdicts.filter((v) => v.verdict === 'incomplete');
  return {
    inspected: verdicts.length,
    complete: verdicts.filter((v) => v.verdict === 'complete').length,
    exempt: verdicts.filter((v) => v.verdict === 'exempt').length,
    incomplete: incomplete.length,
    divergent: divergent.length,
    actionable: [...divergent, ...incomplete],
  };
}
