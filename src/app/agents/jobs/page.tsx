'use client';

/**
 * @file app/agents/jobs/page.tsx
 * @description Activity → Jobs (UX-068).
 *
 * Background verification jobs used to hang off the bottom of `/agents/runs` as
 * a second stacked table. They are their own kind of work — machine-scheduled
 * verification, not agent execution history — so they get their own page under
 * the Activity group, and `/agents/runs` is left holding only Agent Runs.
 *
 * Authentication is the same posture as every other workspace route: the global
 * `AuthProvider` redirects an unauthenticated visitor to `/login`, the data hook
 * stays disabled until auth-state restoration completes, and the underlying
 * `/api/activity/defense-verifications` route authenticates before it reads.
 */

import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { PageShell, PageContent } from '@/components/layout/PageShell';
import { ErrorBoundary, ErrorFallback } from '@/components/feedback/ErrorBoundary';
import { JobsTable } from '@/components/activity/JobsTable';
import { useDefenseVerificationJobs, type DefenseVerificationJobsFilters } from '@/hooks/useDefenseVerifications';
import { useState } from 'react';

function JobsSection() {
  // Kind/status are server-side query inputs, so they live above the table.
  const [filters, setFilters] = useState<DefenseVerificationJobsFilters>({});
  const { jobs, isLoading, error, refetch, hasMore, loadMore, isLoadingMore } = useDefenseVerificationJobs(filters);

  return (
    <JobsTable
      jobs={jobs}
      filters={filters}
      onFiltersChange={setFilters}
      isLoading={isLoading}
      error={error}
      onRetry={refetch}
      hasMore={hasMore}
      onLoadMore={loadMore}
      isLoadingMore={isLoadingMore}
    />
  );
}

export default function AgentJobsPage() {
  return (
    <SmartLayout>
      <PageShell>
        <ErrorBoundary
          fallbackRender={({ error, reset }) => (
            <ErrorFallback
              error={error}
              reset={reset}
              title="Something went wrong"
              description="The jobs page encountered an error."
            />
          )}
        >
          <PageContent noPadding>
            <JobsSection />
          </PageContent>
        </ErrorBoundary>
      </PageShell>
    </SmartLayout>
  );
}
