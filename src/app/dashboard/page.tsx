'use client';

import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { DashboardOverview } from '@/components/dashboard/DashboardOverview';
import { InsightNotification } from '@/components/notifications/InsightNotification';
import { DashboardSkeleton } from '@/components/skeletons';
import { ErrorBoundary, ErrorFallback } from '@/components/feedback/ErrorBoundary';
import { useDashboardData } from '@/hooks/queries';

/**
 * Dashboard Page Component
 *
 * The main dashboard page that provides a comprehensive overview of the innovation platform.
 * This is the command center for understanding:
 * - Items that need attention (pending signals, low-score tech, etc.)
 * - Portfolio metrics (technologies, prototypes, signals)
 * - AI agent activity feed (transparency into autonomous actions)
 * - Recent updates across all entities
 *
 * The dashboard is the primary landing page for understanding platform health
 * and identifying where human attention is required.
 *
 * PERFORMANCE: Uses React Query for:
 * - Automatic caching (instant back-navigation)
 * - Smart polling (pauses when tab inactive)
 * - Background refetching (no loading spinners on refresh)
 *
 * @returns The rendered dashboard page
 */
export default function DashboardPage() {
  const { data: dashboardData, isLoading, error, refetch } = useDashboardData();

  if (isLoading) {
    return (
      <SmartLayout>
        <DashboardSkeleton />
      </SmartLayout>
    );
  }

  if (error) {
    return (
      <SmartLayout>
        <div className="h-full w-full flex items-center justify-center bg-background">
          <div className="flex flex-col items-center gap-4 max-w-md text-center">
            <div className="text-4xl">⚠️</div>
            <h2 className="text-xl font-semibold">Error Loading Dashboard</h2>
            <p className="text-sm text-muted-foreground">
              {error instanceof Error ? error.message : 'Failed to load dashboard data'}
            </p>
            <button
              onClick={() => refetch()}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
            >
              Try Again
            </button>
          </div>
        </div>
      </SmartLayout>
    );
  }

  if (!dashboardData) {
    return null;
  }

  return (
    <SmartLayout>
      <ErrorBoundary
        fallbackRender={({ error, reset }) => (
          <ErrorFallback
            error={error}
            reset={reset}
            title="Failed to load dashboard"
            description="There was a problem rendering the dashboard. Please try refreshing the page."
          />
        )}
      >
        <DashboardOverview data={dashboardData} />
        <InsightNotification />
      </ErrorBoundary>
    </SmartLayout>
  );
}
