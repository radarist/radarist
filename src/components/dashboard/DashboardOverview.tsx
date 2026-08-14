"use client";

import { NeedsAttentionPanel } from "./NeedsAttentionPanel";
import { PortfolioMetricsCards } from "./PortfolioMetricsCards";
import { AgentFeedPanel } from "./AgentFeedPanel";
import { RecentUpdatesTimeline } from "./RecentUpdatesTimeline";
import type { DashboardData } from "@/lib/types";

interface DashboardOverviewProps {
  data: DashboardData;
}

/**
 * Dashboard Overview Component
 *
 * The main dashboard container that orchestrates all dashboard panels.
 * Displays a comprehensive view of the innovation platform including:
 * - Needs attention items (top priority)
 * - Portfolio metrics cards
 * - Agent activity feed
 * - Recent updates timeline
 *
 * Layout:
 * - Portfolio metrics cards (top)
 * - Two-column layout: Needs Attention (left) + Agent Feed (right)
 * - Recent Updates timeline (bottom)
 *
 * Note: Header is now managed by the parent page component (dashboard/page.tsx)
 * to maintain consistency with other pages.
 *
 * @param props.data - Complete dashboard data
 */
export function DashboardOverview({
  data
}: DashboardOverviewProps) {
  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Portfolio Metrics Cards - Top Row (compact) */}
        <PortfolioMetricsCards metrics={data.portfolioMetrics} />

        {/* Two Column Layout - Needs Attention + Agent Feed */}
        {/* Height calculated for exactly 3 items: header (~60px) + 3 items (~100px each) + padding */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:h-[380px]">
          <NeedsAttentionPanel items={data.needsAttention} />
          <AgentFeedPanel activities={data.agentFeed} />
        </div>

      {/* Recent Updates Timeline - Bottom */}
      <RecentUpdatesTimeline updates={data.recentUpdates} />
    </div>
  );
}
