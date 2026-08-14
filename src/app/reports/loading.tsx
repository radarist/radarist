/**
 * @file app/reports/loading.tsx
 * @description Next.js loading state for the Reports page
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import { SmartLayout } from '@/components/layout/AppLayoutV2'
import { PageShell } from '@/components/layout/PageShell'
import { CardGridSkeleton } from '@/components/skeletons'

export default function Loading() {
  return (
    <SmartLayout>
      <PageShell>
        <CardGridSkeleton cards={4} columns={2} cardSize="md" />
      </PageShell>
    </SmartLayout>
  )
}
