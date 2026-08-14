/**
 * @file app/triage/insights/[id]/loading.tsx
 * @description Loading state for the insight detail page. Mirrors the
 * skeleton baked into `InsightDetailView` so users see continuous chrome
 * during the page-chunk load → hook-fetch transition (no layout shift
 * when the data lands).
 */

import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { PageShell, PageContent } from '@/components/layout/PageShell';
import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <SmartLayout>
      <PageShell>
        <PageContent noPadding>
          <div className="flex flex-col gap-6 p-6">
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-10 w-2/3" />
            <div className="grid gap-4 md:grid-cols-3">
              <Skeleton className="h-48 md:col-span-2" />
              <Skeleton className="h-48" />
            </div>
          </div>
        </PageContent>
      </PageShell>
    </SmartLayout>
  );
}
