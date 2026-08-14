/**
 * Dashboard Data Aggregation Module
 *
 * This module provides comprehensive data aggregation functions for the Dashboard UI.
 * It pulls data from all CRUD layers (technologies, companies, use cases, prototypes,
 * signals, agent activities, strategies) to provide a unified view of the innovation platform.
 *
 * Key Functions:
 * - getDashboardData(): Main aggregation function returning complete dashboard state
 * - getNeedsAttentionItems(): Items requiring human review (pending signals, low-score tech, etc.)
 * - getPortfolioMetrics(): Statistical overview of the innovation portfolio
 * - getAgentFeed(): Recent AI agent activities for transparency
 * - getRecentUpdates(): Cross-entity update tracking
 *
 * @module dashboard
 */

import {
  DashboardData,
  NeedsAttentionItem,
  PortfolioMetrics,
  AgentActivity,
  Signal,
  Prototype,
  Strategy,
  RadarData,
  RadarEntry,
  Company,
  UseCase,
  Technology,
  PainPoint,
} from './types';

/**
 * Shared data context passed to dashboard sub-functions to avoid duplicate fetches.
 * All common entity data is fetched ONCE in getDashboardData() and passed down.
 */
interface SharedDashboardData {
  radars: RadarData[];
  prototypes: Prototype[];
  signals: Signal[];
  strategies: Strategy[];
  companies: Company[];
  useCases: UseCase[];
  technologies: Technology[];
  painPoints: PainPoint[];
  /** PERF-001: fetched once (newest-first, capped at 100) and shared by the
   * feed (top 20), needs-attention (failures in top 50), and agent metrics —
   * previously three separate agentRuns reads per dashboard poll. */
  agentRuns: AgentRun[];
}
import { db } from './firebase';
import { collection, getDocs } from 'firebase/firestore';
import { getStrategies } from './strategies';
import { getPrototypes, getPrototypeStatistics, computePrototypeStatistics } from './prototypes';
import {
  getSignals,
  getPendingSignals,
  getHighConfidenceSignals,
  getSignalStatistics,
  computeSignalStatistics,
} from './signals-client';
import { getRecentAgentRuns } from './agent-runs-client';
import type { AgentRun } from '@/lib/schemas/agent-run';
import { agentRunToActivity, deriveAgentActivityStats } from './dashboard/agent-run-activity';
import { getSystemConfig } from './system-config';
import { getCompanies } from './companies';
import { getUseCases } from './use-cases';
import { getTechnologies } from './technology-service';
import { getPainPoints } from './pain-points';
import { getAgentDestination, getAgentRunDestination } from './dashboard/agent-destinations';
import { createLogger } from '@/lib/logger';
const log = createLogger('dashboard');

/**
 * Helper function to fetch all radars with their entries from Firestore.
 * Uses Promise.all to fetch all radar entries in parallel (not sequential).
 * @returns Promise resolving to an array of RadarData objects
 */
async function getRadars(): Promise<RadarData[]> {
  try {
    const radarsSnapshot = await getDocs(collection(db, 'radars'));

    // Fetch all radar entries in PARALLEL using Promise.all (not sequential for...of)
    const radars = await Promise.all(
      radarsSnapshot.docs.map(async (radarDoc) => {
        const radarData = radarDoc.data();
        const entriesSnapshot = await getDocs(collection(db, 'radars', radarDoc.id, 'entries'));
        const entries = entriesSnapshot.docs.map((doc) => doc.data() as RadarEntry);

        return {
          id: radarDoc.id,
          name: radarData.name,
          quadrants: radarData.quadrants,
          entries,
          ringSystem: radarData.ringSystem,
        };
      })
    );

    return radars;
  } catch (error) {
    log.error('Error fetching radars', error instanceof Error ? error : new Error(String(error)));
    return [];
  }
}

/**
 * Retrieves complete dashboard data by aggregating information from all platform modules.
 * This is the primary function called by the Dashboard UI component.
 *
 * This function orchestrates calls to all CRUD layers and computes derived metrics,
 * attention items, and feeds for the dashboard view.
 *
 * @returns {Promise<DashboardData>} Complete dashboard data including metrics, feeds, and attention items
 *
 * @example
 * ```typescript
 * // Fetch dashboard data for UI rendering
 * const dashboardData = await getDashboardData(uid);
 *
 * console.log(`Needs Attention: ${dashboardData.needsAttention.length} items`);
 * console.log(`Total Technologies: ${dashboardData.portfolioMetrics.totalTechnologies}`);
 * console.log(`Recent Agent Activities: ${dashboardData.agentFeed.length}`);
 * ```
 *
 * @param uid - The signed-in user's uid; agent-run reads are scoped to
 *   `observabilityPrincipals(uid)` (AUDIT-019 / ARUN-005).
 * @throws {Error} If any underlying data fetch fails
 */
