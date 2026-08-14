'use client';

/**
 * @file components/activity/AgentLog.tsx
 * @description Agent log timeline component
 *
 * Displays a vertical timeline of all agent actions with status badges,
 * token usage, duration, and error details. Each entry is rendered as
 * a card in a vertical list.
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/feedback/EmptyState';
import { useReports } from '@/hooks/useReports';
import { useAuth } from '@/components/providers/AuthProvider';
import { buildCanonicalReportsByMission } from '@/lib/reports/select-canonical-report';
import { cn } from '@/lib/utils';
import {
  Bot,
  CheckCircle2,
  XCircle,
  SkipForward,
  Clock,
  Zap,
  AlertTriangle,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  FileText,
  Link2,
  Gauge,
  DollarSign,
} from 'lucide-react';
import { type AgentLogEntry, AgentLogEntryStatus } from '@/hooks/useAgentActivity';
import { agentLogDurationMs } from '@/lib/agent-run-duration';
import { agentRunUsageSnapshot } from '@/lib/agent-run-usage';
import { formatRunCost } from '@/lib/run-cost-display';
import type { Report } from '@/lib/schemas/report';

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Color-coded badge className by agent name.
 */
function getAgentBadgeClass(agentName: string): string {
  switch (agentName.toLowerCase()) {
    case 'scout':
      return 'bg-blue-500/15 text-blue-700 border-blue-500/30 dark:text-blue-400';
    case 'evaluator':
      return 'bg-purple-500/15 text-purple-700 border-purple-500/30 dark:text-purple-400';
    case 'linker':
      return 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30 dark:text-emerald-400';
    case 'monitor':
      return 'bg-orange-500/15 text-orange-700 border-orange-500/30 dark:text-orange-400';
    default:
      return 'bg-muted text-muted-foreground border-border';
  }
}

/**
 * Status badge configuration. When `partial === true`, the run surfaces a
 * yellow "Partial" badge instead of red "Failed" — it timed out but
 * Tier 1 checkpointing rescued the pre-timeout output.
 */
function getStatusConfig(
  status: AgentLogEntryStatus,
  partial?: boolean
): {
  label: string;
  className: string;
  icon: React.ElementType;
} {
  if (partial) {
    return {
      label: 'Partial',
      className: 'bg-amber-500/15 text-amber-700 border-amber-500/30 dark:text-amber-400',
      icon: AlertTriangle,
    };
  }
  switch (status) {
    case 'success':
      return {
        label: 'Success',
        className: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30 dark:text-emerald-400',
        icon: CheckCircle2,
      };
    case 'failure':
      return {
        label: 'Failed',
        className: 'bg-destructive/15 text-destructive border-destructive/30',
        icon: XCircle,
      };
    case 'skipped':
      return {
        label: 'Skipped',
        className: 'bg-yellow-500/15 text-yellow-700 border-yellow-500/30 dark:text-yellow-400',
        icon: SkipForward,
      };
  }
}

/**
 * Format duration as human-readable string. Undefined = unknowable
 * (ARUN-008 infrastructure-failure fallback rows) — rendered as "—",
 * matching the shared RunsTable convention.
 */
function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Format token count with K suffix for readability.
 */
function formatTokens(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
  return String(count);
}

/**
 * Format a byte count as human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Quality verdict badge styling.
 */
function getQualityBadgeClass(verdict: 'PASS' | 'REVISE' | 'FAIL'): string {
  switch (verdict) {
    case 'PASS':
      return 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30 dark:text-emerald-400';
    case 'REVISE':
      return 'bg-amber-500/15 text-amber-700 border-amber-500/30 dark:text-amber-400';
    case 'FAIL':
      return 'bg-destructive/15 text-destructive border-destructive/30';
  }
}

/**
 * Format a relative timestamp (e.g., "2 hours ago").
 */
