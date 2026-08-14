/**
 * @file app/visualizations/graph/loading.tsx
 * @description Loading state for the Graph Explorer page
 *
 * @author Radarist Team
 * @created 2026-01-18
 */

import { GraphSkeleton } from "@/components/skeletons";

export default function GraphLoading() {
  return (
    <div className="h-[calc(100vh-8rem)]">
      <GraphSkeleton className="h-full" />
    </div>
  );
}
