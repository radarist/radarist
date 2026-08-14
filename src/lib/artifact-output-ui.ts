/**
 * @file artifact-output-ui.ts
 * @description Pure derivation for the /artifacts OUTPUTS catalog. The catalog
 * shows what a build mission PRODUCED (a Prototype, a verdict Document, an
 * Assessment), keyed off `artifactKind` + `artifact` + `findings` — deliberately
 * INDEPENDENT of run status (a failed run can still have produced a valuable
 * output). Run status appears only as a small contextual "source run" pill.
 *
 * Client-safe, no JSX (returns labels + class strings) — mirrors build-mission-ui.ts.
 */
import { ENTITY_COLORS } from '@/lib/entity-colors';
import { getEntityUrl } from '@/lib/entity-links';
import type { Mission } from '@/lib/schemas/mission';
import type { ArtifactKind } from '@/lib/schemas/mission-build';

export type ArtifactKindResolved = ArtifactKind;

export function artifactKindOf(mission: Mission): ArtifactKindResolved {
  return (mission.artifactKind ?? 'solution') as ArtifactKindResolved;
}

/**
 * Kind → display label + theme-aware tint. `className` is the canonical
 * ENTITY_COLORS text class (kept for the /artifacts/[id] detail-page span);
 * `tint` adds the bg+border pair so ArtifactsTable can render a CONV-BADGE
 * tinted-outline pill (`Badge variant="outline"` + `className + tint`) instead
 * of plain colored text. Tints are hand-rolled literals (NOT
 * `ENTITY_COLORS.*.border`, which is /20) so borders stay at the catalog-wide
 * /30 strength every other status/kind pill uses.
 */
export const ARTIFACT_KIND_BADGE: Record<ArtifactKindResolved, { label: string; className: string; tint: string }> = {
  solution: {
    label: 'App',
    className: ENTITY_COLORS.prototype.text,
    tint: 'bg-teal-500/10 border-teal-500/30',
  },
  evaluation: {
    label: 'Evaluation',
    className: ENTITY_COLORS.technology.text,
    tint: 'bg-emerald-500/10 border-emerald-500/30',
  },
  architecture: {
    label: 'Architecture',
    className: ENTITY_COLORS.document.text,
    tint: 'bg-slate-500/10 border-slate-500/30',
  },
  report: {
    label: 'Report',
    className: ENTITY_COLORS.document.text,
    tint: 'bg-slate-500/10 border-slate-500/30',
  },
};

/**
 * Whether a solution's local preview container is reachable RIGHT NOW — derived
 * from `sandbox.state`, which the lifecycle GC (cleanup-build-sandboxes) flips to
 * 'stopped' when it idles the container past keep-alive and 'destroyed' when it
 * reclaims the container+volume. Start also self-heals to 'destroyed' when a
 * trusted Docker probe proves the recorded volume is already absent. Without
 * this, the UI kept rendering an iframe / "open preview" link to a port that no
 * longer serves anything.
 *
 * - ready   — the container is live and the URL should render.
 * - stopped — idled by GC; Iterate/Start can bring it back, so offer that, not a link.
 * - expired — reclaimed (container+volume gone); the preview is unrecoverable.
 * - none    — this mission never had a preview URL.
 */
export type PreviewState = 'ready' | 'stopped' | 'expired' | 'none';

export function previewState(mission: Mission): PreviewState {
  const hasUrl = Boolean(mission.artifact?.previewUrl) || Boolean(mission.sandbox?.hostPort);
  if (!hasUrl) return 'none';
  const state = mission.sandbox?.state;
  if (state === 'destroyed') return 'expired';
  if (state === 'stopped') return 'stopped';
  return 'ready';
}

export type OutputStatus = 'published' | 'pending-triage' | 'draft' | 'none';

/**
 * Output-status pill tint (CONV-BADGE tinted-outline), keyed by the `status` union
 * (not the free-text `label`) so ArtifactsTable can render a semantic pill — the
 * detail page keeps the plain-text presentation untouched.
 */
export const OUTPUT_STATUS_TINT: Record<OutputStatus, string> = {
  published: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30',
  'pending-triage': 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
  draft: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
  none: 'bg-muted text-muted-foreground border-border',
};