function formatRelativeTime(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffMs = now - then;

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ============================================================================
// LOG ENTRY CARD
// ============================================================================

interface LogEntryCardProps {
  entry: AgentLogEntry;
  /** Lookup of missionId → published report, used to link a run to its report. */
  reportsByMission?: ReadonlyMap<string, Report>;
}

function LogEntryCard({ entry, reportsByMission }: LogEntryCardProps) {
  const statusConfig = getStatusConfig(entry.status, entry.partial);
  const StatusIcon = statusConfig.icon;
  // ARUN-020: the ONE AgentRun usage read rule, shared with the Runs list, the
  // run detail and the daily/by-agent aggregates. Absent — and provider-
  // unreported — usage stays absent: render "—", never a fabricated 0.
  const usage = agentRunUsageSnapshot(entry);
  const totalTokens = usage.tokens;
  const [skillsExpanded, setSkillsExpanded] = React.useState(false);
  const [qualityExpanded, setQualityExpanded] = React.useState(false);
  const [judgementExpanded, setJudgementExpanded] = React.useState(false);
  const [attachmentsExpanded, setAttachmentsExpanded] = React.useState(false);
  const skillCount = entry.skillInvocations?.length ?? 0;
  const attachmentCount = entry.attachments?.length ?? 0;
  const linkedReport = entry.missionId ? reportsByMission?.get(entry.missionId) : undefined;

  return (
    <Card
      className={cn(
        'transition-colors',
        entry.status === 'failure' && !entry.partial && 'border-destructive/20',
        entry.partial && 'border-amber-500/30'
      )}
      data-testid={`agent-log-entry-${entry.id}`}
    >
      <CardContent className="p-4">
        {/* Top row: Agent badge + Status badge */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Badge variant="outline" className={cn('shrink-0 gap-1', getAgentBadgeClass(entry.agentName))}>
              <Bot className="h-3 w-3" />
              {entry.agentName}
            </Badge>
            <Badge variant="outline" className={cn('shrink-0 gap-1', statusConfig.className)}>
              <StatusIcon className="h-3 w-3" />
              {statusConfig.label}
            </Badge>
            {/* REPORT-018: the governing verdict leads when L1 and L2 disagree. */}
            {entry.qualityVerdict && (
              <Badge
                variant="outline"
                className={cn('shrink-0 gap-1', getQualityBadgeClass(entry.qualityVerdict.verdict))}
                title={
                  entry.qualityVerdict.disagreement
                    ? entry.qualityVerdict.disagreement.detail
                    : `Canonical verdict (decided by ${entry.qualityVerdict.decidedBy})`
                }
                data-testid={`quality-badge-canonical-${entry.id}`}
              >
                <Gauge className="h-3 w-3" />
                Quality: {entry.qualityVerdict.verdict}
                {entry.qualityVerdict.disagreement ? ' ⚠' : ''}
              </Badge>
            )}
            {entry.qualityReport && (
              <Badge
                variant="outline"
                className={cn('shrink-0 gap-1', getQualityBadgeClass(entry.qualityReport.verdict))}
                title={`Layer 1 (rule-based) score: ${(entry.qualityReport.overallScore * 100).toFixed(0)}%`}
                data-testid={`quality-badge-L1-${entry.id}`}
              >
                <Gauge className="h-3 w-3" />
                L1: {entry.qualityReport.verdict}
              </Badge>
            )}
            {entry.qualityJudgement && (
              <Badge
                variant="outline"
                className={cn('shrink-0 gap-1', getQualityBadgeClass(entry.qualityJudgement.verdict))}
                title={`Layer 2 (${entry.qualityJudgement.judgeModel}) score: ${(entry.qualityJudgement.overallScore * 100).toFixed(0)}%`}
                data-testid={`quality-badge-L2-${entry.id}`}
              >
                <Gauge className="h-3 w-3" />
                L2: {entry.qualityJudgement.verdict}
              </Badge>
            )}
            {entry.chainId && entry.chainStep && entry.chainTotalSteps && (
              <Badge
                variant="outline"
                className="shrink-0 gap-1 bg-indigo-500/10 text-indigo-700 border-indigo-500/30 dark:text-indigo-400"
                title={`Chain ${entry.chainId}`}
              >
                <Link2 className="h-3 w-3" />
                Step {entry.chainStep}/{entry.chainTotalSteps}
              </Badge>
            )}
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">{formatRelativeTime(entry.createdAt)}</span>
        </div>

        {/* Action description */}
        <p className="mt-2 text-sm text-foreground">{entry.action}</p>

        {/* Metadata row: tokens, duration, sweep */}
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span
            className="flex items-center gap-1"
            title={
              !usage.unavailable
                ? `Input: ${formatTokens(usage.input)} / Output: ${formatTokens(usage.output)}${
                    usage.partiallyReported ? ' (lower bound — a provider response reported no usage)' : ''
                  }`
                : 'Token usage was not recorded for this run'
            }
          >
            <Zap className="h-3 w-3" />
            {totalTokens === undefined ? '—' : formatTokens(totalTokens)} tokens
          </span>
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatDuration(agentLogDurationMs(entry))}
          </span>
          <span className="flex items-center gap-1" data-testid={`agent-log-cost-${entry.id}`}>
            <DollarSign className="h-3 w-3" />
            {/* ARUN-027 — shared wording rule, so an unpriceable model and a
                ledger that lost receipts do not both read "Cost unavailable",
                and a legacy amount is not labelled settled. */}
            <span title={formatRunCost({ ...entry, costUnavailable: entry.costUsd === undefined }).title}>
              {formatRunCost({ ...entry, costUnavailable: entry.costUsd === undefined }).label}
            </span>
          </span>
          {entry.sweepId && <span className="text-muted-foreground/70">Sweep: {entry.sweepId}</span>}
          {linkedReport && (
            <Link
              href={`/reports/${linkedReport.id}`}
              className="flex items-center gap-1 font-medium text-primary hover:underline"
              title={linkedReport.title}
              data-testid={`view-report-link-${entry.id}`}
            >
              <FileText className="h-3 w-3" />
              View report
            </Link>
          )}
        </div>

        {/* Partial notice — the cause is durable (AI-042), never assumed */}
        {entry.partial && (
          <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-3 w-3" />
              {entry.partialReason === 'tool-failures'
                ? 'Partial — some operations failed'
                : `Partial output — timed out${
                    entry.partialCheckpointTurn !== undefined ? ` at turn ${entry.partialCheckpointTurn}` : ''
                  }`}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {entry.partialReason === 'tool-failures'
                ? 'An answer was delivered, but one or more of this turn’s operations did not complete. The failures are listed below.'
                : 'The mission hit its time budget. The agent’s output up to the last checkpoint has been recovered and is available in the mission result.'}
            </p>
            {entry.partialReason === 'tool-failures' && entry.errors && entry.errors.length > 0 && (
              <ul className="mt-1.5 space-y-0.5">
                {entry.errors.map((error, index) => (
                  <li key={index} className="text-xs text-amber-700 dark:text-amber-400">
                    {error}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Skill invocation trail (expandable) */}
        {skillCount > 0 && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setSkillsExpanded(!skillsExpanded)}
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              data-testid={`skills-toggle-${entry.id}`}
            >
              {skillsExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Skills fired ({skillCount})
            </button>
            {skillsExpanded && (
              <ul className="mt-2 space-y-1 border-l-2 border-border pl-3">
                {entry.skillInvocations!.map((inv, idx) => (
                  <li key={`${inv.skill}-${idx}`} className="flex items-baseline gap-2 text-xs">
                    <span className="shrink-0 font-mono text-muted-foreground">turn {inv.turn ?? '?'}</span>
                    <span className="font-medium text-foreground">{inv.skill}</span>
                    {inv.args && (
                      <span className="truncate text-muted-foreground/80" title={inv.args}>
                        — {inv.args.slice(0, 80)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Quality checks (expandable) */}
        {entry.qualityReport && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setQualityExpanded(!qualityExpanded)}
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              data-testid={`quality-toggle-${entry.id}`}
            >
              {qualityExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Quality checks ({entry.qualityReport.checks.filter((c) => c.pass).length}/
              {entry.qualityReport.checks.length} passed, score {(entry.qualityReport.overallScore * 100).toFixed(0)}%)
            </button>
            {qualityExpanded && (
              <ul className="mt-2 space-y-1 border-l-2 border-border pl-3">
                {entry.qualityReport.checks.map((c, idx) => (
                  <li key={`${c.name}-${idx}`} className="flex items-baseline gap-2 text-xs">
                    <span className="shrink-0 font-mono">
                      {c.pass ? (
                        <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                      ) : c.critical ? (
                        <XCircle className="h-3 w-3 text-destructive" />
                      ) : (
                        <AlertTriangle className="h-3 w-3 text-amber-600" />
                      )}
                    </span>
                    <span className={cn('font-medium', c.pass ? 'text-foreground' : 'text-muted-foreground')}>
                      {c.name}
                    </span>
                    <span className="truncate text-muted-foreground/80" title={c.detail}>
                      — {c.detail}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Layer 2 judge dimensions (expandable) */}
        {entry.qualityJudgement && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setJudgementExpanded(!judgementExpanded)}
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              data-testid={`judgement-toggle-${entry.id}`}
            >
              {judgementExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Judge dimensions ({entry.qualityJudgement.dimensions.filter((d) => d.score >= 0.7).length}/
              {entry.qualityJudgement.dimensions.length} strong, score{' '}
              {(entry.qualityJudgement.overallScore * 100).toFixed(0)}%)
            </button>
            {judgementExpanded && (
              <>
                <ul className="mt-2 space-y-1 border-l-2 border-border pl-3">
                  {entry.qualityJudgement.dimensions.map((d, idx) => (
                    <li key={`${d.name}-${idx}`} className="flex items-baseline gap-2 text-xs">
                      <span className="shrink-0 font-mono">
                        {d.score >= 0.7 ? (
                          <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                        ) : d.score >= 0.5 ? (
                          <AlertTriangle className="h-3 w-3 text-amber-600" />
                        ) : (
                          <XCircle className="h-3 w-3 text-destructive" />
                        )}
                      </span>
                      <span className="shrink-0 font-medium text-foreground">{d.name}</span>
                      <span className="shrink-0 font-mono text-muted-foreground">{(d.score * 100).toFixed(0)}%</span>
                      <span className="truncate text-muted-foreground/80" title={d.rationale}>
                        — {d.rationale}
                      </span>
                    </li>
                  ))}
                </ul>
                {entry.qualityJudgement.note && (
                  <p className="mt-2 text-xs italic text-muted-foreground/80 pl-3">{entry.qualityJudgement.note}</p>
                )}
              </>
            )}
          </div>
        )}

        {/* Attachments salvaged from workspace (expandable) */}
        {attachmentCount > 0 && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setAttachmentsExpanded(!attachmentsExpanded)}
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              data-testid={`attachments-toggle-${entry.id}`}
            >
              {attachmentsExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Attachments ({attachmentCount})
            </button>
            {attachmentsExpanded && (
              <ul className="mt-2 space-y-1 border-l-2 border-border pl-3">
                {entry.attachments!.map((att, idx) => (
                  <li key={`${att.filename}-${idx}`} className="flex items-baseline gap-2 text-xs">
                    <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="font-medium text-foreground">{att.filename}</span>
                    <span className="text-muted-foreground/80">— {formatBytes(att.sizeBytes)}</span>
                    {att.salvaged && (
                      <Badge
                        variant="outline"
                        className="shrink-0 gap-1 bg-amber-500/10 text-amber-700 border-amber-500/30 dark:text-amber-400"
                        title="Salvaged from workspace on timeout"
                      >
                        salvaged
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Error messages (only when not partial — partial has its own notice) */}
        {entry.status === 'failure' && !entry.partial && entry.errors && entry.errors.length > 0 && (
          <div className="mt-3 rounded-md bg-destructive/10 p-2.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-destructive">
              <AlertTriangle className="h-3 w-3" />
              Errors
            </div>
            <ul className="mt-1 space-y-0.5">
              {entry.errors.map((error, index) => (
                <li key={index} className="text-xs text-destructive">
                  {error}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// AGENT LOG
// ============================================================================

interface AgentLogProps {
  entries: AgentLogEntry[];
}

/**
 * AgentLog
 *
 * Renders a vertical timeline of agent log entries.
 * Each entry is displayed as a card with agent name, action,
 * status, token usage, duration, and optional error details.
 *
 * @example
 * ```tsx
 * <AgentLog entries={logEntries} />
 * ```
 */
export function AgentLog({ entries }: AgentLogProps) {
  const router = useRouter();
  // Resolve missionId → report client-side from the cached reports list so
  // history cards can deep-link to the report a mission published. Fail-open:
  // while loading or on error there is simply no link.
  //
  // REPORT-002: use the single shared canonical selector (same rule the
  // run-detail Output card and the server-side getReportsByMissionIdOwnedBy
  // apply) so a multi-report mission resolves to ONE deterministic Report and
  // Activity + run detail never disagree. The authenticated uid is passed as a
  // defensive owner scope on top of the already owner-scoped /api/reports list.
  const { data: reports } = useReports();
  const { user } = useAuth();
  const reportsByMission = React.useMemo(
    () => buildCanonicalReportsByMission(reports ?? [], user?.uid),
    [reports, user?.uid]
  );

  if (entries.length === 0) {
    return (
      <EmptyState
        icon={Bot}
        title="No agent activity yet"
        description="Agent actions appear here after a configured mission or background job runs. Review the working automation controls in Agent Config."
        action={{
          label: 'Go to Agent Config',
          onClick: () => {
            router.push('/settings?tab=agent-config');
          },
          icon: RefreshCw,
        }}
        size="sm"
      />
    );
  }

  // Group consecutive entries that share a chainId into a visual wrapper so
  // the user can tell at a glance that these missions are a pipeline, not
  // independent tasks. Non-chain entries render as before.
  const groups: Array<{ key: string; chainId?: string; entries: AgentLogEntry[] }> = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (entry.chainId && last?.chainId === entry.chainId) {
      last.entries.push(entry);
    } else {
      groups.push({
        key: entry.chainId ?? entry.id,
        chainId: entry.chainId,
        entries: [entry],
      });
    }
  }

  return (
    <div className="space-y-2" data-testid="agent-log-timeline">
      {groups.map((group) =>
        group.chainId && group.entries.length > 1 ? (
          <ChainGroup
            key={group.key}
            chainId={group.chainId}
            entries={group.entries}
            reportsByMission={reportsByMission}
          />
        ) : (
          <LogEntryCard key={group.entries[0].id} entry={group.entries[0]} reportsByMission={reportsByMission} />
        )
      )}
    </div>
  );
}

/**
 * Visual wrapper around 2+ chain-linked entries. Shows a chain header and
 * renders each entry as a LogEntryCard underneath.
 */
function ChainGroup({
  chainId,
  entries,
  reportsByMission,
}: {
  chainId: string;
  entries: AgentLogEntry[];
  reportsByMission?: ReadonlyMap<string, Report>;
}) {
  // Order by chainStep ascending so step 1 is at the top. The parent list
  // comes newest-first by createdAt, so within-chain reordering here makes
  // the pipeline read top-to-bottom.
  const ordered = [...entries].sort((a, b) => (a.chainStep ?? 0) - (b.chainStep ?? 0));
  const first = ordered[0];
  return (
    <div
      className="rounded-lg border border-indigo-500/20 bg-indigo-500/[0.03] p-2"
      data-testid={`chain-group-${chainId}`}
    >
      <div className="mb-2 flex items-center gap-2 px-1 text-xs font-medium text-indigo-700 dark:text-indigo-400">
        <Link2 className="h-3.5 w-3.5" />
        <span>
          Chain — {ordered.length} mission{ordered.length > 1 ? 's' : ''}
          {first.chainTotalSteps ? ` of ${first.chainTotalSteps}` : ''}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">{chainId}</span>
      </div>
      <div className="space-y-2">
        {ordered.map((entry) => (
          <LogEntryCard key={entry.id} entry={entry} reportsByMission={reportsByMission} />
        ))}
      </div>
    </div>
  );
}
