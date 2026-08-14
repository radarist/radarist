/**
 * @file app/triage/relations/loading.tsx
 * @description Loading state for the Linker Triage page (moved from
 * `/agents/linker` — P-F4).
 *
 * @author Radarist Team
 * @created 2026-01-20
 */

import { LinkerSkeleton } from '@/components/linker';

export default function LinkerLoading() {
  return (
    <div className="container mx-auto py-6 px-4">
      <LinkerSkeleton />
    </div>
  );
}
