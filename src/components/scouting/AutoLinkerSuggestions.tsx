/**
 * @file AutoLinkerSuggestions.tsx
 * @description UI component for displaying auto-linker suggestions
 *
 * Features:
 * - Displays AI-detected entity suggestions
 * - Shows entity type icons and confidence scores
 * - "Link" button to approve suggestions
 * - "Dismiss" button to hide suggestions
 * - Loading state indicator
 *
 * @author Radarist Team
 * @created 2025-11-28
 */

'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Loader2, Link2, X, Sparkles, ChevronDown, ChevronUp, FileText } from 'lucide-react';
import { ENTITY_ICONS } from '@/lib/entity-icons';
import { ENTITY_COLORS } from '@/lib/entity-colors';
import { cn } from '@/lib/utils';
import type { SuggestedRelation } from '@/lib/auto-linker-utils';

interface AutoLinkerSuggestionsProps {
  /** List of suggested relations */
  suggestions: SuggestedRelation[];
  /** Whether analysis is in progress */
  isAnalyzing: boolean;
  /** Callback when user approves a suggestion */
  onLink: (suggestion: SuggestedRelation) => void;
  /** Callback when user dismisses a suggestion */
  onDismiss: (entityId: string) => void;
  /** Optional CSS class */
  className?: string;
}

/**
 * Displays auto-linker suggestions with actions
 */
export function AutoLinkerSuggestions({
  suggestions,
  isAnalyzing,
  onLink,
  onDismiss,
  className,
}: AutoLinkerSuggestionsProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [linkingId, setLinkingId] = useState<string | null>(null);

  // Don't render if no suggestions and not analyzing
  if (suggestions.length === 0 && !isAnalyzing) {
    return null;
  }

  const handleLink = async (suggestion: SuggestedRelation) => {
    setLinkingId(suggestion.entityId);
    try {
      await onLink(suggestion);
    } finally {
      setLinkingId(null);
    }
  };

  return (
    <div className={cn('rounded-lg border bg-muted/30 p-3', className)}>
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Sparkles className="h-4 w-4 text-primary" />
          <span>AI Suggestions</span>
          {isAnalyzing && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          {suggestions.length > 0 && (
            <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
              {suggestions.length}
            </Badge>
          )}
        </div>
        {suggestions.length > 0 && (
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setIsExpanded(!isExpanded)}>
            {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
        )}
      </div>

      {/* Suggestions list */}
      {isExpanded && (
        <div className="space-y-2">
          {isAnalyzing && suggestions.length === 0 && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              Analyzing text for entity mentions...
            </div>
          )}

          {suggestions.map((suggestion) => {
            const Icon = ENTITY_ICONS[suggestion.entityType];
            const colors = ENTITY_COLORS[suggestion.entityType];
            const isLinking = linkingId === suggestion.entityId;

            return (
              <div
                key={suggestion.entityId}
                className={cn('flex items-center gap-2 p-2 rounded-md border', colors.text, colors.bg, colors.border)}
              >
                <Icon className="h-4 w-4 shrink-0" />

                <div className="flex-1 min-w-0">
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="font-medium text-sm truncate cursor-help">{suggestion.entityName}</div>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-xs">
                        <p className="font-medium">{suggestion.entityName}</p>
                        {suggestion.entityDescription && (
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                            {suggestion.entityDescription}
                          </p>
                        )}
                        {suggestion.context && (
                          <p className="text-xs text-muted-foreground mt-1 italic">Evidence: "{suggestion.context}"</p>
                        )}
                        {suggestion.reasoningSummary && (
                          <p className="text-xs text-muted-foreground mt-1">Reasoning: {suggestion.reasoningSummary}</p>
                        )}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>

                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    <span className="capitalize">{suggestion.entityType}</span>
                    <span>•</span>
                    <span>{suggestion.relationType.replace('_', ' ')}</span>
                    <span>•</span>
                    <span
                      className={cn(
                        suggestion.confidence >= 80
                          ? 'text-green-600'
                          : suggestion.confidence >= 60
                            ? 'text-amber-600'
                            : 'text-muted-foreground'
                      )}
                    >
                      {suggestion.confidence}% match
                    </span>
                    {/* Evidence indicator (Phase 4) */}
                    {suggestion.context && (
                      <>
                        <span>•</span>
                        <span className="flex items-center gap-0.5 text-blue-600">
                          <FileText className="h-2.5 w-2.5" />
                          evidence
                        </span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 gap-1"
                    onClick={() => handleLink(suggestion)}
                    disabled={isLinking}
                  >
                    {isLinking ? <Loader2 className="h-3 w-3 animate-spin" /> : <Link2 className="h-3 w-3" />}
                    <span className="text-xs">Link</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                    onClick={() => onDismiss(suggestion.entityId)}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Help text */}
      {suggestions.length === 0 && !isAnalyzing && (
        <p className="text-xs text-muted-foreground">Start typing to get AI-powered entity suggestions</p>
      )}
    </div>
  );
}
