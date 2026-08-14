/**
 * @file components/linker/ProposedRelationCard.tsx
 * @description Card component for displaying a proposed relation
 *
 * Features:
 * - Entity snapshots with type badges
 * - Confidence score indicator
 * - Expandable evidence viewer
 * - Approve/Reject/Dismiss actions
 * - Keyboard shortcut indicators
 *
 * @author Radarist Team
 * @created 2026-01-20
 */

'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Kbd } from '@/components/ui/kbd';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Check,
  X,
  Ban,
  ChevronDown,
  ChevronUp,
  ArrowRight,
  FileText,
  Clock,
  Sparkles,
  Building2,
  Cpu,
  Lightbulb,
  Beaker,
  Target,
  Radio,
  Users,
  AlertTriangle,
  Briefcase,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProposedRelation, EntityType, EvidenceReference } from '@/lib/types';
import { formatDistanceToNow } from 'date-fns';

// ============================================================================
// ENTITY TYPE STYLING
// ============================================================================

const ENTITY_TYPE_CONFIG: Record<EntityType, { icon: React.ElementType; color: string; label: string }> = {
  company: { icon: Building2, color: 'text-blue-500', label: 'Company' },
  technology: { icon: Cpu, color: 'text-emerald-500', label: 'Technology' },
  useCase: { icon: Lightbulb, color: 'text-yellow-500', label: 'Use Case' },
  prototype: { icon: Beaker, color: 'text-green-500', label: 'Prototype' },
  strategy: { icon: Target, color: 'text-purple-500', label: 'Strategy' },
  signal: { icon: Radio, color: 'text-orange-500', label: 'Signal' },
  initiative: { icon: Briefcase, color: 'text-pink-500', label: 'Initiative' },
  orgUnit: { icon: Users, color: 'text-cyan-500', label: 'Org Unit' },
  painPoint: { icon: AlertTriangle, color: 'text-red-500', label: 'Pain Point' },
  document: { icon: FileText, color: 'text-muted-foreground', label: 'Document' },
  radarPlacement: { icon: Target, color: 'text-indigo-500', label: 'Placement' },
};

// ============================================================================
// CONFIDENCE INDICATOR
// ============================================================================

function ConfidenceIndicator({ confidence }: { confidence: number }) {
  const getColorClass = () => {
    if (confidence >= 85) return 'bg-emerald-500';
    if (confidence >= 70) return 'bg-yellow-500';
    return 'bg-orange-500';
  };

  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-2 bg-muted rounded-full overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all', getColorClass())}
          style={{ width: `${confidence}%` }}
        />
      </div>
      <span className="text-sm font-medium tabular-nums">{confidence}%</span>
    </div>
  );
}

// ============================================================================
// ENTITY BADGE
// ============================================================================

function EntityBadge({ type, name, className }: { type: EntityType; name: string; className?: string }) {
  const config = ENTITY_TYPE_CONFIG[type] || ENTITY_TYPE_CONFIG.document;
  const Icon = config.icon;

  // Truncate very long names for display (keep first ~50 chars)
  const displayName = name.length > 60 ? `${name.slice(0, 57)}...` : name;
  const needsTooltip = name.length > 60;

  return (
    <div
      className={cn('flex items-center gap-2 p-2 rounded-lg bg-muted/50 border max-w-[280px]', className)}
      title={needsTooltip ? name : undefined}
    >
      <div className={cn('shrink-0', config.color)}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1 overflow-hidden">
        <p className="text-xs text-muted-foreground capitalize">{config.label}</p>
        <p className="text-sm font-medium truncate" title={name}>
          {displayName}
        </p>
      </div>
    </div>
  );
}

// ============================================================================
// EVIDENCE VIEWER
// ============================================================================

