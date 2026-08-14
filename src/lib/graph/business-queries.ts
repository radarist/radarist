/**
 * @file business-queries.ts
 * @description Business-specific graph queries for Executive Q&A and AI tools.
 *
 * This module provides high-level functions for answering business questions:
 * - Impact analysis: What org units are affected by a technology?
 * - Solution discovery: What technologies solve a pain point?
 * - Alignment: What technologies align with a strategy?
 * - Gap analysis: What pain points lack initiatives?
 *
 * @phase Phase 5: GraphRAG Reasoning Engine
 * @author Radarist Team
 * @created 2026-01-09
 */

import type { GraphNode, GraphPath, TraversalOptions } from './interface';
import { getGraphService } from './service-factory';
import { findPath, findConnected, getEntity, getNeighbors } from './traversal';
import { BUSINESS_ENTITY_GRAPH_LABELS } from './entity-type-vocab';
import { CLAIM_RELATION_PREDICATES } from './relation-registry';

const DEFAULT_BUSINESS_RELATION_CONFIDENCE = 80;

/**
 * GRAPH-062 — the traversal envelope a strategic-alignment claim has to fit in.
 *
 * `relationTypes` is derived from the canonical Relation write contract, so the
 * only edges admitted are ones some asserter actually claimed between two
 * entities. That is what excludes `EXPLORED` (a Session's browsing trail),
 * `ABOUT`/`ABOUT_SUBJECT`/`ASSERTED_BY` (reification bookkeeping), `CONTAINS`,
 * `OBSERVES`, and the rest of the housekeeping vocabulary — none of which
 * appears in `RELATION_PREDICATE_MAP`.
 *
 * `nodeLabels` closes the other half. Predicate filtering alone still permits an
 * intermediate hop through a non-entity node that happens to carry a business
 * predicate; requiring a canonical entity label at every hop means an admitted
 * path is a chain of domain facts end to end.
 *
 * Session/`EXPLORED` data is untouched — it remains behavioral proximity, which
 * the proactive-insight surfaces read. It is simply not evidence of strategy.
 */
const BUSINESS_ALIGNMENT_TRAVERSAL = {
  relationTypes: CLAIM_RELATION_PREDICATES,
  nodeLabels: BUSINESS_ENTITY_GRAPH_LABELS,
} as const;

function boundedConfidence(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.min(100, Math.max(0, value));
}

/**
 * Read the authoritative relation score used by graph business queries.
 * Effective confidence includes review feedback and corroboration; legacy
 * relations fall back to asserted confidence, then to the historical default.
 */
export function resolveBusinessRelationConfidence(properties: Record<string, unknown> | null | undefined): number {
  return (
    boundedConfidence(properties?.effectiveConfidence) ??
    boundedConfidence(properties?.confidence) ??
    DEFAULT_BUSINESS_RELATION_CONFIDENCE
  );
}

// ============================================================================
// TYPES
// ============================================================================

/**
 * Technology with alignment score for a strategy.
 */
export interface AlignedTechnology {
  technology: GraphNode;
  alignmentScore: number;
  distance: number;
  reason: string;
  /**
   * The predicate chain that was actually admitted, strategy-end first.
   *
   * GRAPH-062 — a score with no visible path is unauditable: the defect this
   * replaces was a 2-hop session co-view presented as "aligns with strategy",
   * and nothing in the recommendation said which edges produced it. Empty only
   * when no path could be resolved, in which case the technology is dropped.
   */
  admittedPath: string[];
}

/**
 * Solution for a pain point with effectiveness metrics.
 */
export interface PainPointSolution {
  technology: GraphNode;
  effectivenessScore: number;
  distance: number;
  path: GraphPath | null;
}

/**
 * Impact result showing how a technology affects org units.
 */
export interface TechnologyImpact {
  technology: GraphNode;
  useCases: Array<{
    useCase: GraphNode;
    distance: number;
  }>;
  orgUnits: Array<{
    orgUnit: GraphNode;
    viaUseCase: string;
    totalDistance: number;
  }>;
  totalReach: number;
}

/**
 * Vendor recommendation for a strategy.
 */
export interface VendorRecommendation {
  company: GraphNode;
  technologies: GraphNode[];
  alignmentScore: number;
  explanation: string;
}

