'use client';

import Link from 'next/link';
import { AlertCircle, AlertTriangle, Info } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { NeedsAttentionItem } from '@/lib/types';

interface NeedsAttentionPanelProps {
  items: NeedsAttentionItem[];
}

/**
 * Needs Attention Panel Component
 *
 * Displays all items that require human review or action.
 * Items are sorted by priority (high -> medium -> low) and timestamp (newest first).
 *
 * Item types include:
 * - Pending signals awaiting validation
 * - High-confidence signals ready for import
 * - Technologies with low alignment scores
 * - Pending agent activities
 * - Prototypes approaching presentation dates
 * - Outdated technology assessments
 *
 * Each item is clickable and links to the relevant detail page.
 *
 * @param props.items - Array of items needing attention
 */
export function NeedsAttentionPanel({ items }: NeedsAttentionPanelProps) {
  /**
   * Returns the appropriate icon and color for each priority level
   */
  const getPriorityIcon = (priority: 'high' | 'medium' | 'low') => {
    switch (priority) {
      case 'high':
        return <AlertCircle className="h-4 w-4 text-red-500" />;
      case 'medium':
        return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
      case 'low':
        return <Info className="h-4 w-4 text-blue-500" />;
    }
  };

  /**
   * Returns the CONV-BADGE tinted-outline className for each priority level.
   * Previously a filled Badge (`destructive`/`default`/`secondary`), which
   * CONV-BADGE reserves for primary action buttons only.
   */
  const getPriorityBadgeClassName = (priority: 'high' | 'medium' | 'low'): string => {
    switch (priority) {
      case 'high':
        return 'bg-destructive/10 text-destructive border-destructive/30';
      case 'medium':
        return 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30';
      case 'low':
        return 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30';
    }
  };

  /**
   * Formats a timestamp into a relative time string
   */
  const formatRelativeTime = (timestamp: number): string => {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return new Date(timestamp).toLocaleDateString();
  };

  return (
    <Card className="flex flex-col h-full overflow-hidden">
      <CardHeader className="pb-3 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              Needs Attention
              {items.length > 0 && (
                <Badge variant="secondary" className="ml-2">
                  {items.length}
                </Badge>
              )}
            </CardTitle>
            <CardDescription className="text-xs">Items requiring your review</CardDescription>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-2 flex-1 overflow-y-auto scrollbar-none">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="text-4xl mb-2">✅</div>
            <p className="text-sm text-muted-foreground">All clear!</p>
            <p className="text-xs text-muted-foreground mt-1">No items need attention right now</p>
          </div>
        ) : (
          items.map((item) => (
            <Link key={item.id} href={item.actionUrl} className="block group">
              <div className="p-3 rounded-lg border border-border hover:border-primary/50 hover:bg-accent/50 transition-all cursor-pointer">
                <div className="flex items-start gap-3">
                  {/* Priority Icon */}
                  <div className="mt-0.5">{getPriorityIcon(item.priority)}</div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <h4 className="text-sm font-medium line-clamp-1 group-hover:text-primary transition-colors">
                        {item.title}
                      </h4>
                      <Badge
                        variant="outline"
                        className={cn('shrink-0 text-xs font-normal', getPriorityBadgeClassName(item.priority))}
                      >
                        {item.priority}
                      </Badge>
                    </div>

                    <p className="text-xs text-muted-foreground line-clamp-2 mb-2">{item.description}</p>

                    <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                      <span className="capitalize">{item.type.replace(/-/g, ' ')}</span>
                      {typeof item.metadata?.agent === 'string' && (
                        // Surface the source agent so users know what
                        // produced the row before they click — previously
                        // a "Linker Agent: Suggested 210 actions" card
                        // gave no indication of which agent (or queue)
                        // they were heading into.
                        <>
                          <span>•</span>
                          <Badge variant="outline" className="text-xs font-normal">
                            {item.metadata.agent}
                          </Badge>
                        </>
                      )}
                      <span>•</span>
                      <span>{formatRelativeTime(item.timestamp)}</span>
                    </div>
                  </div>
                </div>
              </div>
            </Link>
          ))
        )}
      </CardContent>
    </Card>
  );
}
