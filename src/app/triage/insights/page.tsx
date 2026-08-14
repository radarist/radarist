'use client';

import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { PageShell, PageContent } from '@/components/layout/PageShell';
import { ErrorBoundary } from '@/components/feedback/ErrorBoundary';
import { BriefingFeed } from '@/components/impulse/BriefingFeed';

/**
 * @file app/triage/insights/page.tsx
 * @description Insights list page — `/triage/insights`.
 *
 * Renamed + moved from `/briefing` on 2026-05-13 to fit under the
 * Triage nav grouping alongside Signals and Relations. The `/briefing`
 * route now 308-redirects here so old links survive.
 *
 * The page-level component is still called `InsightsPage`; the
 * underlying feed component keeps the `Briefing*` filenames since
 * the data layer (`useBriefing`, `BriefingInsight`) wasn't renamed.
 */
export default function InsightsPage() {
  return (
    <SmartLayout>
      <PageShell>
        <PageContent noPadding>
          <ErrorBoundary>
            {/*
             * BriefingFeed owns its own header row (title + filter
             * controls on a single line, matching the Linker page),
             * plus the table body and pagination footer — all
             * rendered edge-to-edge inside the page card.
             */}
            <BriefingFeed />
          </ErrorBoundary>
        </PageContent>
      </PageShell>
    </SmartLayout>
  );
}