/**
 * Gap analysis result.
 */
export interface GapAnalysis {
  painPoint: GraphNode;
  affectedOrgUnits: GraphNode[];
  hasInitiative: boolean;
  hasTechnology: boolean;
  severity: string;
  recommendation: string;
}

// ============================================================================
// SOLUTION DISCOVERY
// ============================================================================

/**
 * Find technologies that can solve a specific pain point.
 *
 * @example
 * ```typescript
 * const solutions = await findSolutionsForPainPoint('pain-ui-performance');
 * solutions.forEach(s => {
 *   console.log(`${s.technology.properties.name}: ${s.effectivenessScore}%`);
 * });
 * ```
 */
export async function findSolutionsForPainPoint(
  painPointId: string,
  options: TraversalOptions = {}
): Promise<PainPointSolution[]> {
  const technologies = await findConnected(painPointId, 'technology', {
    maxDepth: options.maxDepth || 3,
    ...options,
  });

  const solutions: PainPointSolution[] = [];

  for (const tech of technologies) {
    const path = await findPath(tech.id, painPointId, {
      maxDepth: options.maxDepth || 3,
    });

    // Calculate effectiveness based on path confidence and length
    let effectivenessScore = 100;
    if (path && path.relations) {
      for (const rel of path.relations) {
        const confidence = resolveBusinessRelationConfidence(rel?.properties);
        effectivenessScore = (effectivenessScore * confidence) / 100;
      }
      // Penalize longer paths slightly
      effectivenessScore = effectivenessScore * Math.pow(0.95, path.length - 1);
    }

    solutions.push({
      technology: tech,
      effectivenessScore: Math.round(effectivenessScore),
      distance: path?.length || 0,
      path,
    });
  }

  // Sort by effectiveness
  return solutions.sort((a, b) => b.effectivenessScore - a.effectivenessScore);
}

/**
 * Find pain points affecting an org unit.
 *
 * @example
 * ```typescript
 * const painPoints = await findPainPointsForOrgUnit('org-dairy');
 * ```
 */
export async function findPainPointsForOrgUnit(
  orgUnitId: string,
  options: TraversalOptions = {}
): Promise<GraphNode[]> {
  return findConnected(orgUnitId, 'pain_point', {
    maxDepth: options.maxDepth || 2,
    ...options,
  });
}

// ============================================================================
// STRATEGIC ALIGNMENT
// ============================================================================

/**
 * Find technologies aligned with a strategy.
 *
 * @example
 * ```typescript
 * const aligned = await findTechnologiesForStrategy('strategy-digital-transformation');
 * aligned.forEach(t => {
 *   console.log(`${t.technology.properties.name}: ${t.alignmentScore}% aligned`);
 * });
 * ```
 */
export async function findTechnologiesForStrategy(
  strategyId: string,
  options: TraversalOptions = {}
): Promise<AlignedTechnology[]> {
  // Caller options come first so the business envelope cannot be widened by a
  // caller passing its own relationTypes/nodeLabels: a strategic-alignment
  // claim is defined by that envelope, not by the caller's appetite.
  const traversal: TraversalOptions = {
    maxDepth: options.maxDepth || 3,
    ...options,
    ...BUSINESS_ALIGNMENT_TRAVERSAL,
  };
  const technologies = await findConnected(strategyId, 'technology', traversal);

  const results: AlignedTechnology[] = [];

  for (const tech of technologies) {
    const path = await findPath(tech.id, strategyId, traversal);

    // A technology with no resolvable business path is not aligned. The old
    // code kept it at score 100 labelled "indirectly connected", which is how
    // a co-view could outrank an evidenced ALIGNS_WITH edge.
    if (!path || path.relations.length === 0) continue;

    let alignmentScore = 100;
    const reasons: string[] = [];
    // `findPath` was called technology-end first; report the chain from the
    // strategy so the receipt reads the way the recommendation does.
    const admittedPath = path.relations.map((rel) => rel?.type ?? 'RELATED_TO').reverse();

    for (const rel of path.relations) {
      const confidence = resolveBusinessRelationConfidence(rel?.properties);
      alignmentScore = (alignmentScore * confidence) / 100;

      // Build reason based on relation types
      if (rel?.type === 'ALIGNS_WITH') {
        reasons.push('directly aligns');
      } else if (rel?.type === 'SUPPORTS') {
        reasons.push('supports goals');
      } else if (rel?.type === 'ENABLES') {
        reasons.push('enables capabilities');
      }
    }

    results.push({
      technology: tech,
      alignmentScore: Math.round(alignmentScore),
      distance: path.length,
      reason: reasons.length > 0 ? reasons.join(', ') : `connected via ${admittedPath.join(' -> ')}`,
      admittedPath,
    });
  }

  return results.sort((a, b) => b.alignmentScore - a.alignmentScore);
}