export async function getDashboardData(uid: string): Promise<DashboardData> {
  log.info('Fetching complete dashboard data...');

  try {
    // OPTIMIZATION: Fetch ALL common entity data ONCE upfront
    // This eliminates duplicate getRadars(), getPrototypes(), etc. calls in sub-functions
    const [radars, prototypes, signals, strategies, companies, useCases, technologies, painPoints, agentRuns] =
      await Promise.all([
        getRadars(),
        getPrototypes(),
        getSignals(),
        getStrategies(),
        getCompanies(),
        getUseCases(),
        getTechnologies(),
        getPainPoints(),
        getRecentAgentRuns(uid, 100),
      ]);

    // Create shared data context to pass to sub-functions
    const sharedData: SharedDashboardData = {
      radars,
      prototypes,
      signals,
      strategies,
      companies,
      useCases,
      technologies,
      painPoints,
      agentRuns,
    };

    // Now call sub-functions with shared data (they won't re-fetch)
    const [needsAttentionItems, portfolioMetrics, agentFeed, recentUpdates] = await Promise.all([
      getNeedsAttentionItemsWithData(sharedData),
      getPortfolioMetricsWithData(sharedData),
      // PERF-001: feed = top 20 of the shared agentRuns fetch (no extra read).
      Promise.resolve(sharedData.agentRuns.slice(0, 20).map(agentRunToActivity)),
      getRecentUpdatesWithData(sharedData, 7), // Last 7 days of updates
    ]);

    const dashboardData: DashboardData = {
      needsAttention: needsAttentionItems,
      portfolioMetrics,
      agentFeed,
      recentUpdates,
      lastRefreshed: Date.now(),
    };

    log.info('Dashboard data fetched successfully', {
      detail: {
        needsAttentionCount: needsAttentionItems.length,
        totalTechnologies: portfolioMetrics.totalTechnologies,
        agentFeedCount: agentFeed.length,
      },
    });

    return dashboardData;
  } catch (error) {
    log.error('Error fetching dashboard data', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to fetch dashboard data: ${error}`);
  }
}

/**
 * Retrieves all items that need human attention or review.
 * This includes:
 * - Pending signals awaiting validation
 * - High-confidence signals ready for auto-import (if copilot mode)
 * - Technologies with low strategic alignment scores
 * - Pending agent activities requiring approval
 * - Prototypes approaching presentation dates
 * - Outdated technology maturity assessments
 *
 * Items are sorted by priority (high to low) and then by timestamp (newest first).
 *
 * @returns {Promise<NeedsAttentionItem[]>} Array of items requiring attention
 *
 * @example
 * ```typescript
 * const attentionItems = await getNeedsAttentionItems(uid);
 *
 * // Filter by priority
 * const criticalItems = attentionItems.filter(item => item.priority === 'high');
 *
 * // Group by type
 * const signalItems = attentionItems.filter(item => item.type === 'signal-pending');
 * const techItems = attentionItems.filter(item => item.type === 'technology-low-score');
 * ```
 */
export async function getNeedsAttentionItems(uid: string): Promise<NeedsAttentionItem[]> {
  log.info('Fetching needs attention items...');

  try {
    const items: NeedsAttentionItem[] = [];
    const systemConfig = await getSystemConfig();

    // 1. Pending Signals (always shown in both copilot and autopilot)
    const pendingSignals = await getPendingSignals();
    pendingSignals.forEach((signal: Signal) => {
      items.push({
        id: `signal-${signal.id}`,
        type: 'signal-pending',
        title: signal.title,
        description: `New ${signal.type} signal detected from ${signal.source}`,
        priority: signal.relevanceScore >= 80 ? 'high' : 'medium',
        timestamp: signal.detectedAt,
        actionUrl: `/triage/signals/${signal.id}`,
        metadata: {
          relevanceScore: signal.relevanceScore,
          alignmentScore: signal.alignmentScore,
          signalType: signal.type,
        },
      });
    });

    // 2. High-confidence signals ready for auto-import (copilot mode only)
    if (systemConfig.agentMode.mode === 'copilot') {
      const threshold = systemConfig.agentMode.autoActionThreshold;
      const highConfidenceSignals = await getHighConfidenceSignals(threshold);

      highConfidenceSignals.forEach((signal: Signal) => {
        items.push({
          id: `signal-auto-${signal.id}`,
          type: 'signal-high-confidence',
          title: `Ready to import: ${signal.title}`,
          description: `High confidence signal (${signal.relevanceScore}% relevance) ready for auto-import`,
          priority: 'medium',
          timestamp: signal.detectedAt,
          actionUrl: `/triage/signals/${signal.id}`,
          metadata: {
            relevanceScore: signal.relevanceScore,
            alignmentScore: signal.alignmentScore,
            signalType: signal.type,
          },
        });
      });
    }

    // 3. Failed agent runs that need a human look. Route per-agent so a
    // Linker failure lands in the Linker triage queue, a Scout failure in
    // Signals, etc. Replaces the dead `agent-activities` pending read that
    // never surfaced anything because nothing wrote that collection (DISC-008).
    const attentionRuns = (await getRecentAgentRuns(uid, 50)).filter((run) => run.status === 'failure');
    attentionRuns.forEach((run) => {
      const activity = agentRunToActivity(run);
      items.push({
        id: `activity-${activity.id}`,
        type: 'agent-pending',
        title: activity.title,
        description: activity.description,
        priority: 'high',
        timestamp: activity.createdAt,
        actionUrl: getAgentDestination(activity.agent),
        metadata: {
          agent: activity.agent,
          activityType: activity.type,
          status: activity.status,
        },
      });
    });

    // 4. Technologies with low strategic alignment
    // Note: strategyAlignment is currently a string ("aligned" | "conflict" | "neutral")
    // For now, we'll skip this check until numeric alignment scores are implemented
    const _radars = await getRadars();
    // TODO: Implement low-score technology detection when numeric alignment scores are available

    // 5. Prototypes approaching presentation dates (within 7 days)
    const prototypes = await getPrototypes();
    const now = Date.now();
    const _sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    prototypes.forEach((prototype: Prototype) => {
      if (prototype.presentationDate && prototype.status !== 'Delivered' && prototype.status !== 'Archived') {
        const daysUntil = (prototype.presentationDate - now) / (24 * 60 * 60 * 1000);

        if (daysUntil <= 7 && daysUntil >= 0) {
          items.push({
            id: `prototype-presentation-${prototype.id}`,
            type: 'prototype-deadline',
            title: `Upcoming presentation: ${prototype.name}`,
            description: `Prototype presentation scheduled in ${Math.ceil(daysUntil)} days`,
            priority: daysUntil <= 2 ? 'high' : 'medium',
            timestamp: prototype.presentationDate,
            actionUrl: `/library/prototypes`,
            metadata: {
              prototypeId: prototype.id,
              status: prototype.status,
              daysUntil: Math.ceil(daysUntil),
            },
          });
        }
      }
    });

    // 6. Technologies with outdated maturity assessments (>90 days old, in "Assess" or "Trial")
    // Note: The 'moved' field is a numeric indicator (-1, 0, 1) not a timestamp
    // For now, we'll skip this check until timestamp tracking is implemented
    // TODO: Implement outdated technology detection when timestamp tracking is available

    // Sort by priority (high -> medium -> low), then by timestamp (newest first)
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    items.sort((a, b) => {
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return b.timestamp - a.timestamp;
    });

    log.info('Needs attention items fetched', {
      detail: {
        total: items.length,
        high: items.filter((i) => i.priority === 'high').length,
        medium: items.filter((i) => i.priority === 'medium').length,
        low: items.filter((i) => i.priority === 'low').length,
      },
    });

    return items;
  } catch (error) {
    log.error('Error fetching needs attention items', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to fetch needs attention items: ${error}`);
  }
}

