/**
 * @file components/signals/SignalTriageQueue.tsx
 * @description Workflow-specific UI for quickly triaging signals with keyboard shortcuts
 *
 * Features:
 * - One signal at a time for focused review
 * - Keyboard shortcuts: A (Approve), R (Reject), S (Skip), E (Edit)
 * - Progress tracking with visual progress bar
 * - Auto-advance to next signal
 * - Quick actions with visual feedback
 * - Centered card layout with max-width container
 *
 * @author Radarist Team
 * @created 2025-11-27
 * @updated 2025-11-29 - UI polish: centered layout, improved progress bar, kbd styling
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/components/providers/AuthProvider';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Kbd } from '@/components/ui/kbd';
import {
  Check,
  X,
  SkipForward,
  Edit,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  Calendar,
  Globe,
  Keyboard,
} from 'lucide-react';
import type { Signal } from '@/lib/types';
import { TrustScoreBadge } from '@/components/signals/TrustScoreBadge';
import { submitSignalFeedback } from '@/lib/signals/feedback';
import { useToast } from '@/hooks/use-toast';
import { createLogger } from '@/lib/logger';

const log = createLogger('ui/SignalTriageQueue');

interface SignalTriageQueueProps {
  signals: Signal[];
  onSignalProcessed: (signalId: string, action: 'approved' | 'rejected' | 'skipped') => void;
  onEditSignal?: (signal: Signal) => void;
  onComplete?: () => void;
}

/**
 * Signal Triage Queue component for rapid signal processing
 */