/**
 * Find initiatives addressing a pain point.
 *
 * @example
 * ```typescript
 * const initiatives = await findInitiativesForPainPoint('pain-supply-chain');
 * ```
 */
export async function findInitiativesForPainPoint(painPointId: string): Promise<GraphNode[]> {
  return getNeighbors(painPointId, {
    entityTypes: ['initiative'],
    relationTypes: ['ADDRESSES', 'SOLVES'],
    limit: 50,
  });
}

// ============================================================================
// IMPACT ANALYSIS
// ============================================================================

/**
 * Analyze the business impact of a technology.
 * Shows use cases enabled and org units affected.
 *
 * @example
 * ```typescript
 * const impact = await analyzeTechnologyImpact('tech-react');
 * console.log(`Affects ${impact.orgUnits.length} org units through ${impact.useCases.length} use cases`);
 * ```
 */
export async function analyzeTechnologyImpact(
  technologyId: string,
  options: TraversalOptions = {}
): Promise<TechnologyImpact> {
  // AI-026: `getEntity` proves the id resolves to a business entity, so an
  // `:AgentObservation` id cannot be reported back as the technology under
  // analysis. A refused id lands on the same "Unknown" branch a missing one does.
  const tech = await getEntity(technologyId);

  if (!tech) {
    return {
      technology: {
        id: technologyId,
        labels: [],
        properties: { name: 'Unknown', entityType: 'technology' },
      },
      useCases: [],
      orgUnits: [],
      totalReach: 0,
    };
  }

  // Find use cases enabled by this technology
  const useCases = await findConnected(technologyId, 'useCase', {
    maxDepth: 2,
    ...options,
  });

  const useCaseResults: Array<{ useCase: GraphNode; distance: number }> = [];
  for (const uc of useCases) {
    const path = await findPath(technologyId, uc.id, { maxDepth: 2 });
    useCaseResults.push({
      useCase: uc,
      distance: path?.length || 1,
    });
  }

  // Find org units affected through use cases
  const orgUnitResults: Array<{
    orgUnit: GraphNode;
    viaUseCase: string;
    totalDistance: number;
  }> = [];

  const seenOrgUnits = new Set<string>();

  for (const ucResult of useCaseResults) {
    const affectedOrgs = await findConnected(ucResult.useCase.id, 'org_unit', {
      maxDepth: 2,
    });

    for (const org of affectedOrgs) {
      if (!seenOrgUnits.has(org.id)) {
        seenOrgUnits.add(org.id);
        const ucToOrgPath = await findPath(ucResult.useCase.id, org.id, { maxDepth: 2 });
        orgUnitResults.push({
          orgUnit: org,
          viaUseCase: String(ucResult.useCase.properties.name),
          totalDistance: ucResult.distance + (ucToOrgPath?.length || 1),
        });
      }
    }
  }

  return {
    technology: tech,
    useCases: useCaseResults.sort((a, b) => a.distance - b.distance),
    orgUnits: orgUnitResults.sort((a, b) => a.totalDistance - b.totalDistance),
    totalReach: seenOrgUnits.size,
  };
}

// ============================================================================
// VENDOR RECOMMENDATIONS
// ============================================================================

/**
 * Find vendors (companies) that provide technologies aligned with a strategy.
 *
 * @example
 * ```typescript
 * const vendors = await findVendorsForStrategy('strategy-ai-adoption');
 * vendors.forEach(v => {
 *   console.log(`${v.company.properties.name}: ${v.technologies.length} relevant technologies`);
 * });
 * ```
 */
