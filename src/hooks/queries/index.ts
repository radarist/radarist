/**
 * @file hooks/queries/index.ts
 * @description TanStack Query hooks for all entities
 *
 * Re-exports all entity query and mutation hooks for easy importing.
 *
 * @example
 * import { useCompanies, useCreateCompany } from '@/hooks/queries'
 *
 * @author Radarist Team
 * @created 2025-11-28
 */

// Companies
export { useCompanies, useCompany, useCreateCompany, useUpdateCompany, useDeleteCompany } from './useCompanies';

// Technologies (Legacy - RadarEntry model)
export { useTechnologies, useTechnologyTags, useQuadrants } from './useTechnologies';

// Technologies (Phase 1 - Decoupled model)
export {
  useDecoupledTechnologies,
  useDecoupledTechnology,
  useTechnologyBySlug,
  useTechnologySearch,
  useDecoupledTechnologyTags,
  useTechnologyCategories,
  useCreateDecoupledTechnology,
  useUpdateDecoupledTechnology,
  useDeleteDecoupledTechnology,
  useDeleteTechnologyWithPlacements,
  useLinkCompanyToTechnology,
  useUnlinkCompanyFromTechnology,
  useLinkUseCaseToTechnology,
  useUnlinkUseCaseFromTechnology,
} from './useTechnologiesDecoupled';

// Radar Placements (Phase 1)
export {
  useRadarPlacements,
  usePlacementsByRadar,
  usePlacementsForTechnology,
  useRadarPlacement,
  usePlacementForTechnologyOnRadar,
  useTechnologiesWithPlacements,
  useRadarPlacementStats,
  useCreateRadarPlacement,
  useUpdateRadarPlacement,
  useMoveTechnologyRing,
  useDeleteRadarPlacement,
  useDeleteAllPlacementsForTechnology,
  useDeleteAllPlacementsForRadar,
} from './useRadarPlacements';

// Prototypes
export {
  usePrototypes,
  usePrototype,
  usePrototypesByStatus,
  usePrototypesKanban,
  useCreatePrototype,
  useUpdatePrototype,
  useDeletePrototype,
  useUpdatePrototypeStatus,
} from './usePrototypes';

// Use Cases
export {
  useUseCases,
  useUseCase,
  useUseCasesKanban,
  useCreateUseCase,
  useUpdateUseCase,
  useDeleteUseCase,
  useUpdateUseCaseStatus,
} from './useUseCases';

// Strategies
export { useStrategies, useStrategy, useCreateStrategy, useUpdateStrategy, useDeleteStrategy } from './useStrategies';

// Signals
export {
  useSignals,
  useSignal,
  usePendingSignals,
  useSignalStatistics,
  useApproveSignal,
  useRejectSignal,
} from './useSignals';

// Org Units
export { useOrgUnits, useBusinessUnitNames, selectBusinessUnitNames } from './useOrgUnits';

// Dashboard
export { useDashboardData } from './useDashboard';

// Briefing engagement (Option A — Chunk 1 hooks)
export { useLikeInsight } from './useLikeInsight';
export { useDismissInsight } from './useDismissInsight';
export { useUndismissInsight } from './useUndismissInsight';
export { useBulkDismissInsights } from './useBulkDismissInsights';
export { useInsightDetail, type InsightDetail } from './useInsightDetail';
export { useTrackInsightView } from './useTrackInsightView';

// Agent profiles (live config.yaml + mission budget)
export {
  useAgentProfiles,
  type AgentProfileSummary,
  type MissionBudgetInfo,
  type AgentProfilesResponse,
} from './useAgentProfiles';