/**
 * PERF-006: exact number of pending signals surfaced on the dashboard, matching
 * the legacy `getPendingSignals()` default (`getSignalsByStatus('Validated', 50)`).
 */
const PENDING_SIGNALS_LIMIT = 50;

/**
 * PERF-006: derive pending signals from the already-fetched dashboard snapshot
 * instead of issuing a second `signals` query. Mirrors `getPendingSignals()` =
 * `getSignalsByStatus('Validated', 50)`: status `Validated`, newest-first, capped
 * at 50. `getSignals()` already returns every signal ordered by `detectedAt` desc,
 * so this yields the identical set the query would.
 */
export function selectPendingSignals(signals: Signal[]): Signal[] {
  return signals
    .filter((signal) => signal.status === 'Validated')
    .sort((a, b) => b.detectedAt - a.detectedAt)
    .slice(0, PENDING_SIGNALS_LIMIT);
}

/**
 * PERF-006: derive high-confidence signals from the dashboard snapshot instead of
 * a third `signals` query. Mirrors `getHighConfidenceSignals(threshold)`:
 * `relevanceScore >= threshold`, sorted by relevanceScore desc then detectedAt
 * desc, uncapped.
 */
export function selectHighConfidenceSignals(signals: Signal[], threshold: number): Signal[] {
  return signals
    .filter((signal) => signal.relevanceScore >= threshold)
    .sort((a, b) =>
      b.relevanceScore !== a.relevanceScore ? b.relevanceScore - a.relevanceScore : b.detectedAt - a.detectedAt
    );
}

/**
 * Internal version that uses pre-fetched shared data to avoid duplicate fetches.
 * Called by getDashboardData() with shared context.
 *
 * PERF-006: pending and high-confidence signals are now derived from
 * `sharedData.signals` (fetched once upfront), not re-queried, so the whole
 * dashboard performs a single `signals` read.
 */
