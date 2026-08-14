/**
 * @file lib/inngest/functions/run-comprehensive-tech-research.ts
 * @description Background job to run comprehensive AI research on a technology
 *
 * This function is triggered when a user requests comprehensive research and runs
 * in the background, allowing the user to navigate away from the page.
 *
 * **Execution Flow:**
 * 1. Receive technology.comprehensive-research.requested event with technology details
 * 2. Call the comprehensive AI research generation service
 * 3. Save results to Firestore (comprehensiveResearch field)
 * 4. Optionally sync TRL/TimeToImpact to radar placements
 * 5. Trigger technology.updated event to refresh snapshots
 *
 * **Retry Strategy:**
 * - Max retries: 2 (AI calls can be expensive)
 * - Backoff: Exponential (1min, 5min)
 *
 * @author Radarist Team
 * @created 2026-01-20
 */

import { inngest } from '../client';
import { captureDurableInstantMs, deriveDurableTimingMs, parseDurableInstantMs } from '../durable-duration';
import { declareDomainOutcome } from '../domain-outcome';
import { researchTechnologyComprehensive } from '@/ai/flows/research-technology-comprehensive';
import { boundComprehensiveResearch } from '@/lib/technology-research-bounds';
import { createLogger } from '@/lib/logger';
import {
  clearPendingSnapshotRefresh,
  completeResearchAttempt,
  inspectResearchAttempt,
  recordPendingSnapshotRefresh,
  releaseResearchPending,
} from '@/lib/technology-research-admin';
import { triggerEntityGraphSyncBestEffortServer } from '@/lib/entity-sync-server';

const log = createLogger('inngest/comprehensive-tech-research');
import type { TechnologyResearch, TechnologyCategory } from '@/lib/types';

function isSnapshotDebtPersistenceFailure(error: Error): boolean {
  // Inngest may serialize custom errors between the worker and onFailure, so
  // accept the stable name and the stable message prefix.
  return (
    error.name === 'PendingSnapshotRefreshPersistenceError' ||
    error.message.startsWith('Could not persist snapshot-refresh recovery debt')
  );
}

async function deliverComprehensiveResearchHandoff(
  technologyId: string,
  attempt: number,
  updatedFields: string[]
): Promise<{ deferred: boolean }> {
  let handoffError: unknown;
  let snapshotAcknowledged = false;

  try {
    const accepted = await inngest.send({
      name: 'app/technology.updated',
      data: { technologyId, updatedFields },
    });
    snapshotAcknowledged = Boolean(accepted?.ids?.length);
    if (!snapshotAcknowledged) handoffError = new Error('Inngest accepted no snapshot-refresh event');
  } catch (error) {
    handoffError = error;
  }

  if (!snapshotAcknowledged) {
    log.warn('Post-research snapshot refresh was not acknowledged; recording durable debt', {
      technologyId,
      error: handoffError instanceof Error ? handoffError.message : String(handoffError),
    });
  }

  // Best-effort graph sync records its own GRAPH-056 recovery anchor. Surface
  // either deferred projection through the same operator-visible research debt.
  const graphOutcome = await triggerEntityGraphSyncBestEffortServer('technology', technologyId, 'update');
  if (!graphOutcome.acknowledged) {
    log.warn('Post-research graph sync deferred; recovery anchor recorded', {
      technologyId,
      anchorRecorded: graphOutcome.anchorRecorded,
    });
  }

  if (!snapshotAcknowledged || !graphOutcome.acknowledged) {
    // This write is the immediate recovery anchor. If it fails, throw so the
    // bounded function retry re-enters only this handoff phase.
    await recordPendingSnapshotRefresh(technologyId, attempt, handoffError);
    return { deferred: true };
  }

  // A prior failed execution may already have persisted debt. Only this exact
  // attempt can clear it; a delayed completion cannot erase a newer marker.
  await clearPendingSnapshotRefresh(technologyId, attempt);
  return { deferred: false };
}