function EvidenceViewer({ evidence }: { evidence: EvidenceReference[] }) {
  const [isOpen, setIsOpen] = useState(false);

  if (!evidence || evidence.length === 0) {
    return null;
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-between text-muted-foreground hover:text-foreground"
        >
          <span className="flex items-center gap-2">
            <FileText className="h-4 w-4" />
            {evidence.length} evidence source{evidence.length !== 1 ? 's' : ''}
          </span>
          {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 pt-2">
        {evidence.map((item, index) => (
          <div key={index} className="p-3 rounded-lg bg-muted/30 border border-dashed text-sm">
            {item.snippet && <p className="text-muted-foreground italic mb-2">"{item.snippet}"</p>}
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline" className="text-xs">
                {item.sourceType}
              </Badge>
              {item.sourceId && <span className="truncate max-w-[200px]">{item.sourceId}</span>}
            </div>
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

// ============================================================================
// PROPS
// ============================================================================

export interface ProposedRelationCardProps {
  proposal: ProposedRelation;
  onApprove?: () => void;
  onReject?: (reason?: string) => void;
  onDismiss?: () => void;
  isProcessing?: boolean;
  showKeyboardHints?: boolean;
  className?: string;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function ProposedRelationCard({
  proposal,
  onApprove,
  onReject,
  onDismiss,
  isProcessing = false,
  showKeyboardHints = false,
  className,
}: ProposedRelationCardProps) {
  const _sourceConfig = ENTITY_TYPE_CONFIG[proposal.sourceType] || ENTITY_TYPE_CONFIG.document;
  const _targetConfig = ENTITY_TYPE_CONFIG[proposal.targetType] || ENTITY_TYPE_CONFIG.document;

  const relationTypeLabel = proposal.relationType.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());

  return (
    <Card className={cn('border-2', className)}>
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 space-y-2">
            {/* Discovery source badge */}
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className="text-xs">
                <Sparkles className="h-3 w-3 mr-1" />
                {proposal.discoveredBy === 'linker-agent'
                  ? 'Linker Agent'
                  : proposal.discoveredBy === 'auto-linker'
                    ? 'Auto-Linker'
                    : 'AI Assistant'}
              </Badge>
              {proposal.runId && (
                <Badge variant="secondary" className="text-xs font-mono">
                  {proposal.runId.slice(0, 12)}...
                </Badge>
              )}
            </div>

            {/* Confidence */}
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">Confidence:</span>
              <ConfidenceIndicator confidence={proposal.confidence} />
            </div>
          </div>

          {/* Timestamp */}
          <div className="text-xs text-muted-foreground flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatDistanceToNow(proposal.createdAt, { addSuffix: true })}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Entity relationship visualization */}
        <div className="flex items-center gap-3">
          <EntityBadge type={proposal.sourceType} name={proposal.sourceSnapshot.name} className="flex-1" />
          <div className="flex flex-col items-center gap-1 shrink-0">
            <ArrowRight className="h-5 w-5 text-muted-foreground" />
            <Badge variant="secondary" className="text-xs whitespace-nowrap">
              {relationTypeLabel}
            </Badge>
          </div>
          <EntityBadge type={proposal.targetType} name={proposal.targetSnapshot.name} className="flex-1" />
        </div>

        {/* Reasoning */}
        {proposal.reasoning && <p className="text-sm text-muted-foreground leading-relaxed">{proposal.reasoning}</p>}

        {/* Evidence */}
        <EvidenceViewer evidence={proposal.evidence} />

        {/* Action Buttons */}
        <div className="flex items-center gap-3 pt-4 border-t">
          <Button
            variant="default"
            className="flex-1 bg-emerald-600 hover:bg-emerald-700 focus-visible:ring-emerald-600"
            onClick={onApprove}
            disabled={isProcessing || !onApprove}
          >
            <Check className="h-4 w-4 mr-2" />
            Approve
            {showKeyboardHints && <Kbd className="ml-2 bg-emerald-700/50 border-emerald-500/50">A</Kbd>}
          </Button>
          <Button
            variant="destructive"
            className="flex-1"
            onClick={() => onReject?.()}
            disabled={isProcessing || !onReject}
          >
            <X className="h-4 w-4 mr-2" />
            Reject
            {showKeyboardHints && <Kbd className="ml-2 bg-destructive/50 border-destructive/50">R</Kbd>}
          </Button>
          <Button
            variant="outline"
            onClick={onDismiss}
            disabled={isProcessing || !onDismiss}
            title="Dismiss - won't be suggested again"
          >
            <Ban className="h-4 w-4 mr-2" />
            Dismiss
            {showKeyboardHints && <Kbd className="ml-2">D</Kbd>}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
