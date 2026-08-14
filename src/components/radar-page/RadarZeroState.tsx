/**
 * @file RadarZeroState.tsx
 * @description Actionable empty state for a workspace with zero radars
 * (LOCAL-010). Rendered by the radar page instead of the visualization when
 * the radars collection is empty — a valid, durable state now that nothing
 * client-seeds showcase radars and the final radar is deletable.
 */

'use client';

import { Radar, Plus, Library } from 'lucide-react';
import { EmptyState } from '@/components/feedback/EmptyState';

export interface RadarZeroStateProps {
  /** Open the create-radar dialog. */
  onCreateRadar: () => void;
  /** Navigate to the technology library. */
  onBrowseTechnologies: () => void;
}

export function RadarZeroState({ onCreateRadar, onBrowseTechnologies }: RadarZeroStateProps) {
  return (
    <EmptyState
      icon={Radar}
      title="No radars yet"
      description="Create your first radar to start placing technologies, or browse the technology library first."
      action={{ label: 'New radar', onClick: onCreateRadar, icon: Plus }}
      secondaryAction={{
        label: 'Open technology library',
        onClick: onBrowseTechnologies,
        icon: Library,
        variant: 'outline',
      }}
      size="lg"
      className="flex-1"
    />
  );
}