/** Output status — derived per kind, NOT the run status. */
export function outputStatus(mission: Mission): { status: OutputStatus; label: string } {
  const kind = artifactKindOf(mission);
  const artifact = mission.artifact;
  if (kind === 'solution') {
    if (artifact?.prototypeId && artifact.publishedAt) return { status: 'published', label: 'Published' };
    // Not yet published (mid-run or a failed publish) but a preview exists — its
    // label must track whether that preview is still live.
    const pv = previewState(mission);
    if (pv === 'ready') return { status: 'draft', label: 'Preview only' };
    if (pv === 'stopped') return { status: 'draft', label: 'Preview stopped' };
    if (pv === 'expired') return { status: 'none', label: 'Preview expired' };
    return { status: 'none', label: '—' };
  }
  // evaluation / architecture / report → a Document
  if (kind === 'evaluation') {
    if (artifact?.assessmentId) return { status: 'pending-triage', label: 'Awaiting triage' };
    if (artifact?.documentId) return { status: 'published', label: 'Verdict ready' };
    if ((mission.findings?.length ?? 0) > 0) return { status: 'draft', label: 'Verdict drafted' };
    return { status: 'none', label: '—' };
  }
  if (artifact?.documentId) return { status: 'published', label: 'Document ready' };
  if ((mission.findings?.length ?? 0) > 0) return { status: 'draft', label: 'Drafted' };
  return { status: 'none', label: '—' };
}

export interface OutputRef {
  kind: 'prototype' | 'document' | null;
  id?: string;
  /** A deep link to the output's native surface (library), if resolvable. */
  href?: string;
  /** Live preview URL for a solution prototype, if any. */
  previewUrl?: string;
}

/** Resolve the produced entity (prototype or document) + a deep link. */
export function outputRef(mission: Mission): OutputRef {
  const artifact = mission.artifact;
  // Only hand back a preview URL when the container is actually reachable — a
  // stopped/reclaimed sandbox must not surface a link that 404s or hangs.
  const previewUrl =
    previewState(mission) === 'ready'
      ? (artifact?.previewUrl ??
        (mission.sandbox?.hostPort ? `http://localhost:${mission.sandbox.hostPort}` : undefined))
      : undefined;
  if (artifact?.prototypeId) {
    return {
      kind: 'prototype',
      id: artifact.prototypeId,
      href: getEntityUrl('prototype', artifact.prototypeId) ?? undefined,
      previewUrl,
    };
  }
  if (artifact?.documentId) {
    return {
      kind: 'document',
      id: artifact.documentId,
      href: getEntityUrl('document', artifact.documentId) ?? undefined,
      previewUrl,
    };
  }
  return { kind: null, previewUrl };
}

/**
 * Run-status pill (the ONLY place run status appears in the catalog). Returns a
 * CONV-BADGE tinted-outline className — the run status previously rendered as a
 * filled Badge (`variant="default"`/`"secondary"`/`"destructive"`), which CONV-BADGE
 * reserves for primary action buttons only.
 */
export function runStatusBadge(mission: Mission): { label: string; className: string } {
  if (mission.status === 'running' || mission.status === 'pending') {
    return { label: 'Running', className: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30' };
  }
  if (mission.status === 'completed') {
    return { label: 'Completed', className: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30' };
  }
  if (mission.status === 'failed') {
    return { label: 'Failed', className: 'bg-destructive/10 text-destructive border-destructive/30' };
  }
  return { label: mission.status, className: 'bg-muted text-muted-foreground border-border' };
}

/** Link back to the run on the Agent Runs / Builds tab. */
export function sourceRunHref(mission: Mission): string {
  return `/agents/runs?tab=builds&build=${mission.id}`;
}

/** Should this mission appear in the outputs catalog? (Any output OR findings.) */
export function hasArtifactOutput(mission: Mission): boolean {
  return Boolean(mission.artifact?.prototypeId || mission.artifact?.documentId) || (mission.findings?.length ?? 0) > 0;
}

type Finding = NonNullable<Mission['findings']>[number];
export const verdictFinding = (m: Mission): Finding | undefined => m.findings?.find((f) => f.kind === 'verdict');
export const metricFindings = (m: Mission): Finding[] => m.findings?.filter((f) => f.kind === 'benchmark') ?? [];
export const riskFindings = (m: Mission): Finding[] => m.findings?.filter((f) => f.kind === 'risk') ?? [];
