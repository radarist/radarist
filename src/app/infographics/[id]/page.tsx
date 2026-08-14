'use client';

import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Share2, Trash2 } from 'lucide-react';
import Link from 'next/link';

import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { PageShell, PageContent } from '@/components/layout/PageShell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AIDisclosureBadge } from '@/components/ai/AIDisclosureBadge';
import { useVisualization, useUpdateVisualization, useDeleteVisualization } from '@/hooks/useVisualizations';
import { DataTableSkeleton } from '@/components/skeletons';
import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { InfographicDownloadButton } from '@/components/infographics/InfographicDownloadButton';
import { VisualizationMedia } from '@/components/infographics/VisualizationMedia';

export default function VisualizationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { toast } = useToast();
  const { data: readResult, isLoading, error, refetch } = useVisualization(id);
  const updateMutation = useUpdateVisualization();
  const deleteMutation = useDeleteVisualization();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  if (isLoading) {
    return (
      <SmartLayout>
        <PageShell>
          <PageContent>
            <DataTableSkeleton rows={1} columns={1} />
          </PageContent>
        </PageShell>
      </SmartLayout>
    );
  }

  if (!readResult && error) {
    return (
      <SmartLayout>
        <PageShell>
          <PageContent>
            <div className="flex min-h-[240px] flex-col items-center justify-center gap-3 text-center">
              <h1 className="text-lg font-semibold">Could not load visualization</h1>
              <p className="max-w-md text-sm text-muted-foreground">
                Visualization metadata is temporarily unavailable.
              </p>
              <Button variant="outline" size="sm" onClick={() => void refetch()}>
                Retry
              </Button>
            </div>
          </PageContent>
        </PageShell>
      </SmartLayout>
    );
  }

  if (!readResult || readResult.status === 'not-found') {
    return (
      <SmartLayout>
        <PageShell>
          <PageContent>
            <p className="text-muted-foreground">Visualization not found</p>
          </PageContent>
        </PageShell>
      </SmartLayout>
    );
  }

  const viz = readResult.visualization;

  const handleShare = () => {
    const newShared = !viz.shared;
    updateMutation.mutate(
      { id: viz.id, data: { shared: newShared } },
      {
        onSuccess: () => {
          if (newShared) {
            const shareUrl = `${window.location.origin}/share/visualization/${viz.id}`;
            navigator.clipboard.writeText(shareUrl);
            toast({ title: 'Share link copied to clipboard' });
          } else {
            toast({ title: 'Visualization is now private' });
          }
        },
      }
    );
  };

  const handleDelete = () => {
    deleteMutation.mutate(viz.id, {
      onSuccess: () => {
        toast({ title: 'Visualization deleted' });
        router.push('/infographics');
      },
    });
  };

  return (
    <SmartLayout>
      <PageShell>
        <PageContent>
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <Link
                href="/infographics"
                className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="h-4 w-4" />
                Back to Infographics
              </Link>

              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" data-testid="viz-share-toggle" onClick={handleShare}>
                  <Share2 className="h-4 w-4 mr-1" />
                  {viz.shared ? 'Unshare' : 'Share'}
                </Button>
                <InfographicDownloadButton visualizationId={viz.id} mimeType={viz.mimeType} title={viz.title} />
                <Button variant="outline" size="sm" data-testid="viz-delete" onClick={() => setShowDeleteDialog(true)}>
                  <Trash2 className="h-4 w-4 mr-1" />
                  Delete
                </Button>
              </div>
            </div>

            <div>
              <h1 className="text-2xl font-semibold">{viz.title}</h1>
              <div className="flex items-center gap-2 mt-2">
                {/* EU AI Act Art 50(2)/(4) per-item disclosure — the detail view is
                    where an infographic is consumed/downloaded, so the badge lives
                    here (the list page carries the page-level statement instead).
                    See docs/RESPONSIBLE-AI.md §10. */}
                <AIDisclosureBadge variant="inline-badge" />
                <Badge variant="secondary">{viz.style}</Badge>
                <span className="text-sm text-muted-foreground">{new Date(viz.createdAt).toLocaleDateString()}</span>
                {viz.shared && (
                  <Badge variant="outline" data-testid="viz-share-link">
                    Shared
                  </Badge>
                )}
              </div>
            </div>

            <div className="overflow-hidden rounded-lg border">
              <VisualizationMedia
                src={viz.imageUrl}
                alt={viz.title}
                width={viz.metadata?.width}
                height={viz.metadata?.height}
                variant="detail"
                fit={viz.mimeType === 'image/svg+xml' ? 'contain' : 'cover'}
                retryable
                testId="viz-full-image"
              />
            </div>

            <div className="space-y-3 text-sm">
              <div data-testid="viz-prompt">
                <span className="font-medium">Prompt:</span> <span className="text-muted-foreground">{viz.prompt}</span>
              </div>
              {viz.dataSnapshot?.description && (
                <div data-testid="viz-data-snapshot">
                  <span className="font-medium">Data used:</span>{' '}
                  <span className="text-muted-foreground">{viz.dataSnapshot.description}</span>
                </div>
              )}
              {viz.referencedEntities && viz.referencedEntities.length > 0 && (
                <div data-testid="viz-referenced-entities">
                  <span className="font-medium">Referenced entities:</span>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {viz.referencedEntities.map((ref) => (
                      <Badge
                        key={ref.id}
                        variant="outline"
                        className="font-normal text-muted-foreground"
                        title={`${ref.type} · ${ref.id}`}
                      >
                        {ref.name ?? 'Unresolved entity'}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete visualization?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete &quot;{viz.title}&quot; and its image. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </PageContent>
      </PageShell>
    </SmartLayout>
  );
}