export async function findVendorsForStrategy(
  strategyId: string,
  options: TraversalOptions = {}
): Promise<VendorRecommendation[]> {
  // First find aligned technologies
  const alignedTechs = await findTechnologiesForStrategy(strategyId, options);

  // Then find companies that provide those technologies
  const vendorMap = new Map<
    string,
    {
      company: GraphNode;
      technologies: GraphNode[];
      totalAlignment: number;
    }
  >();

  for (const tech of alignedTechs) {
    const companies = await getNeighbors(tech.technology.id, {
      entityTypes: ['company'],
      relationTypes: ['VENDOR'],
      limit: 20,
    });

    for (const company of companies) {
      const existing = vendorMap.get(company.id);
      if (existing) {
        existing.technologies.push(tech.technology);
        existing.totalAlignment += tech.alignmentScore;
      } else {
        vendorMap.set(company.id, {
          company,
          technologies: [tech.technology],
          totalAlignment: tech.alignmentScore,
        });
      }
    }
  }

  // Convert to recommendations
  const recommendations: VendorRecommendation[] = [];
  for (const [, data] of vendorMap) {
    const avgAlignment = data.totalAlignment / data.technologies.length;
    const techNames = data.technologies.map((t) => String(t.properties.name)).slice(0, 3);

    recommendations.push({
      company: data.company,
      technologies: data.technologies,
      alignmentScore: Math.round(avgAlignment),
      explanation: `Provides ${data.technologies.length} aligned technologies: ${techNames.join(', ')}${data.technologies.length > 3 ? '...' : ''}`,
    });
  }

  return recommendations.sort((a, b) => b.alignmentScore - a.alignmentScore);
}

// ============================================================================
// GAP ANALYSIS
// ============================================================================

/**
 * Analyze gaps: pain points without initiatives or solutions.
 *
 * @example
 * ```typescript
 * const gaps = await analyzeGaps();
 * gaps.forEach(g => {
 *   console.log(`${g.painPoint.properties.name}: ${g.recommendation}`);
 * });
 * ```
 */
export async function analyzeGaps(options: { orgUnitId?: string } = {}): Promise<GapAnalysis[]> {
  const service = await getGraphService();

  // If org unit specified, get its pain points; otherwise get all
  let painPoints: GraphNode[];
  if (options.orgUnitId) {
    painPoints = await findPainPointsForOrgUnit(options.orgUnitId);
  } else {
    // Scan all pain-point nodes directly. Historically this used
    // getNeighbors('*', …), but no node has id '*', so the traversal always
    // returned an empty set and analyzeGaps reported zero gaps regardless of
    // the data. A direct label scan is the correct "all pain points" query.
    const result = await service.query(
      'MATCH (p:PainPoint) RETURN p.id AS id, labels(p) AS labels, properties(p) AS properties LIMIT 100'
    );
    painPoints = result.records.map((r) => ({
      id: r.id as string,
      labels: (r.labels as string[]) ?? ['PainPoint'],
      properties: (r.properties as Record<string, unknown>) ?? {},
    }));
  }

  const gaps: GapAnalysis[] = [];

  for (const painPoint of painPoints) {
    // Check if there are initiatives addressing this pain point
    const initiatives = await findInitiativesForPainPoint(painPoint.id);
    const hasInitiative = initiatives.length > 0;

    // Check if there are technologies that solve it
    const solutions = await findSolutionsForPainPoint(painPoint.id, { maxDepth: 2 });
    const hasTechnology = solutions.length > 0;

    // Find affected org units
    const affectedOrgs = await findConnected(painPoint.id, 'org_unit', { maxDepth: 2 });

    // Determine severity and recommendation
    const severity = String(painPoint.properties.severity || 'medium');
    let recommendation: string;

    if (!hasInitiative && !hasTechnology) {
      recommendation = 'Critical gap: No initiative or technology solution. Requires immediate attention.';
    } else if (!hasInitiative) {
      recommendation = 'Has technology solutions but no active initiative. Consider starting a project.';
    } else if (!hasTechnology) {
      recommendation = 'Has initiative but no proven technology. Evaluate technology options.';
    } else {
      recommendation = 'Addressed by both initiative and technology. Monitor progress.';
    }

    gaps.push({
      painPoint,
      affectedOrgUnits: affectedOrgs,
      hasInitiative,
      hasTechnology,
      severity,
      recommendation,
    });
  }

  // Sort by severity and gap status
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  return gaps.sort((a, b) => {
    // First by whether it's a gap (no initiative and no tech)
    const aIsGap = !a.hasInitiative && !a.hasTechnology ? 0 : 1;
    const bIsGap = !b.hasInitiative && !b.hasTechnology ? 0 : 1;
    if (aIsGap !== bIsGap) return aIsGap - bIsGap;

    // Then by severity
    const aSev = severityOrder[a.severity as keyof typeof severityOrder] ?? 2;
    const bSev = severityOrder[b.severity as keyof typeof severityOrder] ?? 2;
    return aSev - bSev;
  });
}

