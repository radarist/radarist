/**
 * @file components/linker/LinkerTriageQueue.tsx
 * @description Focused triage workflow for reviewing proposed relations one at a time
 *
 * Features:
 * - One-at-a-time focused review
 * - Keyboard shortcuts: A (Approve), R (Reject), D (Dismiss)
 * - Progress tracking with visual progress bar
 * - Auto-advance to next proposal
 * - Undo support with toast action
 *
 * @author Radarist Team
 * @created 2026-01-20
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Kbd } from '@/components/ui/kbd';
import { Check, ChevronLeft, ChevronRight, Keyboard, Sparkles } from 'lucide-react';
import { ProposedRelationCard } from './ProposedRelationCard';
import { RejectionReasonModal } from './RejectionReasonModal';
import type { ProposedRelation } from '@/lib/types';
import { useToast } from '@/hooks/use-toast';
import {
  useApproveProposedRelation,
  useRejectProposedRelation,
  useDismissProposedRelation,
  useUndoProposedRelation,
} from '@/hooks/useProposedRelations';
import { createLogger } from '@/lib/logger';

const log = createLogger('ui/LinkerTriageQueue');

// ============================================================================
// PROPS
// ============================================================================

interface LinkerTriageQueueProps {
  proposals: ProposedRelation[];
  onProposalProcessed?: (proposalId: string, action: 'approved' | 'rejected' | 'dismissed') => void;
  onComplete?: () => void;
  userId: string;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function LinkerTriageQueue({ proposals, onProposalProcessed, onComplete, userId }: LinkerTriageQueueProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [processedCount, setProcessedCount] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [rejectionModalOpen, setRejectionModalOpen] = useState(false);
  const [_lastProcessed, setLastProcessed] = useState<{
    id: string;
    action: string;
  } | null>(null);

  const { toast } = useToast();
  const approveMutation = useApproveProposedRelation();
  const rejectMutation = useRejectProposedRelation();
  const dismissMutation = useDismissProposedRelation();
  const undoMutation = useUndoProposedRelation();

  const currentProposal = proposals[currentIndex];
  const totalProposals = proposals.length;
  const progress = totalProposals > 0 ? (processedCount / totalProposals) * 100 : 0;
  const hasMore = currentIndex < totalProposals - 1;
  const hasPrevious = currentIndex > 0;

  // Reset state when proposals array changes
  useEffect(() => {
    setCurrentIndex(0);
    setProcessedCount(0);
  }, [proposals.length]);

  // Check if all proposals have been processed
  useEffect(() => {
    if (totalProposals === 0 && processedCount > 0 && onComplete) {
      onComplete();
    }
  }, [totalProposals, processedCount, onComplete]);

  /**
   * Handle approval
   */
  const handleApprove = useCallback(async () => {
    if (!currentProposal || isProcessing) return;

    setIsProcessing(true);

    try {
      await approveMutation.mutateAsync({
        proposalId: currentProposal.id,
        reviewedBy: userId,
      });

      onProposalProcessed?.(currentProposal.id, 'approved');
      setProcessedCount((prev) => prev + 1);
      setLastProcessed({ id: currentProposal.id, action: 'approved' });

      // Show toast with undo action
      toast({
        title: 'Relation Approved',
        description: `${currentProposal.sourceSnapshot.name} → ${currentProposal.targetSnapshot.name}`,
        action: (
          <Button variant="outline" size="sm" onClick={() => undoMutation.mutate({ proposalId: currentProposal.id })}>
            Undo
          </Button>
        ),
      });
    } catch (error) {
      log.error('Failed to approve proposal', error instanceof Error ? error : undefined);
    } finally {
      setIsProcessing(false);
    }
  }, [currentProposal, isProcessing, approveMutation, userId, onProposalProcessed, toast, undoMutation]);

  /**
   * Handle rejection
   */
  const handleReject = useCallback(
    async (reason?: string) => {
      if (!currentProposal || isProcessing) return;

      setIsProcessing(true);
      setRejectionModalOpen(false);

      try {
        await rejectMutation.mutateAsync({
          proposalId: currentProposal.id,
          reviewedBy: userId,
          feedbackReason: reason,
        });

        onProposalProcessed?.(currentProposal.id, 'rejected');
        setProcessedCount((prev) => prev + 1);
        setLastProcessed({ id: currentProposal.id, action: 'rejected' });

        toast({
          title: 'Relation Rejected',
          description: reason ? `Reason: ${reason}` : 'The proposal has been rejected.',
          action: (
            <Button variant="outline" size="sm" onClick={() => undoMutation.mutate({ proposalId: currentProposal.id })}>
              Undo
            </Button>
          ),
        });
      } catch (error) {
        log.error('Failed to reject proposal', error instanceof Error ? error : undefined);
      } finally {
        setIsProcessing(false);
      }
    },
    [currentProposal, isProcessing, rejectMutation, userId, onProposalProcessed, toast, undoMutation]
  );

  /**
   * Handle dismissal
   */
  const handleDismiss = useCallback(async () => {
    if (!currentProposal || isProcessing) return;

    setIsProcessing(true);

    try {
      await dismissMutation.mutateAsync({
        proposalId: currentProposal.id,
        reviewedBy: userId,
      });

      onProposalProcessed?.(currentProposal.id, 'dismissed');
      setProcessedCount((prev) => prev + 1);
      setLastProcessed({ id: currentProposal.id, action: 'dismissed' });

      toast({
        title: 'Relation Dismissed',
        description: "This relation won't be suggested again.",
      });
    } catch (error) {
      log.error('Failed to dismiss proposal', error instanceof Error ? error : undefined);
    } finally {
      setIsProcessing(false);
    }
  }, [currentProposal, isProcessing, dismissMutation, userId, onProposalProcessed, toast]);

  /**
   * Keyboard shortcuts
   */
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      // Ignore browser/OS chords — Cmd+A must not approve a proposed relation
      // (a graph write) and Cmd+D (bookmark) must not permanently dismiss one.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Don't trigger if user is typing in an input or a contentEditable element.
      const target = e.target as HTMLElement | null;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) {
        return;
      }

      // Don't trigger if modal is open
      if (rejectionModalOpen) return;

      switch (e.key.toLowerCase()) {
        case 'a':
          e.preventDefault();
          handleApprove();
          break;
        case 'r':
          e.preventDefault();
          setRejectionModalOpen(true);
          break;
        case 'd':
          e.preventDefault();
          handleDismiss();
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
  }, [handleApprove, handleDismiss, hasMore, hasPrevious, rejectionModalOpen]);

  // No proposals to triage
  if (totalProposals === 0) {
    return (
      <div className="max-w-2xl mx-auto">
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center mb-4">
              <Sparkles className="h-7 w-7 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold mb-2">All Caught Up!</h3>
            <p className="text-muted-foreground text-center max-w-sm">
              No proposed relations to review. New proposals will appear here when discovered by the Linker Agent.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // All proposals processed
  if (!currentProposal) {
    return (
      <div className="max-w-2xl mx-auto">
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <div className="h-14 w-14 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mb-4">
              <Check className="h-7 w-7 text-emerald-600 dark:text-emerald-400" />
            </div>
            <h3 className="text-lg font-semibold mb-2">Triage Complete!</h3>
            <p className="text-muted-foreground text-center max-w-sm">
              You've reviewed all {processedCount} proposed relations. Great work!
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
                Proposal {currentIndex + 1} of {totalProposals}
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
              <Kbd>D</Kbd>
              <span>Dismiss</span>
            </div>
            <div className="flex items-center gap-1">
              <Kbd>←</Kbd>
              <Kbd>→</Kbd>
              <span>Navigate</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Proposal Card */}
      <ProposedRelationCard
        proposal={currentProposal}
        onApprove={handleApprove}
        onReject={() => setRejectionModalOpen(true)}
        onDismiss={handleDismiss}
        isProcessing={isProcessing}
        showKeyboardHints
      />

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

      {/* Rejection Reason Modal */}
      <RejectionReasonModal
        open={rejectionModalOpen}
        onOpenChange={setRejectionModalOpen}
        onReject={handleReject}
        proposalName={
          currentProposal ? `${currentProposal.sourceSnapshot.name} → ${currentProposal.targetSnapshot.name}` : ''
        }
      />
    </div>
  );
}
