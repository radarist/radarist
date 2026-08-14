/**
 * @file app/triage/insights/[id]/page.tsx
 * @description Insight detail page — `/triage/insights/[id]`.
 *
 * Server-shell wrapper around `InsightDetailView` (client). Same chrome
 * as `triage/insights/page.tsx` so navigating between list and detail
 * doesn't re-flow the nav or sidebar.
 *
 * Moved from `/briefing/[id]` on 2026-05-13 along with the parent route.
 */

import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { PageShell } from '@/components/layout/PageShell';
import { ErrorBoundary } from '@/components/feedback/ErrorBoundary';
import { InsightDetailView } from '@/components/impulse/InsightDetailView';

interface InsightDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function InsightDetailPage({ params }: InsightDetailPageProps) {
  const { id } = await params;
  return (
    <SmartLayout>
      <PageShell>
        <ErrorBoundary>
          <InsightDetailView insightId={id} />
        </ErrorBoundary>
      </PageShell>
    </SmartLayout>
  );
}
