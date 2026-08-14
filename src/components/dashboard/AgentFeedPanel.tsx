'use client';

import Link from 'next/link';
import { Bot, CheckCircle2, Clock, XCircle, AlertCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { getAgentRunDestination } from '@/lib/dashboard/agent-destinations';
import type { AgentActivity } from '@/lib/types';

interface AgentFeedPanelProps {
  activities: AgentActivity[];
}

/**
 * Agent Feed Panel Component
 *
 * Displays recent AI agent activities for transparency into autonomous operations.
 * This feed shows what agents have been doing, including:
 * - Completed actions (auto-approved or user-approved)
 * - Pending actions awaiting approval (copilot mode)
 * - Failed actions that need attention
 * - In-progress agent operations
 *
 * Each activity shows:
 * - Agent type (scout, evaluation, monitor, portfolio, prototype)
 * - Action title and description
 * - Status and confidence level
 * - Timestamp
 *
 * @param props.activities - Array of recent agent activities
 */
export function AgentFeedPanel({ activities }: AgentFeedPanelProps) {
  /**
   * Returns the appropriate icon and color for each agent type
   */
  const getAgentIcon = (_agent: AgentActivity['agent']) => {
    return <Bot className="h-4 w-4" />;
  };

  /**
   * Returns the appropriate color for each agent type
   */
  const getAgentColor = (agent: AgentActivity['agent']): string => {
    const colors: Record<string, string> = {
      InnovationAgent: 'text-cyan-500',
      ScoutAgent: 'text-blue-500',
      EvaluationAgent: 'text-green-500',
      MonitorAgent: 'text-yellow-500',
      PortfolioAgent: 'text-purple-500',
      PrototypeAgent: 'text-orange-500',
    };
    return colors[agent] || 'text-muted-foreground';
  };

  /**
   * Returns the appropriate icon for each activity status
   */
  const getStatusIcon = (status: AgentActivity['status']) => {
    switch (status) {
      case 'completed':
        return <CheckCircle2 className="h-4 w-4 text-green-500" />;
      case 'pending':
        return <Clock className="h-4 w-4 text-yellow-500" />;
      case 'failed':
        return <XCircle className="h-4 w-4 text-red-500" />;
      case 'needs_review':
        return <AlertCircle className="h-4 w-4 text-blue-500 animate-pulse" />;
    }
  };

  /**
   * Returns the CONV-BADGE tinted-outline className for each status. Previously
   * a filled Badge (`default`/`secondary`/`destructive`), which CONV-BADGE
   * reserves for primary action buttons only.
   */
  const getStatusBadgeClassName = (status: AgentActivity['status']): string => {
    switch (status) {
      case 'completed':
        return 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30';
      case 'pending':
        return 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30';
      case 'failed':
        return 'bg-destructive/10 text-destructive border-destructive/30';
      case 'needs_review':
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
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-primary" />
          <div>
            <CardTitle className="text-base">AI Agent Feed</CardTitle>
            <CardDescription className="text-xs">Recent agent runs</CardDescription>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-2 flex-1 overflow-y-auto scrollbar-none">
        {activities.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <Bot className="h-12 w-12 text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground">No recent agent activity</p>
            <p className="text-xs text-muted-foreground mt-1">Agents will appear here when they take actions</p>
          </div>
        ) : (
          activities.map((activity) => (
            <Link key={activity.id} href={getAgentRunDestination(activity.id)} className="block group">
              <div className="p-3 rounded-lg border border-border hover:border-primary/50 hover:bg-accent/50 transition-all cursor-pointer">
                <div className="flex items-start gap-3">
                  {/* Agent Icon */}
                  <div className={`mt-0.5 ${getAgentColor(activity.agent)}`}>{getAgentIcon(activity.agent)}</div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <h4 className="text-sm font-medium line-clamp-1 group-hover:text-primary transition-colors">
                        {activity.title}
                      </h4>
                      <div className="flex items-center gap-1 shrink-0">{getStatusIcon(activity.status)}</div>
                    </div>

                    <p className="text-xs text-muted-foreground line-clamp-2 mb-2">{activity.description}</p>

                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="text-xs font-normal capitalize">
                        {activity.agent}
                      </Badge>
                      <Badge
                        variant="outline"
                        className={cn('text-xs font-normal capitalize', getStatusBadgeClassName(activity.status))}
                      >
                        {activity.status.replace('_', ' ')}
                      </Badge>
                      {activity.priority && (
                        <Badge
                          variant="outline"
                          className="text-xs font-normal capitalize bg-muted/50 text-muted-foreground border-muted-foreground/20"
                        >
                          {activity.priority} priority
                        </Badge>
                      )}
                      <span className="text-xs text-muted-foreground ml-auto">
                        {formatRelativeTime(activity.createdAt)}
                      </span>
                    </div>

                    {/* Resolution info if available */}
                    {activity.resolution && (
                      <div className="mt-2 pt-2 border-t border-border">
                        <p className="text-xs text-muted-foreground">
                          <span className="font-medium capitalize">{activity.resolution.action}</span> by{' '}
                          {activity.resolution.by}
                          {activity.resolution.notes && `: ${activity.resolution.notes}`}
                        </p>
                      </div>
                    )}
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