async function getNeedsAttentionItemsWithData(sharedData: SharedDashboardData): Promise<NeedsAttentionItem[]> {
  log.info('Processing needs attention items with shared data...');

  try {
    const items: NeedsAttentionItem[] = [];
    const { radars: _radars2, prototypes, agentRuns, signals } = sharedData;
    const systemConfig = await getSystemConfig();

    // 1. Pending Signals (always shown in both copilot and autopilot)
    // PERF-006: filter the shared snapshot rather than re-querying Firestore.
    const pendingSignals = selectPendingSignals(signals);
    pendingSignals.forEach((signal: Signal) => {
      items.push({
        id: `signal-${signal.id}`,
        type: 'signal-pending',
        title: signal.title,
        description: `New ${signal.type} signal detected from ${signal.source}`,
        priority: signal.relevanceScore >= 80 ? 'high' : 'medium',
        timestamp: signal.detectedAt,
        actionUrl: `/triage/signals/${signal.id}`,
        metadata: {
          relevanceScore: signal.relevanceScore,
          alignmentScore: signal.alignmentScore,
          signalType: signal.type,
        },
      });
    });

    // 2. High-confidence signals ready for auto-import (copilot mode only)
    if (systemConfig.agentMode.mode === 'copilot') {
      const threshold = systemConfig.agentMode.autoActionThreshold;
      // PERF-006: derive from the shared snapshot rather than a third query.
      const highConfidenceSignals = selectHighConfidenceSignals(signals, threshold);

      highConfidenceSignals.forEach((signal: Signal) => {
        items.push({
          id: `signal-auto-${signal.id}`,
          type: 'signal-high-confidence',
          title: `Ready to import: ${signal.title}`,
          description: `High confidence signal (${signal.relevanceScore}% relevance) ready for auto-import`,
          priority: 'medium',
          timestamp: signal.detectedAt,
          actionUrl: `/triage/signals/${signal.id}`,
          metadata: {
            relevanceScore: signal.relevanceScore,
            alignmentScore: signal.alignmentScore,
            signalType: signal.type,
          },
        });
      });
    }

    // 3. Failed agent runs that need a human look. Route to the EXACT run's
    // detail page (`/agents/runs/[id]`) so the user lands on the actual
    // failure — its action, status, and error — rather than a generic
    // per-agent triage queue that a failed run never populated (UX-019).
    // Replaces the dead `agent-activities` pending read that never surfaced
    // anything because nothing wrote that collection (DISC-008).
    // PERF-001: shared upfront fetch — the top 50 of the shared runs list,
    // matching the standalone path's getRecentAgentRuns(50) window.
    const attentionRuns = agentRuns.slice(0, 50).filter((run) => run.status === 'failure');
    attentionRuns.forEach((run) => {
      const activity = agentRunToActivity(run);
      items.push({
        id: `activity-${activity.id}`,
        type: 'agent-pending',
        title: activity.title,
        description: activity.description,
        priority: 'high',
        timestamp: activity.createdAt,
        actionUrl: getAgentRunDestination(activity.id),
        metadata: {
          agent: activity.agent,
          activityType: activity.type,
          status: activity.status,
        },
      });
    });

    // 4. Technologies with low strategic alignment - use shared radars
    // Note: strategyAlignment is currently a string ("aligned" | "conflict" | "neutral")
    // For now, we'll skip this check until numeric alignment scores are implemented
    // radars is already available from sharedData - no need to re-fetch!

    // 5. Prototypes approaching presentation dates (within 7 days) - use shared prototypes
    const now = Date.now();
    prototypes.forEach((prototype: Prototype) => {
      if (prototype.presentationDate && prototype.status !== 'Delivered' && prototype.status !== 'Archived') {
        const daysUntil = (prototype.presentationDate - now) / (24 * 60 * 60 * 1000);

        if (daysUntil <= 7 && daysUntil >= 0) {
          items.push({
            id: `prototype-presentation-${prototype.id}`,
            type: 'prototype-deadline',
            title: `Upcoming presentation: ${prototype.name}`,
            description: `Prototype presentation scheduled in ${Math.ceil(daysUntil)} days`,
            priority: daysUntil <= 2 ? 'high' : 'medium',
            timestamp: prototype.presentationDate,
            actionUrl: `/library/prototypes`,
            metadata: {
              prototypeId: prototype.id,
              status: prototype.status,
              daysUntil: Math.ceil(daysUntil),
            },
          });
        }
      }
    });

    // Sort by priority (high -> medium -> low), then by timestamp (newest first)
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    items.sort((a, b) => {
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return b.timestamp - a.timestamp;
    });

    log.info('Needs attention items processed', {
      detail: {
        total: items.length,
        high: items.filter((i) => i.priority === 'high').length,
        medium: items.filter((i) => i.priority === 'medium').length,
        low: items.filter((i) => i.priority === 'low').length,
      },
    });

    return items;
  } catch (error) {
    log.error('Error processing needs attention items', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to process needs attention items: ${error}`);
  }
}

/**
 * Calculates comprehensive portfolio metrics across all innovation platform entities.
 * This provides a statistical overview of:
 * - Technology counts by ring and quadrant
 * - Company distribution
 * - Use case coverage
 * - Prototype status breakdown
 * - Signal detection performance
 * - Agent activity statistics
 *
 * @returns {Promise<PortfolioMetrics>} Complete portfolio metrics
 *
 * @example
 * ```typescript
 * const metrics = await getPortfolioMetrics(uid);
 *
 * console.log(`Total Technologies: ${metrics.totalTechnologies}`);
 * console.log(`Technologies in Adopt ring: ${metrics.technologiesByRing.Adopt}`);
 * console.log(`Active Prototypes: ${metrics.prototypeMetrics.activeCount}`);
 * console.log(`Signal Import Rate: ${metrics.signalMetrics.importRate}%`);
 * ```
 */
export async function getPortfolioMetrics(uid: string): Promise<PortfolioMetrics> {
  log.info('Calculating portfolio metrics...');

  try {
    // Fetch all data in parallel
    const [
      radars,
      strategies,
      prototypes,
      prototypeStats,
      _signals,
      signalStats,
      activityStats,
      companies,
      useCases,
      technologies,
      painPoints,
    ] = await Promise.all([
      getRadars(),
      getStrategies(),
      getPrototypes(),
      getPrototypeStatistics(),
      getSignals(),
      getSignalStatistics(),
      getAgentActivityStats(uid),
      getCompanies(),
      getUseCases(),
      getTechnologies(),
      getPainPoints(),
    ]);

    // Use decoupled technologies collection for accurate count
    const totalTechnologies = technologies.length;

    // Calculate ring/quadrant distribution from radar entries (for visualization purposes)
    const technologiesByRing: Record<string, number> = {
      Adopt: 0,
      Trial: 0,
      Assess: 0,
      Hold: 0,
    };
    const technologiesByQuadrant: Record<string, { name: string; count: number }> = {};

    radars.forEach((radar: RadarData) => {
      // Build an id→name map from this radar's current quadrant config so we
      // can denormalize `quadrantName` onto each stat row.
      const nameByQuadrantId = new Map<string, string>();
      if (Array.isArray(radar.quadrants)) {
        for (const q of radar.quadrants) {
          if (q && typeof q === 'object' && 'id' in q && 'name' in q) {
            nameByQuadrantId.set(q.id as string, q.name as string);
          }
        }
      }
      radar.entries.forEach((entry: RadarEntry) => {
        technologiesByRing[entry.ring]++;
        const existing = technologiesByQuadrant[entry.quadrantId];
        if (existing) {
          existing.count++;
        } else {
          technologiesByQuadrant[entry.quadrantId] = {
            name: nameByQuadrantId.get(entry.quadrantId) ?? 'Unknown',
            count: 1,
          };
        }
      });
    });

    // Calculate average strategic alignment
    // Note: strategyAlignment is currently a string, not a number
    // Skipping numeric alignment calculation for now
    const averageAlignment = 0; // TODO: Implement when numeric alignment is available

    // Calculate prototype metrics by status
    const prototypesByStatus: Record<string, number> = {
      Ideation: 0,
      'In Development': 0,
      'Demo Ready': 0,
      Delivered: 0,
      Archived: 0,
    };
    prototypes.forEach((prototype: Prototype) => {
      prototypesByStatus[prototype.status]++;
    });

    const portfolioMetrics: PortfolioMetrics = {
      totalTechnologies,
      technologiesByRing,
      technologiesByQuadrant,
      averageStrategicAlignment: averageAlignment,
      totalCompanies: companies.length,
      totalUseCases: useCases.length,
      totalStrategies: strategies.length,
      totalPainPoints: painPoints.length,
      prototypeMetrics: {
        total: prototypeStats.total,
        byStatus: prototypesByStatus,
        activeCount: prototypeStats.activeCount,
        deliveredCount: prototypeStats.deliveredCount,
        totalEstimatedValue: prototypeStats.totalEstimatedValue,
        totalActualValue: prototypeStats.totalActualValue,
      },
      signalMetrics: {
        totalDetected: signalStats.total,
        pendingReview: signalStats.pendingCount,
        importRate: signalStats.importRate,
        averageRelevance: signalStats.averageRelevance,
        byType: signalStats.signalsByType,
      },
      agentMetrics: {
        totalActivities: activityStats.total,
        pendingReview: activityStats.pendingReviewCount,
        autoActionRate: activityStats.completionRate,
        averageConfidence: 0, // TODO: Implement confidence tracking
        byAgent: activityStats.byAgent,
      },
    };

    log.info('Portfolio metrics calculated', {
      detail: {
        totalTechnologies,
        totalCompanies: companies.length,
        totalPainPoints: painPoints.length,
        totalPrototypes: prototypeStats.total,
        totalSignals: signalStats.total,
      },
    });

    return portfolioMetrics;
  } catch (error) {
    log.error('Error calculating portfolio metrics', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to calculate portfolio metrics: ${error}`);
  }
}