/**
 * Map valueAssessment.maturityLevel (1-5) to TRL (1-9)
 * maturityLevel 1 → TRL 2 (concept formulated)
 * maturityLevel 2 → TRL 4 (technology validated in lab)
 * maturityLevel 3 → TRL 6 (technology demonstrated)
 * maturityLevel 4 → TRL 7-8 (system complete and qualified)
 * maturityLevel 5 → TRL 9 (actual system proven)
 */
function mapMaturityToTRL(maturityLevel: 1 | 2 | 3 | 4 | 5 | undefined): number | undefined {
  if (!maturityLevel) return undefined;
  const mapping: Record<number, number> = {
    1: 2,
    2: 4,
    3: 6,
    4: 8,
    5: 9,
  };
  return mapping[maturityLevel];
}

/**
 * Parse timeToMainstream string and map to TimeToImpact horizon
 * <1 year, 1 year → H1 (0-12 months)
 * 1-2 years, 2-3 years → H2 (1-3 years)
 * 3+ years, 5+ years, etc. → H3 (3+ years)
 */
function parseTimeToImpact(timeToMainstream: string | undefined): 'H1' | 'H2' | 'H3' | undefined {
  if (!timeToMainstream) return undefined;

  const lower = timeToMainstream.toLowerCase();

  // Check for H1 indicators (<1 year, less than a year, within a year)
  if (
    lower.includes('<1') ||
    lower.includes('< 1') ||
    lower.includes('less than a year') ||
    lower.includes('within a year') ||
    lower.includes('within 12 months') ||
    lower.includes('6 months') ||
    lower.match(/^1\s*year$/)
  ) {
    return 'H1';
  }

  // Check for H3 indicators (3+ years, 5+ years, many years)
  if (
    lower.includes('3+') ||
    lower.includes('5+') ||
    lower.includes('10+') ||
    lower.includes('many years') ||
    lower.includes('long term') ||
    lower.includes('3-5') ||
    lower.includes('5-10') ||
    lower.includes('> 3') ||
    lower.includes('>3') ||
    lower.includes('more than 3')
  ) {
    return 'H3';
  }

  // Check for H2 indicators (1-2 years, 2-3 years, 1-3 years)
  if (
    lower.includes('1-2') ||
    lower.includes('2-3') ||
    lower.includes('1-3') ||
    lower.includes('2 years') ||
    lower.includes('couple of years') ||
    lower.includes('medium term')
  ) {
    return 'H2';
  }

  // Try to extract numbers and make a decision
  const yearMatch = lower.match(/(\d+)(?:\s*-\s*(\d+))?\s*years?/);
  if (yearMatch) {
    const minYears = parseInt(yearMatch[1], 10);
    const maxYears = yearMatch[2] ? parseInt(yearMatch[2], 10) : minYears;
    const avgYears = (minYears + maxYears) / 2;

    if (avgYears <= 1) return 'H1';
    if (avgYears <= 3) return 'H2';
    return 'H3';
  }

  // Default to H2 if we can't determine
  return 'H2';
}

/**
 * Extract TRL and TimeToImpact from research result
 */
function extractOverviewFields(research: TechnologyResearch): { trl?: number; timeToImpact?: 'H1' | 'H2' | 'H3' } {
  const trl = mapMaturityToTRL(research.valueAssessment?.maturityLevel);
  const timeToImpact = parseTimeToImpact(research.maturityAssessment?.timeToMainstream);

  return { trl, timeToImpact };
}

/**
 * Map AI-generated category string to TechnologyCategory enum
 * Uses fuzzy matching to handle variations in AI output
 */
