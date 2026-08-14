'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Radar, Building2, Lightbulb, Target, Layers, TrendingUp, Calendar } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ENTITY_COLORS } from '@/lib/entity-colors';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { DashboardUpdate } from '@/lib/types';

interface RecentUpdatesTimelineProps {
  updates: DashboardUpdate[];
}

type DateRange = '1d' | '3d' | '7d' | '14d' | '30d';

/**
 * Recent Updates Timeline Component
 *
 * Displays a chronological timeline of recent changes across all entity types.
 * Provides visibility into platform activity including:
 * - Technologies added or moved
 * - Prototypes created or status changes
 * - Signals detected or imported
 * - Strategies created or updated
 * - Companies added or updated
 *
 * Updates are shown in reverse chronological order (newest first).
 * Each update is clickable and links to the relevant detail page.
 *
 * @param props.updates - Array of recent updates across all entities
 */
export function RecentUpdatesTimeline({ updates }: RecentUpdatesTimelineProps) {
  const [dateRange, setDateRange] = useState<DateRange>('1d');

  /**
   * Get the date range label for display
   */
  const getDateRangeLabel = (range: DateRange): string => {
    const labels: Record<DateRange, string> = {
      '1d': 'Last 24 hours',
      '3d': 'Last 3 days',
      '7d': 'Last 7 days',
      '14d': 'Last 2 weeks',
      '30d': 'Last 30 days',
    };
    return labels[range];
  };

  /**
   * Filter updates based on selected date range
   */
  const getFilteredUpdates = () => {
    const now = Date.now();
    const rangeMs: Record<DateRange, number> = {
      '1d': 24 * 60 * 60 * 1000,
      '3d': 3 * 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      '14d': 14 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000,
    };
    const cutoff = now - rangeMs[dateRange];
    return updates.filter((update) => update.timestamp >= cutoff);
  };

  const filteredUpdates = getFilteredUpdates();

  /**
   * Returns the appropriate icon for each entity type
   */
  const getEntityIcon = (entityType: DashboardUpdate['entityType']) => {
    const icons = {
      technology: <Radar className={`h-4 w-4 ${ENTITY_COLORS.technology.text}`} />,
      company: <Building2 className={`h-4 w-4 ${ENTITY_COLORS.company.text}`} />,
      prototype: <Layers className={`h-4 w-4 ${ENTITY_COLORS.prototype.text}`} />,
      signal: <TrendingUp className={`h-4 w-4 ${ENTITY_COLORS.signal.text}`} />,
      strategy: <Target className={`h-4 w-4 ${ENTITY_COLORS.strategy.text}`} />,
      useCase: <Lightbulb className={`h-4 w-4 ${ENTITY_COLORS.useCase.text}`} />,
    };
    return icons[entityType] || <Radar className="h-4 w-4 text-muted-foreground" />;
  };

  /**
   * Returns the appropriate badge variant for each action type
   */
  const getActionBadgeVariant = (action: DashboardUpdate['action']) => {
    switch (action) {
      case 'created':
        return 'default' as const;
      case 'updated':
        return 'secondary' as const;
      case 'moved':
        return 'outline' as const;
      case 'imported':
        return 'default' as const;
      case 'status_change':
        return 'secondary' as const;
      case 'deleted':
        return 'destructive' as const;
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

  /**
   * Groups updates by date for better visual organization
   */
  const groupUpdatesByDate = (updates: DashboardUpdate[]) => {
    const groups = new Map<string, DashboardUpdate[]>();

    updates.forEach((update) => {
      const date = new Date(update.timestamp).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });

      if (!groups.has(date)) {
        groups.set(date, []);
      }
      groups.get(date)!.push(update);
    });

    return Array.from(groups.entries());
  };

  const groupedUpdates = groupUpdatesByDate(filteredUpdates);

  // Max height for scrolling (approximately 400px)
  const MAX_HEIGHT = 400;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Recent Updates</CardTitle>
            <CardDescription className="text-xs">
              {filteredUpdates.length} updates in {getDateRangeLabel(dateRange).toLowerCase()}
            </CardDescription>
          </div>
          <Select value={dateRange} onValueChange={(v) => setDateRange(v as DateRange)}>
            <SelectTrigger className="w-[140px] h-8 text-xs">
              <Calendar className="h-3 w-3 mr-1" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1d">Last 24 hours</SelectItem>
              <SelectItem value="3d">Last 3 days</SelectItem>
              <SelectItem value="7d">Last 7 days</SelectItem>
              <SelectItem value="14d">Last 2 weeks</SelectItem>
              <SelectItem value="30d">Last 30 days</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>

      <CardContent className="overflow-y-auto scrollbar-none" style={{ maxHeight: `${MAX_HEIGHT}px` }}>
        {filteredUpdates.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="text-4xl mb-2">📋</div>
            <p className="text-sm text-muted-foreground">No updates in this period</p>
            <p className="text-xs text-muted-foreground mt-1">Activity will appear here as changes are made</p>
          </div>
        ) : (
          <div className="space-y-6">
            {groupedUpdates.map(([date, dateUpdates]) => (
              <div key={date}>
                {/* Date Header */}
                <div className="flex items-center gap-2 mb-3">
                  <h3 className="text-sm font-semibold text-muted-foreground">{date}</h3>
                  <div className="flex-1 h-px bg-border" />
                </div>

                {/* Updates for this date */}
                <div className="space-y-2 pl-4">
                  {dateUpdates.map((update) => (
                    <Link key={update.id} href={update.actionUrl} className="block group">
                      <div className="flex items-start gap-3 p-2 rounded-lg hover:bg-accent/50 transition-colors">
                        {/* Timeline connector */}
                        <div className="relative">
                          <div className="absolute top-6 left-2 w-px h-full bg-border -z-10" />
                          {getEntityIcon(update.entityType)}
                        </div>

                        {/* Content */}
                        <div className="flex-1 min-w-0 pt-0.5">
                          <div className="flex items-start justify-between gap-2 mb-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-medium group-hover:text-primary transition-colors">
                                {update.entityName}
                              </span>
                              <Badge variant={getActionBadgeVariant(update.action)} className="text-xs capitalize">
                                {update.action.replace('_', ' ')}
                              </Badge>
                            </div>
                            <span className="text-xs text-muted-foreground shrink-0">
                              {formatRelativeTime(update.timestamp)}
                            </span>
                          </div>

                          <p className="text-xs text-muted-foreground">{update.description}</p>
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
