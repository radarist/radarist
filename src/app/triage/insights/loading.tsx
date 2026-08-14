/**
 * @file app/triage/insights/loading.tsx
 * @description Next.js loading state for the Insights page (moved from
 * `/briefing` on 2026-05-13 — see `triage/insights/page.tsx`).
 *
 * Renders a single-column card-grid skeleton so the chrome stays calm
 * while the page chunk and the initial briefing query both resolve.
 */

import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { PageShell } from '@/components/layout/PageShell';
import { CardGridSkeleton } from '@/components/skeletons';

export default function Loading() {
  return (
    <SmartLayout>
      <PageShell>
        <CardGridSkeleton cards={4} columns={1} cardSize="md" />
      </PageShell>
    </SmartLayout>
  );
}
