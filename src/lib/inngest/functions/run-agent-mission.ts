/**
 * @file lib/inngest/functions/run-agent-mission.ts
 * @description Inngest function that executes an agent mission via the Orchestrator.
 *
 * When a user creates a mission from the UI, the API route fires an
 * 'app/mission.run.requested' event. This function picks it up, runs the
 * Orchestrator, writes an AgentRun record for the Activity page, and
 * updates the mission document with results.
 *
 * Steps:
 * 1. Mark mission as running
 * 1.5. Create Episode for temporal graph tracking (non-blocking)
 * 2. Execute the Orchestrator (dynamically imported)
 * 2.5. Select the canonical result through quality/revision/reflection
 * 2.6. Complete/fail Episode with that canonical result (non-blocking)
 * 3. Write AgentRun record for Activity page
 * 4. Update mission with results
 *
 * On failure (after retries), the onFailure handler updates the mission
 * status to 'failed' so the UI can show the error.
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import path from 'path';
import { createHash } from 'node:crypto';
// pathToFileURL moved to @/lib/agent-import (Task 0.4)
import { inngest } from '../client';
import { createLogger } from '@/lib/logger';
import { redactText } from '@/lib/redaction';
import { updateMission } from '@/lib/missions';
import { declareDomainOutcome } from '@/lib/inngest/domain-outcome';
import { domainOutcomeFromMissionTerminal, type DomainOutcome } from '@/lib/observability/terminal-outcome';
import { preflightMissionMcp, formatMcpPreflightFailure } from '@/lib/mission-mcp-preflight';
import { QUALITY_HALT_THRESHOLD } from '@/lib/mission-chains';
import { missionExecutionEnvelopeSchema, type Mission } from '@/lib/schemas/mission';
import type { EvidenceProvenanceReceipt, ScoutBundle } from '@/lib/schemas/scout-bundle';
import type { MissionQualityTerminalState, QualityReport } from '@/lib/mission-quality';
import type {
  RequiredSkillArtifactEvidence,
  ReviewedArtifactIdentity,
} from '@/lib/mission-quality/required-skill-outputs';
import {
  ceilingCents,
  describeMissionEnvelopeMismatch,
  resolveAgentMissionCostEnvelope,
  resolveEffectiveAgentMissionLimits,
  resolveMissionLimits,
  type AgentMissionCostEnvelope,
  type AgentMissionExecutionEnvelope,
} from '@/lib/mission-limits';

/**
 * COORD-012 — memoized return of the `validate-authorized-cost-envelope`
 * step. `envelopeSource: 'mission'` means the values came verbatim from the
 * user-confirmed envelope persisted on the mission document and are the sole
 * authority for every paid phase. The extension fields are optional so a
 * replay of a pre-COORD-012 in-flight run (whose memoized value carries only
 * the five cost components) keeps its original environment-derived behavior.
 */
interface EffectiveMissionExecution extends AgentMissionCostEnvelope {
  maxToolCalls?: number;
  timeoutMinutes?: number;
  requestedModel?: string;
  authorizedFallbackModel?: string;
  envelopeSource?: 'mission' | 'environment';
}

const log = createLogger('inngest/run-agent-mission');

function reportHtmlSha256(html: string): string {
  return createHash('sha256').update(html, 'utf8').digest('hex');
}

// Default mission timeout in milliseconds — can be overridden per-agent via
// `timeoutMinutes` in the agent's config.yaml (max 120). Env var sets the
// global default; per-agent config takes precedence when present.
const DEFAULT_MISSION_TIMEOUT_MS = parseInt(process.env.MISSION_TIMEOUT_MINUTES || '45', 10) * 60 * 1000;
const MAX_MISSION_TIMEOUT_MS = 120 * 60 * 1000;
const resolvedMissionLimits = resolveMissionLimits(process.env);
const resolvedMissionCostEnvelope = resolveAgentMissionCostEnvelope(process.env);
// Token reference per mission — observed in telemetry, not an execution cap
const MISSION_TOKEN_BUDGET = resolvedMissionLimits.tokenBudget;
// Max tool calls per mission — default 100, configurable via env
const MISSION_MAX_TOOL_CALLS = resolvedMissionLimits.maxToolCalls;
for (const variable of resolvedMissionLimits.invalidEnvironmentVariables) {
  log.warn('Invalid mission limit environment value; using secure default', { variable });
}
// Budget warning threshold (0-1) — agent told to wrap up at this % spent.
// Wired into the orchestrator's onUsage sync (MISSION-001) so the in-agent
// "[BUDGET WARNING]" fires once real spend crosses the threshold.
const MISSION_WARN_THRESHOLD = resolvedMissionLimits.warnThreshold;

/**
 * Mirror of the decision tree inside `shouldAdvanceChain` — returns a short
 * human-readable string describing why the chain halted at this mission.
 * Used only in the advance-chain step's log line so operators can see the
 * halt reason without digging. Keep in sync with `shouldAdvanceChain` in
 * `mission-chains.ts`.
 */
function resolveHaltReason(m: {
  status?: string;
  partial?: boolean;
  qualityJudgement?: { overallScore: number };
  qualityReport?: { verdict: 'PASS' | 'REVISE' | 'FAIL' };
}): string {
  if (m.status !== 'completed') return `status=${m.status}`;
  if (m.partial === true) return 'partial-recovery';
  if (m.qualityJudgement && m.qualityJudgement.overallScore < QUALITY_HALT_THRESHOLD) {
    return `l2-below-threshold (${(m.qualityJudgement.overallScore * 100).toFixed(0)}%)`;
  }
  if (m.qualityReport?.verdict === 'FAIL') return 'l1-fail';
  return 'unknown';
}

/** Resolve and freeze the one evidence bundle a Scout hands to its author. */
async function filterParentEvidence(
  parentResult: string | undefined,
  ownerId: string,
  sourceMissionId: string
): Promise<{ text: string; bundle: ScoutBundle; provenance: EvidenceProvenanceReceipt }> {
  if (!parentResult) throw new Error('parent evidence result is absent');
  const { parseScoutBundle } = await import('@/lib/scout-bundle-parser');
  const parsed = parseScoutBundle(parentResult);
  if (!parsed.ok) throw new Error(`cannot evaluate parent evidence provenance: ${parsed.error}`);
  const { resolveGraphCitations, describeWithheldCitations, filterBundleByWithheldSourceIds, parseGraphCitation } =
    await import('@/lib/graph/citation-provenance');
  const { createOwnerScopedCitationReader } = await import('@/lib/graph/citation-provenance-admin');
  const resolved = await resolveGraphCitations(parsed.bundle.sources, createOwnerScopedCitationReader(ownerId));
  const withheldIds = new Set([...resolved.absent, ...resolved.unavailable].map((entry) => entry.source.id));
  const filtered = filterBundleByWithheldSourceIds(parsed.bundle, withheldIds);
  if (filtered.bundle.sources.length === 0 || filtered.bundle.findings.length === 0) {
    throw new Error(
      `provenance filtering left no citable evidence ` +
        `(sources=${filtered.bundle.sources.length}, findings=${filtered.bundle.findings.length})`
    );
  }
  const { buildEvidenceProvenanceReceipt } = await import('@/lib/reports/evidence-provenance');
  const provenance = buildEvidenceProvenanceReceipt({
    sourceMissionId,
    bundle: filtered.bundle,
    graphDerivedChecked: resolved.graphDerived,
    eligibleGraphSourceIds: resolved.eligible
      .filter((source) => parseGraphCitation(source.url) !== null)
      .map((source) => source.id),
    withheldAbsentSourceIds: resolved.absent.map((entry) => entry.source.id),
    withheldUnavailableSourceIds: resolved.unavailable.map((entry) => entry.source.id),
  });
  const disclosure = describeWithheldCitations(resolved);
  const text = [
    ...(disclosure ? [disclosure, ''] : []),
    `Evidence after Firestore resolution: ${filtered.bundle.sources.length} source(s), ` +
      `${filtered.keptFindings} supported finding(s), ${filtered.demotedFindings} finding(s) withheld.`,
    'The JSON below is the only evidence bundle available to this report.',
    '',
    '```json',
    JSON.stringify(filtered.bundle, null, 2),
    '```',
  ].join('\n');
  return { text, bundle: filtered.bundle, provenance };
}

/**
 * Fetch the published report HTML referenced by a mission result string, if any.
 * Creator/strategist missions leave a short summary in `result` that embeds a
 * `report-<id>` reference; the full HTML lives in the impulse-reports store.
 * Returns null when there is no report reference or the fetch fails (best-effort,
 * so callers fall back to summary-only evaluation).
 */
/**
 * Mark every not-yet-run downstream step of a halted or failed
 * chain as failed so no mission is left 'pending' forever. Shared by the
 * advance-chain halt branch and the Inngest onFailure handler (hard failures
 * never reach advance-chain). Best-effort: a marking failure only logs.
 */
