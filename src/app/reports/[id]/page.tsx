'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useReport,
  useUpdateReport,
  useDeleteReport,
  useReportVersion,
  useRestoreReportVersion,
  reportKeys,
  ReportFetchError,
} from '@/hooks/useReports';
import { ReportHistorySheet } from '@/components/reports/ReportHistorySheet';
import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { PageShell, PageContent } from '@/components/layout/PageShell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/feedback/EmptyState';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  ArrowLeft,
  Share2,
  Download,
  Trash2,
  Link2,
  Bot,
  User,
  FileText,
  History,
  Printer,
  AlertTriangle,
  ShieldCheck,
} from 'lucide-react';
import { toast } from 'sonner';
import { formatDate } from '@/hooks/useReportsPage';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { buildDownloadHtml } from '@/lib/reports/build-download-html';
import { loadReportBrandCss } from '@/lib/reports/load-report-brand-css';
import { printReportIframe, REPORT_IFRAME_SANDBOX, REPORT_PRINT_IFRAME_SANDBOX } from './print-report-iframe';
import { buildReportPreviewHtml, buildReportPrintHtml } from './report-frame-content';
import { reportLifecycleState } from '@/lib/schemas/report';
import type { Report } from '@/lib/schemas/report';

// ============================================================================
// SKELETON
// ============================================================================

function ReportDetailSkeleton() {
  return (
    <SmartLayout>
      <PageShell>
        <PageContent>
          <Skeleton className="h-8 w-32 mb-4" />
          <Skeleton className="h-10 w-2/3 mb-2" />
          <Skeleton className="h-5 w-1/3 mb-4" />
          <div className="flex gap-2 mb-6">
            <Skeleton className="h-6 w-20" />
            <Skeleton className="h-6 w-24" />
          </div>
          <Skeleton className="h-[600px] w-full rounded-lg" />
        </PageContent>
      </PageShell>
    </SmartLayout>
  );
}

// ============================================================================
// NOT FOUND
// ============================================================================

function ReportNotFound() {
  const router = useRouter();
  return (
    <SmartLayout>
      <PageShell>
        <PageContent>
          <Button variant="ghost" size="sm" onClick={() => router.push('/reports')} className="mb-4 -ml-2">
            <ArrowLeft className="h-4 w-4 mr-1" /> Back to Reports
          </Button>
          <div className="text-center py-12">
            <FileText className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <p className="text-lg font-medium">Report not found</p>
            <p className="text-sm text-muted-foreground mt-1">The report may have been deleted.</p>
          </div>
        </PageContent>
      </PageShell>
    </SmartLayout>
  );
}

// ============================================================================
// UNAVAILABLE (transient failure — network / 401 / 429 / 5xx)
// ============================================================================

/**
 * UX-017: a load failure that is NOT a genuine 404 must not claim the report
 * does not exist. It is usually transient, so offer Retry rather than a dead
 * end.
 */
function ReportUnavailable({ onRetry }: { onRetry: () => void }) {
  const router = useRouter();
  return (
    <SmartLayout>
      <PageShell>
        <PageContent>
          <Button variant="ghost" size="sm" onClick={() => router.push('/reports')} className="mb-4 -ml-2">
            <ArrowLeft className="h-4 w-4 mr-1" /> Back to Reports
          </Button>
          <EmptyState
            icon={AlertTriangle}
            title="Report unavailable"
            description="We couldn't load this report. This is usually temporary — check your connection and try again."
            action={{ label: 'Retry', onClick: onRetry }}
          />
        </PageContent>
      </PageShell>
    </SmartLayout>
  );
}

// ============================================================================
// IFRAME PREVIEW (isolates untrusted report content from the app origin)
// ============================================================================