/**
 * Internal version that uses pre-fetched shared data to avoid duplicate fetches.
 * Called by getDashboardData() with shared context.
 */
async function getPortfolioMetricsWithData(sharedData: SharedDashboardData): Promise<PortfolioMetrics> {
  log.info('Calculating portfolio metrics with shared data...');

  try {
    const {
      radars,
      strategies,
      prototypes,
      signals: _signals2,
      companies,
      useCases,
      technologies,
      painPoints,
    } = sharedData;

    // PERF-001: statistics are pure aggregations — compute them from the
    // shared upfront fetch instead of re-reading three collections.
    const prototypeStats = computePrototypeStatistics(sharedData.prototypes);
    const signalStats = computeSignalStatistics(sharedData.signals);
    const activityStats = deriveAgentActivityStats(sharedData.agentRuns);

    // Use decoupled technologies collection for accurate count
    const totalTechnologies = technologies.length;

    // Calculate ring/quadrant distribution from radar entries (for visualization purposes)
    const technologiesByRing: Record<string, number> = {
      Adopt: 0,
      Trial: 0,
      Assess: 0,
      Hold: 0,
    };
    const technologiesByQuadrant: Record<string, { name: string; count: number }> = {};

    radars.forEach((radar: RadarData) => {
      // Build an id→name map from this radar's current quadrant config so we
      // can denormalize `quadrantName` onto each stat row.
      const nameByQuadrantId = new Map<string, string>();
      if (Array.isArray(radar.quadrants)) {
        for (const q of radar.quadrants) {
          if (q && typeof q === 'object' && 'id' in q && 'name' in q) {
            nameByQuadrantId.set(q.id as string, q.name as string);
          }
        }
      }
      radar.entries.forEach((entry: RadarEntry) => {
        technologiesByRing[entry.ring]++;
        const existing = technologiesByQuadrant[entry.quadrantId];
        if (existing) {
          existing.count++;
        } else {
          technologiesByQuadrant[entry.quadrantId] = {
            name: nameByQuadrantId.get(entry.quadrantId) ?? 'Unknown',
            count: 1,
          };
        }
      });
    });

    // Calculate average strategic alignment
    const averageAlignment = 0; // TODO: Implement when numeric alignment is available

    // Calculate prototype metrics by status from shared prototypes
    const prototypesByStatus: Record<string, number> = {
      Ideation: 0,
      'In Development': 0,
      'Demo Ready': 0,
      Delivered: 0,
      Archived: 0,
    };
    prototypes.forEach((prototype: Prototype) => {
      prototypesByStatus[prototype.status]++;
    });

    const portfolioMetrics: PortfolioMetrics = {
      totalTechnologies,
      technologiesByRing,
      technologiesByQuadrant,
      averageStrategicAlignment: averageAlignment,
      totalCompanies: companies.length,
      totalUseCases: useCases.length,
      totalStrategies: strategies.length,
      totalPainPoints: painPoints.length,
      prototypeMetrics: {
        total: prototypeStats.total,
        byStatus: prototypesByStatus,
        activeCount: prototypeStats.activeCount,
        deliveredCount: prototypeStats.deliveredCount,
        totalEstimatedValue: prototypeStats.totalEstimatedValue,
        totalActualValue: prototypeStats.totalActualValue,
      },
      signalMetrics: {
        totalDetected: signalStats.total,
        pendingReview: signalStats.pendingCount,
        importRate: signalStats.importRate,
        averageRelevance: signalStats.averageRelevance,
        byType: signalStats.signalsByType,
      },
      agentMetrics: {
        totalActivities: activityStats.total,
        pendingReview: activityStats.pendingReviewCount,
        autoActionRate: activityStats.completionRate,
        averageConfidence: 0,
        byAgent: activityStats.byAgent,
      },
    };

    log.info('Portfolio metrics calculated with shared data', {
      detail: {
        totalTechnologies,
        totalCompanies: companies.length,
        totalPainPoints: painPoints.length,
        totalPrototypes: prototypeStats.total,
        totalSignals: signalStats.total,
      },
    });

    return portfolioMetrics;
  } catch (error) {
    log.error('Error calculating portfolio metrics', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to calculate portfolio metrics: ${error}`);
  }
}

/**
 * Aggregate the user's recent agent runs (a capped, user-scoped snapshot — not
 * a live stream) into the dashboard `agentMetrics` shape (total /
 * pendingReview / completionRate / byAgent). Replaces the dead
 * `getActivityStatistics()` read over the never-written `agent-activities`
 * collection (DISC-008).
 */
async function getAgentActivityStats(uid: string) {
  return deriveAgentActivityStats(await getRecentAgentRuns(uid, 100));
}

/**
 * Retrieves recent agent activities for the AI transparency feed.
 * This shows what AI agents have been doing, providing visibility into autonomous actions.
 *
 * Activities are sorted by timestamp (newest first).
 *
 * @param {number} [maxResults=20] - Maximum number of activities to return
 * @returns {Promise<AgentActivity[]>} Array of recent agent activities
 *
 * @example
 * ```typescript
 * // Get last 20 agent activities
 * const feed = await getAgentFeed(uid, 20);
 *
 * // Filter by agent type
 * const scoutActivities = feed.filter(a => a.agent === 'scout');
 *
 * // Filter by status
 * const completedActions = feed.filter(a => a.status === 'completed');
 * ```
 */
export async function getAgentFeed(uid: string, maxResults: number = 20): Promise<AgentActivity[]> {
  log.info('Fetching agent feed...');

  try {
    // Recently completed agent runs (a polled, user-scoped snapshot — not a
    // live stream) mapped into the feed's view model. Replaces the dead
    // `agent-activities` read that always returned an empty feed (DISC-008).
    const runs = await getRecentAgentRuns(uid, maxResults);
    const activities = runs.map(agentRunToActivity);

    log.info('Agent feed fetched', { detail: { count: activities.length } });

    return activities;
  } catch (error) {
    log.error('Error fetching agent feed', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to fetch agent feed: ${error}`);
  }
}