export function SignalTriageQueue({ signals, onSignalProcessed, onEditSignal, onComplete }: SignalTriageQueueProps) {
  const { user } = useAuth();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [processedCount, setProcessedCount] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const { toast } = useToast();

  const currentSignal = signals[currentIndex];
  const totalSignals = signals.length;
  const progress = totalSignals > 0 ? (processedCount / totalSignals) * 100 : 0;
  const hasMore = currentIndex < totalSignals - 1;
  const hasPrevious = currentIndex > 0;

  // Reset state when signals array changes
  useEffect(() => {
    setCurrentIndex(0);
    setProcessedCount(0);
  }, [signals]);

  // Check if all signals have been processed
  useEffect(() => {
    if (totalSignals === 0 && processedCount > 0 && onComplete) {
      // All signals processed
      onComplete();
    }
  }, [totalSignals, processedCount, onComplete]);

  /**
   * Process a signal with the given action
   */
  const processSignal = useCallback(
    async (action: 'approved' | 'rejected' | 'skipped') => {
      if (!currentSignal || isProcessing) return;

      setIsProcessing(true);

      try {
        // Only submit feedback for approve/reject actions. (enrich-on-like is triggered
        // inside submitSignalFeedback now, so every like path gets it uniformly.)
        if (action !== 'skipped') {
          const result = await submitSignalFeedback(
            currentSignal.id,
            action === 'approved' ? 'up' : 'down',
            undefined,
            true,
            user?.uid || 'anonymous'
          );

          // AUDIT-005: submitSignalFeedback swallows its own errors and reports
          // {success:false}. A failed write must NOT advance the queue or toast
          // success — surface the error and let the user retry the same signal.
          if (!result.success) {
            log.error('Failed to process signal', new Error(result.error ?? 'Unknown feedback error'), {
              signalId: currentSignal.id,
              action,
            });
            toast({
              title: 'Error',
              description: result.error || 'Failed to process signal. Please try again.',
              variant: 'destructive',
            });
            return;
          }
        }

        // Notify parent
        onSignalProcessed(currentSignal.id, action);

        // Show feedback
        const actionText = action === 'approved' ? 'Approved' : action === 'rejected' ? 'Rejected' : 'Skipped';
        toast({
          title: `Signal ${actionText}`,
          description: currentSignal.title,
          duration: 2000,
        });

        // Update processed count
        setProcessedCount((prev) => prev + 1);

        // Note: We don't need to advance the index because the parent will
        // remove the processed signal from the array, so the next signal
        // will automatically appear at the current index
      } catch (error) {
        log.error('Failed to process signal', error instanceof Error ? error : undefined);
        toast({
          title: 'Error',
          description: 'Failed to process signal. Please try again.',
          variant: 'destructive',
        });
      } finally {
        setIsProcessing(false);
      }
    },
    [currentSignal, isProcessing, hasMore, onSignalProcessed, onComplete, toast]
  );

  /**
   * Handle keyboard shortcuts
   */
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      // Ignore browser/OS chords — Cmd+A (select all), Ctrl+R (reload),
      // Alt+arrow (back/forward) must not be hijacked as approve/reject/skip.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Don't trigger if user is typing in an input or a contentEditable element.
      const target = e.target as HTMLElement | null;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) {
        return;
      }

      switch (e.key.toLowerCase()) {
        case 'a':
          e.preventDefault();
          processSignal('approved');
          break;
        case 'r':
          e.preventDefault();
          processSignal('rejected');
          break;
        case 's':
          e.preventDefault();
          processSignal('skipped');
          break;
        case 'e':
          e.preventDefault();
          if (onEditSignal && currentSignal) {
            onEditSignal(currentSignal);
          }
          break;
        case 'arrowleft':
          e.preventDefault();
          if (hasPrevious) {
            setCurrentIndex((prev) => prev - 1);
          }
          break;
        case 'arrowright':
          e.preventDefault();
          if (hasMore) {
            setCurrentIndex((prev) => prev + 1);
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [processSignal, onEditSignal, currentSignal, hasMore, hasPrevious]);

  // No signals to triage
  if (totalSignals === 0) {
    return (
      <div className="max-w-2xl mx-auto">
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center mb-4">
              <Sparkles className="h-7 w-7 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold mb-2">All Caught Up!</h3>
            <p className="text-muted-foreground text-center max-w-sm">
              No signals to triage right now. New signals will appear here when detected.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // All signals processed
  if (!currentSignal) {
    return (
      <div className="max-w-2xl mx-auto">
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <div className="h-14 w-14 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mb-4">
              <Check className="h-7 w-7 text-emerald-600 dark:text-emerald-400" />
            </div>
            <h3 className="text-lg font-semibold mb-2">Triage Complete!</h3>
            <p className="text-muted-foreground text-center max-w-sm">
              You've reviewed all {totalSignals} signals. Great work!
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      {/* Progress Header */}
      <Card>
        <CardContent className="py-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                Signal {currentIndex + 1} of {totalSignals}
              </span>
              <span className="font-medium text-primary">{processedCount} processed</span>
            </div>
            <Progress value={progress} className="h-2" />
          </div>
        </CardContent>
      </Card>

      {/* Keyboard Shortcuts Help */}
      <Card className="border-dashed">
        <CardContent className="py-3">
          <div className="flex items-center justify-center gap-4 flex-wrap text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <Keyboard className="h-3.5 w-3.5" />
              <span className="font-medium">Shortcuts:</span>
            </div>
            <div className="flex items-center gap-1">
              <Kbd>A</Kbd>
              <span>Approve</span>
            </div>
            <div className="flex items-center gap-1">
              <Kbd>R</Kbd>
              <span>Reject</span>
            </div>
            <div className="flex items-center gap-1">
              <Kbd>S</Kbd>
              <span>Skip</span>
            </div>
            {onEditSignal && (
              <div className="flex items-center gap-1">
                <Kbd>E</Kbd>
                <span>Edit</span>
              </div>
            )}
            <div className="flex items-center gap-1">
              <Kbd>←</Kbd>
              <Kbd>→</Kbd>
              <span>Navigate</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Signal Card */}
      <Card className="border-2">
        <CardHeader className="pb-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className="text-xs">
                  <Globe className="h-3 w-3 mr-1" />
                  {currentSignal.source}
                </Badge>
                {currentSignal.trustScore && <TrustScoreBadge trustScore={currentSignal.trustScore} size="sm" />}
                {currentSignal.relevanceScore && (
                  <Badge variant="secondary" className="text-xs">
                    Relevance: {Math.round(currentSignal.relevanceScore * 100)}%
                  </Badge>
                )}
              </div>
              <CardTitle className="text-xl leading-tight">{currentSignal.title}</CardTitle>
              {currentSignal.metadata?.publishedAt && (
                <CardDescription className="flex items-center gap-1 text-xs">
                  <Calendar className="h-3 w-3" />
                  {new Date(currentSignal.metadata.publishedAt).toLocaleDateString()}
                </CardDescription>
              )}
            </div>
            {/* External link button */}
            {currentSignal.url && (
              <a href={currentSignal.url} target="_blank" rel="noopener noreferrer" className="shrink-0">
                <Button variant="outline" size="sm">
                  <ExternalLink className="h-4 w-4" />
                  <span className="sr-only">View Source</span>
                </Button>
              </a>
            )}
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Description */}
          <p className="text-sm text-muted-foreground leading-relaxed">{currentSignal.description}</p>

          {/* Categories/Tags (from metadata) */}
          {currentSignal.metadata?.categories &&
            Array.isArray(currentSignal.metadata.categories) &&
            currentSignal.metadata.categories.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-muted-foreground">Categories:</span>
                {currentSignal.metadata.categories.map((category: string, index: number) => (
                  <Badge key={index} variant="outline" className="text-xs">
                    {category}
                  </Badge>
                ))}
              </div>
            )}

          {/* Action Buttons */}
          <div className="flex items-center gap-3 pt-4 border-t">
            <Button
              variant="default"
              className="flex-1 bg-emerald-600 hover:bg-emerald-700 focus-visible:ring-emerald-600"
              onClick={() => processSignal('approved')}
              disabled={isProcessing}
            >
              <Check className="h-4 w-4 mr-2" />
              Approve
              <Kbd className="ml-2 bg-emerald-700/50 border-emerald-500/50">A</Kbd>
            </Button>
            <Button
              variant="destructive"
              className="flex-1"
              onClick={() => processSignal('rejected')}
              disabled={isProcessing}
            >
              <X className="h-4 w-4 mr-2" />
              Reject
              <Kbd className="ml-2 bg-destructive/50 border-destructive/50">R</Kbd>
            </Button>
            <Button variant="outline" onClick={() => processSignal('skipped')} disabled={isProcessing}>
              <SkipForward className="h-4 w-4 mr-2" />
              Skip
              <Kbd className="ml-2">S</Kbd>
            </Button>
            {onEditSignal && (
              <Button variant="outline" onClick={() => onEditSignal(currentSignal)} disabled={isProcessing}>
                <Edit className="h-4 w-4 mr-2" />
                Edit
                <Kbd className="ml-2">E</Kbd>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Navigation */}
      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCurrentIndex((prev) => prev - 1)}
          disabled={!hasPrevious || isProcessing}
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Previous
        </Button>
        <span className="text-xs text-muted-foreground">
          Use <Kbd>←</Kbd> <Kbd>→</Kbd> to navigate
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCurrentIndex((prev) => prev + 1)}
          disabled={!hasMore || isProcessing}
        >
          Next
          <ChevronRight className="h-4 w-4 ml-1" />
        </Button>
      </div>
    </div>
  );
}