// ============================================================================
// COMPETITIVE ANALYSIS
// ============================================================================

/**
 * Find technologies used by competitors.
 *
 * @example
 * ```typescript
 * const competitorTech = await findCompetitorTechnologies('company-competitor-a');
 * ```
 */
export async function findCompetitorTechnologies(competitorId: string): Promise<GraphNode[]> {
  return getNeighbors(competitorId, {
    entityTypes: ['technology'],
    relationTypes: ['USES', 'VENDOR'],
    limit: 50,
  });
}

/**
 * Compare technologies between our company and competitors.
 *
 * @example
 * ```typescript
 * const comparison = await compareTechnologyPortfolio('company-us', ['company-competitor-a']);
 * ```
 */
export async function compareTechnologyPortfolio(
  ourCompanyId: string,
  competitorIds: string[]
): Promise<{
  unique: GraphNode[];
  shared: GraphNode[];
  gaps: GraphNode[];
}> {
  const ourTechs = await findCompetitorTechnologies(ourCompanyId);
  const ourTechIds = new Set(ourTechs.map((t) => t.id));

  const allCompetitorTechs: GraphNode[] = [];
  const competitorTechIds = new Set<string>();

  for (const competitorId of competitorIds) {
    const techs = await findCompetitorTechnologies(competitorId);
    for (const tech of techs) {
      if (!competitorTechIds.has(tech.id)) {
        competitorTechIds.add(tech.id);
        allCompetitorTechs.push(tech);
      }
    }
  }

  // Technologies only we have
  const unique = ourTechs.filter((t) => !competitorTechIds.has(t.id));

  // Technologies we share with competitors
  const shared = ourTechs.filter((t) => competitorTechIds.has(t.id));

  // Technologies competitors have but we don't (potential gaps)
  const gaps = allCompetitorTechs.filter((t) => !ourTechIds.has(t.id));

  return { unique, shared, gaps };
}

// ============================================================================
// EXECUTIVE Q&A HELPERS
// ============================================================================

/**
 * Answer "What technologies should we invest in?"
 * Considers strategy alignment, pain point solutions, and competitor gaps.
 */
export async function recommendTechnologyInvestments(options: {
  strategyId?: string;
  orgUnitId?: string;
  competitorIds?: string[];
  limit?: number;
}): Promise<
  Array<{
    technology: GraphNode;
    score: number;
    reasons: string[];
    /**
     * GRAPH-062 — the predicate chain behind the strategy-alignment factor, so
     * a reader can tell an evidenced `ALIGNS_WITH` from a two-hop inference.
     * Absent when strategy alignment did not contribute to the score.
     */
    strategyAlignmentPath?: string[];
  }>