async function failDownstreamChainSteps(missionId: string, reason: string): Promise<void> {
  try {
    const { getMissionById, updateMission } = await import('@/lib/missions');
    const { findNextChainStep } = await import('@/lib/mission-chains');
    const current = await getMissionById(missionId);
    if (!current || !current.chainId) return;
    let walker = current;
    for (;;) {
      const downstream = await findNextChainStep(walker);
      if (!downstream) break;
      if (downstream.status === 'pending') {
        await updateMission(downstream.id, {
          status: 'failed',
          errors: [`chain halted upstream (${reason}) at ${missionId} — this step will not run`],
          progressMessage: 'Chain halted upstream — step will not run',
          completedAt: new Date().toISOString(),
        });
        log.info('Marked downstream chain step failed after halt', {
          chainId: current.chainId,
          downstreamMissionId: downstream.id,
          haltReason: reason,
        });
      }
      walker = downstream;
    }
  } catch (err) {
    log.warn('Failed to mark downstream chain steps after halt', {
      missionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function extractReportHtml(
  resultText: string | undefined,
  missionId: string,
  ownerId: string
): Promise<string | null> {
  const match = (resultText ?? '').match(/report-[a-z0-9]+-[a-z0-9]+/i);
  if (!match) return null;
  try {
    const { getReportOwnedBy } = await import('@/lib/reports');
    const reportDoc = await getReportOwnedBy(match[0], ownerId);
    // The id came from AGENT FREE TEXT. Only accept a report that genuinely
    // belongs to this mission — otherwise a prompt-injected (or hallucinated)
    // id would pull an unrelated report's HTML into this mission's evaluation.
    if (!reportDoc || reportDoc.missionId !== missionId) return null;
    return reportDoc.html ?? null;
  } catch {
    return null;
  }
}

/**
 * REPORT-002/REPORT-003 — resolve the mission's CANONICAL published artifacts.
 *
 * The reviewed artifact must be the exact persisted report HTML, keyed by
 * missionId — never a summary or whatever report id happens to appear in the
 * agent's result TEXT (a revision that forgets to mention the id would
 * otherwise be evaluated on its summary alone, incomparably to the original).
 * Newest-first; the first entry is the primary deliverable. The repository
 * query is owner-scoped and strict: ownerless/foreign reports are excluded at
 * the storage boundary and a failed read is represented separately from a
 * proven-empty result.
 */
type CanonicalReport = {
  id: string;
  html?: string;
  title?: string;
  slotName?: string;
  reviewStatus?: 'published' | 'needs-review';
  designPassVerdict?: 'PASS' | 'FAIL' | 'UNREVIEWED';
  designPassDetails?: string;
  createdAt?: string;
  artifactIdentity?: {
    sha256: string;
    revisionNumber: number;
    reviewedBy: readonly ['design-pass', 'critique-report'];
  } | null;
};

/**
 * The resolution outcome. `ok:false` means the STORE could not be read — which
 * is emphatically not the same as "this mission published nothing", and callers
 * that decide terminal truth must not conflate them (a transient Firestore
 * deadline would otherwise demote a delivered mission to failed and tell the
 * user to pay again).
 */
const REPORT_LOOKUP_FAILED_MESSAGE =
  'The mission execution finished, but the owner-scoped Report lookup failed, so Radarist could not verify whether its promised deliverable exists. No retry was started. Restore Report access and retry the read before deciding whether to re-dispatch.';

type CanonicalResolution = { ok: true; reports: CanonicalReport[] } | { ok: false; reports: []; error: string };

type ReportIdentityResolution = { ok: true; reportIds: string[] } | { ok: false; reportIds: []; error: string };

interface MissionReportTruth {
  ownerId: string;
  promisedReport: boolean;
  resolution: ReportIdentityResolution;
  terminalState: MissionQualityTerminalState;
}

async function resolveCanonicalMissionReportsResult(missionId: string, ownerId: string): Promise<CanonicalResolution> {
  try {
    const { getReportsByMissionIdOwnedBy } = await import('@/lib/reports');
    const reports = await getReportsByMissionIdOwnedBy(missionId, ownerId);
    return { ok: true, reports };
  } catch (err) {
    log.error('Owner-scoped canonical Report lookup failed', err instanceof Error ? err : new Error(String(err)), {
      missionId,
      ownerId,
    });
    return { ok: false, reports: [], error: REPORT_LOOKUP_FAILED_MESSAGE };
  }
}

function missionQualityTerminalState(input: {
  executionSucceeded: boolean;
  promisedReport: boolean;
  resolution: ReportIdentityResolution;
}): MissionQualityTerminalState {
  if (!input.promisedReport) {
    return {
      executionSucceeded: input.executionSucceeded,
      deliverable: {
        required: false,
        resolution: 'not-required',
        ...(input.resolution.reportIds.length > 0 ? { ownerVisibleArtifactIds: input.resolution.reportIds } : {}),
      },
    };
  }

  return {
    executionSucceeded: input.executionSucceeded,
    deliverable: {
      required: true,
      resolution: !input.resolution.ok
        ? 'lookup-failed'
        : input.resolution.reportIds.length > 0
          ? 'owner-visible'
          : 'missing',
      ownerVisibleArtifactIds: input.resolution.reportIds,
    },
  };
}

/**
 * Resolve the mission owner's canonical Report identities and make the durable
 * mission pointers load-bearing before any post-run quality work. The Inngest
 * step memoizes only compact IDs — never Report HTML or other document bodies.
 */
async function resolveMissionReportTruth(input: {
  missionId: string;
  eventUserId: string;
  executionSucceeded: boolean;
}): Promise<MissionReportTruth> {
  const { getMissionById } = await import('@/lib/missions');
  const { missionPromisedReportDeliverable } = await import('@/lib/mission-quality');
  const mission = (await getMissionById(input.missionId)) as {
    userId?: string;
    slots?: Array<{ name: string }>;
    classifierMetadata?: { fallback?: boolean };
  } | null;

  const ownerId = mission?.userId?.trim();
  if (!mission || !ownerId) {
    throw new Error(`Mission ${input.missionId} has no persisted owner; Report truth cannot be resolved`);
  }
  if (ownerId !== input.eventUserId) {
    throw new Error(`Mission ${input.missionId} owner does not match the dispatched user`);
  }

  const promisedReport = missionPromisedReportDeliverable(mission);
  const canonical = await resolveCanonicalMissionReportsResult(input.missionId, ownerId);
  if (!canonical.ok) {
    const resolution: ReportIdentityResolution = {
      ok: false,
      reportIds: [],
      error: canonical.error,
    };
    return {
      ownerId,
      promisedReport,
      resolution,
      terminalState: missionQualityTerminalState({
        executionSucceeded: input.executionSucceeded,
        promisedReport,
        resolution,
      }),
    };
  }

  const reportIds = Array.from(
    new Set(canonical.reports.map((report) => report.id?.trim()).filter((id): id is string => Boolean(id)))
  );
  const resolution: ReportIdentityResolution = { ok: true, reportIds };

  // This write is deliberately outside the lookup catch. A Report that exists
  // but cannot be durably linked must stop the workflow before quality rather
  // than continue with a best-effort pointer and risk orphaning paid output.
  await updateMission(
    input.missionId,
    reportIds.length > 0 ? { reportId: reportIds[0], reportIds } : { reportId: null, reportIds: [] }
  );

  return {
    ownerId,
    promisedReport,
    resolution,
    terminalState: missionQualityTerminalState({
      executionSucceeded: input.executionSucceeded,
      promisedReport,
      resolution,
    }),
  };
}

/**
 * Run the grounded fact-check (Quality Layer 1.5) on a published report's HTML
 * and fold its single soft `report-claims-verified` check into `report`,
 * re-deriving the verdict. A contradiction → REVISE; any infra failure keeps the
 * base verdict unchanged (fail-open). Used in BOTH the initial evaluate-quality
 * step and the revise loop, so the persisted report always reflects whether the
 * actually-shipped artifact had its load-bearing claims verified.
 */
async function foldReportFactCheck(
  report: QualityReport,
  reportHtml: string,
  missionId: string,
  owner: string,
  /**
   * ARUN-022 — this helper runs in BOTH the initial quality step and the revise
   * loop, so each call site passes its own stable ordinal. Two fact-checks in one
   * mission are genuinely different spend and must land in different receipt
   * batches; sharing one would make the second a conflicting replay of the first
   * and lose it.
   */
  sequence: number
): Promise<QualityReport> {
  try {
    const { runReportFactCheck } = await import('@/lib/mission-fact-check');
    const { withAdditionalChecks } = await import('@/lib/mission-quality');
    const { withMissionStageReceipts } = await import('@/lib/mission-stage-usage');
    const { result: factCheck } = await withMissionStageReceipts(
      { missionId, owner, stage: 'fact-check', sequence },
      () => runReportFactCheck({ reportText: reportHtml, missionId })
    );
    const merged = withAdditionalChecks(report, [factCheck.check]);
    // MISSION-005: accumulate the fact-check's real Gemini spend on the
    // mission doc (durable across replays; this helper runs in BOTH the
    // evaluate-quality step and the revise step, so read-modify-write).
    if (factCheck.costUsd === null) {
      await markMissionCostUnavailable(missionId, 'factCheck');
    } else if (factCheck.costUsd > 0) {
      try {
        const { getMissionById } = await import('@/lib/missions');
        const doc = (await getMissionById(missionId)) as { factCheckCostUsd?: number } | null;
        await updateMission(missionId, {
          factCheckCostUsd: (doc?.factCheckCostUsd ?? 0) + factCheck.costUsd,
        });
      } catch (costErr) {
        log.warn('fact-check cost persistence failed (non-blocking)', {
          missionId,
          error: costErr instanceof Error ? costErr.message : String(costErr),
        });
      }
    }
    log.info('Report fact-check folded into quality report', {
      missionId,
      claimsChecked: factCheck.claimsChecked,
      contradicted: factCheck.contradicted,
      unverifiable: factCheck.unverifiable,
      failedOpen: factCheck.failedOpen,
      verdict: merged.verdict,
    });
    return merged;
  } catch (factErr) {
    log.warn('Report fact-check step failed — keeping base verdict', {
      missionId,
      error: factErr instanceof Error ? factErr.message : String(factErr),
    });
    return report;
  }
}

/** REPORT-002 — the mission's honest terminal decision, resolved once. */
interface TerminalDecision {
  status: 'completed' | 'failed';
  progressMessage: string;
  outcome?: 'delivered' | 'needs-review' | 'no-deliverable';
  /** Canonical report ids to persist as the durable run→report link. */
  reportIds: string[];
  /** Appended to the mission result so the run links its artifact(s). */
  resultAppendix: string;
  /** Extra error to surface (no-deliverable, or an unresolvable store). */
  error?: string;
  /** The exact substantive failures behind a needs-review verdict. */
  failingChecks: Array<{ name: string; detail: string; critical: boolean }>;
  /** The verdict/timestamp to stamp on a withheld artifact's receipt. */
  verdict: 'PASS' | 'REVISE' | 'FAIL';
  evaluatedAt: string;
  /** Whether final persistence replaces, clears, or preserves durable pointers. */
  pointerDisposition: 'replace' | 'clear' | 'preserve';
}

/**
 * REPORT-002 — resolve the terminal truth of a run: what the mission actually
 * delivered, decided from the CANONICAL persisted artifacts plus the final
 * quality verdict. The caller memoizes it so the AgentRun row and the mission
 * doc can never disagree. SDK failures still consume the compact Report truth:
 * an artifact published before the SDK error must remain linked and private for
 * owner review instead of becoming an orphan.
 */
async function resolveTerminalOutcome(input: {
  missionId: string;
  sdkSuccess: boolean;
  reportTruth: MissionReportTruth;
}): Promise<TerminalDecision> {
  const evaluatedAt = new Date().toISOString();
  const { resolution, promisedReport } = input.reportTruth;

  if (!resolution.ok) {
    if (!promisedReport) {
      // Report availability is not a completion dependency for exploratory or
      // legacy/fallback chain missions that never promised an artifact. Preserve
      // any prior pointer because the failed read proves neither presence nor
      // absence, but keep their SDK terminal truth unchanged.
      return {
        status: input.sdkSuccess ? 'completed' : 'failed',
        progressMessage: input.sdkSuccess ? 'Mission completed' : 'Mission failed',
        ...(input.sdkSuccess ? { outcome: 'delivered' as const } : {}),
        reportIds: [],
        resultAppendix: '',
        failingChecks: [],
        verdict: input.sdkSuccess ? 'REVISE' : 'FAIL',
        evaluatedAt,
        pointerDisposition: 'preserve',
      };
    }

    return {
      status: 'failed',
      progressMessage: 'Mission failed — Report lookup could not be verified',
      reportIds: [],
      resultAppendix: '',
      error: resolution.error,
      failingChecks: [],
      verdict: 'FAIL',
      evaluatedAt,
      // A failed read proves nothing about previously persisted durable links.
      pointerDisposition: 'preserve',
    };
  }

  const { getMissionById } = await import('@/lib/missions');
  const { resolveMissionOutcome, substantiveFailingChecks } = await import('@/lib/mission-quality');
  let current: { qualityReport?: QualityReport } | null = null;
  try {
    current = (await getMissionById(input.missionId)) as { qualityReport?: QualityReport } | null;
  } catch (err) {
    // Artifact identity remains authoritative. Missing quality evidence routes
    // a real report to needs-review instead of falsely calling it clean.
    log.warn('Terminal mission-quality read failed — treating report as unevaluated', {
      missionId: input.missionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const reportIds = resolution.reportIds;
  const pointerDisposition: TerminalDecision['pointerDisposition'] = reportIds.length > 0 ? 'replace' : 'clear';

  if (!input.sdkSuccess && reportIds.length > 0) {
    const fallbackFailure = {
      name: 'result-exists',
      pass: false,
      critical: true,
      detail: 'structured terminal state says execution failed',
    };
    const failedChecks = current?.qualityReport?.checks.filter((check) => !check.pass) ?? [];
    const substantive = substantiveFailingChecks(failedChecks);
    const failingChecks = substantive.length > 0 ? substantive : [fallbackFailure];
    const reportLinks = reportIds.map((reportId) => `/reports/${reportId}`);
    return {
      status: 'failed',
      progressMessage: 'Mission failed — published report retained for review',
      outcome: 'needs-review',
      reportIds,
      resultAppendix:
        `\n\n---\n\nReport (needs review): ${reportLinks.join(', ')}\n` +
        'The SDK run failed after publishing this report. Radarist retained it as a private draft for owner review.',
      failingChecks: failingChecks.map((check) => ({
        name: check.name,
        detail: check.detail,
        critical: check.critical,
      })),
      verdict: 'FAIL',
      evaluatedAt: current?.qualityReport?.evaluatedAt ?? evaluatedAt,
      pointerDisposition,
    };
  }

  if (!input.sdkSuccess && reportIds.length === 0 && !promisedReport) {
    return {
      status: 'failed',
      progressMessage: 'Mission failed',
      reportIds: [],
      resultAppendix: '',
      failingChecks: [],
      verdict: current?.qualityReport?.verdict ?? 'FAIL',
      evaluatedAt: current?.qualityReport?.evaluatedAt ?? evaluatedAt,
      pointerDisposition,
    };
  }

  // resolveMissionOutcome deliberately accepts SDK-successful input only. An
  // SDK failure that also missed a promised report still consumes the same
  // no-deliverable diagnosis, while retaining the SDK failure status.
  const outcome = resolveMissionOutcome({
    sdkSuccess: true,
    hadReportSlots: promisedReport,
    reports: reportIds.map((id) => ({ id })),
    qualityReport: current?.qualityReport,
  });

  return {
    status: input.sdkSuccess ? outcome.status : 'failed',
    progressMessage: outcome.progressMessage,
    outcome: outcome.kind,
    reportIds,
    resultAppendix: outcome.resultAppendix,
    ...(outcome.kind === 'no-deliverable' ? { error: outcome.error } : {}),
    failingChecks: outcome.failingChecks.map((check) => ({
      name: check.name,
      detail: check.detail,
      critical: check.critical,
    })),
    verdict: current?.qualityReport?.verdict ?? 'REVISE',
    evaluatedAt: current?.qualityReport?.evaluatedAt ?? evaluatedAt,
    pointerDisposition,
  };
}

/**
 * Persist the needs-review quarantine before the mirrored AgentRun is written.
 * A completed run may never coexist with a report we failed to make private.
 */
async function enforceTerminalReportLifecycle(
  terminal: TerminalDecision,
  agent: string,
  ownerId: string
): Promise<TerminalDecision> {
  if (terminal.outcome !== 'needs-review' || terminal.reportIds.length === 0) return terminal;

  const { updateReport } = await import('@/lib/reports');
  const qualityGate = {
    verdict: terminal.verdict,
    evaluatedAt: terminal.evaluatedAt,
    failingChecks: terminal.failingChecks,
    repair:
      'Fix the issues with an edit, restore an earlier version from History, or Approve & publish the draft as-is. Public sharing stays unavailable until approved.',
  };
  const unmarked: string[] = [];

  for (const reportId of terminal.reportIds) {
    try {
      await updateReport(
        reportId,
        { reviewStatus: 'needs-review', shared: false, qualityGate },
        { savedBy: `agent:${agent}`, requireOwnerId: ownerId }
      );
      log.info('Report retained as owner-visible needs-review draft', {
        reportId,
        failingChecks: qualityGate.failingChecks.map((c) => c.name),
      });
    } catch (err) {
      unmarked.push(reportId);
      log.error('Failed to make needs-review report private', err instanceof Error ? err : new Error(String(err)), {
        reportId,
      });
    }
  }

  if (unmarked.length === 0) return terminal;

  const quarantineError =
    `This run's quality gate did not pass, and ${unmarked.length} report(s) could not be made private for review ` +
    `(${unmarked.join(', ')}). Review them immediately before sharing.`;
  return {
    ...terminal,
    status: 'failed',
    progressMessage: 'Mission failed — report review isolation could not be enforced',
    error: terminal.error ? `${terminal.error} ${quarantineError}` : quarantineError,
  };
}

type MissionCostComponent =
  'orchestrator' | 'classifier' | 'prelude' | 'revisions' | 'judge' | 'factCheck' | 'reflection' | 'mission-read';

type MissionCostUnavailableReason = 'unknown-pricing' | 'accounting-incomplete';

function canonicalCostUnavailableReason(reason?: string): MissionCostUnavailableReason {
  if (reason === 'accounting-incomplete') return 'accounting-incomplete';
  return reason ? 'unknown-pricing' : 'accounting-incomplete';
}

/**
 * OBS-001 / GRAPH-030 — the ONE derivation of a mission's canonical business
 * outcome, consumed by every terminal surface: the Reflection, the Episode, the
 * JobRun declaration, and (via `onFailure`) the post-hoc reconciliation.
 *
 * It reads only the two facts the Mission itself persists as canonical — the
 * terminal status and the partial-recovery flag — so the JobRun's declared
 * outcome and the Mission doc cannot disagree by construction. `Mission.outcome`
 * (`delivered` / `needs-review` / `no-deliverable`) is deliberately NOT folded in:
 * that is a statement about the ARTIFACT's review state on a different axis, and
 * mixing it in here would make a `failed` mission declare `partial` while the
 * Mission doc still said failed — trading one divergence for another.
 */
function domainOutcomeForMissionTerminal(
  terminal: Pick<TerminalDecision, 'status'>,
  result: { partial?: boolean }
): DomainOutcome {
  return (
    domainOutcomeFromMissionTerminal({
      status: terminal.status,
      partial: result.partial === true,
    }) ??
    // `status` is a closed 'completed' | 'failed' union, so the mapper always
    // resolves. Fail closed rather than silently declaring a success.
    'failed'
  );
}

/** OPS-004 structured terminal failure codes the Mission/AgentRun can carry. */
const MISSION_FAILURE_CODES = [
  'mcp-preflight-failed',
  'mcp-base-url-missing',
  'mcp-internal-key-missing',
  'unsupported-model',
  'mcp-credential-containment-failed',
] as const;
type MissionFailureCode = (typeof MISSION_FAILURE_CODES)[number];

/**
 * Derive a stable failure code from a terminal error message. The MCP preflight
 * failures (route/tool/gate/worker/orchestrator) all emit their reason code as
 * the leading token of the message, so a prefix match is exact and free of
 * false positives.
 */
export function deriveMissionFailureCode(message: string): MissionFailureCode | undefined {
  return MISSION_FAILURE_CODES.find((code) => message.startsWith(code));
}

async function markMissionCostUnavailable(missionId: string, component: MissionCostComponent): Promise<void> {
  const { getMissionById } = await import('@/lib/missions');
  const mission = (await getMissionById(missionId)) as { costUnavailableComponents?: MissionCostComponent[] } | null;
  const components = Array.from(new Set([...(mission?.costUnavailableComponents ?? []), component]));
  await updateMission(missionId, {
    costUnavailableReason: 'unknown-pricing',
    costUnavailableComponents: components,
  });
}

export const runAgentMission = inngest.createFunction(
  {
    id: 'run-agent-mission',
    name: 'Run Agent Mission',
    // No retries. Each retry is a fresh Anthropic SDK session that re-runs all
    // research from scratch and bills again — there is no mid-stream resume at
    // the LLM layer. Gateway re-dispatch can also overlap long-running steps.
    // On failure
    // we surface the error to the user and let them decide whether to
    // dispatch again — single-shot is the right semantic for $1-3 ops.
    retries: 0,
    concurrency: { limit: 3 },
    timeouts: {
      // Raised to accommodate per-agent timeoutMinutes up to 120 min.
      // The per-mission wall-clock timeout is enforced inside the handler;
      // these bounds are an outer safety net for Inngest queue management.
      start: '100m',
      finish: '130m',
    },
    onFailure: async ({ error, event }) => {
      // This is the infrastructure fallback, not a normal orchestrator outcome:
      // it can run because AgentRun persistence itself failed, so it must not
      // fabricate a duration/history row. Handled success, returned failure,
      // and wall-clock timeout outcomes all finalize through the main handler
      // and persist the memoized execution duration below.
      // In Inngest onFailure, the original event is nested under event.data.event
      const originalEvent = (event.data as Record<string, unknown>).event as
        { data?: Record<string, unknown> } | undefined;
      const missionId = (originalEvent?.data?.missionId ?? '') as string;
      log.error('Mission failed after retries', error instanceof Error ? error : new Error(String(error)), {
        missionId,
      });
      if (!missionId) {
        log.error('Cannot update mission on failure — missionId is empty', new Error('empty missionId'));
        return;
      }
      // OPS-004: derive a stable, machine-readable terminal failure code from
      // the error so the Mission carries a structured code, not just prose.
      const failureMessage = error instanceof Error ? error.message : String(error);
      const failureCode = deriveMissionFailureCode(failureMessage);

      // Never trust the failed event's principal for recovery writes. A forged
      // or stale event must not fail another owner's Mission, create an
      // AgentRun under the attacker, or emit an owner-scoped SSE event. Resolve
      // the persisted owner first; an absent/unreadable owner leaves no safe
      // user-scoped fallback action.
      const eventUserId = typeof originalEvent?.data?.userId === 'string' ? originalEvent.data.userId.trim() : '';
      const { getMissionById } = await import('@/lib/missions');
      let missionDoc: {
        userId?: string;
        costUsd?: number;
        costUnavailableReason?: MissionCostUnavailableReason;
        tokenUsage?: { input: number; output: number };
        agent?: string;
        classifierMetadata?: { costUsd?: number; costUnavailableReason?: 'unknown-pricing' };
        preludeAccounting?: {
          cost?: { totalUsd?: number | null; costUnavailableReason?: MissionCostUnavailableReason };
        };
      } | null;
      try {
        missionDoc = (await getMissionById(missionId)) as typeof missionDoc;
      } catch (ownerReadErr) {
        log.error(
          'Cannot authorize mission failure recovery — persisted owner lookup failed',
          ownerReadErr instanceof Error ? ownerReadErr : new Error(String(ownerReadErr)),
          { missionId }
        );
        return;
      }

      const failureUserId = missionDoc?.userId?.trim();
      if (!failureUserId) {
        log.error(
          'Cannot authorize mission failure recovery — persisted owner is absent',
          new Error('missing persisted mission owner'),
          { missionId }
        );
        return;
      }
      if (!eventUserId || eventUserId !== failureUserId) {
        log.error(
          'Rejected mission failure recovery for absent or mismatched event owner',
          new Error(eventUserId ? 'mission event owner mismatch' : 'mission event owner absent'),
          { missionId }
        );
        return;
      }

      try {
        await updateMission(missionId, {
          status: 'failed',
          errors: [failureMessage],
          completedAt: new Date().toISOString(),
          ...(failureCode ? { failureCode } : {}),
        });
      } catch (updateErr) {
        log.error(
          'Failed to update mission on failure',
          updateErr instanceof Error ? updateErr : new Error(String(updateErr)),
          { missionId }
        );
      }

      // T1.8: hard failures never reach the advance-chain step — mark the
      // chain's downstream steps failed here too; otherwise a scout that fails
      // at startup can leave its creator pending forever.
      await failDownstreamChainSteps(missionId, 'mission failed');

      // The folded cost of every KNOWN pre-failure component. Declared at handler
      // scope (not inside the try) because BOTH the fallback AgentRun and the
      // OBS-004 sweep settlement below must report the same figure — a second,
      // independently-derived fold could disagree with the run row.
      let foldedCostUsd: number | undefined;
      let foldedUnavailableReason: MissionCostUnavailableReason | undefined;

      // ARUN-008: make the infrastructure failure visible in run history.
      // Idempotent (keyed run-fallback-<missionId>) and honest — durationUnknown,
      // cost/tokens only from the mission doc's pre-failure H1 snapshots. If a
      // real AgentRun already landed before a later Mission write failed, the
      // helper reconciles that row to failure instead of leaving split truth.
      try {
        const { recordMissionFailureFallback } = await import('@/lib/agent-runs');

        // OPS-004 (G): when a preflight (or any pre-orchestrator) abort reaches
        // here, the intent classifier already ran and BILLED at dispatch. Its
        // spend lives on mission.classifierMetadata; the orchestrator spend (if
        // any) lives on mission.costUsd. Fold every KNOWN component into the
        // fallback receipt instead of discarding the classifier cost. The
        // fallback writer accepts either a precise `costUsd` OR a
        // `costUnavailableReason` (never both), so:
        //  - all present components priced           → precise summed costUsd;
        //  - a mix of priced + unpriced components   → 'accounting-incomplete';
        //  - a single present component, unpriced    → preserve its own reason
        //                                               ('unknown-pricing');
        //  - no components                           → whatever the mission had.
        const classifier = missionDoc?.classifierMetadata;
        const preludeCost = missionDoc?.preludeAccounting?.cost?.totalUsd;
        const preludeUnavailableReason = missionDoc?.preludeAccounting?.cost?.costUnavailableReason;
        const orchestratorPresent =
          missionDoc?.costUsd !== undefined || missionDoc?.costUnavailableReason !== undefined;
        const classifierPresent = classifier?.costUsd !== undefined || classifier?.costUnavailableReason !== undefined;
        const preludePresent = typeof preludeCost === 'number' || preludeCost === null || !!preludeUnavailableReason;
        const orchestratorUnpriced = !!missionDoc?.costUnavailableReason;
        const classifierUnpriced = classifier?.costUnavailableReason === 'unknown-pricing';
        const preludeUnpriced = preludeCost === null || !!preludeUnavailableReason;
        const orchestratorCost = orchestratorUnpriced ? undefined : missionDoc?.costUsd;
        const classifierCost = classifierUnpriced ? undefined : classifier?.costUsd;
        const pricedParts = [orchestratorCost, classifierCost, preludeCost].filter(
          (v): v is number => typeof v === 'number'
        );
        const unpricedPresent = orchestratorUnpriced || classifierUnpriced || preludeUnpriced;
        const presentComponentCount =
          (orchestratorPresent ? 1 : 0) + (classifierPresent ? 1 : 0) + (preludePresent ? 1 : 0);

        if (pricedParts.length > 0 && !unpricedPresent) {
          foldedCostUsd = pricedParts.reduce((sum, part) => sum + part, 0);
          foldedUnavailableReason = undefined;
        } else if (unpricedPresent && (pricedParts.length > 0 || presentComponentCount >= 2)) {
          // Genuinely incomplete: at least one component priced and another not,
          // or multiple present components all unpriced.
          foldedCostUsd = undefined;
          foldedUnavailableReason = 'accounting-incomplete';
        } else {
          // Zero or one present component — preserve its specific reason.
          foldedCostUsd = undefined;
          foldedUnavailableReason =
            missionDoc?.costUnavailableReason ??
            (classifierUnpriced ? 'unknown-pricing' : undefined) ??
            preludeUnavailableReason;
        }

        // OPS-004 coordination: the *cost* fold above is done here (allowed
        // file). Two AgentRun-side gaps remain OWNED by `ARUN-029` because they
        // require editing the operation-receipt file `src/lib/agent-runs.ts`
        // ARUN-029 closed both gaps this call used to carry: the structured
        // `failureCode` now reaches the AgentRun alongside the Mission, and an
        // absent `tokenUsage` is recorded as explicitly unreported rather than
        // the writer's `{0,0}` default.
        await recordMissionFailureFallback({
          missionId,
          userId: failureUserId,
          agentName: missionDoc?.agent ?? ((originalEvent?.data?.agent ?? 'unknown') as string),
          errorMessage: error instanceof Error ? error.message : String(error),
          costUsd: foldedCostUsd,
          costUnavailableReason: foldedUnavailableReason,
          tokenUsage: missionDoc?.tokenUsage,
          ...(failureCode ? { failureCode } : {}),
        });
      } catch (fallbackErr) {
        log.error(
          'Failed to write failure-fallback AgentRun',
          fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr)),
          { missionId }
        );
      }

      // ====================================================================
      // GRAPH-030 / OBS-001 — bring every OTHER store into exact agreement
      // with the failed Mission this handler just persisted.
      //
      // The main handler writes the Reflection and finalizes the Episode BEFORE
      // it writes the AgentRun and the Mission. So a permanent failure in one of
      // those later steps lands here with Neo4j already holding a `completed`
      // Episode and a `success: true` Reflection — the failure shape
      // divergence. Firestore and Neo4j are separate systems with no shared
      // transaction, so the repair is an idempotent, downgrade-only pass driven
      // by the canonical Mission outcome.
      // ====================================================================
      const canonicalOutcome = domainOutcomeFromMissionTerminal({ status: 'failed', failureCode }) ?? 'failed';

      try {
        const { reconcileMissionLineageOutcome } = await import('@/lib/graph/mission-lineage-parity');
        const reconciliation = await reconcileMissionLineageOutcome({
          missionId,
          outcome: canonicalOutcome,
          reason: failureCode ?? 'mission-failed-after-retries',
        });
        log.info('Mission graph lineage reconciled after terminal failure', {
          missionId,
          outcome: canonicalOutcome,
          episode: reconciliation.episode,
          reflectionsCorrected: reconciliation.reflectionsCorrected,
        });
      } catch (lineageErr) {
        // Non-blocking: the Mission is already authoritative and Neo4j may be
        // unavailable. Logged loudly because the graph is now KNOWN to be behind,
        // and `npm run graph:health` is the standing detector for that.
        log.error(
          'Could not reconcile mission graph lineage to the failed outcome',
          lineageErr instanceof Error ? lineageErr : new Error(String(lineageErr)),
          { missionId, outcome: canonicalOutcome }
        );
      }

      // OBS-001: refine this run's transport record. The middleware could only
      // entail a coarse `failed` from the throw; the persisted failure code can
      // prove the run was refused BEFORE any paid stage, which is a materially
      // different operator story (nothing spent, nothing half-written).
      const failedRunId =
        typeof (event.data as Record<string, unknown>)?.run_id === 'string'
          ? ((event.data as Record<string, unknown>).run_id as string)
          : undefined;
      if (failedRunId && canonicalOutcome !== 'failed') {
        try {
          const { recordJobDomainOutcome } = await import('@/lib/inngest/observability');
          const { jobRunDocIdForRun } = await import('./finalize-cancelled-job-run');
          const update = await recordJobDomainOutcome(jobRunDocIdForRun(failedRunId), {
            outcome: canonicalOutcome,
            reason: failureCode ?? undefined,
          });
          log.info('Refined the failed run job-run domain outcome', {
            missionId,
            outcome: canonicalOutcome,
            update,
          });
        } catch (jobRunErr) {
          log.warn('Could not refine the failed run job-run domain outcome (non-blocking)', {
            missionId,
            error: jobRunErr instanceof Error ? jobRunErr.message : String(jobRunErr),
          });
        }
      }

      // OBS-004: a child that died must STILL report to its sweep. Without this,
      // the exact reported shape — a sweep whose paid children failed — leaves the
      // sweep's aggregate stuck at `pending` forever, and the failures (and their
      // spend) never reach the summary row.
      const failedSweepId = (missionDoc as { sweepId?: string } | null)?.sweepId;
      if (failedSweepId) {
        try {
          const { recordSweepChildSettlement, refreshSweepChildAggregate } =
            await import('@/lib/sweep-child-accounting-admin');
          await recordSweepChildSettlement(failedSweepId, {
            missionId,
            outcome: canonicalOutcome,
            // Only the pre-failure snapshots this handler already folded — never a
            // fabricated 0. `durationMs` is deliberately omitted: this path never
            // saw the orchestrator run, so its elapsed time is unknowable
            // (the same ARUN-008 `durationUnknown` reasoning).
            ...(foldedCostUsd !== undefined
              ? { costUsd: foldedCostUsd }
              : { costUnavailableReason: foldedUnavailableReason ?? 'accounting-incomplete' }),
            ...(missionDoc?.tokenUsage
              ? { tokensIn: missionDoc.tokenUsage.input, tokensOut: missionDoc.tokenUsage.output }
              : {}),
          });
          const refresh = await refreshSweepChildAggregate(failedSweepId);
          log.info('Sweep child accounting settled from the failure handler', {
            missionId,
            sweepId: failedSweepId,
            outcome: canonicalOutcome,
            refresh,
          });
        } catch (sweepErr) {
          log.warn('Could not settle sweep child accounting after a terminal failure', {
            missionId,
            sweepId: failedSweepId,
            error: sweepErr instanceof Error ? sweepErr.message : String(sweepErr),
          });
        }
      }

      // Emit agent.error event (best-effort)
      try {
        const { emitAgentEvent } = await import('@/lib/agent-events');
        await emitAgentEvent({
          type: 'agent.error',
          userId: failureUserId,
          missionId,
          agentType: (originalEvent?.data?.agent ?? 'unknown') as string,
          data: { error: error instanceof Error ? error.message : String(error) },
        });
      } catch {
        // Event emission must never break the failure handler
      }
    },
  },
  { event: 'app/mission.run.requested' },
  async ({ event, step }) => {
    const { missionId, userId: eventUserId, prompt, agent } = event.data;
    // ARUN-002 duration contract: queue wait is excluded. This first memoized
    // step runs only after Inngest dequeues the event, and its value survives
    // every handler replay. A bare `Date.now()` here is re-initialized on each
    // replay and previously collapsed completed runs to a few milliseconds.
    const startTime = await step.run('capture-start-time', () => Date.now());

    // Authorize the queued event against persisted ownership before ANY state
    // mutation, user-preference read, graph/SSE attribution, MCP probe, or paid
    // provider stage. Event payloads are transport input, not an ownership
    // authority. The stored owner becomes the sole principal downstream.
    const userId = await step.run('authorize-mission-owner', async () => {
      const { getMissionById } = await import('@/lib/missions');
      const mission = (await getMissionById(missionId)) as Pick<Mission, 'userId'> | null;
      const ownerId = mission?.userId?.trim();
      if (!ownerId) {
        throw new Error(`Mission ${missionId} has no persisted owner; execution was refused before provider work`);
      }
      if (ownerId !== eventUserId) {
        throw new Error(`Mission ${missionId} owner does not match the dispatched user; execution was refused`);
      }
      return ownerId;
    });

    // The Assistant authorizes the complete workflow before creating the
    // mission. Configuration can change while an Inngest event is queued or
    // across a process restart; never let that raise the worker's paid envelope
    // above the amount the user saw. COORD-012: a mission dispatched with a
    // persisted `executionEnvelope` runs on that envelope VERBATIM — the
    // worker-startup environment supplies nothing. Legacy missions without one
    // retain the configured local-runtime behavior (environment defaults plus
    // the one-sided total check).
    const executionCostEnvelope: EffectiveMissionExecution = await step.run(
      'validate-authorized-cost-envelope',
      async (): Promise<EffectiveMissionExecution> => {
        const { getMissionById } = await import('@/lib/missions');
        const mission = (await getMissionById(missionId)) as Pick<
          Mission,
          'authorizedMaxCostUsd' | 'executionEnvelope'
        > | null;
        const authorizedMaxCostUsd = mission?.authorizedMaxCostUsd;
        if (mission?.executionEnvelope) {
          // Fail-closed: a malformed envelope (components not summing to the
          // declared total, timeout above the platform ceiling, …) refuses the
          // run here, before any paid phase.
          const envelope = missionExecutionEnvelopeSchema.parse(mission.executionEnvelope);
          if (
            authorizedMaxCostUsd !== undefined &&
            ceilingCents(envelope.totalMaxCostUsd) !== ceilingCents(authorizedMaxCostUsd)
          ) {
            throw new Error(
              `Mission executionEnvelope totalMaxCostUsd $${envelope.totalMaxCostUsd.toFixed(2)} does not match ` +
                `the user-authorized $${authorizedMaxCostUsd.toFixed(2)} confirmation; nothing was started`
            );
          }
          // Requirement: persist the effective envelope BEFORE the first
          // provider call, so the mission receipt carries both the confirmed
          // (`executionEnvelope`) and effective (`effectiveExecutionEnvelope`)
          // values even if the run later dies mid-phase.
          await updateMission(missionId, { effectiveExecutionEnvelope: envelope });
          log.info('Mission execution envelope resolved from the persisted user authorization', {
            missionId,
            orchestratorMaxCostUsd: envelope.orchestratorMaxCostUsd,
            revisionMaxCostUsd: envelope.revisionMaxCostUsd,
            preludeMaxCostUsd: envelope.preludeMaxCostUsd,
            auxiliaryMaxCostUsd: envelope.auxiliaryMaxCostUsd,
            totalMaxCostUsd: envelope.totalMaxCostUsd,
            maxToolCalls: envelope.maxToolCalls,
            timeoutMinutes: envelope.timeoutMinutes,
            requestedModel: envelope.requestedModel,
            authorizedFallbackModel: envelope.authorizedFallbackModel,
          });
          return { ...envelope, envelopeSource: 'mission' };
        }
        if (
          authorizedMaxCostUsd !== undefined &&
          resolvedMissionCostEnvelope.totalMaxCostUsd > authorizedMaxCostUsd + 0.000001
        ) {
          throw new Error(
            `Mission cost envelope $${resolvedMissionCostEnvelope.totalMaxCostUsd.toFixed(2)} exceeds ` +
              `the user-authorized $${authorizedMaxCostUsd.toFixed(2)} maximum; nothing was started`
          );
        }
        // Inngest persists this return value with the validation step. Every
        // later paid phase consumes the memoized envelope, so a process restart
        // with higher environment limits cannot bypass a completed check.
        return { ...resolvedMissionCostEnvelope, envelopeSource: 'environment' };
      }
    );
    // Absent on pre-COORD-012 memoized replays — those runs keep the
    // environment-derived behavior their earlier steps already executed with.
    const envelopeFromMission = executionCostEnvelope.envelopeSource === 'mission';
    const MISSION_MAX_COST_USD = executionCostEnvelope.orchestratorMaxCostUsd;

    // OPS-004: repeat the internal-MCP preflight the dispatch surfaces already
    // ran (route + chat tool), memoized here so it can't re-ping on replay.
    // This is the last gate BEFORE any paid provider stage (skill prelude,
    // orchestrator SDK, LLM judge, revision, reflection). If the platform MCP
    // surface is unreachable at the active base URL, throwing here routes
    // through onFailure — which persists a truthful `failed` Mission + an honest
    // (zero-cost, durationUnknown) fallback AgentRun and fails the downstream
    // chain — WITHOUT entering a single paid stage. The env can change between
    // dispatch and dequeue (queue latency, process restart), so the worker must
    // re-verify rather than trust the dispatch-time check.
    await step.run('mcp-preflight', async () => {
      const preflight = await preflightMissionMcp();
      if (!preflight.ok) {
        throw new Error(formatMcpPreflightFailure(preflight));
      }
      return { ok: true as const, baseUrl: preflight.baseUrl, checked: preflight.checked };
    });

    // MISSION-006: there is deliberately NO resume-from-checkpoint branch.
    // Function `retries: 0` (set to kill the gateway-retry storm that once ran
    // 4 parallel orchestrators) means Inngest never re-invokes this handler
    // with attempt > 0, so the old resume path was unreachable dead code and
    // was removed with its `mission-resume` module. The supported recovery
    // contracts are: partial-output recovery on timeout/stream failure (below)
    // and an explicit user re-dispatch / iterate.

    // Step 1: Mark mission as running + emit agent.started
    await step.run('update-status-running', async () => {
      await updateMission(missionId, {
        status: 'running',
        progress: 10,
        progressMessage: `Starting ${agent} agent...`,
        // ARUN-009: durable post-dequeue clock for live UI rows — execution
        // age must match the terminal duration contract (queue wait excluded).
        executionStartedAt: new Date().toISOString(),
      });

      try {
        const { emitAgentEvent } = await import('@/lib/agent-events');
        await emitAgentEvent({
          type: 'agent.started',
          userId,
          missionId,
          agentType: agent,
          data: { prompt: prompt.slice(0, 200) },
        });
      } catch (err) {
        log.warn('[agent-events] Failed to emit agent.started', { error: String(err) });
      }
    });

    // Step 1.5: Create Episode for temporal graph tracking
    let episodeId: string | undefined;
    try {
      episodeId = await step.run('create-episode', async () => {
        const { createEpisode } = await import('@/lib/graph/episodes');
        const episode = await createEpisode({
          agentName: agent,
          missionId,
          userId,
          summary: prompt.slice(0, 200),
        });
        return episode.id;
      });
    } catch {
      // Episode creation is non-blocking — Neo4j may be unavailable
    }

    // Hard ceiling on prelude spend per mission ($2.00). If a sub-mission
    // cost would push cumulative spend above this, we abort the prelude
    // and let the mission proceed without that block.
    const PRELUDE_MAX_TOTAL_COST_USD = executionCostEnvelope.preludeMaxCostUsd;
    const configuredPreludePerSkill = Number(process.env.PRELUDE_PER_SKILL_COST_USD ?? '0.30');
    const PRELUDE_PER_SKILL_COST_USD =
      Number.isFinite(configuredPreludePerSkill) && configuredPreludePerSkill > 0
        ? Math.min(configuredPreludePerSkill, PRELUDE_MAX_TOTAL_COST_USD)
        : Math.min(0.3, PRELUDE_MAX_TOTAL_COST_USD);
    const configuredPreludeTimeout = Number(process.env.PRELUDE_PER_SKILL_TIMEOUT_MS ?? '60000');
    const PRELUDE_PER_SKILL_TIMEOUT_MS =
      Number.isSafeInteger(configuredPreludeTimeout) && configuredPreludeTimeout > 0
        ? configuredPreludeTimeout
        : 60_000;
    const configuredPreludeConcurrency = Number(process.env.PRELUDE_CONCURRENCY ?? '6');
    const PRELUDE_CONCURRENCY =
      Number.isSafeInteger(configuredPreludeConcurrency) && configuredPreludeConcurrency > 0
        ? configuredPreludeConcurrency
        : 6;

    // Step 1.7: Skill-activation prelude. Gated on the prompt containing a
    // CRITICAL DIMENSIONS block (P3-style structured prompts only). For each
    // required skill, dispatch a stripped-down sub-mission that produces a
    // fenced block, and persist the results on mission.skillPrelude. The
    // stitched block is then prepended to the orchestrator's user message
    // in Step 2.
    let preludeBlock = '';
    let preludeCostUsd: number | null = 0;
    let preludeCostUnavailableReason: MissionCostUnavailableReason | undefined;
    try {
      const preludeStep = await step.run('skill-activation-prelude', async () => {
        // COORD-012: an explicitly zero prelude allocation de-funds the phase.
        // Skipping here matters beyond spend: with a $0 cap the batch reserve
        // arithmetic below (remaining / per-skill) degenerates and would launch
        // helper sessions with a $0 provider budget instead of none.
        if (PRELUDE_MAX_TOTAL_COST_USD <= 0) {
          log.info('Skill prelude skipped — the authorized prelude allocation is zero', { missionId });
          return { block: '', totalCostUsd: 0 };
        }
        // Per-mission opt-out — used for controlled A/B benchmarks where one
        // arm runs without the prelude. Read enablePrelude from the mission
        // doc; undefined or true = enabled (default), false = skip.
        try {
          const { getMissionById } = await import('@/lib/missions');
          const m = (await getMissionById(missionId)) as { enablePrelude?: boolean } | null;
          if (m?.enablePrelude === false) {
            log.info('Skill prelude disabled per mission.enablePrelude=false', { missionId });
            return { block: '', totalCostUsd: 0 };
          }
        } catch (err) {
          log.warn('Skill prelude: enablePrelude read failed (treating as enabled)', {
            missionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        const {
          parseCriticalDimensions,
          splitScopeLine,
          refinePreludeTargets,
          MAX_PRELUDE_TARGETS,
          isPerEntitySkill,
          isPrecomputedSkill,
          runSkillSubMission,
          buildPreludeBlock,
        } = await import('@/lib/skill-prelude');

        const parsed = parseCriticalDimensions(prompt);
        if (!parsed || parsed.skills.size === 0) {
          log.info('Skill prelude skipped — no CRITICAL DIMENSIONS block', { missionId });
          return { block: '', totalCostUsd: 0 };
        }

        // Independent, env-configurable target-count cap (ARUN-025) — separate
        // from the prelude spend cap. Applied by refinePreludeTargets AFTER
        // normalization + dedup so a timeframe fragment or a duplicate can never
        // displace a real entity.
        const configuredMaxTargets = Number(process.env.PRELUDE_MAX_TARGETS ?? String(MAX_PRELUDE_TARGETS));
        const PRELUDE_MAX_TARGETS =
          Number.isSafeInteger(configuredMaxTargets) && configuredMaxTargets > 0
            ? configuredMaxTargets
            : MAX_PRELUDE_TARGETS;

        // Only schema-valid, resolvable, deduplicated targets may fan out into a
        // paid helper session. Generic prose, timeframes, bare numbers, and
        // duplicates are dropped here with a recorded reason (ARUN-025).
        const targetPlan = refinePreludeTargets(splitScopeLine(prompt), {
          maxTargets: PRELUDE_MAX_TARGETS,
        });
        const entities = targetPlan.accepted;
        const tasks: Array<{ skill: string; target?: string; briefContext?: string }> = [];
        // SKILL-010 — an output-time skill (red-team-claim, verify-citations, …)
        // works on material this run has not produced yet. Precomputing it from
        // a 500-character brief excerpt would spend a real helper session to
        // produce a block about nothing, so it is recorded as a deliberate
        // non-dispatch rather than silently dropped: the directive still reaches
        // the agent in the prompt, and mission-quality's procedure markers
        // measure whether the agent actually ran it.
        const directiveOnlySkills: Array<{ skill: string; reason: string }> = [];
        for (const skill of parsed.skills) {
          if (!isPrecomputedSkill(skill)) {
            directiveOnlySkills.push({ skill, reason: 'output-time-directive' });
            continue;
          }
          if (isPerEntitySkill(skill)) {
            for (const entity of entities) {
              tasks.push({ skill, target: entity });
            }
          } else {
            tasks.push({ skill, briefContext: prompt.slice(0, 500) });
          }
        }

        log.info('Skill prelude tasks', {
          missionId,
          count: tasks.length,
          skills: Array.from(parsed.skills),
          directiveOnly: directiveOnlySkills.map((d) => d.skill),
          acceptedTargets: targetPlan.accepted.length,
          rejectedTargets: targetPlan.rejected.length,
          duplicateTargets: targetPlan.duplicates.length,
          droppedForCountCap: targetPlan.droppedForCountCap.length,
        });

        // The prelude accounting ledger. Filled with dispatch outcomes below and
        // persisted even when nothing launches, so rejected / duplicate /
        // over-cap targets and the exact cost state are disclosed rather than
        // silently discarded (ARUN-025).
        const buildAccounting = (dispatch: {
          planned: number;
          executed: number;
          skipped: Array<{ skill: string; target?: string; reason: string }>;
          totalUsd: number | null;
          costUnavailableReason?: MissionCostUnavailableReason;
          aborted: boolean;
        }) => ({
          targets: {
            accepted: targetPlan.accepted,
            rejected: targetPlan.rejected,
            duplicates: targetPlan.duplicates,
            droppedForCountCap: targetPlan.droppedForCountCap,
            countCap: targetPlan.countCap,
          },
          tasks: {
            planned: dispatch.planned,
            executed: dispatch.executed,
            // Output-time directives are appended to every dispatch outcome so
            // the ledger shows the full set of required skills, and shows which
            // of them the prelude deliberately did not pay to precompute.
            skipped: [...dispatch.skipped, ...directiveOnlySkills],
          },
          cost: {
            totalUsd: dispatch.totalUsd,
            ...(dispatch.costUnavailableReason ? { costUnavailableReason: dispatch.costUnavailableReason } : {}),
            capUsd: PRELUDE_MAX_TOTAL_COST_USD,
            aborted: dispatch.aborted,
          },
        });

        if (tasks.length === 0) {
          await updateMission(missionId, {
            preludeAccounting: buildAccounting({
              planned: 0,
              executed: 0,
              skipped: [],
              totalUsd: 0,
              aborted: false,
            }),
          });
          return { block: '', totalCostUsd: 0 };
        }

        // Eagerly preload the orchestrator module BEFORE building the sync
        // factory that `runSkillSubMission` consumes. The dynamic
        // `@/lib/agent-import` resolve is deferred to runtime so unit tests
        // that mock `runSkillSubMission` (and therefore never invoke the
        // factory) don't trip the ESM resolve that Jest cannot handle —
        // when the import throws here, the catch logs a non-blocking warn
        // and `orchestratorMod` stays null. In tests the mock takes over;
        // in production the import succeeds and `createOrchestrator` is
        // called with a populated `orchestratorMod`.
        const agentsDir = path.resolve(process.cwd(), 'agent', 'agents');
        const configPath = path.resolve(process.cwd(), 'impulse.config.yaml');
        type OrchestratorMod = Awaited<ReturnType<typeof import('@/lib/agent-import').importOrchestrator>>;
        let orchestratorMod: OrchestratorMod | null = null;
        try {
          const { importOrchestrator } = await import('@/lib/agent-import');
          orchestratorMod = await importOrchestrator();
        } catch (err) {
          log.warn('Skill prelude: orchestrator preload failed (sub-missions will record errors)', {
            missionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        const createOrchestrator = () => {
          if (!orchestratorMod) {
            // Should not be reachable in production (preload either succeeded
            // or threw above and Step 1.7 was skipped). If it does fire,
            // runSkillSubMission catches and records a failed sub-mission.
            throw new Error('orchestrator module not loaded');
          }
          const subLogger = orchestratorMod.createLogger(process.env.IMPULSE_LOG_FILE);
          return new orchestratorMod.Orchestrator({
            apiKey: process.env.IMPULSE_INTERNAL_KEY,
            // Inherit the parent mission's ID so MCP calls from sub-missions
            // bind to the same mission context server-side (H9). Without
            // this, sub-mission tool calls land with userId='system' and
            // missionId=undefined, breaking any tool that requires per-user
            // or per-mission scope.
            missionId,
            agentsDir,
            configPath,
            logger: subLogger,
            permissionMode: 'bypassPermissions' as const,
            maxBudgetUsd: PRELUDE_PER_SKILL_COST_USD,
            timeoutMs: PRELUDE_PER_SKILL_TIMEOUT_MS,
          });
        };

        // Reserve each batch's full provider envelope before launching it.
        // Post-hoc accounting is too late for concurrent work: six $0.30
        // sub-missions can all be billed before the first result is inspected.
        const results: Array<Awaited<ReturnType<typeof runSkillSubMission>>> = [];
        let cumulativeCost: number | null = 0;
        let cumulativeUnavailableReason: MissionCostUnavailableReason | undefined;
        let aborted = false;
        let taskIndex = 0;
        while (taskIndex < tasks.length) {
          if (cumulativeCost === null) {
            aborted = true;
            break;
          }
          const remainingEnvelope = Math.max(0, PRELUDE_MAX_TOTAL_COST_USD - cumulativeCost);
          const affordable = Math.floor((remainingEnvelope + Number.EPSILON) / PRELUDE_PER_SKILL_COST_USD);
          const batchSize = Math.min(PRELUDE_CONCURRENCY, affordable, tasks.length - taskIndex);
          if (batchSize <= 0) {
            aborted = true;
            break;
          }
          const batch = tasks.slice(taskIndex, taskIndex + batchSize);
          taskIndex += batch.length;
          const batchResults = await Promise.all(
            batch.map((t) =>
              runSkillSubMission({
                skill: t.skill,
                target: t.target,
                briefContext: t.briefContext,
                maxCostUsd: PRELUDE_PER_SKILL_COST_USD,
                timeoutMs: PRELUDE_PER_SKILL_TIMEOUT_MS,
                createOrchestrator,
              })
            )
          );
          for (const r of batchResults) {
            results.push(r);
            if (r.costUsd === null) {
              cumulativeCost = null;
              if (r.costUnavailableReason === 'unknown-pricing') {
                cumulativeUnavailableReason ??= 'unknown-pricing';
              } else {
                cumulativeUnavailableReason = 'accounting-incomplete';
              }
            } else if (cumulativeCost !== null) {
              cumulativeCost += r.costUsd;
            }
          }
          if (cumulativeCost === null) {
            // Once one launched helper is unpriceable, the aggregate and its
            // remaining budget are unknowable. Stop launching new paid work.
            aborted = taskIndex < tasks.length;
            break;
          }
          if (cumulativeCost > PRELUDE_MAX_TOTAL_COST_USD) {
            // A sub-run exceeded the budget passed to its provider. Account
            // for every launched result honestly and stop launching more.
            log.error('Skill prelude provider exceeded its reserved cost envelope', undefined, {
              missionId,
              cumulativeCost,
              cap: PRELUDE_MAX_TOTAL_COST_USD,
            });
            aborted = taskIndex < tasks.length;
            break;
          }
        }

        // Tasks the budget/count envelope prevented from launching are recorded
        // with a reason instead of vanishing (ARUN-025).
        const skippedTasks = tasks.slice(taskIndex).map((t) => ({
          skill: t.skill,
          target: t.target,
          reason: cumulativeCost === null ? ('cost-accounting-unavailable' as const) : ('budget-exhausted' as const),
        }));
        // ARUN-022/AI-029 — each launched helper session is a paid out-of-process
        // Anthropic turn. Flush its provider-reported per-SERVED-MODEL usage as
        // durable receipts before the in-memory summary is discarded; without
        // this the only trace of this spend is the aggregated `preludeCostUsd`,
        // with no served model and no token/cache counters.
        //
        // Identity: `<taskIndex>-<firedAt epoch>`. The index alone would make a
        // step RETRY (which re-dispatches genuinely new paid sessions) collide
        // with the previous attempt's receipts and be recorded as a conflict;
        // folding in the immutable dispatch instant gives a retry its own
        // identity while a re-flush of the SAME results stays idempotent.
        //
        // FAILED helpers are receipted too — a failed session still burned
        // tokens. Fully contained: a ledger failure must never perturb the
        // prelude it observes.
        try {
          const { flushSubSessionUsageReceipts } = await import('@/lib/mission-usage-receipts');
          for (const [index, helper] of results.entries()) {
            if (!helper.modelUsage || Object.keys(helper.modelUsage).length === 0) continue;
            const firedAtMs = Date.parse(helper.firedAt);
            if (!Number.isFinite(firedAtMs)) continue;
            await flushSubSessionUsageReceipts({
              missionId,
              owner: `user:${userId}`,
              asOf: helper.firedAt,
              kind: 'skill-prelude',
              sessionKey: `${index}-${firedAtMs}`,
              modelUsage: helper.modelUsage,
            });
          }
        } catch (receiptError) {
          log.warn('Skill-prelude usage receipt flush failed (best-effort, non-fatal)', {
            missionId,
            error: receiptError instanceof Error ? receiptError.message : String(receiptError),
          });
        }

        await updateMission(missionId, {
          // `modelUsage` is in-memory only: its durable home is the receipt
          // ledger flushed above, not a second copy on the mission document.
          skillPrelude: results.map(({ modelUsage: _modelUsage, ...persisted }) => persisted),
          preludeAccounting: buildAccounting({
            planned: tasks.length,
            executed: results.length,
            skipped: skippedTasks,
            totalUsd: cumulativeCost,
            ...(cumulativeUnavailableReason ? { costUnavailableReason: cumulativeUnavailableReason } : {}),
            aborted,
          }),
        });

        const successCount = results.filter((r) => r.success).length;
        log.info('Skill prelude complete', {
          missionId,
          requested: tasks.length,
          succeeded: successCount,
          failed: results.length - successCount,
          totalCostUsd: cumulativeCost,
          costUnavailableReason: cumulativeUnavailableReason,
          aborted,
        });

        // Return both the prompt block AND the aggregated cost so the
        // outer scope can roll prelude spend into the parent mission's
        // costUsd (H2). Without this, the parent mission's costUsd shows
        // only the orchestrator's spend — hiding 30–80% of actual cost
        // for prelude-enabled missions.
        return {
          block: buildPreludeBlock(results),
          totalCostUsd: cumulativeCost,
          ...(cumulativeUnavailableReason ? { costUnavailableReason: cumulativeUnavailableReason } : {}),
        };
      });
      preludeBlock = preludeStep.block;
      preludeCostUsd = preludeStep.totalCostUsd;
      preludeCostUnavailableReason =
        preludeStep.costUnavailableReason ?? (preludeStep.totalCostUsd === null ? 'accounting-incomplete' : undefined);
    } catch (err) {
      log.warn('Skill prelude step failed (non-blocking)', {
        missionId,
        error: err instanceof Error ? err.message : String(err),
      });
      preludeBlock = '';
      // The step may have launched provider work before failing. Its total is
      // therefore unavailable, not an exact zero.
      preludeCostUsd = null;
      preludeCostUnavailableReason = 'accounting-incomplete';
    }

    // Step 2: Run the orchestrator. Per-step retries inherit from the
    // function-level `retries: 0` above — Inngest's StepOptions has no
    // per-step retries field. Setting function retries to 0 cascades to
    // every step including this one, so the gateway-timeout retries that
    // produced 4 parallel orchestrator instances are gone too.
    const result = await step.run('execute-orchestrator', async () => {
      // Task 0.4: Use shared import utility (centralizes Turbopack bypass)
      const { importOrchestrator } = await import('@/lib/agent-import');
      const agentsDir = path.resolve(process.cwd(), 'agent', 'agents');
      const configPath = path.resolve(process.cwd(), 'impulse.config.yaml');

      const mod = await importOrchestrator();

      // Create agent-side file logger so operator can:
      //   tail -f <project>/logs/agent.log
      const agentLogger = mod.createLogger(
        process.env.IMPULSE_LOG_FILE // explicit override, or default <project>/logs/agent.log
      );

      agentLogger.info(`[mission] id=${missionId} agent=${agent} prompt="${prompt.slice(0, 120)}"`);

      // Build audit + budget + permissions hooks so the SDK logs every tool
      // call, observes the configured token reference, enforces the tool-call
      // cap, and grants subagents correct MCP server access.
      const { hooks: auditHooks } = mod.createAuditHooks();

      // SEC-014: the capability allowlist is NOT built here any more.
      //
      // This worker used to assemble a per-agent MCP-server map and hand it to
      // `createPermissionsHooks`. That arrangement left the parent orchestrator
      // unchecked, allowed non-MCP
      // built-ins (`Bash`, `Write`, `Edit`, …) were allowed unconditionally, and
      // a profile-load failure fell OPEN with "subagents will have unrestricted
      // access". The result was a Creator that wrote repository-root HTML when
      // the Report MCP failed.
      //
      // The Orchestrator now derives the policy from the same agent definitions
      // and MCP configs it hands the SDK, and installs the enforcing hook
      // itself, so the transport and the boundary cannot disagree and a worker
      // omission cannot disable it. The profile load below is only for budgets
      // and timeouts.

      // Per-agent wall-clock timeout. COORD-012: a persisted execution
      // envelope carries the user-authorized timeout and tool-call cap, and
      // that authorization outranks both the environment default and the
      // profile's own narrowing — the profile is a deployment default, not the
      // user's confirmation. Legacy missions keep the env default plus the
      // per-agent config.yaml override.
      const envelopeTimeoutMs =
        envelopeFromMission && executionCostEnvelope.timeoutMinutes !== undefined
          ? Math.min(executionCostEnvelope.timeoutMinutes * 60 * 1000, MAX_MISSION_TIMEOUT_MS)
          : undefined;
      let missionTimeoutMs = envelopeTimeoutMs ?? DEFAULT_MISSION_TIMEOUT_MS;
      let activeAgentTimeoutMinutes: number | undefined;
      let activeMissionLimits = {
        tokenBudget: MISSION_TOKEN_BUDGET,
        maxToolCalls:
          envelopeFromMission && executionCostEnvelope.maxToolCalls !== undefined
            ? executionCostEnvelope.maxToolCalls
            : MISSION_MAX_TOOL_CALLS,
      };

      try {
        const profiles = mod.loadAllProfiles(agentsDir) as Map<
          string,
          {
            budget: { max_tokens: number; max_tool_calls: number };
            mcp_servers: { internal: string[]; external: string[] };
            timeoutMinutes?: number;
          }
        >;
        const activeProfile = profiles.get(agent);
        const profileNarrowedLimits = resolveEffectiveAgentMissionLimits(resolvedMissionLimits, activeProfile?.budget);
        activeMissionLimits =
          envelopeFromMission && executionCostEnvelope.maxToolCalls !== undefined
            ? { tokenBudget: profileNarrowedLimits.tokenBudget, maxToolCalls: executionCostEnvelope.maxToolCalls }
            : profileNarrowedLimits;
        if (activeProfile) {
          log.info('Applied active agent mission limits', {
            agent,
            tokenReference: activeMissionLimits.tokenBudget,
            maxToolCalls: activeMissionLimits.maxToolCalls,
            maxToolCallsSource:
              envelopeFromMission && executionCostEnvelope.maxToolCalls !== undefined ? 'envelope' : 'profile-env',
          });
        }
        if (activeProfile?.timeoutMinutes) {
          if (envelopeTimeoutMs !== undefined) {
            log.info('Per-agent profile timeout outranked by the user-authorized envelope timeout', {
              agent,
              profileTimeoutMinutes: activeProfile.timeoutMinutes,
              envelopeTimeoutMinutes: executionCostEnvelope.timeoutMinutes,
            });
          } else {
            activeAgentTimeoutMinutes = activeProfile.timeoutMinutes;
            missionTimeoutMs = Math.min(activeAgentTimeoutMinutes * 60 * 1000, MAX_MISSION_TIMEOUT_MS);
            log.info('Per-agent mission timeout', {
              agent,
              timeoutMinutes: activeAgentTimeoutMinutes,
              cappedMs: missionTimeoutMs,
            });
          }
        }
      } catch (err) {
        // SEC-014: this catch no longer affects the capability boundary. The
        // Orchestrator loads the same profiles to build its policy, and a load
        // failure there throws out of its constructor and fails the mission —
        // fail-closed. All that is lost here is the per-agent budget/timeout
        // override, so the mission continues on the env-level defaults.
        log.warn('Failed to load agent profiles for budget/timeout overrides — using mission defaults', {
          error: String(err),
        });
      }

      const { hooks: budgetHooks, budgetState } = mod.createBudgetHooks(
        activeMissionLimits.tokenBudget,
        activeMissionLimits.maxToolCalls
      );
      let hasObservedUsage = false;
      const readBudgetCost = (): {
        costUsd: number | null;
        costUnavailableReason?: MissionCostUnavailableReason;
      } => {
        if (!hasObservedUsage) {
          return { costUsd: null, costUnavailableReason: 'accounting-incomplete' };
        }
        const state = budgetState as {
          estimatedCostUsd?: number | null;
          costUnavailableReason?: string;
        };
        if (state.estimatedCostUsd === null) {
          return {
            costUsd: null,
            costUnavailableReason: canonicalCostUnavailableReason(state.costUnavailableReason),
          };
        }
        return { costUsd: state.estimatedCostUsd ?? 0 };
      };

      // Tool call event hooks — emits agent.tool_call events to the SSE gateway
      // with per-call timing, and updates mission progress based on tool call count.
      // Fire-and-forget — never blocks the agent, never throws.
      let toolCallCount = 0;
      const toolStartTimes = new Map<string, number>();

      // PreToolUse hook: record tool start time
      const toolCallPreHook = {
        hooks: [
          async (input: unknown) => {
            try {
              const hookInput = input as { tool_use_id?: string };
              if (hookInput.tool_use_id) {
                toolStartTimes.set(hookInput.tool_use_id, Date.now());
              }
            } catch {
              // Timing is best-effort
            }
            return { continue: true as const };
          },
        ],
      };

      // PostToolUse hook: emit event with timing
      const toolCallPostHook = {
        hooks: [
          async (input: unknown) => {
            toolCallCount++;
            try {
              const hookInput = input as {
                tool_name: string;
                tool_input: unknown;
                tool_response: unknown;
                tool_use_id?: string;
                agent_type?: string;
              };

              // Compute per-call duration
              let durationMs: number | undefined;
              if (hookInput.tool_use_id) {
                const startTime = toolStartTimes.get(hookInput.tool_use_id);
                if (startTime !== undefined) {
                  durationMs = Date.now() - startTime;
                  toolStartTimes.delete(hookInput.tool_use_id);
                }
              }

              const { emitAgentEvent } = await import('@/lib/agent-events');
              const budgetCost = readBudgetCost();
              await emitAgentEvent({
                type: 'agent.tool_call',
                userId,
                missionId,
                agentType: agent,
                data: {
                  toolName: hookInput.tool_name,
                  toolCallNumber: toolCallCount,
                  // Truncate input/response to avoid bloating Firestore docs.
                  // SEC-013: redact first — these are PERSISTED to Firestore and
                  // rendered in the activity log, so an MCP header, a signed URL,
                  // or an env value echoed back by a tool would be retained and
                  // exportable. Redaction runs before truncation so a credential
                  // straddling the 500-char cut is still masked, not halved.
                  toolInput: redactText(JSON.stringify(hookInput.tool_input ?? '')).slice(0, 500),
                  toolResponse: redactText(JSON.stringify(hookInput.tool_response ?? '')).slice(0, 500),
                  ...(budgetCost.costUsd === null
                    ? { costUnavailableReason: budgetCost.costUnavailableReason }
                    : { costUsd: budgetCost.costUsd }),
                  tokensUsed: budgetState.tokensUsed,
                  ...(durationMs !== undefined ? { durationMs } : {}),
                },
              });

              // Update mission progress every 5 tool calls (10% → 15% → 20% ... → 90% max)
              // Also persist running cost so onFailure / orchestrator-crash paths can
              // surface the pre-failure spend (H1). Without this, mid-mission crashes
              // strip the cost and the mission shows $0 when it actually burned $$$.
              if (toolCallCount % 5 === 0) {
                const progress = Math.min(10 + Math.floor(toolCallCount / 5) * 5, 90);
                const costUpdate =
                  budgetCost.costUsd === null
                    ? {
                        costUnavailableReason: budgetCost.costUnavailableReason!,
                        costUnavailableComponents: ['orchestrator'] as MissionCostComponent[],
                      }
                    : { costUsd: budgetCost.costUsd };
                await updateMission(missionId, {
                  progress,
                  progressMessage: `Processing... (${toolCallCount} tool calls)`,
                  // ARUN-020: persist the running TOKEN total beside the running
                  // cost. Both were already in hand here; only the cost was
                  // durable, so the in-flight token count existed solely on the
                  // ephemeral heartbeat and the Runs list could show a number the
                  // run detail had no way to reproduce.
                  runningTokensUsed: budgetState.tokensUsed,
                  ...costUpdate,
                });
              }
            } catch {
              // Event emission must never break the agent loop
            }
            return { continue: true as const };
          },
        ],
      };

      // Merge hook arrays by event name (PreToolUse, PostToolUse, etc.)
      const mergedHooks: Record<string, unknown[]> = {};
      for (const hookSet of [auditHooks, budgetHooks]) {
        for (const [eventName, matchers] of Object.entries(hookSet)) {
          if (!mergedHooks[eventName]) mergedHooks[eventName] = [];
          mergedHooks[eventName].push(...(matchers as unknown[]));
        }
      }
      // Append tool timing/event hooks
      if (!mergedHooks['PreToolUse']) mergedHooks['PreToolUse'] = [];
      mergedHooks['PreToolUse'].push(toolCallPreHook);
      if (!mergedHooks['PostToolUse']) mergedHooks['PostToolUse'] = [];
      mergedHooks['PostToolUse'].push(toolCallPostHook);

      // Checkpoint callback — persists partial mission output every 5 turns
      // so timed-out missions still return usable content.
      const onCheckpoint = async ({ turn, partialResult }: { turn: number; partialResult: string }) => {
        try {
          await updateMission(missionId, {
            partialResult,
            partialCheckpointTurn: turn,
          });
          agentLogger.info(`[checkpoint] turn=${turn} bytes=${partialResult.length}`);
        } catch (err) {
          agentLogger.error(`[checkpoint-error] turn=${turn}: ${err instanceof Error ? err.message : String(err)}`);
          // Never throw from the callback — checkpointing is best-effort.
        }
      };

      // Passive preference harvesting (Item 2 of quality-deepening plan) —
      // read the user's profile (if the nightly harvester has populated it)
      // and render a USER PROFILE preamble block. Injected before the
      // orchestrator's permission map so the agent sees the context
      // without the prompt restating it every time.
      let userPreferencesPreamble = '';
      try {
        const { getMissionUserPreferences, buildUserPreferencesPreamble } = await import('@/lib/user-preferences');
        const prefs = await getMissionUserPreferences(userId);
        userPreferencesPreamble = buildUserPreferencesPreamble(prefs);
        if (userPreferencesPreamble) {
          agentLogger.info(`[user-preferences] preamble injected (${userPreferencesPreamble.length}B)`);
        }
      } catch {
        /* best-effort — missing preferences doc is normal for fresh users */
      }

      // Bug B: load the mission's frozen slot manifest so the orchestrator
      // can surface the allowed slotNames to the agent in its preamble.
      // Without this, agents invent off-manifest slot names like
      // "agentic-frameworks-2026" that publishReport then rejects, leaving
      // the FS draft orphaned and burning the rest of the budget on retries.
      let missionSlots: Array<{ name: string; intent?: string }> | undefined;
      // REPORT-015: the mission's resolved DesignBrief, rendered into the
      // report-authoring prompt below. Read from the SAME mission document as
      // the slots so this costs no extra fetch.
      let designBriefBlock = '';
      try {
        const { getMissionById } = await import('@/lib/missions');
        const m = (await getMissionById(missionId)) as {
          slots?: Array<{ name: string; intent?: string }>;
          designBrief?: import('@/lib/schemas/design-brief').DesignBrief;
        } | null;
        missionSlots = m?.slots;
        if (agent === 'creator' && m?.designBrief) {
          const { buildDesignBriefPromptBlock } = await import('@/lib/reports/design-brief-instruction');
          designBriefBlock = buildDesignBriefPromptBlock(m.designBrief);
          if (designBriefBlock) {
            agentLogger.info(`[design-brief] instruction injected (${designBriefBlock.length}B)`);
          }
        }
      } catch {
        /* best-effort — orchestrator falls back to slot-less preamble */
      }

      // COORD-012 requirement 7: the values this step is about to hand the
      // SDK must equal the confirmed envelope exactly. They are derived from
      // the memoized envelope above, so this guard costs nothing in the happy
      // path — it exists to refuse execution (before any provider spend in
      // this step) if a future edit ever reintroduces an environment- or
      // profile-derived value into an envelope-authorized mission.
      if (envelopeFromMission) {
        const confirmedEnvelope = executionCostEnvelope as AgentMissionExecutionEnvelope;
        const mismatches = describeMissionEnvelopeMismatch(confirmedEnvelope, {
          ...confirmedEnvelope,
          orchestratorMaxCostUsd: MISSION_MAX_COST_USD,
          maxToolCalls: activeMissionLimits.maxToolCalls,
          timeoutMinutes: Math.round(missionTimeoutMs / 60_000),
        });
        if (mismatches.length > 0) {
          throw new Error(
            `Mission effective execution values diverged from the confirmed envelope: ${mismatches.join('; ')}; ` +
              'execution was refused'
          );
        }
      }

      const orchestrator = new mod.Orchestrator({
        // MCP server auth key — NOT the Anthropic API key.
        // ANTHROPIC_API_KEY is read from env by the Agent SDK automatically.
        apiKey: process.env.IMPULSE_INTERNAL_KEY,
        agentsDir,
        configPath,
        logger: agentLogger,
        // bypassPermissions: there is no interactive user in Inngest functions
        // to answer a permission prompt. SEC-014: this is NOT "no boundary" —
        // the Orchestrator installs a default-deny PreToolUse capability hook
        // and an SDK-level deny list, both derived from the agent profiles, so
        // host mutation is refused whatever the permission mode says.
        permissionMode: 'bypassPermissions' as const,
        hooks: mergedHooks,
        maxBudgetUsd: MISSION_MAX_COST_USD,
        roleAgent: agent,
        // COORD-012: a persisted envelope pins the exact model the user
        // authorized; passing it as the parent-turn override means profile or
        // environment drift in the worker can never substitute another model.
        // (`authorizedFallbackModel` is the dispatch-time receipt of the
        // configured fallback; transparent-retry substitution authorization
        // continues to flow through the orchestrator's own machinery.)
        ...(envelopeFromMission && executionCostEnvelope.requestedModel
          ? { model: executionCostEnvelope.requestedModel }
          : {}),
        // COORD-012: the envelope is ALSO the authority over the SDK's
        // transparent-retry fallback. A persisted authorization pins exactly
        // that model; a mission that authorized none disables the retry
        // (explicit null) so the worker environment's configured fallback and
        // the built-in Haiku default can never spend without authorization.
        // Legacy missions omit the option and keep the historical chain.
        ...(envelopeFromMission
          ? { authorizedFallbackModel: executionCostEnvelope.authorizedFallbackModel ?? null }
          : {}),
        onCheckpoint,
        // MISSION-001: sync the orchestrator's real per-turn spend into
        // budgetState so live events, the in-agent 80% budget warning, and the
        // wall-clock-timeout path stop reporting $0 / 0 tokens. The 4th arg is
        // the authoritative cumulative token total (the PostToolUse hook's own
        // counter never sees the SDK usage stream). Never throws.
        onUsage: (u: {
          costUsd: number | null;
          tokenUsage: { input: number; output: number };
          costUnavailableReason?: string;
        }) => {
          try {
            budgetState.updateCost(
              u.costUsd,
              MISSION_MAX_COST_USD,
              MISSION_WARN_THRESHOLD,
              u.tokenUsage.input + u.tokenUsage.output,
              u.costUnavailableReason
            );
            hasObservedUsage = true;
          } catch {
            /* telemetry sync must never break the agent loop */
          }
        },
        timeoutMs: missionTimeoutMs,
        userPreferencesPreamble,
        // Surface missionId to the agent. The MCP layer binds this to the
        // request context; publishReport then enforces the slot manifest
        // server-side without the agent needing to pass missionId explicitly.
        missionId,
        slots: missionSlots,
        onSkillInvocation: async (inv: { skill: string; args?: string; firedAt: string; turn: number }) => {
          try {
            const { appendSkillInvocation } = await import('@/lib/missions');
            await appendSkillInvocation(missionId, inv);
            agentLogger.info(`[skill-invocation] turn=${inv.turn} skill=${inv.skill}`);
          } catch {
            /* skill telemetry is non-critical */
          }
        },
        watchdog: {
          enabled: true,
          // defaults: 3 duplicate fingerprints, 120/300s idle warn/abort, 5 empty turns
        },
        // Bug H: external cancel signal. The orchestrator polls this every
        // 30s alongside the watchdog idle check; when it returns true, the
        // SDK loop aborts via the watchdog channel (cost capture + partial
        // recovery still run). This makes mission.status='failed' writes
        // from outside (UI cancel, kill scripts) actually stop spending,
        // instead of letting the function run to the cost cap.
        cancelCheck: async () => {
          try {
            const { getMissionById } = await import('@/lib/missions');
            const m = (await getMissionById(missionId)) as { status?: string } | null;
            return !!m && m.status !== 'running' && m.status !== 'pending';
          } catch {
            return false;
          }
        },
      });

      // Heartbeat: emit agent.thinking every 30s so frontend knows the agent is alive
      const heartbeatInterval = setInterval(async () => {
        try {
          const { emitAgentEvent } = await import('@/lib/agent-events');
          const budgetCost = readBudgetCost();
          await emitAgentEvent({
            type: 'agent.thinking',
            userId,
            missionId,
            agentType: agent,
            data: {
              status: 'processing',
              toolCalls: budgetState.toolCallCount,
              tokensUsed: budgetState.tokensUsed,
              ...(budgetCost.costUsd === null
                ? { costUnavailableReason: budgetCost.costUnavailableReason }
                : { costUsd: budgetCost.costUsd }),
              maxCostUsd: MISSION_MAX_COST_USD,
              elapsed: Math.round((Date.now() - startTime) / 1000),
            },
          });
        } catch {
          /* heartbeat is non-critical */
        }
      }, 15_000);

      // Wall-clock timeout — prevents runaway missions that burn budget
      let missionResult;
      let missionTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          missionTimeoutHandle = setTimeout(() => {
            const timeoutMinutes = Math.round(missionTimeoutMs / 60000);
            reject(
              new Error(`Mission timed out after ${timeoutMinutes} ${timeoutMinutes === 1 ? 'minute' : 'minutes'}`)
            );
          }, missionTimeoutMs);
        });
        // Task 3.11: Inject recent reflections into prompt (post-mission reflection learning)
        let augmentedPrompt = prompt;
        // Skill-activation prelude (Step 1.7) precomputes innovation-discipline
        // blocks. Prepend them so the agent sees them in its first turn.
        if (preludeBlock) {
          const { injectIntoPrompt } = await import('@/lib/skill-prelude');
          augmentedPrompt = injectIntoPrompt(preludeBlock, augmentedPrompt);
        }
        // REPORT-015: Creator, the report writer, sees the palette/typography
        // the server is about to apply. Research agents do not author the
        // report and must not pay this prompt/token cost.
        if (designBriefBlock) {
          augmentedPrompt = `${augmentedPrompt}\n\n${designBriefBlock}`;
        }
        try {
          const { queryRecentReflections, buildReflectionPromptBlock } = await import('@/lib/graph/agent-reflections');
          const reflections = await queryRecentReflections({ agentName: agent, limit: 5 });
          const block = buildReflectionPromptBlock(reflections);
          if (block) augmentedPrompt = augmentedPrompt + block;
        } catch {
          // Neo4j unavailable — use original prompt
        }

        missionResult = await Promise.race([orchestrator.runMission(augmentedPrompt), timeoutPromise]);
      } catch (err) {
        // Timeout or orchestrator error — FORCE a final-flush from the
        // orchestrator's in-memory accumulator (may contain up to 4 turns of
        // work that happened between the last 5-turn checkpoint and the
        // abort). Then read back from Firestore to get whichever partial
        // is larger.
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const errorMsg = err instanceof Error ? err.message : String(err);
        agentLogger.error(`[mission] id=${missionId} TIMEOUT/ERROR after ${elapsed}s: ${errorMsg}`);

        // MISSION-001: Promise.race abandoned the orchestrator's runMission but
        // left it iterating — abort it so it stops spending immediately rather
        // than running until the 30s cancelCheck poll trips. Then snapshot its
        // real cumulative usage so the recovered result records true cost +
        // input/output tokens instead of the $0 / 0 that stale budgetState
        // reported for a genuinely billed run.
        try {
          orchestrator.abort('wall-clock timeout / mission error');
        } catch {
          /* abort is best-effort */
        }
        let usageOnAbort: {
          costUsd: number | null;
          tokenUsage: { input: number; output: number };
          costUnavailableReason?: string;
        } | null = null;
        try {
          usageOnAbort = orchestrator.getUsageSnapshot();
        } catch {
          /* snapshot is best-effort; fall back to budgetState below */
        }

        // Final-flush: ask the orchestrator for its current accumulator
        // snapshot and persist if it's materially larger than whatever's
        // already in Firestore.
        try {
          const final = orchestrator.getAccumulatedPartial();
          if (final.partialResult.length > 0) {
            await updateMission(missionId, {
              partialResult: final.partialResult,
              partialCheckpointTurn: final.turn,
            });
            agentLogger.info(`[checkpoint-final-flush] turn=${final.turn} bytes=${final.partialResult.length}`);
          }
        } catch {
          /* final flush is best-effort */
        }

        let partialResult: string | undefined;
        let partialCheckpointTurn: number | undefined;
        try {
          const { getMissionById } = await import('@/lib/missions');
          const current = (await getMissionById(missionId)) as unknown as {
            partialResult?: string;
            partialCheckpointTurn?: number;
          } | null;
          partialResult = current?.partialResult;
          partialCheckpointTurn = current?.partialCheckpointTurn;
        } catch {
          /* if we can't read back, fall through to the error-only path */
        }

        // Single-shot mission semantics: do not re-throw transient stream
        // errors to trigger an Inngest retry.
        // Each "retry" is a fresh Anthropic SDK session that re-runs all
        // research from scratch — there is no mid-stream resume at the
        // LLM layer, so duplicate work can also clobber the final write.
        // Failures now resolve cleanly with whatever partial we managed to save;
        // the user sees the error and decides whether to dispatch again.
        const recoveredResult = partialResult
          ? `${partialResult}\n\n---\n\n> ⚠️ **Partial output** — this mission hit its ${Math.round(
              missionTimeoutMs / 60000
            )}-minute time budget at turn ${partialCheckpointTurn ?? '?'} (${elapsed}s elapsed). The text above is the last checkpoint; the agent did not reach a clean final section.`
          : `Mission failed: ${errorMsg}`;

        if (partialResult) {
          agentLogger.info(
            `[checkpoint-promotion] mission=${missionId} turn=${partialCheckpointTurn ?? '?'} bytes=${partialResult.length} — saved work on timeout`
          );
        }

        // Tier 3 Task 6 — workspace file salvage. Scan the agent's workspace
        // for artifacts written during the run (HTML drafts, markdown,
        // JSON scratch, etc.) and attach them to the mission so the user
        // gets whatever the agent produced on disk, not just in-memory text.
        try {
          const { salvageWorkspace } = await import('@/lib/mission-salvage');
          const workspaceRoot = path.resolve(process.cwd(), 'workspace');
          const attachments = salvageWorkspace(workspaceRoot, agent, missionId);
          if (attachments.length > 0) {
            await updateMission(missionId, { attachments });
            agentLogger.info(
              `[workspace-salvage] mission=${missionId} attachments=${attachments.length} ` +
                `bytes=${attachments.reduce((a, b) => a + b.sizeBytes, 0)}`
            );
          }
        } catch (err) {
          agentLogger.error(`[workspace-salvage-error] ${err instanceof Error ? err.message : String(err)}`);
          // Salvage is best-effort; never block the timeout recovery path.
        }

        // The BudgetState starts at zero before the first callback. That is a
        // display baseline, not proof of a zero-dollar provider run. If the
        // authoritative snapshot throws and onUsage never fired, accounting is
        // incomplete rather than an exact $0.
        const fallbackBudgetCost = hasObservedUsage
          ? readBudgetCost()
          : ({ costUsd: null, costUnavailableReason: 'accounting-incomplete' } as const);
        const abortCostUsd = usageOnAbort ? usageOnAbort.costUsd : fallbackBudgetCost.costUsd;
        const abortUnavailableReason: MissionCostUnavailableReason | undefined =
          abortCostUsd === null
            ? canonicalCostUnavailableReason(
                usageOnAbort?.costUnavailableReason ?? fallbackBudgetCost.costUnavailableReason
              )
            : undefined;
        missionResult = {
          success: false,
          result: recoveredResult,
          // Surface the actual pre-timeout spend rather than hardcoding 0.
          // Prefer the orchestrator's authoritative snapshot (real cost + the
          // input/output split); fall back to budgetState (kept fresh by the
          // onUsage sync) only if the snapshot was unavailable (MISSION-001).
          costUsd: abortCostUsd,
          ...(abortUnavailableReason ? { costUnavailableReason: abortUnavailableReason } : {}),
          tokenUsage: usageOnAbort?.tokenUsage ?? { input: budgetState.tokensUsed, output: 0 },
          numTurns: partialCheckpointTurn ?? 0,
          durationApiMs: elapsed * 1000,
          errors: [errorMsg],
          partial: !!partialResult,
        };
      } finally {
        if (missionTimeoutHandle !== undefined) clearTimeout(missionTimeoutHandle);
        clearInterval(heartbeatInterval);
      }

      // Log mission summary with full token breakdown
      const mu = missionResult.modelUsage;
      const cacheInfo = mu
        ? (Object.values(mu) as { cacheReadInputTokens?: number }[])
            .map((u) => `cache_read=${u.cacheReadInputTokens}`)
            .join(' ')
        : '';
      const missionCostLog =
        typeof missionResult.costUsd === 'number' ? `$${missionResult.costUsd.toFixed(4)}` : 'unavailable';
      agentLogger.info(
        `[mission] id=${missionId} success=${missionResult.success} cost=${missionCostLog} turns=${missionResult.numTurns ?? '?'} tokens=${missionResult.tokenUsage?.input ?? 0}+${missionResult.tokenUsage?.output ?? 0} ${cacheInfo} duration=${((missionResult.durationApiMs ?? 0) / 1000).toFixed(1)}s`
      );
      if (!missionResult.success && missionResult.errors?.length) {
        agentLogger.error(`[mission] id=${missionId} errors: ${missionResult.errors.join('; ')}`);
      }
      agentLogger.close();
      return missionResult;
    });

    // OPS-004: the Orchestrator runs its OWN (broader, key-checked) MCP preflight
    // at the start of runMission and, on failure, RETURNS an ordinary failed
    // MissionResult tagged with a typed `failureKind`. That catches the realistic
    // asymmetric/stale case the worker's memoized `mcp-preflight` step can miss
    // (env drift between dequeue and execute, or a per-server outage). Without
    // this guard the worker would continue into recover/L1/fact-check/judge/
    // revision/reflection on a $0 no-deliverable result and pay for every one.
    // No deliverable exists, so throwing here (→ onFailure) is terminal-safe:
    // it persists a truthful `failed` Mission + honest fallback AgentRun and
    // skips every later paid stage.
    const preSpendFailureKind = (result as { failureKind?: string }).failureKind;
    if (
      preSpendFailureKind === 'mcp-preflight-failed' ||
      preSpendFailureKind === 'unsupported-model' ||
      preSpendFailureKind === 'mcp-credential-containment-failed'
    ) {
      const reason = result.errors?.[0] ?? `${preSpendFailureKind}: pre-spend mission refusal`;
      // The orchestrator preflight runs before the first provider turn. Its
      // returned zero is therefore an exact measured value, not a missing
      // estimate. Persist it before throwing so onFailure cannot downgrade the
      // known $0 + zero-token receipt to "usage unavailable".
      try {
        await updateMission(missionId, {
          ...(result.costUsd === null
            ? {
                costUnavailableReason: 'accounting-incomplete' as const,
                costUnavailableComponents: ['orchestrator'] as MissionCostComponent[],
              }
            : { costUsd: result.costUsd }),
          tokenUsage: result.tokenUsage,
        });
      } catch (persistErr) {
        log.warn('Failed to persist orchestrator-preflight zero-cost receipt before terminal failure', {
          missionId,
          error: persistErr instanceof Error ? persistErr.message : String(persistErr),
        });
      }
      log.error('Mission aborted at orchestrator MCP preflight — skipping every later paid stage', undefined, {
        missionId,
        reason,
      });
      throw new Error(reason);
    }

    // MISSION-010 / REPORT-002: resolve owner-bound deliverable truth once,
    // immediately after the SDK run and before any post-run quality stage. The
    // step persists canonical pointers before it returns, while its memoized
    // payload stays compact (owner + promise + IDs; never Report HTML).
    const reportTruth = await step.run('resolve-owner-scoped-report-truth', async () =>
      resolveMissionReportTruth({
        missionId,
        eventUserId: userId,
        executionSucceeded: result.success,
      })
    );
    const paidQualityStagesAllowed =
      result.success &&
      (!reportTruth.promisedReport || (reportTruth.resolution.ok && reportTruth.resolution.reportIds.length > 0));

    // Step 2.55: Recover partial output on non-timeout failures.
    // When runMission itself catches an internal error (watchdog abort,
    // SDK stream error, etc.) it RETURNS a failure MissionResult — it
    // doesn't throw. That means Promise.race resolves normally and the
    // Inngest handler's wall-clock-timeout catch block never fires, so
    // partialResult is left orphaned in Firestore. This step patches that
    // gap: if the mission failed AND a partialResult exists AND no usable
    // result was returned, promote the partial so the user gets back what
    // the agent produced before the abort.
    const recoveredResult = await step.run('recover-partial-on-failure', async () => {
      if (result.success) return null; // successful runs are evaluated as-is; recovery is failure-only

      const errMsg = (result.errors?.[0] ?? 'non-timeout failure').slice(0, 200);

      // 1. Prefer the PUBLISHED OWNED REPORT — the real artifact. Budget exhaustion
      //    (or a watchdog abort) makes runMission RETURN a failure with an empty
      //    result AFTER the agent already published its report, orphaning it.
      //    Salvage a reference (carrying the report id) so Step 2.7 fetches the
      //    HTML by that id and L1 + the fact-check evaluate the real report
      //    instead of marking the mission empty (result-exists FAIL).
      const recoveredReportId = reportTruth.resolution.reportIds[0];
      if (recoveredReportId) {
        const ref = `Report published: ${recoveredReportId}. ` + `(Recovered after the run ended early: ${errMsg}.)`;
        await updateMission(missionId, { result: ref, partial: true });
        log.info('Recovered owned published report into empty/failed result', {
          missionId,
          reportId: recoveredReportId,
          errMsg,
        });
        return ref;
      }

      // 2. Else promote the in-memory partial checkpoint text.
      try {
        const { getMissionById } = await import('@/lib/missions');
        const current = (await getMissionById(missionId)) as unknown as {
          partialResult?: string;
          partialCheckpointTurn?: number;
        } | null;
        const partial = current?.partialResult;
        if (!partial || partial.length < 100) return null;

        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const recovered =
          `${partial}\n\n---\n\n> ⚠️ **Partial output** — this mission ended early (${errMsg}). ` +
          `The text above is the last checkpoint at turn ${current?.partialCheckpointTurn ?? '?'} (${elapsed}s elapsed). ` +
          `The agent did not reach a clean final section.`;
        await updateMission(missionId, { result: recovered, partial: true });
        log.info('Recovered partial output on non-timeout failure', {
          missionId,
          partialBytes: partial.length,
          errMsg,
        });
        return recovered;
      } catch (err) {
        log.warn('Partial-output recovery failed', {
          missionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return null;
    });

    // Apply the recovery to the in-scope `result` so downstream steps (quality
    // eval, mission finalize) see it. This runs in the handler body — re-executed
    // on every Inngest replay — using the step's MEMOIZED return; a closure
    // mutation INSIDE the step body is lost across replays (the original bug).
    if (recoveredResult) {
      (result as { result?: string }).result = recoveredResult;
      (result as { partial?: boolean }).partial = true;
    }

    // Exact summary the pre-GRAPH-030 terminal step would have stored. It is
    // carried into the canonical finalizer solely to authenticate a one-time
    // correction of an unmarked Episode from an in-flight old execution.
    const legacyEpisodeSummary =
      result.success && typeof result.result === 'string' ? result.result.slice(0, 500) : prompt.slice(0, 200);

    // Compatibility marker: this step id used to terminalize the Episode at
    // this premature point. Keep it in place so in-flight executions can
    // replay across the deployment. New runs memoize only the deferral; the
    // versioned `finalize-episode` step below performs the graph transition
    // after canonical result selection. Old runs that already memoized the
    // former write are corrected once by that versioned terminal operation.
    if (episodeId) {
      try {
        await step.run('complete-episode', async () => ({ deferredTo: 'finalize-episode' as const }));
      } catch {
        // The historical Episode step was non-blocking; preserve that contract.
      }
    }

    // Step 2.7: Evaluate quality BEFORE writing the AgentRun record, so the
    // AgentRun can carry qualityReport for the Activity UI in a single write.
    // Quality Layer 1 is rule-based + deterministic — no LLM cost, ~fast.
    await step.run('evaluate-quality', async () => {
      try {
        const primaryReportId = reportTruth.resolution.reportIds[0];

        // ARUN-014: surface the quality-review phase (L1 rule-based + L1.5
        // grounded fact-check) so the running mission isn't opaque during the
        // inline quality window. The canonical durable pointers were already
        // persisted by resolve-owner-scoped-report-truth; this write is telemetry
        // only and may remain best-effort.
        try {
          await updateMission(missionId, {
            phase: 'quality-review',
            phaseStartedAt: new Date().toISOString(),
            phaseLimitMs: null,
            phaseLimitCostUsd: null,
            preliminaryReportId: primaryReportId ?? null,
          });
        } catch (phaseErr) {
          log.warn('quality-review phase telemetry write failed (non-blocking)', {
            missionId,
            error: phaseErr instanceof Error ? phaseErr.message : String(phaseErr),
          });
        }

        const { evaluateMissionQuality } = await import('@/lib/mission-quality');
        const { getMissionById } = await import('@/lib/missions');
        const current = (await getMissionById(missionId)) as unknown as {
          skillInvocations?: Array<{ skill: string; args?: string; firedAt: string; turn?: number }>;
          preludeAccounting?: { tasks?: { skipped?: Array<{ skill: string; reason: string }> } };
        } | null;

        // SKILL-050 — the output-time skills this mission was dispatched with.
        // The prelude already resolved them from the brief's directives and
        // persisted them as deliberate non-dispatches; reading that ledger keeps
        // one source of truth and survives a revision turn appending to `prompt`.
        const requiredOutputSkills = (current?.preludeAccounting?.tasks?.skipped ?? [])
          .filter((task) => task.reason === 'output-time-directive')
          .map((task) => task.skill);

        // Creator missions save the full HTML report to impulse-reports and
        // leave only a short summary in mission.result. Evaluate the EXACT
        // canonical persisted HTML (resolved by missionId above) concatenated
        // with the summary; the result-text regex is only a legacy fallback
        // for pre-slot reports that carry no missionId linkage.
        let primaryReportHtml: string | null = null;
        let artifactEvidence: RequiredSkillArtifactEvidence | undefined;
        let artifactIdentity: ReviewedArtifactIdentity | undefined;
        if (primaryReportId) {
          const { getReportOwnedBy } = await import('@/lib/reports');
          const primaryReport = await getReportOwnedBy(primaryReportId, reportTruth.ownerId);
          if (primaryReport?.missionId === missionId) {
            primaryReportHtml = primaryReport.html ?? null;
            const storedIdentity = primaryReport.artifactIdentity;
            const currentSha = primaryReportHtml ? reportHtmlSha256(primaryReportHtml) : undefined;
            artifactEvidence = {
              reportId: primaryReport.id,
              ...(storedIdentity?.sha256 ? { sha256: storedIdentity.sha256 } : {}),
              ...(storedIdentity?.revisionNumber !== undefined
                ? { revisionNumber: storedIdentity.revisionNumber }
                : {}),
              ...(storedIdentity?.reviewedBy ? { reviewedBy: storedIdentity.reviewedBy } : {}),
              ...(primaryReport.designPassVerdict ? { designPassVerdict: primaryReport.designPassVerdict } : {}),
              ...(primaryReport.designPassDetails ? { designPassDetails: primaryReport.designPassDetails } : {}),
            };
            artifactIdentity = {
              reportId: primaryReport.id,
              ...(currentSha ? { sha256: currentSha } : {}),
              ...(storedIdentity?.revisionNumber !== undefined
                ? { revisionNumber: storedIdentity.revisionNumber }
                : {}),
            };
          }
        }
        const reportHtml =
          primaryReportHtml ?? (await extractReportHtml(result.result, missionId, reportTruth.ownerId));
        const effectiveResult = reportHtml ? `${result.result ?? ''}\n\n---\n\n${reportHtml}` : (result.result ?? '');

        const partialFlagForQuality = (result as { partial?: boolean }).partial === true;
        let qualityReport = evaluateMissionQuality({
          prompt,
          result: effectiveResult,
          agent,
          partial: partialFlagForQuality,
          skillInvocations: current?.skillInvocations,
          terminalState: reportTruth.terminalState,
          requiredOutputSkills,
          artifactEvidence,
          artifactIdentity,
        });

        // Step 2.72: external claim verification (the fact-check). Runs ONLY
        // when a real published report exists. L1/L2 verify citation discipline
        // and text quality but never check a claim's VALUE against the world —
        // this re-verifies load-bearing specifics via live grounding. Soft +
        // fail-open: a contradicted claim flips the verdict to REVISE so the
        // Step 2.75 loop corrects it; any infra failure resolves to PASS and
        // never blocks the ship.
        if (paidQualityStagesAllowed && reportHtml) {
          qualityReport = await foldReportFactCheck(qualityReport, reportHtml, missionId, `user:${userId}`, 0);
        }

        await updateMission(missionId, { qualityReport });
        log.info('Mission quality evaluated', {
          missionId,
          verdict: qualityReport.verdict,
          score: qualityReport.overallScore,
        });
      } catch (err) {
        log.warn('Mission quality evaluation failed', {
          missionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // Hard caps for the revision turn. Default is 0.8× the mission cap (half
    // forced the model to truncate critic feedback), and MISSION-003 CLAMPS
    // the env override to the mission cap — pre-fix the comment claimed
    // "revise can't cost more than the original" while an env value of, say,
    // $50 sailed straight through parseFloat unchecked.
    const REVISION_MAX_COST_USD = executionCostEnvelope.revisionMaxCostUsd;
    // COORD-012: an envelope-authorized mission derives the revision window
    // from ITS confirmed timeout, not the worker-startup environment default.
    const REVISION_TIMEOUT_MS = Math.floor(
      (envelopeFromMission && executionCostEnvelope.timeoutMinutes !== undefined
        ? Math.min(executionCostEnvelope.timeoutMinutes * 60 * 1000, MAX_MISSION_TIMEOUT_MS)
        : DEFAULT_MISSION_TIMEOUT_MS) / 2
    );

    // Step 2.75: REVISE retry loop. Gated on Step 2.7's verdict + revision
    // attempt count (cap = 1). Builds a feedback message from failing checks,
    // dispatches one revision turn through a fresh orchestrator, re-runs L1
    // on the revised output, and persists the attempt. Fully best-effort —
    // any failure leaves the original output + verdict intact.
    //
    // MISSION-002 (replay safety): the step RETURNS the promoted revision text
    // (or null when the original is kept) and the outer `result` mutation
    // happens OUTSIDE the step from that memoized return value. Mutating outer
    // state inside the step body was replay-unsafe: on an Inngest replay the
    // completed step's callback is skipped, the mutation vanished, and Step 4
    // finalization overwrote the promoted revision with the original result.
    const promotedRevision = await step.run('revise-on-l1-fail', async (): Promise<string | null> => {
      try {
        if (!paidQualityStagesAllowed) {
          log.info('Revise step skipped — canonical terminal truth blocks paid quality work', {
            missionId,
            reportLookupOk: reportTruth.resolution.ok,
            promisedReport: reportTruth.promisedReport,
            canonicalReportCount: reportTruth.resolution.reportIds.length,
            sdkSuccess: result.success,
          });
          return null;
        }

        // COORD-012: an explicit zero revision allocation de-funds the phase —
        // a $0 cap must launch no paid revision turn at all rather than a turn
        // that instantly aborts against a zero provider budget.
        if (REVISION_MAX_COST_USD <= 0) {
          log.info('Revise step skipped — the authorized revision allocation is zero', { missionId });
          return null;
        }

        const { getMissionById } = await import('@/lib/missions');
        const current = (await getMissionById(missionId)) as unknown as {
          result?: string;
          qualityReport?: {
            overallScore: number;
            verdict: 'PASS' | 'REVISE' | 'FAIL';
            checks: Array<{ name: string; pass: boolean; critical: boolean; detail: string }>;
          };
          revisionAttempts?: Array<{ rejected?: boolean }>;
          skillInvocations?: Array<{ skill: string; args?: string; firedAt: string; turn?: number }>;
          skillPrelude?: Array<{ skill: string; success: boolean }>;
          slots?: Array<{ name: string; intent?: string }>;
          preludeAccounting?: { tasks?: { skipped?: Array<{ skill: string; reason: string }> } };
        } | null;
        // SKILL-050 — the revised draft is scored against the SAME required
        // output-time skills as the original, or the promotion comparison would
        // be made over two different check sets.
        const requiredOutputSkillsForRevision = (current?.preludeAccounting?.tasks?.skipped ?? [])
          .filter((task) => task.reason === 'output-time-directive')
          .map((task) => task.skill);
        // SKILL-050 — and against the SAME receipt set, for the same reason. The
        // revision turn corrects one skill's output; a skill that fired in the
        // ORIGINAL session and whose output survives into the revised draft still
        // has a formal receipt, it is just recorded on the mission rather than on
        // this session. Scoring the revision against `revResult.skillInvocations`
        // alone would fail every already-satisfied skill and make the revised
        // verdict incomparable to the original's — the same asymmetry the
        // required-skills note above guards against.
        const priorSkillInvocations = current?.skillInvocations ?? [];
        // Bug G: pull the slot manifest here so we can pass it to the
        // revise orchestrator. Without this the revise agent has no idea which
        // slotName publishReport will accept and can repeatedly draft to
        // off-manifest slots.
        const reviseSlots = current?.slots;

        // MISSION-002 hardening: if a prior execution already PROMOTED a
        // revision (non-rejected attempt + result persisted on the mission doc)
        // but crashed before Inngest memoized this step's return, a re-executed
        // step must re-return that promotion — otherwise the verdict/cap guards
        // below would return null and Step 4 would overwrite the promoted
        // result with the original.
        const priorAttempts = current?.revisionAttempts ?? [];
        if (priorAttempts.length >= 1 && priorAttempts[0]?.rejected === false && current?.result) {
          log.info('Revise step re-run after promotion — re-returning the persisted promoted result', {
            missionId,
          });
          return current.result;
        }

        const report = current?.qualityReport;
        // REPORT-017: the step is named `revise-on-l1-fail` but only ever
        // accepted REVISE, so a parseable Scout bundle whose offending findings
        // L1 already named had no correction path. One bounded repair is now permitted, and
        // only for a failure the agent can fix from the report it was handed;
        // malformed, fabricated and unrepairable bundles stay fail-closed.
        const { isCorrectableScoutBundleFailure, isRepairedBundleSafe, recoverScoutBundleEvidence } =
          await import('@/lib/mission-quality/scout-bundle-repair');
        const scoutRepair = isCorrectableScoutBundleFailure(agent, report);
        const isBundleRepair = scoutRepair.correctable;
        if (!report || (report.verdict !== 'REVISE' && !isBundleRepair)) {
          log.info('Revise step skipped — verdict not REVISE and not a correctable scout bundle', {
            missionId,
            verdict: report?.verdict,
            ...(report?.verdict === 'FAIL' ? { repairRefusedBecause: scoutRepair.reason } : {}),
          });
          return null;
        }
        if (isBundleRepair) {
          log.info('Scout bundle repair permitted — one bounded correction turn', {
            missionId,
            correctableChecks: scoutRepair.correctableChecks,
          });
        }

        const previousAttempts = (current?.revisionAttempts ?? []).length;
        if (previousAttempts >= 1) {
          log.info('Revise step skipped — cap reached', { missionId, previousAttempts });
          return null;
        }

        const failing = report.checks.filter((c) => !c.pass);
        if (failing.length === 0) {
          log.warn('Revise step skipped — REVISE verdict but no failing checks', { missionId });
          return null;
        }

        // MISSION-003: only SUBSTANTIVE failures earn a paid revision turn.
        // skill-adherence / not-partial are process heuristics about the
        // original run — a rewrite cannot fix them, so a report failing only
        // those ships as-is with the verdict recorded.
        const { substantiveFailingChecks } = await import('@/lib/mission-quality');
        const substantive = substantiveFailingChecks(failing);
        if (substantive.length === 0) {
          log.info('Revise step skipped — only non-substantive (heuristic) checks failing', {
            missionId,
            failingChecks: failing.map((c) => c.name),
          });
          return null;
        }

        // REPORT-019: use the original parsed bundle and deterministic analyzer
        // receipts as the correction authority. The previous implementation
        // asked a paid model to recreate the entire source and finding set from a
        // prose brief, which could erase valid records and still fail the gate.
        // This recovery changes only analyzer-implicated
        // findings, preserves every other finding byte-for-byte, and moves any
        // still-unsupported claim into an uncited unresolved channel.
        const bundleRecovery = isBundleRepair
          ? recoverScoutBundleEvidence(result.result ?? current?.result ?? '')
          : null;
        const bundleRecoveryFailureReason =
          bundleRecovery?.ok === false ? bundleRecovery.reason : 'Scout evidence recovery was unavailable';

        const { buildRevisionFeedbackWithManifest } = await import('@/lib/skill-prelude');
        const { missionDeliverableKind } = await import('@/lib/mission-deliverable');
        const preluddedSkills = new Set((current?.skillPrelude ?? []).filter((p) => p.success).map((p) => p.skill));
        // MISSION-011: the correction turn must ask for the deliverable this
        // mission actually owes. A proposal mission handed the report-shaped
        // brief re-entered the exact Creator/publishReport loop the L1 failure
        // was flagging.
        const manifest = buildRevisionFeedbackWithManifest({
          failingChecks: substantive,
          preluddedSkills,
          // REPORT-017: a Scout bundle repair is corrected as a bundle. The
          // report-shaped brief would close with "Output: revised report HTML" —
          // the same pathology MISSION-011 removed for Linker.
          deliverableKind: isBundleRepair ? 'research-bundle' : missionDeliverableKind({ agent }),
        });
        const feedback =
          bundleRecovery?.ok === true
            ? `${manifest.feedback}\n\nDETERMINISTIC RECOVERY RECEIPT: ${
                bundleRecovery.receipt.preservedFindingIndexes.length
              } unaffected finding(s) preserved byte-for-byte; ${
                bundleRecovery.receipt.correctedFindingIndexes.length
              } affected finding(s) corrected; ${
                bundleRecovery.receipt.downgradedFindingIndexes.length
              } affected finding(s) moved to unresolved evidence. No provider turn was dispatched.`
            : bundleRecovery?.ok === false
              ? `${manifest.feedback}\n\nDETERMINISTIC RECOVERY REFUSED: ${bundleRecovery.reason}`
              : manifest.feedback;

        log.info('[revision] requesting revision', {
          missionId,
          mode: isBundleRepair ? 'deterministic-scout-record-recovery' : 'provider-revision',
          requestedDimensions: manifest.requestedDimensions,
          requestedSkills: manifest.requestedSkills,
          preludedRelevantSkills: manifest.preludedRelevantSkills,
        });

        // MISSION-002: snapshot EVERY published report for this mission before
        // the revision agent republishes. A mission can publish up to MAX_SLOTS
        // deliverables, and the revise turn gets all slots — it may overwrite
        // any of them in place (`upsertReportBySlot`). Snapshotting only the
        // newest report would leave a different clobbered slot un-restored. If
        // the revision turns out to be a regression we restore each of these so
        // the mission keeps its better original artifacts instead of shipping
        // the worse rewrites. (MISSION-003: fetched BEFORE the prompt so the
        // revision brief can name the concrete deliverables to revise.)
        // REPORT-001: snapshot the design-review lifecycle (reviewStatus /
        // designPassVerdict / designPassDetails) alongside the HTML. A revision
        // re-publish overwrites the slot's status with the revision's verdict; on
        // a regression restore we must put back the ORIGINAL status too, or a
        // restored (design-failing) original would keep the revision's — possibly
        // `published` — status and leak to the catalog/share surface.
        let originalReports: Array<{
          id: string;
          html: string;
          title?: string;
          slotName?: string;
          reviewStatus?: 'published' | 'needs-review';
          designPassVerdict?: 'PASS' | 'FAIL' | 'UNREVIEWED';
          designPassDetails?: string;
        }> = [];
        try {
          const { getReportsByMissionIdOwnedBy } = await import('@/lib/reports');
          const priors = await getReportsByMissionIdOwnedBy(missionId, reportTruth.ownerId);
          originalReports = priors
            .filter((r): r is typeof r & { html: string } => Boolean(r.id && r.html))
            .map((r) => ({
              id: r.id,
              html: r.html,
              title: (r as { title?: string }).title,
              slotName: (r as { slotName?: string }).slotName,
              reviewStatus: (r as { reviewStatus?: 'published' | 'needs-review' }).reviewStatus,
              designPassVerdict: (r as { designPassVerdict?: 'PASS' | 'FAIL' | 'UNREVIEWED' }).designPassVerdict,
              designPassDetails: (r as { designPassDetails?: string }).designPassDetails,
            }));
        } catch (err) {
          // MISSION-002: without the snapshot there is NO restore path — if the
          // revision regressed, its worse HTML would stay published. "Never
          // publish a regression" is absolute, so skip the revision attempt
          // entirely rather than run it without a safety net.
          log.warn('[revision] original-report snapshot failed — skipping revision (no restore path)', {
            missionId,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        }

        // REPORT-004: freeze each prior artifact as an IMMUTABLE version with
        // its check receipt (verdict + failing checks + design lifecycle) and
        // the exact html sha256 BEFORE any paid revision work. This durable
        // capture — not the in-memory snapshot above — is what the revision
        // agent gets as its prior-artifact reference and what the regression
        // rollback restores from deterministically. Capture failure = no
        // durable restore path = no paid revision (same absolute rule as the
        // MISSION-002 snapshot).
        const preRevisionRefs = new Map<
          string,
          { versionId: string; versionNumber: number; htmlLength: number; htmlSha256: string }
        >();
        try {
          const { captureReportVersionWithReceipt } = await import('@/lib/reports/report-versions');
          for (const snap of originalReports) {
            const captured = await captureReportVersionWithReceipt(snap.id, {
              savedBy: `agent:${agent}`,
              reason: 'pre-revision',
              checkReceipt: {
                verdict: report.verdict,
                failingChecks: substantive.map((c) => c.name),
                ...(snap.designPassVerdict ? { designPassVerdict: snap.designPassVerdict } : {}),
                ...(snap.reviewStatus ? { reviewStatus: snap.reviewStatus } : {}),
                ...(snap.designPassDetails ? { designPassDetails: snap.designPassDetails } : {}),
              },
            });
            if (!captured) throw new Error(`pre-revision capture returned null for report ${snap.id}`);
            preRevisionRefs.set(snap.id, captured);
          }
        } catch (err) {
          log.warn('[revision] pre-revision version capture failed — skipping revision (no durable restore path)', {
            missionId,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        }

        // MISSION-003: the revision turn gets the CONCRETE deliverables, not
        // just prompt+feedback. REPORT-004: each deliverable carries its
        // immutable prior-version identity (versionId + bytes + sha256) and the
        // agent is told how to load the EXACT prior HTML — a tool that returned
        // metadata-only made paid rewrites rebuild blind.
        const deliverablesBlock =
          originalReports.length > 0
            ? `\n\nEXISTING DELIVERABLES — revise these IN PLACE (republish to the SAME slot; do not create new slots):\n${originalReports
                .map((r) => {
                  const ref = preRevisionRefs.get(r.id);
                  const refNote = ref
                    ? ` [prior version ${ref.versionId} · ${ref.htmlLength} bytes · sha256 ${ref.htmlSha256.slice(0, 12)}]`
                    : '';
                  return `- Report ${r.id}${r.slotName ? ` (slot: ${r.slotName})` : ''}${r.title ? ` — ${r.title}` : ''}${refNote}`;
                })
                .join(
                  '\n'
                )}\nLoad each report's EXACT current HTML with getReportById { reportId, includeHtml: true } and revise that HTML — do not rebuild from memory.`
            : '';

        const triggeringVerdict = isBundleRepair ? ('FAIL' as const) : ('REVISE' as const);
        const revisionPrompt = `${prompt}\n\n---\n\nPREVIOUS DRAFT VERDICT: ${triggeringVerdict}\n\n${feedback}${deliverablesBlock}`;

        // ARUN-014: enter the bounded `revising` phase and persist its explicit
        // wall-clock + cost bounds so the single correction turn is observable
        // (and demonstrably bounded) rather than an opaque stall.
        await updateMission(missionId, {
          phase: 'revising',
          phaseStartedAt: new Date().toISOString(),
          phaseLimitMs: REVISION_TIMEOUT_MS,
          phaseLimitCostUsd: REVISION_MAX_COST_USD,
        });

        // Ordinary revisions run a fresh orchestrator turn with bounded budget.
        // REPORT-019 Scout recovery stays inside this same one-attempt/replay
        // envelope but consumes no provider turn: its output was derived above
        // from the original parsed bundle and analyzer receipts.
        const { runRevisionOrchestrator } = await import('@/lib/skill-prelude');
        const revStart = Date.now();
        const revResult: Awaited<ReturnType<typeof runRevisionOrchestrator>> = isBundleRepair
          ? bundleRecovery?.ok === true
            ? {
                success: true,
                result: bundleRecovery.result,
                costUsd: 0,
                tokenUsage: { input: 0, output: 0 },
              }
            : {
                success: false,
                costUsd: 0,
                errors: [bundleRecoveryFailureReason],
              }
          : await runRevisionOrchestrator({
              prompt: revisionPrompt,
              agentsDir: path.resolve(process.cwd(), 'agent', 'agents'),
              configPath: path.resolve(process.cwd(), 'impulse.config.yaml'),
              apiKey: process.env.IMPULSE_INTERNAL_KEY,
              maxBudgetUsd: REVISION_MAX_COST_USD,
              timeoutMs: REVISION_TIMEOUT_MS,
              logFilePath: process.env.IMPULSE_LOG_FILE,
              // Bug G: thread mission context through to the revise turn so it
              // can actually publish. Without missionId the MCP layer drops
              // x-mission-id and publishReport rejects every call; without
              // slots the agent can invent off-manifest slot names and never
              // ship the revision.
              missionId,
              slots: reviseSlots,
              roleAgent: agent,
            });
        const revisionCostUsd = revResult.costUsd === undefined ? null : revResult.costUsd;
        const revisionCostUnavailableReason: MissionCostUnavailableReason | undefined =
          revisionCostUsd === null ? (revResult.costUnavailableReason ?? 'accounting-incomplete') : undefined;
        const revisionRuntimeFacts = {
          ...(revResult.providerReportedCostUsd !== undefined
            ? { providerReportedCostUsd: revResult.providerReportedCostUsd }
            : {}),
          ...(revResult.exposureUsd !== undefined ? { exposureUsd: revResult.exposureUsd } : {}),
          ...(revResult.duplicateUsageEvents ? { duplicateUsageEvents: revResult.duplicateUsageEvents } : {}),
          ...(revResult.restatedUsageEvents ? { restatedUsageEvents: revResult.restatedUsageEvents } : {}),
          ...(revResult.requestedModel ? { requestedModel: revResult.requestedModel } : {}),
          ...(revResult.modelSubstitution
            ? {
                modelSubstitution: {
                  ...revResult.modelSubstitution,
                  servedModels: [...revResult.modelSubstitution.servedModels],
                },
              }
            : {}),
        };
        const revisionSkillFacts =
          revResult.skillInvocations && revResult.skillInvocations.length > 0
            ? { skillInvocations: revResult.skillInvocations }
            : {};
        const revDuration = Date.now() - revStart;

        // ARUN-022/AI-029 — the revision turn is a full paid out-of-process
        // Anthropic session. Flush its provider-reported per-SERVED-MODEL usage
        // as durable receipts; before this the only trace was the aggregated
        // `revisionAttempts[].costUsd`, with no served model and no counters.
        //
        // Placed BEFORE the failure branch below on purpose: a revision that
        // failed (or produced too little output to promote) still burned
        // provider tokens, and dropping its receipt would under-report spend.
        //
        // Identity folds in `revStart` — the immutable pre-dispatch instant — so
        // a step RETRY, which dispatches a genuinely new paid session, gets its
        // own receipt identity instead of conflicting with the prior attempt's,
        // while a re-flush of the same result stays idempotent.
        if (revResult.modelUsage && Object.keys(revResult.modelUsage).length > 0) {
          try {
            const { flushSubSessionUsageReceipts } = await import('@/lib/mission-usage-receipts');
            await flushSubSessionUsageReceipts({
              missionId,
              owner: `user:${userId}`,
              asOf: new Date(revStart).toISOString(),
              kind: 'revision',
              // REPORT-017: a bundle repair is a distinct paid session from an
              // ordinary revision, so it gets its own receipt identity under the
              // same mission correlation. The original Scout session's receipts
              // are untouched, and the two reconcile into the mission total
              // rather than one overwriting the other.
              sessionKey: `${isBundleRepair ? 'bundle-repair' : 'attempt'}-1-${revStart}`,
              modelUsage: revResult.modelUsage,
            });
          } catch (receiptError) {
            log.warn('Revision usage receipt flush failed (best-effort, non-fatal)', {
              missionId,
              error: receiptError instanceof Error ? receiptError.message : String(receiptError),
            });
          }
        }

        if (!revResult.success || !revResult.result || revResult.result.length < 100) {
          log.warn('Revision turn failed — retaining original output', {
            missionId,
            errors: revResult.errors,
          });
          await updateMission(missionId, {
            revisionAttempts: [
              {
                attempt: 1,
                triggeredByVerdict: triggeringVerdict,
                failingChecks: failing.map((c) => c.name),
                feedback,
                costUsd: revisionCostUsd,
                ...(revisionCostUnavailableReason ? { costUnavailableReason: revisionCostUnavailableReason } : {}),
                ...revisionRuntimeFacts,
                ...revisionSkillFacts,
                durationMs: revDuration,
                revisedAt: new Date().toISOString(),
                // REPORT-020 (E): a failed revision turn is a REJECTION, and it
                // must say so. `rejected` was previously set only on the
                // bundle-repair path, so an ordinary failure persisted an
                // attempt with the field ABSENT — which
                // `src/lib/schemas/mission.ts` defines as "promoted as the
                // canonical result". A failed turn may leave the last version
                // write as `reason=restore`; that is retention, not promotion.
                rejected: true,
                promotionReasons: [
                  isBundleRepair
                    ? bundleRecoveryFailureReason
                    : `revision turn produced no usable output (${
                        revResult.success ? `${revResult.result?.length ?? 0} chars` : 'turn failed'
                      })`,
                ],
              },
            ],
          });
          return null;
        }

        // Re-run L1 on the revised output and persist the new verdict +
        // revisionAttempts entry.
        const { evaluateMissionQuality, withAdditionalChecks } = await import('@/lib/mission-quality');
        const partialFlag = (result as { partial?: boolean }).partial === true;

        // Score the revised draft over its summary + the FULL republished report
        // HTML — SYMMETRIC with the initial evaluate-quality step (2.7, which
        // builds the same effectiveResult). Creator missions leave only a short
        // summary in the orchestrator result and publish the real artifact as
        // report HTML; evaluating the raw summary alone suppresses the
        // HTML/entity-gated structural, brand, and JTBD/evolution checks. That
        // would make the revised verdict incomparable to the original's (scored
        // over result + HTML) and could flip the regression gate the wrong way —
        // see isRevisionRegression's note on comparability.
        //
        // REPORT-003/REPORT-004: the reviewed artifact is the CANONICAL
        // persisted HTML re-read by missionId — the same slot the original
        // evaluation read — never whatever id the revision agent happened to
        // mention in its text. If the agent failed to republish, this re-read
        // returns the UNCHANGED original html, so the comparison stays honest.
        const revisedResolution = await resolveCanonicalMissionReportsResult(missionId, reportTruth.ownerId);
        const revisedReports = revisedResolution.reports;
        const revisedIdentity: ReportIdentityResolution = revisedResolution.ok
          ? {
              ok: true,
              reportIds: revisedReports
                .map((revisedReport) => revisedReport.id?.trim())
                .filter((id): id is string => Boolean(id)),
            }
          : { ok: false, reportIds: [], error: revisedResolution.error };
        const revisedHtml =
          revisedReports[0]?.html ??
          (revisedResolution.ok ? await extractReportHtml(revResult.result, missionId, reportTruth.ownerId) : null);
        const effectiveRevisedResult = revisedHtml
          ? `${revResult.result ?? ''}\n\n---\n\n${revisedHtml}`
          : (revResult.result ?? '');
        const newReport = evaluateMissionQuality({
          prompt,
          result: effectiveRevisedResult,
          agent,
          partial: partialFlag,
          skillInvocations: [...priorSkillInvocations, ...(revResult.skillInvocations ?? [])],
          terminalState: missionQualityTerminalState({
            executionSucceeded: revResult.success,
            promisedReport: reportTruth.promisedReport,
            resolution: revisedIdentity,
          }),
          requiredOutputSkills: requiredOutputSkillsForRevision,
          ...(revisedReports[0]?.id && revisedHtml
            ? {
                artifactEvidence: {
                  reportId: revisedReports[0].id,
                  ...(revisedReports[0].artifactIdentity?.sha256
                    ? { sha256: revisedReports[0].artifactIdentity.sha256 }
                    : {}),
                  ...(revisedReports[0].artifactIdentity?.revisionNumber !== undefined
                    ? { revisionNumber: revisedReports[0].artifactIdentity.revisionNumber }
                    : {}),
                  ...(revisedReports[0].artifactIdentity?.reviewedBy
                    ? { reviewedBy: revisedReports[0].artifactIdentity.reviewedBy }
                    : {}),
                  ...(revisedReports[0].designPassVerdict
                    ? { designPassVerdict: revisedReports[0].designPassVerdict }
                    : {}),
                  ...(revisedReports[0].designPassDetails
                    ? { designPassDetails: revisedReports[0].designPassDetails }
                    : {}),
                },
                artifactIdentity: {
                  reportId: revisedReports[0].id,
                  sha256: reportHtmlSha256(revisedHtml),
                  ...(revisedReports[0].artifactIdentity?.revisionNumber !== undefined
                    ? { revisionNumber: revisedReports[0].artifactIdentity.revisionNumber }
                    : {}),
                },
              }
            : {}),
        });

        // Re-run the fact-check on the REVISED report's HTML (not just L1).
        // Without this the revised report ships unverified and the persisted
        // report loses the `report-claims-verified` check entirely — so a
        // contradiction the revision was meant to fix could silently flip to
        // PASS. Re-running re-derives the verdict honestly: a still-contradicted
        // claim keeps the verdict at REVISE (recorded, not re-revised — cap=1),
        // a fixed one passes. Fail-open keeps newReport on any infra failure.
        let finalReport = newReport;
        if (isBundleRepair) {
          // Source records are immutable in deterministic recovery, so a prior
          // passing URL-reachability receipt remains applicable. Preserve that
          // critical provenance result instead of silently dropping it because
          // the synchronous re-evaluator does not perform network checks. A
          // failed URL receipt never reaches this branch: eligibility refuses it.
          const preservedSourceReceipts = report.checks.filter(
            (check) =>
              check.name === 'scout-no-fake-urls' &&
              check.pass &&
              !newReport.checks.some((candidate) => candidate.name === check.name)
          );
          finalReport = withAdditionalChecks(newReport, preservedSourceReceipts);
        }
        if (revisedResolution.ok && revisedHtml) {
          finalReport = await foldReportFactCheck(finalReport, revisedHtml, missionId, `user:${userId}`, 1);
        }

        // Coverage shift — did the revision actually address what was
        // flagged? Compute per-dimension before/after (including the fact-check
        // check) so we can later tell whether the retry budget is paying off.
        const beforeFailing = new Set(failing.map((c) => c.name));
        const afterFailing = new Set(finalReport.checks.filter((c) => !c.pass).map((c) => c.name));
        const dimensionsFixed = [...beforeFailing].filter((n) => !afterFailing.has(n));
        const dimensionsStillFailing = [...beforeFailing].filter((n) => afterFailing.has(n));
        const dimensionsNewlyFailing = [...afterFailing].filter((n) => !beforeFailing.has(n));

        log.info('[revision] coverage shift', {
          missionId,
          requestedDimensions: manifest.requestedDimensions,
          dimensionsFixed,
          dimensionsStillFailing,
          dimensionsNewlyFailing,
          beforeFailCount: beforeFailing.size,
          afterFailCount: afterFailing.size,
        });

        // MISSION-002/REPORT-003: never publish a regression. The L1 evaluator
        // is deterministic and both evaluations ran over the CANONICAL
        // persisted HTML, so the two check sets are directly comparable. The
        // promotion decision rejects a verdict-rank drop AND any
        // previously-passing load-bearing check that now fails (equal verdicts
        // no longer auto-promote a materially worse artifact) — plus, per
        // report, a design-gate regression: a slot whose publish-time design
        // verdict was PASS must not come back FAIL/UNREVIEWED from the
        // revision's republish.
        const { evaluateRevisionPromotion } = await import('@/lib/mission-quality');
        const decision = evaluateRevisionPromotion(report, finalReport);
        const designRegressions: string[] = [];
        if (!revisedResolution.ok && originalReports.length > 0) {
          // The post-revision artifacts could not be read, so non-regression is
          // UNPROVEN — not proven-good. "Never publish a regression" is
          // absolute, so an unverifiable comparison keeps the known-good
          // original (the same rule the pre-revision snapshot failure applies).
          designRegressions.push('post-revision artifact read failed — non-regression could not be verified');
        }
        for (const snap of originalReports) {
          if (snap.designPassVerdict !== 'PASS') continue; // no passing baseline to regress from
          const revisedDoc = revisedReports.find((r) => r.id === snap.id) as
            { designPassVerdict?: 'PASS' | 'FAIL' | 'UNREVIEWED' } | undefined;
          const after = revisedDoc?.designPassVerdict;
          if (after === 'FAIL' || after === 'UNREVIEWED') {
            designRegressions.push(`report ${snap.id}: design gate regressed from PASS to ${after}`);
          }
        }
        // REPORT-020 (C): a promotion must be backed by BYTES THAT ACTUALLY
        // CHANGED.
        //
        // `preRevisionRefs` already carries each slot's immutable pre-revision
        // `htmlSha256`, and the canonical post-revision HTML is re-read above —
        // but the two were never compared. Nothing therefore required the
        // revision to have published anything: a turn could fail publication (an
        // off-origin link, a denied out-of-root write, an exhausted budget),
        // leave the stored report byte-identical, and still be recorded as the
        // promoted canonical result with a raised L1 even though the stored SHA
        // never changed.
        //
        // Scored quality cannot substitute for this check: L1 runs over
        // `revisionText + canonicalHtml`, so prose describing an unpublished
        // draft can flip a check while the artifact stands still.
        //
        // Only a mission whose every comparable slot is unchanged is rejected —
        // if one slot of several genuinely republished, real work shipped and the
        // ordinary non-regression rules decide its fate.
        const byteComparisons = originalReports.flatMap((snap) => {
          const before = preRevisionRefs.get(snap.id)?.htmlSha256;
          const revisedDoc = revisedReports.find((r) => r.id === snap.id) as { html?: string } | undefined;
          if (!before || !revisedDoc?.html) return [];
          return [{ id: snap.id, before, after: reportHtmlSha256(revisedDoc.html) }];
        });
        const unchangedReports = byteComparisons.filter((c) => c.before === c.after);
        const byteRejections =
          byteComparisons.length > 0 && unchangedReports.length === byteComparisons.length
            ? [
                `revision published no new bytes — canonical HTML is byte-identical to the pre-revision capture for ${unchangedReports
                  .map((c) => `${c.id} (sha256 ${c.before.slice(0, 12)}…)`)
                  .join(', ')}`,
              ]
            : [];

        // REPORT-017: a repaired research bundle must pass EVERY critical Scout
        // check before it may replace the original. This is stricter than the
        // ordinary non-regression rule, which treats an equal verdict as
        // promotable — promoting FAIL over FAIL would swap known-bad evidence for
        // differently-bad evidence and spend the single attempt for nothing. The
        // chain gate would still halt, but the mission would carry the worse of
        // the two bundles as its canonical result.
        const repairRejections =
          isBundleRepair && !isRepairedBundleSafe(finalReport, scoutRepair.correctableChecks)
            ? [
                `scout bundle repair did not clear every critical check (verdict ${finalReport.verdict}); original bundle retained`,
              ]
            : [];
        const promotionReasons = [...decision.reasons, ...designRegressions, ...repairRejections, ...byteRejections];
        const isRegression = promotionReasons.length > 0;

        const attempt = {
          attempt: 1 as const,
          triggeredByVerdict: triggeringVerdict,
          failingChecks: failing.map((c) => c.name),
          feedback,
          costUsd: revisionCostUsd,
          ...(revisionCostUnavailableReason ? { costUnavailableReason: revisionCostUnavailableReason } : {}),
          ...revisionRuntimeFacts,
          ...revisionSkillFacts,
          durationMs: revDuration,
          revisedAt: new Date().toISOString(),
          newVerdict: finalReport.verdict,
          coverageShift: { dimensionsFixed, dimensionsStillFailing, dimensionsNewlyFailing },
        };

        if (isRegression) {
          // REPORT-004: deterministic rollback — restore every clobbered slot
          // from its IMMUTABLE pre-revision version (exact captured html, by
          // versionId) with the original review lifecycle applied in the SAME
          // transaction as the html swap. KEEP the mission's original result +
          // qualityReport, and record the attempt as rejected so the retry
          // spend stays visible. Each restore is independent — one failing
          // must not skip the others.
          if (originalReports.length > 0) {
            const { restoreReportVersion } = await import('@/lib/reports');
            for (const snap of originalReports) {
              try {
                const ref = preRevisionRefs.get(snap.id);
                if (!ref) throw new Error('missing pre-revision version reference');
                await restoreReportVersion(snap.id, {
                  versionId: ref.versionId,
                  // DISC-014: attribute the regression-restore version to the agent.
                  savedBy: `agent:${agent}`,
                  // REPORT-001/REPORT-004: the original's lifecycle rides the
                  // same atomic transaction as the html swap. Only fields the
                  // original actually HAD are restored — a field it lacked
                  // (e.g. designPassDetails) is left as the revision wrote it,
                  // which the UI does not surface because Step 4 always writes
                  // a fresh qualityGate receipt on this path and the detail
                  // page prefers it.
                  alsoSet: {
                    ...(snap.reviewStatus ? { reviewStatus: snap.reviewStatus } : {}),
                    ...(snap.designPassVerdict ? { designPassVerdict: snap.designPassVerdict } : {}),
                    ...(snap.designPassDetails ? { designPassDetails: snap.designPassDetails } : {}),
                  },
                  requireOwnerId: reportTruth.ownerId,
                });
                log.info('[revision] restored pre-revision version after regression', {
                  missionId,
                  reportId: snap.id,
                  versionId: ref.versionId,
                  htmlSha256: ref.htmlSha256,
                });
              } catch (err) {
                log.error('[revision] failed to restore pre-revision version', {
                  missionId,
                  reportId: snap.id,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          }
          await updateMission(missionId, {
            revisionAttempts: [{ ...attempt, rejected: true, promotionReasons }],
          });
          log.warn('Revision rejected — regression; original result retained', {
            missionId,
            originalScore: report.overallScore,
            revisedScore: finalReport.overallScore,
            originalVerdict: report.verdict,
            revisedVerdict: finalReport.verdict,
            promotionReasons,
          });
          return null;
        }

        // Promote the revised output as the canonical mission result. The
        // outer-state mutation happens OUTSIDE this step from the memoized
        // return value (replay-safe — see the step's MISSION-002 note).
        await updateMission(missionId, {
          result: revResult.result,
          qualityReport: { ...finalReport, revisedFromVerdict: triggeringVerdict },
          revisionAttempts: [{ ...attempt, rejected: false }],
          ...(revResult.skillInvocations && revResult.skillInvocations.length > 0
            ? { skillInvocations: [...priorSkillInvocations, ...revResult.skillInvocations] }
            : {}),
        });

        log.info('Revision turn complete', {
          missionId,
          oldVerdict: triggeringVerdict,
          newVerdict: finalReport.verdict,
          costUsd: revisionCostUsd,
          ...(revisionCostUnavailableReason ? { costUnavailableReason: revisionCostUnavailableReason } : {}),
        });
        return revResult.result;
      } catch (err) {
        log.warn('Revise step failed (non-blocking)', {
          missionId,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    });

    // MISSION-002: apply the promotion from the step's MEMOIZED return value —
    // deterministic on every Inngest replay, so Step 4 finalization can never
    // overwrite the chosen revision with the original result.
    if (typeof promotedRevision === 'string' && promotedRevision.length > 0) {
      (result as { result?: string }).result = promotedRevision;
    }

    // Step 2.8: Layer 2 quality judge — LLM-as-judge semantic evaluation.
    // Runs after Layer 1 (rule-based) so we always have a structural verdict,
    // even when the judge is skipped or the Gemini call fails. Sample rate
    // is controlled by QUALITY_LLM_SAMPLE_RATE (default 1.0). Best-effort —
    // on any failure the mission continues without a judgement.
    await step.run('evaluate-quality-llm', async () => {
      try {
        if (!paidQualityStagesAllowed) {
          log.info('Layer 2 quality judge skipped — canonical terminal truth blocks paid quality work', {
            missionId,
            reportLookupOk: reportTruth.resolution.ok,
            promisedReport: reportTruth.promisedReport,
            canonicalReportCount: reportTruth.resolution.reportIds.length,
            sdkSuccess: result.success,
          });
          return;
        }

        const { evaluateMissionQualityLlm } = await import('@/lib/mission-quality-llm');
        // Re-use the same report-concatenation trick as Layer 1 so the judge
        // sees the real artifact for creator missions, not the short summary.
        // Canonical-by-missionId first (same artifact L1 scored); the
        // result-text regex remains only as the legacy fallback.
        let effectiveResult = result.result ?? '';
        const judgedResolution = await resolveCanonicalMissionReportsResult(missionId, reportTruth.ownerId);
        if (!judgedResolution.ok) {
          log.warn('Layer 2 quality judge skipped — owner-scoped Report re-read failed', { missionId });
          return;
        }
        const judgedHtml =
          judgedResolution.reports[0]?.html ??
          (await extractReportHtml(effectiveResult, missionId, reportTruth.ownerId));
        if (judgedHtml) {
          effectiveResult = `${effectiveResult}\n\n---\n\n${judgedHtml}`;
        }

        // ARUN-022 — the judge's Gemini responses become durable receipts under the
        // mission correlation. Its spend is already folded into the mission
        // headline, so the batch is `included-in-parent`.
        const { withMissionStageReceipts } = await import('@/lib/mission-stage-usage');
        const {
          result: { judgement, costUsd: judgeCostUsd },
        } = await withMissionStageReceipts({ missionId, owner: `user:${userId}`, stage: 'judge' }, () =>
          evaluateMissionQualityLlm({
            prompt,
            result: effectiveResult,
            agent,
          })
        );
        // MISSION-005: persist the judge's real Gemini spend on the mission
        // doc (durable across replays) so Step 3 can fold it into the total.
        // Skipped judges (short result / trivial prompt / sampled out) have
        // NOTHING to write — Firestore rejects an empty update(), and calling
        // it anyway logged a spurious mission-update error on every failed
        // mission (adversarial finding #3).
        if (judgeCostUsd === null) {
          await markMissionCostUnavailable(missionId, 'judge');
        }
        if (judgement || (judgeCostUsd !== null && judgeCostUsd > 0)) {
          await updateMission(missionId, {
            ...(judgement ? { qualityJudgement: judgement } : {}),
            ...(judgeCostUsd !== null && judgeCostUsd > 0 ? { judgeCostUsd } : {}),
          });
        }
        if (judgement) {
          log.info('Mission quality judged (Layer 2)', {
            missionId,
            verdict: judgement.verdict,
            overallScore: judgement.overallScore,
            judgeModel: judgement.judgeModel,
          });
        }
      } catch (err) {
        log.warn('Layer 2 quality judge failed (non-blocking)', {
          missionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // Step 2.85: REPORT-018 — compose the ONE canonical quality verdict from the
    // two evaluators that just ran, and persist it beside their untouched
    // receipts. If L1 carries a deterministic critical failure while L2 passes,
    // this composition makes the governing result explicit.
    // Deterministic critical failures are a hard upper bound here; the judge can
    // still lower a clean result, and the conflict is preserved as evidence.
    //
    // Runs AFTER the judge step so it reads both persisted values from the
    // mission doc — deterministic on replay, and correct when either evaluator
    // was skipped. Best-effort: a composition failure must not change the
    // mission's terminal outcome, which is decided by the deterministic report.
    await step.run('compose-canonical-quality-verdict', async () => {
      try {
        const { getMissionById } = await import('@/lib/missions');
        const current = (await getMissionById(missionId)) as unknown as {
          qualityReport?: Parameters<typeof composeCanonicalQualityVerdict>[0];
          qualityJudgement?: Parameters<typeof composeCanonicalQualityVerdict>[1];
        } | null;
        const { composeCanonicalQualityVerdict } = await import('@/lib/mission-quality/canonical-verdict');
        const composed = composeCanonicalQualityVerdict(current?.qualityReport, current?.qualityJudgement);
        if (!composed) return;
        await updateMission(missionId, { qualityVerdict: composed });
        if (composed.disagreement) {
          log.warn('Quality evaluators disagreed — canonical verdict recorded', {
            missionId,
            canonical: composed.verdict,
            deterministic: composed.deterministic?.verdict,
            judge: composed.judge?.verdict,
            kind: composed.disagreement.kind,
          });
        }
      } catch (err) {
        log.warn('Canonical quality verdict composition failed (non-blocking)', {
          missionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // Resolve the one canonical terminal decision before any optional
    // post-mission provider call or graph finalization. This step also makes a
    // needs-review quarantine load-bearing: if the Report lifecycle write
    // fails, no reflection is purchased and no success transition is emitted.
    const terminalDecisionBeforePersistence = await step.run(
      'resolve-terminal-outcome',
      async (): Promise<TerminalDecision> => {
        const resolved = await resolveTerminalOutcome({
          missionId,
          sdkSuccess: result.success,
          reportTruth,
        });
        return enforceTerminalReportLifecycle(resolved, agent, reportTruth.ownerId);
      }
    );

    // Task 3.11: Post-mission reflection (best-effort). Runs BEFORE Step 3 so its
    // spend still folds into the finalized mission/AgentRun cost. ARUN-014: it
    // now also runs BEFORE capture-end-time, so the recorded execution duration
    // spans the reflection + episode-finalization latency and matches the
    // `completedAt` wall clock (the pre-ARUN-014 contract froze duration before
    // reflection, so live elapsed overshot the persisted value).
    await step.run('create-reflection', async () => {
      try {
        if (terminalDecisionBeforePersistence.status !== 'completed') {
          log.info('Reflection skipped — canonical terminal state is failed', {
            missionId,
            sdkSuccess: result.success,
            promisedReport: reportTruth.promisedReport,
            reportLookupOk: reportTruth.resolution.ok,
          });
          return;
        }

        const { createReflection } = await import('@/lib/graph/agent-reflections');

        const reflectionPrompt =
          `Mission agent: ${agent}\n` +
          'Result: success\n' +
          `Summary: ${(result.result ?? result.errors?.join('; ') ?? 'No details').slice(0, 500)}\n` +
          `What went well? What would you do differently? (2-3 bullets each, max 150 words)`;

        const { generateContentWithMetadata } = await import('@/lib/ai/client');
        // ARUN-022 — the reflection is a real paid Gemini call folded into the
        // mission headline; receipt it under the mission correlation.
        const { withMissionStageReceipts } = await import('@/lib/mission-stage-usage');
        const { result: generated } = await withMissionStageReceipts(
          { missionId, owner: `user:${userId}`, stage: 'reflection' },
          () =>
            generateContentWithMetadata(reflectionPrompt, {
              model: 'gemini-2.5-flash',
              maxOutputTokens: 300,
            })
        );
        const learnings = generated.text;
        // MISSION-005: persist the reflection's Gemini spend BEFORE Step 3
        // finalizes cost (this step was reordered ahead of finalization so
        // the spend can no longer be silently dropped).
        if (generated.costUsd === null) {
          await markMissionCostUnavailable(missionId, 'reflection');
        } else if (generated.costUsd > 0) {
          await updateMission(missionId, { reflectionCostUsd: generated.costUsd });
        }

        await createReflection({
          agentName: agent,
          missionId,
          learnings,
          toolsUsed: [],
          success: true,
          // GRAPH-030: stamp the canonical outcome, not just the boolean. A
          // checkpoint-recovered mission is `partial`, and a reflection that
          // claims plain success for it is the divergence this row closes.
          outcome: domainOutcomeForMissionTerminal(terminalDecisionBeforePersistence, result),
        });
      } catch (err) {
        log.warn('Reflection generation failed (non-blocking)', { error: String(err) });
      }
    });

    // Step 2.9: Finalize the Episode only after every step that can select or
    // mutate the canonical mission result. The graph transition is best-effort,
    // but when it lands its summary is exactly the same bounded result slice
    // that downstream persistence observes. Passing an explicit empty string
    // also prevents returned failures with no result from keeping the initial
    // prompt as a misleading terminal summary.
    if (episodeId) {
      try {
        await step.run('finalize-episode', async () => {
          const mod = await import('@/lib/graph/episodes');
          const finalSummary = (result.result ?? '').slice(0, 500);
          await mod.finalizeMissionEpisode({
            episodeId: episodeId!,
            missionId,
            userId,
            agentName: agent,
            status: terminalDecisionBeforePersistence.status,
            summary: finalSummary,
            legacySummary: legacyEpisodeSummary,
            // GRAPH-030: the finer canonical outcome, so the Episode can be
            // compared against the Mission/AgentRun without the coarse
            // completed/failed pair hiding a partial recovery.
            missionOutcome: domainOutcomeForMissionTerminal(terminalDecisionBeforePersistence, result),
          });
        });
      } catch (err) {
        // Episode finalization is non-blocking — Neo4j may be unavailable.
        log.warn('Episode finalization failed (non-blocking)', {
          missionId,
          episodeId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ARUN-014 duration contract: capture the end AFTER reflection and episode
    // finalization but BEFORE persistence, so the recorded execution duration
    // spans every pre-terminal step (incl. the reflection Gemini call) and
    // matches `completedAt`. Memoizing both endpoints keeps the duration stable
    // and accurate across an Inngest replay. Reflection's own Gemini spend is
    // still folded into cost independently (create-reflection persists
    // reflectionCostUsd; write-agent-run reads it back), so moving this endpoint
    // does not change the cost accounting.
    const endTime = await step.run('capture-end-time', () => Date.now());
    const duration = Math.max(0, endTime - startTime);

    // Single source of truth for the mission's true cost. Populated inside
    // Step 3 once revisionAttempts is loaded from Firestore, then read by
    // Step 4. Declaring it at outer scope keeps the agent-run row and the
    // mission doc bit-identical — they can't drift apart if the formula
    // ever changes.
    let totalMissionCost: number | null =
      typeof result.costUsd === 'number' && typeof preludeCostUsd === 'number' ? result.costUsd + preludeCostUsd : null;
    let auxCosts = { classifier: 0, judge: 0, factCheck: 0, reflection: 0 };
    let costBreakdownUsd:
      | {
          orchestrator: number;
          classifier: number;
          prelude: number;
          revisions: number;
          judge: number;
          factCheck: number;
          reflection: number;
        }
      | undefined;
    let missionSubjectEntityIds: string[] = [];

    // Step 3: Write AgentRun record (for Activity page)
    const finalizedCosts = await step.run('write-agent-run', async () => {
      const { createAgentRun } = await import('@/lib/agent-runs');
      // Pull the skill-invocation trail from Firestore — orchestrator has
      // been appending to it throughout the run; this reads it once at
      // completion time and copies onto the AgentRun record so the
      // Activity page can render it without a second fetch.
      let skillInvocations: Array<{ skill: string; args?: string; firedAt: string; turn?: number }> | undefined;
      let partialCheckpointTurn: number | undefined;
      let qualityReport:
        | {
            evaluatedAt: string;
            overallScore: number;
            verdict: 'PASS' | 'REVISE' | 'FAIL';
            checks: Array<{ name: string; pass: boolean; critical: boolean; detail: string }>;
          }
        | undefined;
      let qualityJudgement: import('@/lib/schemas/mission-quality-llm').QualityJudgement | undefined;
      let attachments:
        | Array<{
            filename: string;
            relativePath: string;
            mimeType: string;
            sizeBytes: number;
            content?: string;
            savedAt: string;
            salvaged?: boolean;
          }>
        | undefined;
      let chainId: string | undefined;
      let chainStep: number | undefined;
      let chainTotalSteps: number | undefined;
      let skillPrelude:
        | Array<{
            skill: string;
            target?: string;
            block: string;
            costUsd: number | null;
            costUnavailableReason?: MissionCostUnavailableReason;
            durationMs: number;
            firedAt: string;
            success: boolean;
            error?: string;
          }>
        | undefined;
      let revisionAttempts: Mission['revisionAttempts'];
      let subjectEntityIds: string[] = [];
      let costUnavailableComponents: MissionCostComponent[] = [];
      try {
        const { getMissionById } = await import('@/lib/missions');
        const m = (await getMissionById(missionId)) as unknown as {
          skillInvocations?: Array<{ skill: string; args?: string; firedAt: string; turn?: number }>;
          partialCheckpointTurn?: number;
          qualityReport?: typeof qualityReport;
          qualityJudgement?: typeof qualityJudgement;
          attachments?: typeof attachments;
          chainId?: string;
          chainStep?: number;
          chainTotalSteps?: number;
          skillPrelude?: typeof skillPrelude;
          revisionAttempts?: typeof revisionAttempts;
          entities?: Array<{ id?: string }>;
          classifierMetadata?: { costUsd?: number; costUnavailableReason?: 'unknown-pricing' };
          costUnavailableComponents?: MissionCostComponent[];
        } | null;
        skillInvocations = m?.skillInvocations;
        partialCheckpointTurn = m?.partialCheckpointTurn ?? undefined;
        qualityReport = m?.qualityReport;
        qualityJudgement = m?.qualityJudgement;
        attachments = m?.attachments;
        chainId = m?.chainId;
        chainStep = m?.chainStep;
        chainTotalSteps = m?.chainTotalSteps;
        skillPrelude = m?.skillPrelude;
        revisionAttempts = m?.revisionAttempts;
        costUnavailableComponents = [...(m?.costUnavailableComponents ?? [])];
        if (m?.classifierMetadata?.costUnavailableReason === 'unknown-pricing') {
          costUnavailableComponents.push('classifier');
        }
        subjectEntityIds = Array.from(
          new Set((m?.entities ?? []).map((entity) => entity.id?.trim()).filter((id): id is string => Boolean(id)))
        );
        auxCosts = {
          classifier: m?.classifierMetadata?.costUsd ?? 0,
          judge: (m as { judgeCostUsd?: number } | null)?.judgeCostUsd ?? 0,
          factCheck: (m as { factCheckCostUsd?: number } | null)?.factCheckCostUsd ?? 0,
          reflection: (m as { reflectionCostUsd?: number } | null)?.reflectionCostUsd ?? 0,
        };
      } catch (readErr) {
        // A failed read here permanently undercounts the bill (revise + aux
        // costs zero out and the memoized Step-3 return locks that in) — say
        // so loudly instead of silently shipping a smaller number.
        log.warn('Step 3 mission-doc read failed — revise/aux costs missing from the finalized total', {
          missionId,
          error: readErr instanceof Error ? readErr.message : String(readErr),
        });
        costUnavailableComponents.push('mission-read');
      }

      const partialFlagOnRun = (result as { partial?: boolean }).partial === true;
      // Roll EVERY cost component into the mission's headline costUsd so
      // the Activity page, billing audits, and downstream chain decisions
      // see the actual bill, not a partial slice.
      //
      // Components:
      //   1. orchestrator main run    — result.costUsd
      //   2. Step 1.7 prelude         — preludeCostUsd (sum of sub-missions)
      //   3. Step 2.75 revise turns   — sum of revisionAttempts[*].costUsd
      //
      // Revision costs live in revisionAttempts[*].costUsd, so they must be
      // aggregated with the main run and prelude for billing reconciliation
      // and chain-budget decisions.
      let reviseCostUsd = 0;
      let revisionsCostUnavailableReason: MissionCostUnavailableReason | undefined;
      for (const revision of revisionAttempts ?? []) {
        if (revision.costUsd === null || revision.costUsd === undefined) {
          if (revision.costUnavailableReason === 'accounting-incomplete' || revision.costUsd === undefined) {
            revisionsCostUnavailableReason = 'accounting-incomplete';
          } else {
            revisionsCostUnavailableReason ??= 'unknown-pricing';
          }
        } else {
          reviseCostUsd += revision.costUsd;
        }
      }
      // MISSION-005: auxiliary Gemini spend (dispatch classifier, L2 judge,
      // fact-check, and reflection) persisted on the mission doc —
      // folded here so the AgentRun/mission cost is the WHOLE bill.
      const auxTotalUsd = auxCosts.classifier + auxCosts.judge + auxCosts.factCheck + auxCosts.reflection;
      const orchestratorCostUnavailableReason: MissionCostUnavailableReason | undefined =
        result.costUsd === null
          ? canonicalCostUnavailableReason(result.costUnavailableReason)
          : result.costUsd === undefined
            ? 'accounting-incomplete'
            : undefined;
      if (orchestratorCostUnavailableReason) costUnavailableComponents.push('orchestrator');
      if (preludeCostUsd === null) costUnavailableComponents.push('prelude');
      if (revisionsCostUnavailableReason) costUnavailableComponents.push('revisions');
      costUnavailableComponents = Array.from(new Set(costUnavailableComponents));
      const accountingIncomplete =
        costUnavailableComponents.includes('mission-read') ||
        orchestratorCostUnavailableReason === 'accounting-incomplete' ||
        preludeCostUnavailableReason === 'accounting-incomplete' ||
        revisionsCostUnavailableReason === 'accounting-incomplete';
      const costUnavailableReason: MissionCostUnavailableReason | undefined =
        costUnavailableComponents.length === 0
          ? undefined
          : accountingIncomplete
            ? 'accounting-incomplete'
            : 'unknown-pricing';
      if (costUnavailableComponents.length === 0) {
        totalMissionCost = result.costUsd! + preludeCostUsd! + reviseCostUsd + auxTotalUsd;
        costBreakdownUsd = {
          orchestrator: result.costUsd!,
          classifier: auxCosts.classifier,
          prelude: preludeCostUsd!,
          revisions: reviseCostUsd,
          judge: auxCosts.judge,
          factCheck: auxCosts.factCheck,
          reflection: auxCosts.reflection,
        };
      } else {
        totalMissionCost = null;
        costBreakdownUsd = undefined;
      }
      // ARUN-003 / OPS-005: honest model attribution. The provider-reported
      // per-model breakdown is the EFFECTIVE SERVED model and outranks
      // everything; only when the SDK reported no breakdown at all does the run
      // fall back to the model it asked for. Ordering these the other way round
      // (`result.model` first) would let a requested pin overwrite the model the
      // provider actually billed. NEVER a hardcoded Sonnet fallback — a run that
      // reported neither simply carries no model. The full breakdown is
      // persisted so per-model billing never depends on a single collapsed field.
      const { primaryModelFromUsage } = await import('@/lib/agent-run-model');
      const runModel = primaryModelFromUsage(result.modelUsage) ?? result.requestedModel;

      // REPORT-002: resolve the HONEST terminal outcome here — BEFORE the run
      // row is written — so the Activity pill and the mission agree. Deriving
      // the row from `result.success` alone can show Success when a mission
      // produced no required artifact. Step 4 consumes this memoized value,
      // so there is one decision with two consumers, not two decisions.
      const terminal = terminalDecisionBeforePersistence;
      const runErrors = terminal.error ? [...(result.errors ?? []), terminal.error] : result.errors;

      await createAgentRun({
        userId,
        missionId,
        agentName: agent,
        action: `Mission: ${prompt.slice(0, 100)}`,
        status: terminal.status === 'completed' ? 'success' : 'failure',
        ...(runModel ? { model: runModel } : {}),
        ...(result.requestedModel ? { requestedModel: result.requestedModel } : {}),
        ...(result.modelSubstitution
          ? {
              modelSubstitution: {
                ...result.modelSubstitution,
                servedModels: [...result.modelSubstitution.servedModels],
              },
            }
          : {}),
        ...(result.modelUsage ? { modelUsage: result.modelUsage } : {}),
        tokenUsage: result.tokenUsage,
        ...(totalMissionCost === null
          ? { costUnavailableReason: costUnavailableReason! }
          : { costUsd: totalMissionCost }),
        ...(result.providerReportedCostUsd !== undefined
          ? { providerReportedCostUsd: result.providerReportedCostUsd }
          : {}),
        ...(result.exposureUsd !== undefined ? { exposureUsd: result.exposureUsd } : {}),
        ...(result.duplicateUsageEvents ? { duplicateUsageEvents: result.duplicateUsageEvents } : {}),
        ...(result.restatedUsageEvents ? { restatedUsageEvents: result.restatedUsageEvents } : {}),
        duration,
        ...(runErrors ? { errors: runErrors } : {}),
        ...(partialFlagOnRun ? { partial: true } : {}),
        ...(partialCheckpointTurn !== undefined ? { partialCheckpointTurn } : {}),
        ...(skillInvocations && skillInvocations.length > 0 ? { skillInvocations } : {}),
        ...(qualityReport ? { qualityReport } : {}),
        ...(qualityJudgement ? { qualityJudgement } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        ...(chainId ? { chainId } : {}),
        ...(chainStep !== undefined ? { chainStep } : {}),
        ...(chainTotalSteps !== undefined ? { chainTotalSteps } : {}),
        ...(skillPrelude && skillPrelude.length > 0 ? { skillPrelude } : {}),
        ...(revisionAttempts && revisionAttempts.length > 0 ? { revisionAttempts } : {}),
      });
      // MISSION-005 (replay safety): return the finalized figures so a replay
      // hands them back memoized — outer-scope mutation alone would vanish on
      // replay and let Step 4 write a stale total (same class of bug as the
      // MISSION-002 revise promotion).
      return {
        totalMissionCost,
        costBreakdownUsd,
        subjectEntityIds,
        costUnavailableComponents,
        costUnavailableReason,
      };
    });
    totalMissionCost = finalizedCosts.totalMissionCost;
    costBreakdownUsd = finalizedCosts.costBreakdownUsd;
    missionSubjectEntityIds = finalizedCosts.subjectEntityIds ?? [];
    // The same memoized decision drives reflection, Episode, AgentRun, Mission,
    // events, and the handler result; no surface recomputes raw SDK truth.
    const terminalDecision = terminalDecisionBeforePersistence;
    const finalizedUnavailableComponents = finalizedCosts.costUnavailableComponents ?? [];
    const finalizedCostUnavailableReason = finalizedCosts.costUnavailableReason;

    // ARUN-022 (mission envelope) — flush the orchestrator's provider-reported
    // per-model usage as durable operation-usage receipts, and record the SDK's
    // authoritative per-model cost as an append-only settlement. The `/agent`
    // package cannot reach the receipt substrate (it imports nothing from
    // @/lib), so this handler seam converts its modelUsage summary. A separate,
    // fully try/caught step so a ledger failure is non-fatal and never perturbs
    // the mission; only runs when the orchestrator reported per-model usage.
    // ARUN-022 (mission envelope) — flush the orchestrator's provider-reported
    // per-model usage as durable operation-usage receipts, and record the SDK's
    // authoritative per-model cost as an append-only settlement. The `/agent`
    // package cannot reach the receipt substrate (it imports nothing from
    // @/lib), so this handler seam converts its modelUsage summary.
    //
    // Failures, timeouts, and some orchestrator error returns may consume tokens
    // and cost WITHOUT exposing a per-model breakdown. In that case we flush ONE
    // synthetic model entry from the available tokenUsage/cost so the fire is
    // still receipted; a missing model prices as unavailable rather than being
    // silently dropped.
    await step.run('record-mission-usage-receipts', async () => {
      try {
        const { flushMissionUsageReceipts } = await import('@/lib/mission-usage-receipts');
        const effectiveModelUsage: Record<
          string,
          { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; costUSD?: number }
        > = result.modelUsage ? { ...result.modelUsage } : {};
        const hasModelUsage = Object.keys(effectiveModelUsage).length > 0;
        const tokenUsage = result.tokenUsage;
        const consumedTokens =
          tokenUsage &&
          (typeof tokenUsage.input === 'number' ? tokenUsage.input : 0) +
            (typeof tokenUsage.output === 'number' ? tokenUsage.output : 0) >
            0;
        if (!hasModelUsage && consumedTokens) {
          const effectiveModel = result.model ?? 'unknown';
          effectiveModelUsage[effectiveModel] = {
            inputTokens: tokenUsage.input,
            outputTokens: tokenUsage.output,
            // Aggregate tokenUsage does not prove cache use was zero, so the
            // synthetic fallback must not manufacture a known-zero cache counter.
            // modelUsageToCapture will mark the receipt as partial because the
            // per-model cache facts are absent.
            ...(typeof result.costUsd === 'number' && Number.isFinite(result.costUsd)
              ? { costUSD: result.costUsd }
              : {}),
          };
        }

        if (Object.keys(effectiveModelUsage).length === 0) {
          // Nothing was captured/reported; there is no provider spend to receipt.
          return;
        }

        await flushMissionUsageReceipts({
          missionId,
          owner: `user:${userId}`,
          // `endTime` is the memoized completion timestamp — stable on replay,
          // so a dated introductory rate prices identically across replays.
          asOf: new Date(endTime).toISOString(),
          modelUsage: effectiveModelUsage,
        });
      } catch (receiptError) {
        log.warn('Mission usage receipt flush failed (best-effort, non-fatal)', {
          missionId,
          error: receiptError instanceof Error ? receiptError.message : String(receiptError),
        });
      }
    });

    // Step 4: Update mission with results (qualityReport was already written
    // by Step 2.7 so we don't overwrite it here).
    await step.run('update-mission-results', async () => {
      const partialFlag = (result as { partial?: boolean }).partial === true;

      // REPORT-002: consume the MEMOIZED terminal decision computed in Step 3
      // (see resolveTerminalOutcome) — never a green "Mission completed" with
      // zero output, and one decision shared with the AgentRun row. SDK
      // failures and partial recoveries keep the legacy terminal semantics.
      const terminalStatus: 'completed' | 'failed' = terminalDecision.status;
      const terminalMessage = partialFlag
        ? 'Mission timed out — partial output recovered'
        : terminalDecision.progressMessage;
      const terminalOutcome = terminalDecision.outcome;
      const terminalErrors = terminalDecision.error
        ? [...(result.errors ?? []), terminalDecision.error]
        : result.errors;
      let resultForWrite = result.result;
      const terminalReportIds = terminalDecision.reportIds;

      if (terminalDecision.resultAppendix && result.result) {
        resultForWrite = `${result.result}${terminalDecision.resultAppendix}`;
      }

      if (result.success && terminalReportIds.length > 0) {
        const { updateReport } = await import('@/lib/reports');
        if (terminalOutcome === 'delivered') {
          // A clean delivery must not leave a stale gate receipt (and its
          // banner) from an earlier unclean run on the same slot.
          for (const reportId of terminalReportIds) {
            try {
              await updateReport(
                reportId,
                { qualityGate: null },
                { savedBy: `agent:${agent}`, requireOwnerId: reportTruth.ownerId }
              );
            } catch (err) {
              log.warn('Failed to clear a stale quality-gate receipt (non-blocking)', {
                missionId,
                reportId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      }

      const completionUpdate: Partial<Mission> = {
        status: terminalStatus,
        progress: 100,
        progressMessage: terminalMessage,
        // ARUN-014: the mission is terminal — clear the transient processing
        // phase (and its preliminary pointer). REPORT-002: the CANONICAL
        // reportId/reportIds persist — they are the durable run→report link.
        phase: null,
        phaseStartedAt: null,
        phaseLimitMs: null,
        phaseLimitCostUsd: null,
        preliminaryReportId: null,
        ...(terminalOutcome ? { outcome: terminalOutcome } : {}),
        ...(terminalDecision.pointerDisposition === 'replace'
          ? { reportId: terminalReportIds[0], reportIds: terminalReportIds }
          : terminalDecision.pointerDisposition === 'clear'
            ? { reportId: null, reportIds: [] }
            : {}),
        ...(resultForWrite ? { result: resultForWrite } : {}),
        // On successful completion, clear the checkpoint scratch fields so
        // the Firestore doc doesn't carry confusing "partialResult = X bytes"
        // alongside a valid final `result`. On partial-output recovery
        // (timeout), keep them so the UI can show the pre-recovery state.
        ...(result.success && !partialFlag
          ? { partialResult: null, partialCheckpointTurn: null, partial: null }
          : partialFlag
            ? { partial: true }
            : {}),
        entities: [],
        sources: [],
        tokenUsage: result.tokenUsage,
        ...(result.requestedModel ? { requestedModel: result.requestedModel } : {}),
        ...(result.modelSubstitution
          ? {
              modelSubstitution: {
                ...result.modelSubstitution,
                servedModels: [...result.modelSubstitution.servedModels],
              },
            }
          : {}),
        ...(result.providerReportedCostUsd !== undefined
          ? { providerReportedCostUsd: result.providerReportedCostUsd }
          : {}),
        ...(result.exposureUsd !== undefined ? { exposureUsd: result.exposureUsd } : {}),
        ...(result.duplicateUsageEvents ? { duplicateUsageEvents: result.duplicateUsageEvents } : {}),
        ...(result.restatedUsageEvents ? { restatedUsageEvents: result.restatedUsageEvents } : {}),
        // Single source of truth — same value as the agent-run row above.
        // Includes orchestrator + prelude + every revise turn so the
        // displayed bill includes every recorded component, including revisions.
        ...(totalMissionCost === null
          ? {
              costUnavailableReason: finalizedCostUnavailableReason!,
              costUnavailableComponents: finalizedUnavailableComponents,
            }
          : { costUsd: totalMissionCost }),
        // MISSION-005: single-writer breakdown — components sum exactly to
        // costUsd above, so nothing can double count.
        ...(costBreakdownUsd ? { costBreakdownUsd } : {}),
        completedAt: new Date().toISOString(),
        ...(terminalErrors ? { errors: terminalErrors } : {}),
      };
      if (terminalDecision.pointerDisposition === 'preserve' && terminalOutcome === undefined) {
        await updateMission(missionId, completionUpdate, {
          // A required Report lookup outage has no honest outcome
          // classification. Delete any stale value while preserving the old
          // durable pointers, because the failed read proves neither presence
          // nor absence.
          deleteFields: ['outcome'],
        });
      } else {
        await updateMission(missionId, completionUpdate);
      }

      try {
        const { emitAgentEvent } = await import('@/lib/agent-events');
        await emitAgentEvent({
          // REPORT-002: the event reflects the HONEST terminal status — a
          // no-deliverable run emits agent.error even though the SDK reported
          // success, so live UIs never celebrate a missing artifact.
          type: terminalStatus === 'completed' ? 'agent.completed' : 'agent.error',
          userId,
          missionId,
          agentType: agent,
          data: {
            success: terminalStatus === 'completed',
            ...(totalMissionCost === null
              ? {
                  costUnavailableReason: finalizedCostUnavailableReason,
                  costUnavailableComponents: finalizedUnavailableComponents,
                }
              : { costUsd: totalMissionCost }),
            tokenUsage: result.tokenUsage,
            duration,
            ...(result.numTurns !== undefined ? { numTurns: result.numTurns } : {}),
            ...(result.durationApiMs !== undefined ? { durationApiMs: result.durationApiMs } : {}),
            ...(result.modelUsage ? { modelUsage: result.modelUsage } : {}),
            ...(terminalErrors?.length ? { errors: terminalErrors } : {}),
          },
        });
      } catch (err) {
        log.warn('[agent-events] Failed to emit agent completion event', { error: String(err) });
      }
    });

    // Mission chaining — if this mission is part of a chain and completed
    // cleanly, dispatch the next step. Partial/failed missions halt the
    // chain so bad work doesn't cascade downstream.
    await step.run('advance-chain', async () => {
      let failureReason = 'chain-dispatch-failure';
      try {
        const { getMissionById } = await import('@/lib/missions');
        const { findNextChainStep, renderPromptWithParent, shouldAdvanceChain } = await import('@/lib/mission-chains');
        const current = await getMissionById(missionId);
        if (!current || !current.chainId) return; // not a chain mission

        if (!shouldAdvanceChain(current)) {
          const haltReason = resolveHaltReason({
            status: current.status,
            partial: current.partial ?? undefined,
            qualityJudgement: current.qualityJudgement,
            qualityReport: current.qualityReport ? { verdict: current.qualityReport.verdict } : undefined,
          });
          log.info('Chain halted at this step', {
            chainId: current.chainId,
            missionId,
            status: current.status,
            partial: current.partial ?? undefined,
            l1Verdict: current.qualityReport?.verdict,
            l1Score: current.qualityReport?.overallScore,
            l2Verdict: current.qualityJudgement?.verdict,
            l2Score: current.qualityJudgement?.overallScore,
            reason: haltReason,
          });
          // Mark un-run downstream steps failed so
          // no mission is left 'pending' forever (shared helper; also fired
          // from onFailure for hard failures that never reach this step).
          await failDownstreamChainSteps(missionId, haltReason);
          return;
        }

        const next = await findNextChainStep(current);
        if (!next) return; // already final step

        let parentResult = current.result;
        if (current.agent === 'scout' && next.agent === 'creator') {
          failureReason = 'evidence-provenance-failure';
          const filtered = await filterParentEvidence(current.result, userId, missionId);
          // Persist before dispatch. Firestore is the citation authority; the
          // graph projection is deliberately never consulted by the reader.
          await updateMission(next.id, {
            evidenceBundle: filtered.bundle,
            evidenceProvenance: filtered.provenance,
          });
          parentResult = filtered.text;
          failureReason = 'chain-dispatch-failure';
        }
        const renderedPrompt = renderPromptWithParent(next.prompt, parentResult);

        await inngest.send({
          name: 'app/mission.run.requested',
          data: {
            missionId: next.id,
            userId,
            prompt: renderedPrompt,
            agent: next.agent,
          },
        });

        log.info('Chain advanced', {
          chainId: current.chainId,
          from: { missionId, step: current.chainStep },
          to: { missionId: next.id, step: next.chainStep },
        });
      } catch (err) {
        log.warn('Chain advancement failed (chain halted)', {
          missionId,
          error: err instanceof Error ? err.message : String(err),
        });
        await failDownstreamChainSteps(missionId, failureReason);
      }
    });

    // SDM Task 4: Best-effort — emit observations from the scout bundle's sources
    // for each subject entity. Defense Minister's smart scorer aggregates these
    // to avoid a full active recheck on every verification call.
    await step.run('emit-scout-observations', async () => {
      try {
        if (agent !== 'scout') return { emitted: 0, reason: 'not-scout' };
        if (!result.success) return { emitted: 0, reason: 'mission-failed' };

        // Step 4 intentionally clears mission.entities. Use the IDs captured
        // in the memoized AgentRun step before that finalization, otherwise
        // every successful scout mission silently emits zero observations.
        if (missionSubjectEntityIds.length === 0) return { emitted: 0, reason: 'no-subject-entities' };

        const { parseScoutBundle, verdictFromAdmiralty } = await import('@/lib/scout-bundle-parser');
        const { createMissionObservationEvent, deduplicateMissionObservationSources } =
          await import('@/lib/graph/observation-identity');
        const parsed = parseScoutBundle(result.result ?? '');
        if (!parsed.ok) return { emitted: 0, reason: 'no-bundle' };
        const bundle = parsed.bundle;
        const observationSources = deduplicateMissionObservationSources(
          bundle.sources.map((source) => ({
            sourceUrl: source.url,
            verdict: verdictFromAdmiralty(source.admiralty),
          }))
        );
        if (observationSources.conflictingSourceUrls.length > 0) {
          log.warn('Skipped Scout sources with conflicting verdicts for the same URL', {
            missionId,
            sourceUrls: observationSources.conflictingSourceUrls,
          });
        }

        let emitted = 0;
        for (const entityId of missionSubjectEntityIds) {
          for (const source of observationSources.accepted) {
            try {
              await inngest.send(
                createMissionObservationEvent({
                  entityId,
                  sourceUrl: source.sourceUrl,
                  // M13: derive the verdict from the source's own Admiralty
                  // grade instead of stamping every source 'confirming'
                  // (which made verify-entity scoring a rubber stamp).
                  verdict: source.verdict,
                  agentType: 'scout',
                  missionId,
                  observedAt: new Date(endTime).toISOString(),
                })
              );
              emitted++;
            } catch {
              // Best-effort — a single send failure must not stop the loop
            }
          }
        }
        log.info('Scout observations emitted', { missionId, emitted });
        return { emitted };
      } catch (err) {
        log.warn('Failed to emit scout observations', {
          missionId,
          error: err instanceof Error ? err.message : String(err),
        });
        return { emitted: 0, error: err instanceof Error ? err.message : String(err) };
      }
    });

    // ========================================================================
    // OBS-004 — report this child's terminal accounting back to its sweep.
    //
    // A sweep dispatches children fire-and-forget and returns long before they
    // finish, so the sweep itself can never observe how they ended. This step is
    // the reporting half: the child, which DOES know, writes a durable settlement
    // keyed by (sweepId, missionId) and asks the sweep's summary row to refresh.
    //
    // Idempotent by doc-id identity, so an Inngest replay re-reports the same
    // observation instead of double-counting the child's spend. Fully try/caught:
    // a sweep's bookkeeping must never fail a mission that already delivered.
    // ========================================================================
    await step.run('settle-sweep-child-accounting', async () => {
      try {
        const { getMissionById } = await import('@/lib/missions');
        const settledMission = (await getMissionById(missionId)) as
          | (Pick<Mission, 'sweepId' | 'status' | 'partial' | 'costUsd' | 'tokenUsage'> & {
              costUnavailableReason?: 'unknown-pricing' | 'accounting-incomplete';
              reportIds?: string[];
            })
          | null;
        const sweepId = settledMission?.sweepId;
        if (!sweepId) return { settled: false, reason: 'not-a-sweep-child' as const };

        const { recordSweepChildSettlement, refreshSweepChildAggregate } =
          await import('@/lib/sweep-child-accounting-admin');

        await recordSweepChildSettlement(sweepId, {
          missionId,
          // The SAME canonical derivation every other store uses, so the sweep's
          // child partition cannot disagree with the child's own Mission doc.
          outcome: domainOutcomeForMissionTerminal(terminalDecision, result),
          // An unknown cost stays absent, never 0 (AI-029) — a partly-priced batch
          // must not present its total as exact.
          ...(totalMissionCost === null
            ? { costUnavailableReason: finalizedCostUnavailableReason ?? 'accounting-incomplete' }
            : { costUsd: totalMissionCost }),
          ...(result.tokenUsage ? { tokensIn: result.tokenUsage.input, tokensOut: result.tokenUsage.output } : {}),
          durationMs: duration,
          outputs: {
            // Durable outputs only — what persisted, not what the agent claimed.
            reports: terminalDecision.reportIds.length,
            entities: missionSubjectEntityIds.length,
          },
        });

        const refresh = await refreshSweepChildAggregate(sweepId);
        log.info('Sweep child accounting settled', { missionId, sweepId, refresh });
        return { settled: true, sweepId };
      } catch (err) {
        log.warn('Sweep child accounting settlement failed (non-blocking)', {
          missionId,
          error: err instanceof Error ? err.message : String(err),
        });
        return { settled: false, reason: 'error' as const };
      }
    });

    // OBS-001: the transport record must not stand in for the business result.
    // This run can finish cleanly
    // while the mission failed and no Report existed; the declaration is what
    // stops that row being counted as a delivered mission.
    return declareDomainOutcome(
      { missionId, success: terminalDecision.status === 'completed', duration },
      {
        outcome: domainOutcomeForMissionTerminal(terminalDecision, result),
        ...(terminalDecision.outcome ? { reason: terminalDecision.outcome } : {}),
      }
    );
  }
);