/**
 * Retrieves recent updates across all entity types for activity tracking.
 * This provides a unified chronological view of changes to:
 * - Technologies (added, moved, updated)
 * - Companies (added, updated)
 * - Prototypes (created, status changes)
 * - Signals (detected, imported)
 * - Strategies (created, updated)
 *
 * Updates are sorted by timestamp (newest first).
 *
 * @param {number} [days=7] - Number of days to look back for updates
 * @returns {Promise<Array<RecentUpdate>>} Array of recent updates
 *
 * @example
 * ```typescript
 * // Get updates from last 7 days
 * const updates = await getRecentUpdates(7);
 *
 * // Filter by entity type
 * const techUpdates = updates.filter(u => u.entityType === 'technology');
 *
 * // Get updates from last 30 days
 * const monthlyUpdates = await getRecentUpdates(30);
 * ```
 */
export async function getRecentUpdates(days: number = 7): Promise<
  Array<{
    id: string;
    entityType: 'technology' | 'company' | 'prototype' | 'signal' | 'strategy' | 'useCase';
    entityId: string;
    entityName: string;
    action: 'created' | 'updated' | 'moved' | 'imported' | 'status_change';
    description: string;
    timestamp: number;
    actionUrl: string;
  }>
> {
  log.info('Fetching recent updates...');

  try {
    const cutoffTime = Date.now() - days * 24 * 60 * 60 * 1000;
    const updates: Array<{
      id: string;
      entityType: 'technology' | 'company' | 'prototype' | 'signal' | 'strategy' | 'useCase';
      entityId: string;
      entityName: string;
      action: 'created' | 'updated' | 'moved' | 'imported' | 'status_change';
      description: string;
      timestamp: number;
      actionUrl: string;
    }> = [];

    // Fetch all entities in parallel
    const [_radars3, prototypes, signals, strategies] = await Promise.all([
      getRadars(),
      getPrototypes(),
      getSignals(),
      getStrategies(),
    ]);

    // 1. Technology updates (moved or updated recently)
    // Note: The 'moved' field is a numeric indicator (-1, 0, 1) not a timestamp
    // Skipping technology update tracking for now
    // TODO: Implement when timestamp tracking is available on RadarEntry

    // 2. Prototype updates (created or status changed)
    prototypes.forEach((prototype: Prototype) => {
      if (prototype.createdAt >= cutoffTime) {
        updates.push({
          id: `prototype-created-${prototype.id}`,
          entityType: 'prototype',
          entityId: prototype.id,
          entityName: prototype.name,
          action: 'created',
          description: `New prototype created in ${prototype.status} status`,
          timestamp: prototype.createdAt,
          actionUrl: `/library/prototypes`,
        });
      } else if (prototype.updatedAt >= cutoffTime && prototype.updatedAt !== prototype.createdAt) {
        updates.push({
          id: `prototype-updated-${prototype.id}-${prototype.updatedAt}`,
          entityType: 'prototype',
          entityId: prototype.id,
          entityName: prototype.name,
          action: 'status_change',
          description: `Status changed to ${prototype.status}`,
          timestamp: prototype.updatedAt,
          actionUrl: `/library/prototypes`,
        });
      }
    });

    // 3. Signal updates (detected or imported)
    signals.forEach((signal: Signal) => {
      if (signal.detectedAt >= cutoffTime) {
        if (signal.status === 'Imported' && signal.importedAs) {
          updates.push({
            id: `signal-imported-${signal.id}`,
            entityType: 'signal',
            entityId: signal.id,
            entityName: signal.title,
            action: 'imported',
            description: `Signal imported as ${signal.importedAs.type}`,
            timestamp: signal.processedAt || signal.detectedAt,
            actionUrl: `/triage/signals/${signal.id}`,
          });
        } else if (signal.status === 'Detected') {
          updates.push({
            id: `signal-detected-${signal.id}`,
            entityType: 'signal',
            entityId: signal.id,
            entityName: signal.title,
            action: 'created',
            description: `New ${signal.type} signal detected (${signal.relevanceScore}% relevance)`,
            timestamp: signal.detectedAt,
            actionUrl: `/triage/signals/${signal.id}`,
          });
        }
      }
    });

    // 4. Strategy updates (created or updated)
    strategies.forEach((strategy: Strategy) => {
      if (strategy.createdAt >= cutoffTime) {
        updates.push({
          id: `strategy-created-${strategy.id}`,
          entityType: 'strategy',
          entityId: strategy.id,
          entityName: strategy.name,
          action: 'created',
          description: 'New strategy created',
          timestamp: strategy.createdAt,
          actionUrl: `/library/strategies`,
        });
      } else if (strategy.updatedAt >= cutoffTime && strategy.updatedAt !== strategy.createdAt) {
        updates.push({
          id: `strategy-updated-${strategy.id}-${strategy.updatedAt}`,
          entityType: 'strategy',
          entityId: strategy.id,
          entityName: strategy.name,
          action: 'updated',
          description: 'Strategy updated',
          timestamp: strategy.updatedAt,
          actionUrl: `/library/strategies`,
        });
      }
    });

    // Sort by timestamp (newest first)
    updates.sort((a, b) => b.timestamp - a.timestamp);

    log.info('Recent updates fetched', { detail: { total: updates.length, days } });

    return updates;
  } catch (error) {
    log.error('Error fetching recent updates', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to fetch recent updates: ${error}`);
  }
}

/**
 * Internal version that uses pre-fetched shared data to avoid duplicate fetches.
 * Called by getDashboardData() with shared context.
 */
async function getRecentUpdatesWithData(
  sharedData: SharedDashboardData,
  days: number = 7
): Promise<
  Array<{
    id: string;
    entityType: 'technology' | 'company' | 'prototype' | 'signal' | 'strategy' | 'useCase';
    entityId: string;
    entityName: string;
    action: 'created' | 'updated' | 'moved' | 'imported' | 'status_change';
    description: string;
    timestamp: number;
    actionUrl: string;
  }>
> {
  log.info('Processing recent updates with shared data...');

  try {
    const { radars: _radars4, prototypes, signals, strategies } = sharedData;
    const cutoffTime = Date.now() - days * 24 * 60 * 60 * 1000;
    const updates: Array<{
      id: string;
      entityType: 'technology' | 'company' | 'prototype' | 'signal' | 'strategy' | 'useCase';
      entityId: string;
      entityName: string;
      action: 'created' | 'updated' | 'moved' | 'imported' | 'status_change';
      description: string;
      timestamp: number;
      actionUrl: string;
    }> = [];

    // 1. Technology updates - use shared radars (no re-fetch needed)
    // Note: The 'moved' field is a numeric indicator (-1, 0, 1) not a timestamp
    // Skipping technology update tracking for now

    // 2. Prototype updates - use shared prototypes (no re-fetch needed)
    prototypes.forEach((prototype: Prototype) => {
      if (prototype.createdAt >= cutoffTime) {
        updates.push({
          id: `prototype-created-${prototype.id}`,
          entityType: 'prototype',
          entityId: prototype.id,
          entityName: prototype.name,
          action: 'created',
          description: `New prototype created in ${prototype.status} status`,
          timestamp: prototype.createdAt,
          actionUrl: `/library/prototypes`,
        });
      } else if (prototype.updatedAt >= cutoffTime && prototype.updatedAt !== prototype.createdAt) {
        updates.push({
          id: `prototype-updated-${prototype.id}-${prototype.updatedAt}`,
          entityType: 'prototype',
          entityId: prototype.id,
          entityName: prototype.name,
          action: 'status_change',
          description: `Status changed to ${prototype.status}`,
          timestamp: prototype.updatedAt,
          actionUrl: `/library/prototypes`,
        });
      }
    });

    // 3. Signal updates - use shared signals (no re-fetch needed)
    signals.forEach((signal: Signal) => {
      if (signal.detectedAt >= cutoffTime) {
        if (signal.status === 'Imported' && signal.importedAs) {
          updates.push({
            id: `signal-imported-${signal.id}`,
            entityType: 'signal',
            entityId: signal.id,
            entityName: signal.title,
            action: 'imported',
            description: `Signal imported as ${signal.importedAs.type}`,
            timestamp: signal.processedAt || signal.detectedAt,
            actionUrl: `/triage/signals/${signal.id}`,
          });
        } else if (signal.status === 'Detected') {
          updates.push({
            id: `signal-detected-${signal.id}`,
            entityType: 'signal',
            entityId: signal.id,
            entityName: signal.title,
            action: 'created',
            description: `New ${signal.type} signal detected (${signal.relevanceScore}% relevance)`,
            timestamp: signal.detectedAt,
            actionUrl: `/triage/signals/${signal.id}`,
          });
        }
      }
    });

    // 4. Strategy updates - use shared strategies (no re-fetch needed)
    strategies.forEach((strategy: Strategy) => {
      if (strategy.createdAt >= cutoffTime) {
        updates.push({
          id: `strategy-created-${strategy.id}`,
          entityType: 'strategy',
          entityId: strategy.id,
          entityName: strategy.name,
          action: 'created',
          description: 'New strategy created',
          timestamp: strategy.createdAt,
          actionUrl: `/library/strategies`,
        });
      } else if (strategy.updatedAt >= cutoffTime && strategy.updatedAt !== strategy.createdAt) {
        updates.push({
          id: `strategy-updated-${strategy.id}-${strategy.updatedAt}`,
          entityType: 'strategy',
          entityId: strategy.id,
          entityName: strategy.name,
          action: 'updated',
          description: 'Strategy updated',
          timestamp: strategy.updatedAt,
          actionUrl: `/library/strategies`,
        });
      }
    });

    // Sort by timestamp (newest first)
    updates.sort((a, b) => b.timestamp - a.timestamp);

    log.info('Recent updates processed with shared data', { detail: { total: updates.length, days } });

    return updates;
  } catch (error) {
    log.error('Error processing recent updates', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to process recent updates: ${error}`);
  }
}

