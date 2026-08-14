/**
 * @file entity-icons.ts
 * @description Canonical single source of truth for entity glyphs (lucide).
 *
 * Replaces 16+ independently-maintained entity-icon maps that drifted
 * (e.g. signal = Radio in 14 files vs Target in 2; prototype = Lightbulb /
 * FlaskConical / Beaker). Import from here; never re-declare an icon map.
 *
 * Pairs with `entity-colors.ts` so glyph + color stay in lockstep.
 */
import {
  Building2,
  Cpu,
  Target,
  FlaskConical,
  Workflow,
  Radio,
  FileText,
  Network,
  Rocket,
  AlertTriangle,
  Radar,
  type LucideIcon,
} from 'lucide-react';
import type { EntityType } from '@/lib/types';

export const ENTITY_ICONS: Record<EntityType, LucideIcon> = {
  company: Building2,
  technology: Cpu,
  useCase: Target,
  strategy: Workflow,
  prototype: FlaskConical,
  signal: Radio,
  document: FileText,
  orgUnit: Network,
  initiative: Rocket,
  painPoint: AlertTriangle,
  radarPlacement: Radar,
};

/** Lucide glyph for an entity type (falls back to a neutral Target). */
export function entityIcon(type: EntityType): LucideIcon {
  return ENTITY_ICONS[type] ?? Target;
}
