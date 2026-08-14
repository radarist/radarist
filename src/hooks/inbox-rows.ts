/**
 * @file hooks/inbox-rows.ts
 * @description The inbox ROW shape + the pure mappers that turn each proposal kind
 * (discovery / verdict / recommendation) into a uniform InboxRow. Kept free of React
 * and fetch so it is trivially unit-testable; the hooks in useInbox.ts consume these.
 */
import type { ProposedEntity } from '@/lib/schemas/proposed-entity';
import type { ProposedAssessment, AssessmentEvidence } from '@/lib/schemas/proposed-assessment';
import type { ProposedArtifact } from '@/lib/schemas/proposed-artifact';
import { resolvePainPointApprovalClassification } from '@/lib/pain-points-shared';
import { formatEnumLabel } from '@/lib/enum-label';

const REC_LABEL: Record<string, string> = { adopt: 'Adopt', trial: 'Trial', assess: 'Assess', hold: 'Hold' };

export type InboxKind = 'discovery' | 'verdict' | 'recommendation';

export interface InboxRow {
  id: string;
  kind: InboxKind;
  name: string;
  entityType: string;
  effect: string;
  source: string;
  confidence: number;
  detail: string;
  tags: string[];
  sourceUrl: string;
  whyRelevant: string; // proactive: why the scout surfaced this
  matchedTopics: string[]; // proactive: which of the user's interests it matched
  status?: string; // resolved status (for the archive view)
  createdAt?: number; // when the proposal was created (for the Created column)
  generationStatus?: string; // recommendation: idle | generating | ready | failed
  outputUrl?: string; // recommendation: the produced artifact link (once ready)
  artifactKind?: string; // recommendation: report | research | infographic
  scopeQuery?: string; // recommendation: the topic/scope the artifact is about
  updateTargetUrl?: string; // recommendation (update): link to the CURRENT output being refreshed
  evidenceMetrics?: AssessmentEvidence['metrics']; // verdict: measured metrics (name/value/command)
  evidenceFindings?: AssessmentEvidence['findings']; // verdict: structured findings from the run
  sourceDocumentId?: string; // verdict: the verdict Document produced by the run
  sourceRunId?: string; // verdict: the build-mission run that produced the verdict
}

export function entityToRow(e: ProposedEntity): InboxRow {
  const data = e.data as {
    tags?: string[];
    sourceUrl?: string;
    whyRelevant?: string;
    matchedTopics?: string[];
    severity?: unknown;
    status?: unknown;
    category?: unknown;
  };
  const painPointClassification =
    e.entityType === 'painPoint'
      ? resolvePainPointApprovalClassification(data)
      : null;
  const classificationUsesDefaults =
    painPointClassification?.usesDefaultSeverity ||
    painPointClassification?.usesDefaultCategory;
  const effect = painPointClassification
    ? `Add painPoint to the catalog as ${formatEnumLabel(painPointClassification.severity)} severity · ${formatEnumLabel(painPointClassification.category)} category${classificationUsesDefaults ? ' (defaults shown for review)' : ''}`
    : `Add ${e.entityType} to the catalog`;

  return {
    id: e.id,
    kind: 'discovery',
    name: e.name,
    entityType: e.entityType,
    effect,
    source: 'scout',
    confidence: e.confidence,
    detail: e.description ?? '',
    tags: Array.isArray(data?.tags) ? data.tags : [],
    sourceUrl: data?.sourceUrl ?? '',
    whyRelevant: data?.whyRelevant ?? '',
    matchedTopics: Array.isArray(data?.matchedTopics) ? data.matchedTopics : [],
    status: e.status,
    createdAt: e.createdAt,
  };
}

export function assessmentToRow(a: ProposedAssessment): InboxRow {
  const rec = REC_LABEL[a.recommendation] ?? a.recommendation;
  // Rows arrive as raw API JSON (not zod-parsed), so older records may lack `evidence`.
  const evidence = a.evidence as AssessmentEvidence | undefined;
  const metrics = Array.isArray(evidence?.metrics) ? evidence.metrics : [];
  const findings = Array.isArray(evidence?.findings) ? evidence.findings : [];
  return {
    id: a.id,
    kind: 'verdict',
    name: a.technologyName ?? a.technologyId,
    entityType: 'technology',
    effect: `${rec} → ${a.proposedRing} ring`,
    source: 'build mission',
    confidence: a.confidence,
    detail: `Evaluation verdict: ${rec} (TRL ${a.trl ?? '—'}). Approving places it on the ${a.proposedRing} ring.`,
    tags: [],
    sourceUrl: '',
    whyRelevant: '',
    matchedTopics: [],
    status: a.status,
    createdAt: (a as { createdAt?: number }).createdAt,
    evidenceMetrics: metrics.length > 0 ? metrics : undefined,
    evidenceFindings: findings.length > 0 ? findings : undefined,
    sourceDocumentId: a.sourceDocumentId,
    sourceRunId: a.sourceRunId,
  };
}

export function artifactToRow(a: ProposedArtifact): InboxRow {
  const noun =
    a.artifactKind === 'research'
      ? 'a research document'
      : a.artifactKind === 'infographic'
        ? 'a visual infographic'
        : 'an HTML report';
  const effect = a.updateOf
    ? `Update the existing ${a.artifactKind} (regenerates on approve)`
    : `Produce ${noun} (runs on approve)`;
  const about = a.scope?.query?.trim();
  // A real DESCRIPTION of the deliverable — distinct from the rationale (the "why"),
  // so the detail page isn't the same sentence twice.
  const detail = a.updateOf
    ? `Approving regenerates the existing ${a.artifactKind === 'infographic' ? 'infographic' : 'report'} in place with the latest radar data${about ? ` on “${about}”` : ''} — same link, refreshed content.`
    : `Approving generates ${noun}${about ? ` on “${about}”` : ''} and files it in ${a.artifactKind === 'research' ? 'Documents' : a.artifactKind === 'infographic' ? 'the Infographics gallery' : 'Reports'}. Nothing runs until you approve.`;
  return {
    id: a.id,
    kind: 'recommendation',
    name: a.title,
    entityType: a.artifactKind,
    effect,
    source: 'scout',
    confidence: a.confidence,
    detail,
    tags: [],
    sourceUrl: a.outputRef?.url ?? '',
    whyRelevant: a.rationale ?? '',
    matchedTopics: Array.isArray(a.matchedTopics) ? a.matchedTopics : [],
    status: a.status,
    createdAt: a.createdAt,
    generationStatus: a.generationStatus,
    outputUrl: a.outputRef?.url,
    artifactKind: a.artifactKind,
    scopeQuery: about || undefined,
    updateTargetUrl: a.updateOf?.url,
  };
}

// ── UX-053: per-source health ───────────────────────────────────────────────

/** Which of the three independent inbox sources failed (true = failed). */
export interface InboxSourceHealth {
  discoveries: boolean;
  recommendations: boolean;
  verdicts: boolean;
}

/**
 * Human labels for the degraded banner. Labels ONLY — raw error messages must
 * never cross into the UI (they can leak backend internals).
 */
export const INBOX_SOURCE_LABEL: Record<keyof InboxSourceHealth, string> = {
  discoveries: 'discoveries',
  recommendations: 'report recommendations',
  verdicts: 'verdicts',
};

/** The failed sources as display labels, in stable order. */
export function degradedInboxSources(health: InboxSourceHealth): string[] {
  return (Object.keys(INBOX_SOURCE_LABEL) as Array<keyof InboxSourceHealth>)
    .filter((k) => health[k])
    .map((k) => INBOX_SOURCE_LABEL[k]);
}