function mapToTechnologyCategory(aiCategory: string | undefined): TechnologyCategory | undefined {
  if (!aiCategory) return undefined;

  const lower = aiCategory.toLowerCase();

  // Direct mappings
  const categoryMap: Record<string, TechnologyCategory> = {
    framework: 'framework',
    language: 'language',
    'programming language': 'language',
    platform: 'platform',
    tool: 'tool',
    library: 'library',
    service: 'service',
    methodology: 'methodology',
    infrastructure: 'infrastructure',
    hardware: 'hardware',
    standard: 'standard',
    protocol: 'protocol',
    api: 'api',
    architecture: 'architecture',
  };

  // Check direct match first
  for (const [key, value] of Object.entries(categoryMap)) {
    if (lower === key || lower.includes(key)) {
      return value;
    }
  }

  // Fuzzy matching for common variations
  if (lower.includes('cloud') || lower.includes('hosting') || lower.includes('paas') || lower.includes('iaas')) {
    return 'platform';
  }
  if (lower.includes('sdk') || lower.includes('kit')) {
    return 'library';
  }
  if (lower.includes('process') || lower.includes('practice') || lower.includes('agile') || lower.includes('devops')) {
    return 'methodology';
  }
  if (
    lower.includes('database') ||
    lower.includes('storage') ||
    lower.includes('compute') ||
    lower.includes('network')
  ) {
    return 'infrastructure';
  }
  if (lower.includes('chip') || lower.includes('device') || lower.includes('sensor') || lower.includes('iot')) {
    return 'hardware';
  }

  // Default to 'other' if no match
  return 'other';
}

/**
 * Extract GitHub URL from open source projects in research
 * Looks for GitHub links in project names or constructs from project name
 */
function extractGitHubUrl(research: TechnologyResearch): string | undefined {
  const openSourceProjects = research.keyPlayers?.openSourceProjects;
  if (!openSourceProjects || openSourceProjects.length === 0) return undefined;

  // Look for the most popular project (by stars if available)
  const sortedProjects = [...openSourceProjects].sort((a, b) => (b.stars || 0) - (a.stars || 0));
  const topProject = sortedProjects[0];

  if (!topProject?.name) return undefined;

  // Check if the name already contains a GitHub URL
  const githubUrlMatch = topProject.name.match(/github\.com\/[\w-]+\/[\w-]+/i);
  if (githubUrlMatch) {
    return `https://${githubUrlMatch[0]}`;
  }

  // Check description for GitHub URL
  const descMatch = topProject.description?.match(/github\.com\/[\w-]+\/[\w-]+/i);
  if (descMatch) {
    return `https://${descMatch[0]}`;
  }

  return undefined;
}

/**
 * Generate tags from research key insights and other relevant data
 * Extracts meaningful keywords that can be used for filtering/categorization
 */
function extractTags(research: TechnologyResearch, existingTags: string[] = []): string[] {
  const newTags = new Set<string>(existingTags);

  // Extract from hype cycle position
  const hypeCyclePosition = research.maturityAssessment?.hypeCyclePosition;
  if (hypeCyclePosition) {
    const hypeCycleTagMap: Record<string, string> = {
      'innovation-trigger': 'emerging',
      'peak-of-inflated-expectations': 'hyped',
      'trough-of-disillusionment': 'consolidating',
      'slope-of-enlightenment': 'maturing',
      'plateau-of-productivity': 'mature',
    };
    const hypeTag = hypeCycleTagMap[hypeCyclePosition];
    if (hypeTag) newTags.add(hypeTag);
  }

  // Extract from maturity trajectory
  const trajectory = research.maturityAssessment?.maturityTrajectory;
  if (trajectory === 'accelerating') {
    newTags.add('fast-growing');
  }

  // Extract from category
  const category = research.technologyMetrics?.category;
  if (category) {
    const categoryLower = category.toLowerCase();
    // Add category as tag if it's a common technology category
    if (
      ['ai', 'ml', 'blockchain', 'quantum', 'cloud', 'security', 'data', 'devops', 'mobile', 'web'].some((term) =>
        categoryLower.includes(term)
      )
    ) {
      // Extract the main term
      const terms = [
        'ai',
        'ml',
        'machine-learning',
        'blockchain',
        'quantum',
        'cloud',
        'security',
        'data',
        'devops',
        'mobile',
        'web',
      ];
      for (const term of terms) {
        if (categoryLower.includes(term)) {
          newTags.add(term);
          break;
        }
      }
    }
  }

  // Extract from industries (top 2)
  const industries = research.useCasesAndApplications?.byIndustry?.slice(0, 2);
  if (industries) {
    for (const ind of industries) {
      if (ind.industry && ind.industry.length < 20) {
        newTags.add(ind.industry.toLowerCase().replace(/\s+/g, '-'));
      }
    }
  }

  // Limit total tags to 10
  return Array.from(newTags).slice(0, 10);
}