function ReportPreviewIframe({ html }: { html: string }) {
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    // Brand CSS is progressive enhancement. The stored, sanitized report must
    // remain visible even when this optional static asset is slow or unavailable.
    try {
      setPreviewError(false);
      setSrcDoc(buildReportPreviewHtml(html, { brandCss: null }));
    } catch {
      setSrcDoc(null);
      setPreviewError(true);
      return () => controller.abort();
    }

    void loadReportBrandCss({ signal: controller.signal }).then((brandCss) => {
      if (!cancelled && brandCss) {
        try {
          setSrcDoc(buildReportPreviewHtml(html, { brandCss }));
        } catch {
          // Keep the already-rendered static fallback. Optional branding must
          // never replace usable report content with an empty frame.
        }
      }
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [html]);

  return (
    // REPORT-014: below `sm` the preview goes edge-to-edge. Inside the app shell
    // the frame measured 272 CSS px at a 390 px viewport, so a report band with a
    // normal desktop inset had almost no column left; reclaiming the shell's own
    // padding is the half of that geometry the report's stylesheet cannot fix.
    // The negative margin is cancelled at `sm` and up, where the card border and
    // radius are part of the page design.
    <div className="-mx-4 mt-6 overflow-hidden border-y sm:mx-0 sm:rounded-lg sm:border" data-testid="report-preview">
      {previewError ? (
        <div role="alert" className="flex min-h-[600px] items-center justify-center px-6 text-center text-sm">
          Report preview unavailable. Reload the page or download the report to view it.
        </div>
      ) : srcDoc ? (
        <iframe
          srcDoc={srcDoc}
          title="Report preview"
          sandbox={REPORT_IFRAME_SANDBOX}
          referrerPolicy="no-referrer"
          className="w-full border-0"
          style={{ height: '75vh', minHeight: '600px', maxHeight: '1000px' }}
        />
      ) : (
        <div
          role="status"
          aria-label="Loading report preview"
          className="flex min-h-[600px] items-center justify-center text-sm text-muted-foreground"
        >
          Loading report…
        </div>
      )}
    </div>
  );
}

// ============================================================================
// PAGE
// ============================================================================

export default function ReportDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: report, isLoading, error, refetch } = useReport(params.id);
  const updateMutation = useUpdateReport();
  const deleteMutation = useDeleteReport();
  const restoreVersionMutation = useRestoreReportVersion();
  const [isRestoring, setIsRestoring] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  // DISC-014 version history + point-in-time preview.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [previewVersionId, setPreviewVersionId] = useState<string | null>(null);
  const { data: previewVersion } = useReportVersion(params.id, previewVersionId);
  const printIframeRef = useRef<HTMLIFrameElement>(null);
  const printIframeLoadedRef = useRef(false);
  const [printDocumentHtml, setPrintDocumentHtml] = useState<string | null>(null);

  useEffect(() => {
    printIframeLoadedRef.current = false;
    setPrintDocumentHtml(null);
    if (!report) return;

    let cancelled = false;
    const controller = new AbortController();
    try {
      setPrintDocumentHtml(buildReportPrintHtml(report.html, report.title, { brandCss: null }));
    } catch {
      return () => controller.abort();
    }

    void loadReportBrandCss({ signal: controller.signal }).then((brandCss) => {
      if (!cancelled && brandCss) {
        try {
          printIframeLoadedRef.current = false;
          setPrintDocumentHtml(buildReportPrintHtml(report.html, report.title, { brandCss }));
        } catch {
          // Preserve the printable static fallback when optional branding fails.
        }
      }
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [report]);

  // previousHtml is stored on the Firestore doc by the edit paths (AI
  // updateReport tool, mission revisions, PUT /api/reports/[id]) but is not
  // part of the public reportSchema — read it as an optional extra field.
  const hasPreviousVersion = Boolean((report as (Report & { previousHtml?: string }) | undefined)?.previousHtml);

  const handleRestore = async () => {
    if (!report) return;
    setIsRestoring(true);
    try {
      const response = await fetchWithAuth(`/api/reports/${report.id}/restore`, { method: 'POST' });
      if (!response.ok) throw new Error(`Failed to restore report: ${response.status}`);
      await queryClient.invalidateQueries({ queryKey: reportKeys.all });
      toast.success('Previous version restored');
    } catch {
      toast.error('Failed to restore report');
    } finally {
      setIsRestoring(false);
    }
  };

  // DISC-014: toggle point-in-time preview of a historical version.
  const handlePreviewVersion = (versionId: string) => {
    setPreviewVersionId((current) => (current === versionId ? null : versionId));
  };

  // DISC-014: restore a specific historical version (snapshots the current head
  // first, so it is never destructive).
  const handleRestoreVersion = async (versionId: string) => {
    if (!report) return;
    setIsRestoring(true);
    try {
      await restoreVersionMutation.mutateAsync({ id: report.id, versionId });
      setPreviewVersionId(null);
      setHistoryOpen(false);
      toast.success('Version restored');
    } catch {
      toast.error('Failed to restore version');
    } finally {
      setIsRestoring(false);
    }
  };

  // REPORT-002: a needs-review draft is owner-visible but not publicly
  // shareable until the owner approves it (the server refuses shared:true on
  // drafts; this guard keeps the UI honest instead of surfacing a 409).
  const needsReview = report ? reportLifecycleState(report) === 'needs-review' : false;

  const handleShare = async () => {
    if (!report) return;
    const newShared = !report.shared;
    if (newShared && needsReview) {
      toast.error('This draft needs review before it can be shared', {
        description: 'Approve the report (or restore a passing version) first.',
      });
      return;
    }
    try {
      await updateMutation.mutateAsync({ id: report.id, updates: { shared: newShared } });
      if (newShared) {
        const url = `${window.location.origin}/share/report/${report.id}`;
        await navigator.clipboard.writeText(url);
        toast.success('Public link copied to clipboard');
      } else {
        toast.success('Public link disabled');
      }
    } catch {
      toast.error('Failed to update sharing');
    }
  };

  // REPORT-002 repair action: an explicit owner decision publishes the draft
  // (decision authority — the automatic gate never does this on its own).
  const handleApprove = async () => {
    if (!report) return;
    try {
      await updateMutation.mutateAsync({ id: report.id, updates: { reviewStatus: 'published' } });
      toast.success('Report approved and published to your catalog');
    } catch {
      toast.error('Failed to approve report');
    }
  };

  const handleDownload = async () => {
    if (!report) return;
    try {
      // Inline the brand stylesheet so the downloaded file is
      // self-contained. The in-app iframe sees `/css/report-brand.css`
      // resolve to the app origin; opened from disk, that path 404s
      // and the editorial layout (dark hero, Playfair Display, gold
      // accents) silently disappears.
      const brandCss = await loadReportBrandCss();
      const downloadHtml = buildDownloadHtml(report.html, report.title, { brandCss });
      const blob = new Blob([downloadHtml], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${report.title.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.html`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Report downloaded');
    } catch {
      toast.error('Failed to download report');
    }
  };

  // Print from a separate static frame. The active preview deliberately has
  // no same-origin capability, while this frame deliberately has no scripts.
  const handlePrint = () => {
    const printed = printReportIframe(printIframeRef.current, printIframeLoadedRef.current);
    if (!printed) {
      toast.error('Report is still loading — try printing again in a moment');
    }
  };

  const handleDelete = async () => {
    // Guard against a double-submit: the confirm button is disabled while
    // pending, but this also blocks a stray second call (e.g. Enter key).
    if (!report || deleteMutation.isPending) return;
    try {
      await deleteMutation.mutateAsync(report.id);
      toast.success('Report deleted');
      setShowDeleteDialog(false);
      router.push('/reports');
    } catch {
      // Stay on the page and keep the report visible so the user can retry —
      // closing the dialog is enough feedback alongside the toast.
      toast.error('Failed to delete report');
      setShowDeleteDialog(false);
    }
  };

  if (isLoading) return <ReportDetailSkeleton />;
  // UX-017: only a genuine 404 means the report does not exist. Any other
  // failure (network, 401, 429, 5xx) is transient — surface Unavailable + Retry
  // instead of falsely claiming the report was deleted.
  if (error instanceof ReportFetchError && error.status === 404) return <ReportNotFound />;
  if (error) return <ReportUnavailable onRetry={() => void refetch()} />;
  if (!report) return <ReportNotFound />;

  return (
    <SmartLayout>
      <PageShell>
        <PageContent>
          {/* Back link */}
          <Button variant="ghost" size="sm" onClick={() => router.push('/reports')} className="mb-4 -ml-2">
            <ArrowLeft className="h-4 w-4 mr-1" /> Back to Reports
          </Button>

          {/* Header */}
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight">{report.title}</h1>
              {report.metadata?.description && (
                <p className="text-sm text-muted-foreground">{report.metadata.description}</p>
              )}
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">
                  {report.createdBy === 'agent' ? <Bot className="h-3 w-3 mr-1" /> : <User className="h-3 w-3 mr-1" />}
                  {report.agentType ?? report.createdBy}
                </Badge>
                <Badge variant="outline">{formatDate(report.createdAt)}</Badge>
                {report.metadata?.dataSnapshotAt && (
                  <Badge variant="outline">Data as of {formatDate(report.metadata.dataSnapshotAt)}</Badge>
                )}
                {report.agentType === 'artifact-recommender' && (
                  <Badge variant="outline" className="text-muted-foreground">
                    AI-generated · not grounded in radar data
                  </Badge>
                )}
                {report.updatedAt && <Badge variant="outline">Updated {formatDate(report.updatedAt)}</Badge>}
                {needsReview && (
                  <Badge
                    variant="outline"
                    className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                    data-testid="report-needs-review-badge"
                  >
                    <AlertTriangle className="h-3 w-3 mr-1" /> Needs review
                  </Badge>
                )}
                {report.shared && (
                  <Badge variant="outline">
                    <Link2 className="h-3 w-3 mr-1" /> Shared
                  </Badge>
                )}
                {report.missionId && <Badge variant="outline">Mission</Badge>}
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleShare}
                disabled={needsReview && !report.shared}
                title={needsReview && !report.shared ? 'Approve this draft before sharing' : undefined}
              >
                <Share2 className="h-4 w-4 mr-1" /> {report.shared ? 'Unshare' : 'Share'}
              </Button>
              <Button variant="outline" size="sm" onClick={handleDownload}>
                <Download className="h-4 w-4 mr-1" /> Download
              </Button>
              <Button variant="outline" size="sm" onClick={handlePrint} disabled={!printDocumentHtml}>
                <Printer className="h-4 w-4 mr-1" /> Print / Save as PDF
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setHistoryOpen(true)}
                aria-label="Version history"
                data-testid="report-history"
              >
                <History className="h-4 w-4 mr-1" /> History
              </Button>
              {hasPreviousVersion && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm" disabled={isRestoring} aria-label="Restore previous version">
                      <History className="h-4 w-4 mr-1" /> Restore
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Restore previous version?</AlertDialogTitle>
                      <AlertDialogDescription>
                        The report will revert to its previous version. The current version is kept as the backup, so
                        restoring again undoes this.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={handleRestore}>Restore</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
              <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                    data-testid="report-delete"
                    aria-label="Delete report"
                  >
                    <Trash2 className="h-4 w-4 mr-1" /> Delete
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete &ldquo;{report.title}&rdquo;?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This action cannot be undone. This will permanently delete the report.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={(e) => {
                        // Keep the dialog open until the mutation settles so a
                        // failure stays on-page and a double-click can't fire a
                        // second delete.
                        e.preventDefault();
                        void handleDelete();
                      }}
                      disabled={deleteMutation.isPending}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>

          {/* REPORT-002: owner-visible needs-review draft banner — names the
              exact failed checks and the bounded repair path. The draft stays
              private (never on /share) until the owner repairs or approves. */}
          {needsReview && (
            <div
              className="mt-6 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3"
              data-testid="needs-review-banner"
            >
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="min-w-0 flex-1 space-y-2">
                  <p className="text-sm font-medium">
                    This report is a draft pending your review — it is not publicly available.
                  </p>
                  {report.qualityGate && report.qualityGate.failingChecks.length > 0 ? (
                    <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground" data-testid="failed-checks">
                      {report.qualityGate.failingChecks.map((check) => (
                        <li key={check.name}>
                          <span className="font-medium text-foreground">{check.name}</span>
                          {check.critical ? ' (critical)' : ''}: {check.detail}
                        </li>
                      ))}
                    </ul>
                  ) : report.designPassDetails ? (
                    <p className="text-sm text-muted-foreground" data-testid="failed-checks">
                      Design review: {report.designPassDetails}
                    </p>
                  ) : null}
                  <p className="text-sm text-muted-foreground">
                    {report.qualityGate?.repair ??
                      'Fix the issues with an edit, restore an earlier passing version from History, or approve the draft as-is.'}
                  </p>
                </div>
                <Button size="sm" onClick={() => void handleApprove()} data-testid="approve-report">
                  <ShieldCheck className="h-4 w-4 mr-1" /> Approve & publish
                </Button>
              </div>
            </div>
          )}

          {/* DISC-014: point-in-time preview banner — shown while viewing a
              historical version instead of the live report. */}
          {previewVersionId && (
            <div
              className="mt-6 flex flex-col gap-3 rounded-lg border border-primary/40 bg-primary/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              data-testid="version-preview-banner"
            >
              <p className="text-sm">
                {previewVersion ? (
                  <>
                    Viewing <strong>version {previewVersion.versionNumber}</strong> from{' '}
                    {formatDate(previewVersion.createdAt)} — this is not the current report.
                  </>
                ) : (
                  'Loading version…'
                )}
              </p>
              <div className="flex shrink-0 gap-2">
                <Button variant="outline" size="sm" onClick={() => setPreviewVersionId(null)}>
                  Back to current
                </Button>
                {previewVersion && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button size="sm" disabled={isRestoring}>
                        Restore this version
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Restore version {previewVersion.versionNumber}?</AlertDialogTitle>
                        <AlertDialogDescription>
                          The report will revert to this version. The current version is first saved to history, so no
                          version is ever lost — you can restore it again later.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void handleRestoreVersion(previewVersionId)}>
                          Restore this version
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            </div>
          )}

          {/* Executable HTML is removed before this opaque-origin, child-CSP preview.
              When previewing a historical version, its html is shown instead. */}
          <ReportPreviewIframe html={previewVersionId && previewVersion ? previewVersion.html : report.html} />

          <ReportHistorySheet
            reportId={report.id}
            open={historyOpen}
            onOpenChange={setHistoryOpen}
            previewVersionId={previewVersionId}
            onPreview={handlePreviewVersion}
            onRestore={(versionId) => void handleRestoreVersion(versionId)}
            isRestoring={isRestoring}
          />
          {printDocumentHtml && (
            <iframe
              ref={printIframeRef}
              srcDoc={printDocumentHtml}
              title="Printable report"
              sandbox={REPORT_PRINT_IFRAME_SANDBOX}
              referrerPolicy="no-referrer"
              aria-hidden="true"
              tabIndex={-1}
              onLoad={() => {
                printIframeLoadedRef.current = true;
              }}
              style={{ position: 'fixed', left: '-10000px', top: 0, width: '1024px', height: '768px', border: 0 }}
            />
          )}
        </PageContent>
      </PageShell>
    </SmartLayout>
  );
}