/**
 * Retrieves aggregated statistics for quick dashboard overview cards.
 * This is a lightweight alternative to getPortfolioMetrics() for simple stat displays.
 *
 * @returns {Promise<Object>} Key statistics for dashboard cards
 *
 * @example
 * ```typescript
 * const stats = await getQuickStats(uid);
 *
 * console.log(`${stats.totalTechnologies} technologies tracked`);
 * console.log(`${stats.pendingSignals} signals need review`);
 * console.log(`${stats.activePrototypes} prototypes in progress`);
 * ```
 */
export async function getQuickStats(uid: string): Promise<{
  totalTechnologies: number;
  totalCompanies: number;
  totalPrototypes: number;
  activePrototypes: number;
  pendingSignals: number;
  pendingReview: number;
  todaySignals: number;
}> {
  log.info('Fetching quick stats...');

  try {
    const [technologies, prototypeStats, signalStats, recentRuns, signals, companies, _useCases] = await Promise.all([
      getTechnologies(),
      getPrototypeStatistics(),
      getSignalStatistics(),
      getRecentAgentRuns(uid, 100),
      getSignals(),
      getCompanies(),
      getUseCases(),
    ]);

    // Use decoupled technologies collection for accurate count
    const totalTechnologies = technologies.length;

    // Count signals detected today
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todaySignals = signals.filter((s) => s.detectedAt >= todayStart.getTime()).length;

    const stats = {
      totalTechnologies,
      totalCompanies: companies.length,
      totalPrototypes: prototypeStats.total,
      activePrototypes: prototypeStats.activeCount,
      pendingSignals: signalStats.pendingCount,
      pendingReview: recentRuns.filter((r) => r.status === 'failure').length,
      todaySignals,
    };

    log.info('Quick stats fetched', { stats });

    return stats;
  } catch (error) {
    log.error('Error fetching quick stats', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to fetch quick stats: ${error}`);
  }
}

/**
 * Retrieves signal detection trends over time for charting.
 * Returns daily signal counts grouped by type for the specified time period.
 *
 * @param {number} [days=30] - Number of days to include in trends
 * @returns {Promise<Array>} Daily signal counts by type
 *
 * @example
 * ```typescript
 * // Get 30-day signal detection trends
 * const trends = await getSignalTrends(30);
 *
 * // Use in Chart.js or similar
 * const chartData = {
 *   labels: trends.map(t => t.date),
 *   datasets: [
 *     { label: 'Patents', data: trends.map(t => t.byType.patent) },
 *     { label: 'Papers', data: trends.map(t => t.byType.paper) },
 *     { label: 'News', data: trends.map(t => t.byType.news) }
 *   ]
 * };
 * ```
 */
export async function getSignalTrends(days: number = 30): Promise<
  Array<{
    date: string;
    total: number;
    byType: Record<string, number>;
  }>
> {
  log.info('Fetching signal trends...');

  try {
    const cutoffTime = Date.now() - days * 24 * 60 * 60 * 1000;
    const signals = await getSignals();

    // Filter signals within time range
    const recentSignals = signals.filter((s) => s.detectedAt >= cutoffTime);

    // Group by date
    const trendMap = new Map<string, { total: number; byType: Record<string, number> }>();

    recentSignals.forEach((signal: Signal) => {
      const date = new Date(signal.detectedAt).toISOString().split('T')[0];

      if (!trendMap.has(date)) {
        trendMap.set(date, { total: 0, byType: {} });
      }

      const trend = trendMap.get(date)!;
      trend.total++;
      trend.byType[signal.type] = (trend.byType[signal.type] || 0) + 1;
    });

    // Convert to array and sort by date
    const trends = Array.from(trendMap.entries())
      .map(([date, data]) => ({ date, ...data }))
      .sort((a, b) => a.date.localeCompare(b.date));

    log.info('Signal trends fetched', { detail: { days, dataPoints: trends.length } });

    return trends;
  } catch (error) {
    log.error('Error fetching signal trends', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to fetch signal trends: ${error}`);
  }
}