/**
 * Extract a clean description from executive summary
 * Truncates if too long and ensures it ends properly
 */
function extractDescription(research: TechnologyResearch): string | undefined {
  const summary = research.executiveSummary?.summary;
  if (!summary) return undefined;

  // Truncate to 500 characters if too long
  if (summary.length <= 500) return summary;

  // Find a good breaking point (end of sentence)
  const truncated = summary.substring(0, 500);
  const lastPeriod = truncated.lastIndexOf('.');
  const lastQuestion = truncated.lastIndexOf('?');
  const lastExclaim = truncated.lastIndexOf('!');

  const breakPoint = Math.max(lastPeriod, lastQuestion, lastExclaim);
  if (breakPoint > 300) {
    return summary.substring(0, breakPoint + 1);
  }

  // If no good break point, just truncate with ellipsis
  return truncated.trim() + '...';
}

/**
 * Run comprehensive research on a technology in the background
 *
 * **Trigger:** `app/technology.comprehensive-research.requested` event
 * **Timeout:** 15 minutes (comprehensive AI research can take time)
 * **Retries:** 2 attempts with exponential backoff
 */
export const runComprehensiveTechResearchJob = inngest.createFunction(
  {
    id: 'run-comprehensive-tech-research',
    name: 'Run Comprehensive Technology Research',

    /**
     * Retry configuration - fewer retries since AI is expensive
     */
    retries: 2,

    /**
     * Rate limit: Only 3 concurrent research jobs to manage AI costs
     */
    concurrency: {
      limit: 3,
    },

    /**
     * Failure handler - logs error and updates status
     * Note: In onFailure, the original event is nested at event.event.data
     */
    onFailure: async ({ error, event }) => {
      log.error('Final failure after all retries', new Error(error.message));

      // Extract event data from nested structure (onFailure wraps the event)
      // Structure is: event.data.event.data (FailureEventPayload wraps original event)
      const eventData = event.data.event?.data as
        | {
            technologyId: string;
            triggeredAt?: number;
          }
        | undefined;

      if (!eventData?.technologyId || !Number.isFinite(eventData.triggeredAt) || Number(eventData.triggeredAt) <= 0) {
        log.error('No valid technology attempt in failure event');
        return;
      }

      const attempt = Number(eventData.triggeredAt);
      if (isSnapshotDebtPersistenceFailure(error)) {
        try {
          await recordPendingSnapshotRefresh(eventData.technologyId, attempt, error);
        } catch (persistenceError) {
          log.error(
            'Research is complete but snapshot-refresh recovery debt could not be persisted after bounded retries',
            persistenceError instanceof Error ? persistenceError : undefined,
            { technologyId: eventData.technologyId, attempt }
          );
          try {
            await inngest.send({
              name: 'app/placement.snapshot-refresh.failed',
              data: {
                technologyId: eventData.technologyId,
                error: error.message,
                failedAt: Date.now(),
                severity: 'low',
              },
            });
          } catch (notificationError) {
            log.error(
              'Could not emit terminal snapshot-refresh recovery notification',
              notificationError instanceof Error ? notificationError : undefined,
              { technologyId: eventData.technologyId, attempt }
            );
          }
        }
        return;
      }
      const { released } = await releaseResearchPending(eventData.technologyId, 'worker-failed', attempt);
      if (!released) {
        log.info('Skipped stale research failure', { technologyId: eventData.technologyId, triggeredAt: attempt });
        return;
      }

      // Send notification event for monitoring
      await inngest.send({
        name: 'app/technology.comprehensive-research.failed',
        data: {
          technologyId: eventData.technologyId,
          error: error.message,
          failedAt: Date.now(),
        },
      });
    },
  },

  /**
   * Event trigger: When comprehensive research is requested
   */
  { event: 'app/technology.comprehensive-research.requested' },

  /**
   * Main function handler
   */
  async ({ event, step }) => {
    const { technologyId, triggeredAt } = event.data;

    if (!Number.isFinite(triggeredAt) || Number(triggeredAt) <= 0) {
      throw new Error('Comprehensive research event requires a valid triggeredAt attempt token');
    }
    const attempt = Number(triggeredAt);

    // OBS-006: durable endpoints. `triggeredAt` is both the attempt token and the
    // instant the work was accepted, so queue wait is separable from execution.
    const acceptedAtMs = parseDurableInstantMs(attempt);
    const startedAtMs = await captureDurableInstantMs(step, 'capture-start-time');

    log.info('Starting comprehensive research', { technologyId, triggeredAt: attempt });

    try {
      /**
       * Step 1: Verify this event still owns the active research attempt and
       * load canonical entity fields before any provider spend.
       */
      const inspection = await step.run('verify-research-attempt', async () => {
        return inspectResearchAttempt(technologyId, attempt, 'comprehensive');
      });

      if (!inspection.active) {
        if (inspection.reason === 'not-found') throw new Error(`Technology ${technologyId} not found`);
        if (inspection.reason === 'handoff-pending') {
          await step.run('post-research-handoff', async () =>
            deliverComprehensiveResearchHandoff(technologyId, attempt, ['comprehensiveResearch'])
          );
          log.info('Resumed comprehensive-research handoff without provider spend', { technologyId, attempt });
          return declareDomainOutcome(
            {
              success: true,
              resumedHandoff: true,
              technologyId,
              technologyName: inspection.technology.name,
            },
            { outcome: 'success', reason: 'resumed-handoff' }
          );
        }
        log.info('Ignoring inactive comprehensive research event', {
          technologyId,
          triggeredAt: attempt,
          reason: inspection.reason,
        });
        // OBS-001: a superseded attempt did no business work. `success: true`
        // means "stop retrying", not "delivered".
        return declareDomainOutcome(
          { success: true, ignored: true, technologyId, reason: inspection.reason },
          { outcome: 'skipped', reason: inspection.reason }
        );
      }
      const technology = inspection.technology;
      const technologyName = technology.name;

      /**
       * Step 2: Run comprehensive research via AI
       *
       * OBS-006: the provider span is measured INSIDE the step so it is memoized
       * with the step result; measured outside, it would be re-zeroed on replay
       * exactly like the old handler-body `startTime`.
       */
      const research = await step.run('run-ai-research', async () => {
        log.info('Calling AI for research', { technologyName });
        const providerStartedAtMs = Date.now();

        const result = await researchTechnologyComprehensive({
          name: technology.name,
          description: technology.description,
          category: technology.category,
          websiteUrl: technology.websiteUrl,
        });

        if (!result) {
          throw new Error('AI research returned no data');
        }

        // Validate that we actually got meaningful content
        // At minimum, we should have an executive summary
        const hasExecutiveSummary = result.executiveSummary && result.executiveSummary.summary;
        const hasSomeContent = result.maturityAssessment || result.keyPlayers || result.valueAssessment;

        if (!hasExecutiveSummary && !hasSomeContent) {
          log.error('AI returned empty research', undefined, {
            keys: Object.keys(result),
            hasExecutiveSummary,
            executiveSummary: result.executiveSummary,
          });
          throw new Error('AI research returned empty data - no executive summary or key sections populated');
        }

        // Log summary of what we received
        const sectionCount = [
          'executiveSummary',
          'maturityAssessment',
          'technologyMetrics',
          'keyPlayers',
          'useCasesAndApplications',
          'technicalDeepDive',
          'valueAssessment',
          'risksAndBarriers',
          'investmentLandscape',
          'regulatoryAndCompliance',
          'talentAndSkills',
          'futureOutlook',
        ].filter((key) => result[key as keyof typeof result] !== undefined).length;

        log.info('AI research completed', { technologyName, sectionCount });
        return { result, providerMs: Math.max(0, Date.now() - providerStartedAtMs) };
      });
      const researchResult = research.result;

      /**
       * Step 3: Save comprehensive research to technology document
       * Also extract and populate TRL, TimeToImpact, description, category, links, and tags
       */
      const completion = await step.run('save-research', async () => {
        // Extract all fields from research
        const overviewFields = extractOverviewFields(researchResult);
        const extractedDescription = extractDescription(researchResult);
        const extractedCategory = mapToTechnologyCategory(researchResult.technologyMetrics?.category);
        const extractedGitHubUrl = extractGitHubUrl(researchResult);
        const extractedTags = extractTags(researchResult);

        // Log what we're about to save
        log.info('Saving research', {
          technologyName,
          hasExecutiveSummary: !!researchResult.executiveSummary,
          hasMaturityAssessment: !!researchResult.maturityAssessment,
          hasKeyPlayers: !!researchResult.keyPlayers,
          extractedTRL: overviewFields.trl,
          extractedTimeToImpact: overviewFields.timeToImpact,
          extractedCategory: extractedCategory ?? 'none',
          extractedTagsCount: extractedTags.length,
        });

        // TEST-022: bound the payload before it reaches Firestore. Stored
        // whole, a long 12-section result with a large source list can breach
        // the hard 1 MiB per-document limit — and a rejected write would leave
        // the run reporting success with nothing persisted. Anything removed is
        // named in `metadata.bounded`, never dropped silently.
        const { research: boundedResearch, report: boundsReport, trimmed } = boundComprehensiveResearch(researchResult);
        if (trimmed) {
          log.warn('Comprehensive research trimmed to fit the document budget', {
            technologyName,
            ...boundsReport,
          });
        }

        return completeResearchAttempt(technologyId, attempt, {
          completedAt: Date.now(),
          research: boundedResearch,
          trl: overviewFields.trl,
          timeToImpact: overviewFields.timeToImpact,
          description: extractedDescription,
          category: extractedCategory,
          githubUrl: extractedGitHubUrl,
          tags: extractedTags,
        });
      });

      if (!completion.completed) {
        log.info('Research completed after its attempt was superseded; result not persisted', {
          technologyId,
          triggeredAt: attempt,
          reason: completion.reason,
        });
        return declareDomainOutcome(
          { success: true, ignored: true, technologyId, reason: completion.reason },
          { outcome: 'skipped', reason: completion.reason }
        );
      }

      log.info('Saved research', { technologyName, updatedFields: completion.updatedFields });

      /**
       * Step 4: Trigger technology updated event to refresh snapshots
       * Include all extracted fields that may have been updated
       */
      // Research is already committed as completed. A failed recovery-marker
      // write rejects this bounded step, but retries resume here without any
      // additional provider call or mutation of the completed artifact.
      await step.run('post-research-handoff', async () =>
        deliverComprehensiveResearchHandoff(technologyId, attempt, completion.updatedFields)
      );

      const completedAtMs = await captureDurableInstantMs(step, 'capture-end-time');
      const timing = deriveDurableTimingMs({
        acceptedAtMs,
        startedAtMs,
        completedAtMs,
        providerMs: research.providerMs,
      });

      log.info('Comprehensive research completed', { technologyId, technologyName, ...timing });

      // Extract all fields for return value
      const finalOverviewFields = extractOverviewFields(researchResult);
      const finalCategory = mapToTechnologyCategory(researchResult.technologyMetrics?.category);
      const finalGitHubUrl = extractGitHubUrl(researchResult);
      const finalTags = extractTags(researchResult);

      return declareDomainOutcome(
        {
          success: true,
          technologyId,
          technologyName,
          ...timing,
          sectionsPopulated: Object.keys(researchResult).filter(
            (k) => k !== 'lastResearched' && k !== 'version' && k !== 'metadata'
          ).length,
          extractedTRL: finalOverviewFields.trl,
          extractedTimeToImpact: finalOverviewFields.timeToImpact,
          extractedCategory: finalCategory,
          extractedGitHubUrl: finalGitHubUrl,
          extractedTagsCount: finalTags.length,
          updatedDescription: completion.updatedFields.includes('description'),
        },
        { outcome: 'success' }
      );
    } catch (error) {
      log.error('Comprehensive research job failed', error instanceof Error ? error : undefined);
      throw error;
    }
  }
);
