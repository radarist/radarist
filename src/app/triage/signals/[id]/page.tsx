/**
 * @file page.tsx (Agents > Signals > [id])
 * @description Signal detail page showing full signal information
 *
 * Features:
 * - Full signal details with metadata
 * - Trust score breakdown
 * - Related entities
 * - Action buttons (approve/reject)
 * - External source link
 *
 * @author Radarist Team
 * @created 2025-12-01
 */

'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { PageShell } from '@/components/layout/PageShell';
import { DetailPageShell } from '@/components/layout/DetailPageShell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { TrustScoreBadge } from '@/components/signals/TrustScoreBadge';
import { useToast } from '@/hooks/use-toast';
import {
  ArrowLeft,
  ExternalLink,
  Check,
  Calendar,
  Tag,
  Building2,
  Cpu,
  Lightbulb,
  Target,
  Loader2,
  CheckCircle,
  XCircle,
  Bot,
  TrendingUp,
  AlertTriangle,
  Shield,
  FileText,
  Compass,
  Users,
  Link2,
  Info,
  Sparkles,
  Copy,
  X,
  Merge,
} from 'lucide-react';
import type { Signal } from '@/lib/types';
import { getSignalById } from '@/lib/signals-client';
import { submitSignalFeedback } from '@/lib/signals/feedback';
import { dismissDuplicate, mergeIntoSignal, deleteSignal } from '@/lib/signals-client';
import { useAuth } from '@/components/providers/AuthProvider';
import { cn } from '@/lib/utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('signal-detail-page');

