/**
 * @file AssessmentNavBadge.tsx
 * @description Sidebar badge for the Assessments inbox: the combined count of everything
 * proactive awaiting approval — pending evaluation verdicts (proposedAssessment), net-new
 * entities the scout discovered (proposedEntity), AND artifact recommendations
 * (proposedArtifact), since all three now live in the one Assessments table.
 */
'use client';

import { usePendingAssessmentsCount } from '@/hooks/useAssessments';
import { usePendingProposedEntitiesCount } from '@/hooks/useProposedEntities';
import { usePendingProposedArtifactsCount } from '@/hooks/useProposedArtifacts';
import { Badge } from '@/components/ui/badge';

export function AssessmentNavBadge() {
  const { data: verdicts } = usePendingAssessmentsCount();
  const { data: discoveries } = usePendingProposedEntitiesCount();
  const { data: recommendations } = usePendingProposedArtifactsCount();
  const count = (verdicts ?? 0) + (discoveries ?? 0) + (recommendations ?? 0);
  if (count === 0) return null;
  return (
    <Badge variant="secondary" className="ml-auto h-5 min-w-5 px-1.5 text-xs font-medium">
      {count > 99 ? '99+' : count}
    </Badge>
  );
}