> {
  const scores = new Map<
    string,
    {
      technology: GraphNode;
      score: number;
      reasons: string[];
      strategyAlignmentPath?: string[];
    }
  >();

  // Factor 1: Strategy alignment
  if (options.strategyId) {
    const aligned = await findTechnologiesForStrategy(options.strategyId);
    for (const tech of aligned) {
      const existing = scores.get(tech.technology.id);
      const alignmentBonus = tech.alignmentScore * 0.4; // 40% weight
      const reason = `Aligns with strategy (${tech.alignmentScore}%) via ${tech.admittedPath.join(' -> ')}`;
      if (existing) {
        existing.score += alignmentBonus;
        existing.reasons.push(reason);
        existing.strategyAlignmentPath = tech.admittedPath;
      } else {
        scores.set(tech.technology.id, {
          technology: tech.technology,
          score: alignmentBonus,
          reasons: [reason],
          strategyAlignmentPath: tech.admittedPath,
        });
      }
    }
  }

  // Factor 2: Solves org unit pain points
  if (options.orgUnitId) {
    const painPoints = await findPainPointsForOrgUnit(options.orgUnitId);
    for (const painPoint of painPoints) {
      const solutions = await findSolutionsForPainPoint(painPoint.id, { maxDepth: 2 });
      for (const solution of solutions.slice(0, 5)) {
        // Top 5 solutions
        const existing = scores.get(solution.technology.id);
        const solutionBonus = solution.effectivenessScore * 0.35; // 35% weight
        const reason = `Solves "${painPoint.properties.name}" (${solution.effectivenessScore}%)`;
        if (existing) {
          existing.score += solutionBonus;
          existing.reasons.push(reason);
        } else {
          scores.set(solution.technology.id, {
            technology: solution.technology,
            score: solutionBonus,
            reasons: [reason],
          });
        }
      }
    }
  }

  // Factor 3: Competitor gap (they have it, we don't)
  if (options.competitorIds?.length) {
    // Would need our company ID to properly calculate, simplified here
    for (const competitorId of options.competitorIds) {
      const competitorTechs = await findCompetitorTechnologies(competitorId);
      for (const tech of competitorTechs) {
        const existing = scores.get(tech.id);
        const gapBonus = 25; // 25% weight as fixed bonus
        if (existing) {
          existing.score += gapBonus;
          existing.reasons.push('Used by competitor');
        } else {
          scores.set(tech.id, {
            technology: tech,
            score: gapBonus,
            reasons: ['Used by competitor'],
          });
        }
      }
    }
  }

  // Convert to array and sort
  const recommendations = Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit || 10);

  return recommendations;
}

/**
 * Generate an executive summary for a technology.
 */
export async function generateTechnologySummary(technologyId: string): Promise<{
  technology: GraphNode | null;
  impact: TechnologyImpact;
  alignedStrategies: Array<{ strategy: GraphNode; score: number }>;
  solvesPainPoints: Array<{ painPoint: GraphNode; effectiveness: number }>;
  providers: GraphNode[];
}> {
  const technology = await getEntity(technologyId);

  // Get impact
  const impact = await analyzeTechnologyImpact(technologyId);

  // Find aligned strategies (reverse lookup)
  const strategies = await findConnected(technologyId, 'strategy', { maxDepth: 2 });
  const alignedStrategies: Array<{ strategy: GraphNode; score: number }> = [];
  for (const strategy of strategies) {
    const path = await findPath(technologyId, strategy.id, { maxDepth: 2 });
    let score = 100;
    if (path && path.relations) {
      for (const rel of path.relations) {
        score = (score * resolveBusinessRelationConfidence(rel?.properties)) / 100;
      }
    }
    alignedStrategies.push({ strategy, score: Math.round(score) });
  }

  // Find pain points this solves
  const painPoints = await findConnected(technologyId, 'pain_point', { maxDepth: 2 });
  const solvesPainPoints: Array<{ painPoint: GraphNode; effectiveness: number }> = [];
  for (const painPoint of painPoints) {
    const path = await findPath(technologyId, painPoint.id, { maxDepth: 2 });
    let effectiveness = 100;
    if (path && path.relations) {
      for (const rel of path.relations) {
        effectiveness = (effectiveness * resolveBusinessRelationConfidence(rel?.properties)) / 100;
      }
    }
    solvesPainPoints.push({ painPoint, effectiveness: Math.round(effectiveness) });
  }

  // Find providers
  const providers = await getNeighbors(technologyId, {
    entityTypes: ['company'],
    relationTypes: ['VENDOR'],
    limit: 10,
  });

  return {
    technology,
    impact,
    alignedStrategies: alignedStrategies.sort((a, b) => b.score - a.score),
    solvesPainPoints: solvesPainPoints.sort((a, b) => b.effectiveness - a.effectiveness),
    providers,
  };
}