// Status badge component
function SignalStatusBadge({ status }: { status: string }) {
  const config: Record<string, { className: string; icon: typeof CheckCircle }> = {
    Detected: { className: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/30', icon: Tag },
    Validated: { className: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30', icon: CheckCircle },
    Approved: {
      className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
      icon: CheckCircle,
    },
    Rejected: { className: 'bg-destructive/10 text-destructive border-destructive/30', icon: XCircle },
    Imported: {
      className: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30',
      icon: CheckCircle,
    },
  };

  const { className } = config[status] || { className: 'bg-muted text-muted-foreground' };

  return (
    <Badge variant="outline" className={cn('text-sm', className)}>
      {status}
    </Badge>
  );
}

function SignalSourceBadge({ source }: { source: string }) {
  const colors: Record<string, string> = {
    patents: 'bg-purple-500/10 text-purple-600 dark:text-purple-400',
    papers: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
    news: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
    hackernews: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    github: 'bg-muted text-muted-foreground',
    trends: 'bg-pink-500/10 text-pink-600 dark:text-pink-400',
    funding: 'bg-green-500/10 text-green-600 dark:text-green-400',
    sec: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  };

  return (
    <Badge variant="outline" className={cn('text-sm capitalize', colors[source] || 'bg-muted')}>
      {source}
    </Badge>
  );
}

// Duplicate signal card component
function DuplicateSignalCard({
  duplicateId,
  similarity,
  currentSignal: _currentSignal,
  onDismiss,
  onMerge,
}: {
  duplicateId: string;
  similarity: number;
  currentSignal: Signal;
  onDismiss: () => Promise<void>;
  onMerge: () => Promise<void>;
}) {
  const [duplicate, setDuplicate] = useState<Signal | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDismissing, setIsDismissing] = useState(false);
  const [isMerging, setIsMerging] = useState(false);

  useEffect(() => {
    const loadDuplicate = async () => {
      try {
        const data = await getSignalById(duplicateId);
        setDuplicate(data);
      } catch (error) {
        log.error('Failed to load duplicate signal', error instanceof Error ? error : new Error(String(error)));
      } finally {
        setIsLoading(false);
      }
    };
    loadDuplicate();
  }, [duplicateId]);

  const handleDismiss = async () => {
    setIsDismissing(true);
    try {
      await onDismiss();
    } finally {
      setIsDismissing(false);
    }
  };

  const handleMerge = async () => {
    setIsMerging(true);
    try {
      await onMerge();
    } finally {
      setIsMerging(false);
    }
  };

  if (isLoading) {
    return (
      <div className="bg-muted/50 rounded-lg p-4">
        <Skeleton className="h-5 w-3/4 mb-2" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }

  if (!duplicate) {
    return null;
  }

  return (
    <div className="bg-muted/50 rounded-lg p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <Link href={`/triage/signals/${duplicate.id}`} className="font-medium text-sm hover:underline line-clamp-1">
            {duplicate.title}
          </Link>
          <div className="flex items-center gap-2 mt-1">
            <Badge
              variant="outline"
              className={cn(
                'text-xs',
                similarity >= 90
                  ? 'border-red-500/50 text-red-600'
                  : similarity >= 80
                    ? 'border-amber-500/50 text-amber-600'
                    : 'border-muted-foreground/50'
              )}
            >
              {similarity}% similar
            </Badge>
            <span className="text-xs text-muted-foreground">{new Date(duplicate.detectedAt).toLocaleDateString()}</span>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDismiss}
            disabled={isDismissing || isMerging}
            title="Not a duplicate"
          >
            {isDismissing ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleMerge}
            disabled={isDismissing || isMerging}
            className="text-blue-600 border-blue-500/30 hover:bg-blue-500/10"
            title="Merge into this signal"
          >
            {isMerging ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <Merge className="h-4 w-4 mr-1" />
                Merge
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function SignalDetailPage() {
  const params = useParams();
  const router = useRouter();
  const signalId = params.id as string;

  const [signal, setSignal] = useState<Signal | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const { user } = useAuth();
  const { toast } = useToast();

  useEffect(() => {
    const loadSignal = async () => {
      setIsLoading(true);
      try {
        const data = await getSignalById(signalId);
        setSignal(data);
      } catch (error) {
        log.error('Failed to load signal', error instanceof Error ? error : new Error(String(error)));
        toast({
          title: 'Error',
          description: 'Failed to load signal details.',
          variant: 'destructive',
        });
      } finally {
        setIsLoading(false);
      }
    };

    if (signalId) {
      loadSignal();
    }
  }, [signalId, toast]);

  const handleFeedback = async (isPositive: boolean) => {
    if (!signal) return;
    setIsProcessing(true);
    try {
      // Pass true for updateStatus to also update the signal status
      const result = await submitSignalFeedback(
        signal.id,
        isPositive ? 'up' : 'down',
        undefined,
        true,
        user?.uid ?? 'anonymous',
        true
      );
      // AUDIT-005: submitSignalFeedback swallows its own errors and reports
      // {success:false} — treat that as a failed write, not a success.
      if (!result.success) {
        throw new Error(result.error || 'Failed to submit feedback');
      }
      toast({
        title: isPositive ? 'Signal Approved' : 'Signal Rejected',
        description: `The signal has been ${isPositive ? 'approved' : 'rejected'}.`,
      });
      // Reload signal to get updated status
      const updated = await getSignalById(signalId);
      setSignal(updated);
    } catch (e) {
      log.error('Failed to submit feedback', e instanceof Error ? e : new Error(String(e)), { signalId: signal.id });
      toast({
        title: 'Error',
        description: 'Failed to submit feedback.',
        variant: 'destructive',
      });
    } finally {
      setIsProcessing(false);
    }
  };

  if (isLoading) {
    return (
      <SmartLayout>
        <PageShell>
          <div className="max-w-4xl mx-auto space-y-6 p-6">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        </PageShell>
      </SmartLayout>
    );
  }

  if (!signal) {
    return (
      <SmartLayout>
        <PageShell>
          <div className="max-w-4xl mx-auto p-6 text-center">
            <h1 className="text-2xl font-semibold mb-4">Signal Not Found</h1>
            <p className="text-muted-foreground mb-6">
              The signal you&apos;re looking for doesn&apos;t exist or has been removed.
            </p>
            <Button asChild>
              <Link href="/triage/signals">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Signals
              </Link>
            </Button>
          </div>
        </PageShell>
      </SmartLayout>
    );
  }

  return (
    <SmartLayout entityName={signal.title}>
      <PageShell>
        <DetailPageShell
          backHref="/triage/signals"
          backLabel="Back to Signals"
          title={signal.title}
          chips={
            <>
              <SignalStatusBadge status={signal.status} />
              <SignalSourceBadge source={signal.source} />
              {signal.trustScore && <TrustScoreBadge trustScore={signal.trustScore} size="sm" />}
              {signal.importedAs && (
                <Badge
                  variant="outline"
                  className="bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30"
                >
                  <CheckCircle className="h-3 w-3 mr-1" />
                  Imported as {signal.importedAs.type}
                </Badge>
              )}
            </>
          }
          actions={
            <>
              <Button onClick={() => handleFeedback(true)} disabled={isProcessing || signal.status === 'Approved'}>
                {isProcessing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Check className="h-4 w-4 mr-2" />}
                Approve
              </Button>
              <Button
                variant="outline"
                className="border-destructive/30 text-destructive hover:bg-destructive/10"
                onClick={() => handleFeedback(false)}
                disabled={isProcessing || signal.status === 'Rejected'}
              >
                {isProcessing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <X className="h-4 w-4 mr-2" />}
                Reject
              </Button>
            </>
          }
          aside={
            <>
              {/* Metadata */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Details</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center gap-3 text-sm">
                    <Calendar className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <div className="text-muted-foreground">Detected</div>
                      <div className="font-medium">
                        {new Date(signal.detectedAt).toLocaleDateString('en-US', {
                          year: 'numeric',
                          month: 'long',
                          day: 'numeric',
                        })}
                      </div>
                    </div>
                  </div>

                  {signal.relevanceScore !== undefined && (
                    <div className="flex items-center gap-3 text-sm">
                      <Target className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <div className="text-muted-foreground">Relevance Score</div>
                        <div className="font-medium">{signal.relevanceScore}%</div>
                      </div>
                    </div>
                  )}

                  {signal.alignmentScore !== undefined && (
                    <div className="flex items-center gap-3 text-sm">
                      <Target className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <div className="text-muted-foreground">Alignment Score</div>
                        <div className="font-medium">{signal.alignmentScore}%</div>
                      </div>
                    </div>
                  )}

                  {signal.url && (
                    <div>
                      <Button variant="outline" size="sm" className="w-full" asChild>
                        <a href={signal.url} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="h-4 w-4 mr-2" />
                          View Source
                        </a>
                      </Button>
                    </div>
                  )}

                  {/* Agent Info (if agent-generated) */}
                  {signal.metadata?.agentId && (
                    <>
                      <Separator className="my-3" />
                      <div className="flex items-center gap-3 text-sm">
                        <Bot className="h-4 w-4 text-purple-500" />
                        <div>
                          <div className="text-muted-foreground">Generated By</div>
                          <div className="font-medium">{signal.metadata.agentName || 'Custom Agent'}</div>
                        </div>
                      </div>
                      {signal.metadata.taskTemplate && (
                        <div className="flex items-center gap-3 text-sm">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                          <div>
                            <div className="text-muted-foreground">Task Template</div>
                            <div className="font-medium capitalize">
                              {signal.metadata.taskTemplate.replace(/-/g, ' ')}
                            </div>
                          </div>
                        </div>
                      )}
                      {signal.metadata.llmModel && (
                        <div className="flex items-center gap-3 text-sm">
                          <Sparkles className="h-4 w-4 text-muted-foreground" />
                          <div>
                            <div className="text-muted-foreground">AI Model</div>
                            <div className="font-medium">{signal.metadata.llmModel}</div>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>

              {/* Trust Score Breakdown */}
              {signal.trustScore && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Trust Score</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-muted-foreground">Overall</span>
                      <span className="font-semibold">{signal.trustScore.overall}%</span>
                    </div>
                    {signal.trustScore.breakdown && (
                      <>
                        {signal.trustScore.breakdown.sourceReliability !== undefined && (
                          <div className="flex justify-between items-center">
                            <span className="text-sm text-muted-foreground">Source Reliability</span>
                            <span className="text-sm">{signal.trustScore.breakdown.sourceReliability}%</span>
                          </div>
                        )}
                        {signal.trustScore.breakdown.dataCompleteness !== undefined && (
                          <div className="flex justify-between items-center">
                            <span className="text-sm text-muted-foreground">Data Completeness</span>
                            <span className="text-sm">{signal.trustScore.breakdown.dataCompleteness}%</span>
                          </div>
                        )}
                        {signal.trustScore.breakdown.corroboration !== undefined && (
                          <div className="flex justify-between items-center">
                            <span className="text-sm text-muted-foreground">Corroboration</span>
                            <span className="text-sm">{signal.trustScore.breakdown.corroboration}%</span>
                          </div>
                        )}
                        {signal.trustScore.breakdown.aiConfidence !== undefined && (
                          <div className="flex justify-between items-center">
                            <span className="text-sm text-muted-foreground">AI Confidence</span>
                            <span className="text-sm">{signal.trustScore.breakdown.aiConfidence}%</span>
                          </div>
                        )}
                      </>
                    )}
                    {/* Trust Score Factors */}
                    {signal.trustScore.factors && signal.trustScore.factors.length > 0 && (
                      <>
                        <Separator className="my-3" />
                        <div className="text-sm font-medium mb-2">Trust Factors</div>
                        <ul className="space-y-1">
                          {signal.trustScore.factors.map((factor, i) => (
                            <li key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                              <Shield className="h-3 w-3 shrink-0 mt-0.5 text-emerald-500" />
                              {factor}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* Aligned Strategies */}
              {signal.alignedStrategies && signal.alignedStrategies.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Aligned Strategies</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap gap-2">
                      {signal.alignedStrategies.map((strategy, i) => (
                        <Badge key={i} variant="outline">
                          {strategy}
                        </Badge>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </>
          }
        >
          {/* Description */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Description</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="prose prose-sm dark:prose-invert max-w-none text-muted-foreground">
                <ReactMarkdown>{signal.description || 'No description available.'}</ReactMarkdown>
              </div>
            </CardContent>
          </Card>

          {/* AI Summary */}
          {signal.aiSummary && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">AI Summary</CardTitle>
                <CardDescription>Generated analysis of this signal</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="prose prose-sm dark:prose-invert max-w-none text-muted-foreground">
                  <ReactMarkdown>{signal.aiSummary}</ReactMarkdown>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Possible Duplicates */}
          {signal.metadata?.possibleDuplicates && signal.metadata.possibleDuplicates.length > 0 && (
            <Card className="border-amber-500/50 bg-amber-500/5">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Copy className="h-4 w-4 text-amber-500" />
                  Possible Duplicates
                </CardTitle>
                <CardDescription>These signals may be duplicates. Review and take action.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {signal.metadata.possibleDuplicates.map((dup: { signalId: string; similarity: number }) => (
                  <DuplicateSignalCard
                    key={dup.signalId}
                    duplicateId={dup.signalId}
                    similarity={dup.similarity}
                    currentSignal={signal}
                    onDismiss={async () => {
                      await dismissDuplicate(signal.id, dup.signalId);
                      const updated = await getSignalById(signalId);
                      setSignal(updated);
                      toast({
                        title: 'Duplicate dismissed',
                        description: 'This signal has been marked as not a duplicate.',
                      });
                    }}
                    onMerge={async () => {
                      // Merge current signal into the duplicate
                      await mergeIntoSignal(dup.signalId, {
                        title: signal.title,
                        source: signal.source,
                        url: signal.url,
                        description: signal.description,
                      });
                      // Delete current signal after merge
                      await deleteSignal(signal.id);
                      toast({
                        title: 'Signals merged',
                        description: 'This signal has been merged into the existing signal.',
                      });
                      router.push(`/triage/signals/${dup.signalId}`);
                    }}
                  />
                ))}
              </CardContent>
            </Card>
          )}

          {/* Merged Sources */}
          {signal.metadata?.mergedSources && signal.metadata.mergedSources.length > 0 && (
            <Card className="border-blue-500/50 bg-blue-500/5">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Merge className="h-4 w-4 text-blue-500" />
                  Merged Sources ({signal.metadata.mergedSources.length})
                </CardTitle>
                <CardDescription>Additional sources that have been merged into this signal.</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {signal.metadata.mergedSources.map(
                    (source: { source: string; url: string; title: string; mergedAt: number }, i: number) => (
                      <li key={i} className="flex items-center justify-between bg-muted/50 rounded-lg p-3">
                        <div>
                          <div className="font-medium text-sm">{source.title}</div>
                          <div className="text-xs text-muted-foreground">
                            From {source.source} • {new Date(source.mergedAt).toLocaleDateString()}
                          </div>
                        </div>
                        {source.url && (
                          <Button variant="ghost" size="sm" asChild>
                            <a href={source.url} target="_blank" rel="noopener noreferrer">
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          </Button>
                        )}
                      </li>
                    )
                  )}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* Linked Entities */}
          {signal.linkedEntities && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Related Entities</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {signal.linkedEntities.technologies && signal.linkedEntities.technologies.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 text-sm font-medium mb-2">
                      <Cpu className="h-4 w-4 text-emerald-500" />
                      Technologies
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {signal.linkedEntities.technologies.map((tech, i) => (
                        <Badge key={i} variant="secondary">
                          {tech}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {signal.linkedEntities.companies && signal.linkedEntities.companies.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 text-sm font-medium mb-2">
                      <Building2 className="h-4 w-4 text-blue-500" />
                      Companies
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {signal.linkedEntities.companies.map((company, i) => (
                        <Badge key={i} variant="secondary">
                          {company}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {signal.linkedEntities.useCases && signal.linkedEntities.useCases.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 text-sm font-medium mb-2">
                      <Lightbulb className="h-4 w-4 text-yellow-500" />
                      Use Cases
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {signal.linkedEntities.useCases.map((uc, i) => (
                        <Badge key={i} variant="secondary">
                          {uc}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Entity Profile (from expandedContent) */}
          {signal.expandedContent?.entityProfile && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-purple-500" />
                  Entity Profile
                </CardTitle>
                <CardDescription>Deep analysis of the {signal.expandedContent.entityProfile.type}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="text-sm font-medium mb-1">Summary</div>
                  <p className="text-sm text-muted-foreground">{signal.expandedContent.entityProfile.summary}</p>
                </div>

                {signal.expandedContent.entityProfile.keyFacts.length > 0 && (
                  <div>
                    <div className="text-sm font-medium mb-2">Key Facts</div>
                    <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
                      {signal.expandedContent.entityProfile.keyFacts.map((fact, i) => (
                        <li key={i}>{fact}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {signal.expandedContent.entityProfile.recentDevelopments.length > 0 && (
                  <div>
                    <div className="text-sm font-medium mb-2">Recent Developments</div>
                    <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
                      {signal.expandedContent.entityProfile.recentDevelopments.map((dev, i) => (
                        <li key={i}>{dev}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {signal.expandedContent.entityProfile.keyPlayers &&
                  signal.expandedContent.entityProfile.keyPlayers.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 text-sm font-medium mb-2">
                        <Users className="h-4 w-4 text-blue-500" />
                        Key Players
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {signal.expandedContent.entityProfile.keyPlayers.map((player, i) => (
                          <Badge key={i} variant="outline">
                            {player}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                {signal.expandedContent.entityProfile.maturityAssessment && (
                  <div>
                    <div className="text-sm font-medium mb-1">Maturity Assessment</div>
                    <p className="text-sm text-muted-foreground">
                      {signal.expandedContent.entityProfile.maturityAssessment}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Strategic Analysis (from expandedContent) */}
          {signal.expandedContent?.strategicAnalysis && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Compass className="h-4 w-4 text-blue-500" />
                  Strategic Analysis
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Opportunity or Threat Indicator */}
                <div className="flex items-center gap-2">
                  {signal.expandedContent.strategicAnalysis.opportunityOrThreat === 'opportunity' && (
                    <Badge className="bg-green-500/10 text-green-600 border-green-500/30">
                      <TrendingUp className="h-3 w-3 mr-1" />
                      Opportunity
                    </Badge>
                  )}
                  {signal.expandedContent.strategicAnalysis.opportunityOrThreat === 'threat' && (
                    <Badge className="bg-red-500/10 text-red-600 border-red-500/30">
                      <AlertTriangle className="h-3 w-3 mr-1" />
                      Threat
                    </Badge>
                  )}
                  {signal.expandedContent.strategicAnalysis.opportunityOrThreat === 'neutral' && (
                    <Badge className="bg-muted text-muted-foreground border-border">Neutral</Badge>
                  )}
                </div>

                {/* Aligned Strategies with Scores */}
                {signal.expandedContent.strategicAnalysis.alignedStrategies.length > 0 && (
                  <div>
                    <div className="text-sm font-medium mb-2">Strategy Alignment</div>
                    <div className="space-y-2">
                      {signal.expandedContent.strategicAnalysis.alignedStrategies.map((strategy, i) => (
                        <div key={i} className="bg-muted/50 rounded-lg p-3">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm font-medium">{strategy.strategyName}</span>
                            <Badge variant="outline" className="text-xs">
                              {strategy.alignmentScore}%
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground">{strategy.alignmentReason}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {signal.expandedContent.strategicAnalysis.radarImpact && (
                  <div>
                    <div className="text-sm font-medium mb-1">Radar Impact</div>
                    <p className="text-sm text-muted-foreground">
                      {signal.expandedContent.strategicAnalysis.radarImpact}
                    </p>
                  </div>
                )}

                {signal.expandedContent.strategicAnalysis.competitiveImplications && (
                  <div>
                    <div className="text-sm font-medium mb-1">Competitive Implications</div>
                    <p className="text-sm text-muted-foreground">
                      {signal.expandedContent.strategicAnalysis.competitiveImplications}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Recommendations (from expandedContent) */}
          {signal.expandedContent?.recommendations && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Lightbulb className="h-4 w-4 text-yellow-500" />
                  Recommendations
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {signal.expandedContent.recommendations.suggestedNextSteps.length > 0 && (
                  <div>
                    <div className="text-sm font-medium mb-2">Suggested Next Steps</div>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      {signal.expandedContent.recommendations.suggestedNextSteps.map((step, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <CheckCircle className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
                          <span>{step}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {signal.expandedContent.recommendations.questionsForInvestigation.length > 0 && (
                  <div>
                    <div className="text-sm font-medium mb-2">Questions to Investigate</div>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      {signal.expandedContent.recommendations.questionsForInvestigation.map((question, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <Info className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />
                          <span>{question}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {signal.expandedContent.recommendations.suggestedRadarPlacement && (
                  <div className="bg-muted/50 rounded-lg p-3">
                    <div className="text-sm font-medium mb-2">Suggested Radar Placement</div>
                    <div className="flex gap-2 mb-2">
                      <Badge variant="outline">
                        {signal.expandedContent.recommendations.suggestedRadarPlacement.quadrant}
                      </Badge>
                      <Badge variant="outline">
                        {signal.expandedContent.recommendations.suggestedRadarPlacement.ring}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {signal.expandedContent.recommendations.suggestedRadarPlacement.rationale}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Reference Sources (from expandedContent) */}
          {signal.expandedContent?.sources && signal.expandedContent.sources.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Link2 className="h-4 w-4 text-muted-foreground" />
                  Reference Sources
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {signal.expandedContent.sources.map((source, i) => (
                    <li key={i} className="text-sm">
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline flex items-center gap-1"
                      >
                        <ExternalLink className="h-3 w-3" />
                        {source.title}
                      </a>
                      {source.description && (
                        <p className="text-xs text-muted-foreground mt-0.5">{source.description}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </DetailPageShell>
      </PageShell>
    </SmartLayout>
  );
}
