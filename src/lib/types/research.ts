// ============================================================================
// RESEARCH DATA TYPES (leaf module)
// ============================================================================
// AI-generated research payloads shared by BOTH a Technology (types/entities)
// and a RadarPlacement (types/radar). Extracted here as a dependency-free leaf
// (primitives only — imports nothing) to break the types/entities <-> types/radar
// import cycle: radar and entities each import these from this leaf instead of
// from each other (ARCH-003).

/**
 * Persisted deep research data for a technology.
 * Contains comprehensive AI-generated insights from research flows.
 *
 * This data is typically populated by:
 * - AI Assistant deep research tool
 * - ScoutAgent when discovering new technologies
 * - EvaluationAgent during technology assessment
 *
 * @example
 * ```typescript
 * const deepResearch: DeepResearchData = {
 *   summary: 'React is a JavaScript library for building user interfaces...',
 *   keyInsights: [
 *     'Dominant in web development with 40%+ market share',
 *     'Strong ecosystem with Next.js, Remix, and Gatsby',
 *     'Regular release cycle with focus on performance',
 *   ],
 *   competitiveLandscape: 'Competes with Vue.js, Angular, and Svelte...',
 *   marketAnalysis: 'Growing adoption in enterprise applications...',
 *   technicalDetails: 'Virtual DOM, component-based architecture...',
 *   lastResearched: Date.now(),
 *   sources: ['https://react.dev', 'https://npmtrends.com', 'https://stateofjs.com'],
 * };
 * ```
 *
 * @phase Phase 0 Task 0.2.3
 */
export interface DeepResearchData {
  /** AI-generated executive summary of the technology (2-4 sentences). */
  summary: string;

  /** Key insights discovered during research (3-7 bullet points). */
  keyInsights: string[];

  /** Analysis of competitive technologies and market positioning. */
  competitiveLandscape?: string;

  /** Market trends, adoption rates, and business implications. */
  marketAnalysis?: string;

  /** Technical architecture, implementation details, and specifications. */
  technicalDetails?: string;

  /** Timestamp when research was last performed (milliseconds since epoch). */
  lastResearched: number;

  /** Source URLs used in the research. */
  sources: string[];
}

/**
 * Comprehensive AI-generated research data for a Technology.
 * Contains 12 research sections covering all aspects of technology assessment.
 * Populated by the comprehensive technology research flow.
 */
export interface TechnologyResearch {
  /** When research was last performed (milliseconds since epoch) */
  lastResearched: number;

  /** Research version for cache invalidation */
  version: number;

  // ========== SECTION 1: EXECUTIVE SUMMARY ==========
  /** High-level summary and key takeaways */
  executiveSummary?: {
    summary?: string;
    keyInsights?: string[];
  };

  // ========== SECTION 2: MATURITY ASSESSMENT ==========
  /** Technology maturity and adoption timeline */
  maturityAssessment?: {
    hypeCyclePosition?:
      | 'innovation-trigger'
      | 'peak-of-inflated-expectations'
      | 'trough-of-disillusionment'
      | 'slope-of-enlightenment'
      | 'plateau-of-productivity';
    timeToMainstream?: string;
    maturityTrajectory?: 'accelerating' | 'steady' | 'slowing' | 'declining';
  };

  // ========== SECTION 3: TECHNOLOGY METRICS ==========
  /** Quantitative metrics and milestones */
  technologyMetrics?: {
    category?: string;
    keyMetrics?: Array<{
      name?: string;
      value?: string;
      trend?: 'up' | 'down' | 'stable';
    }>;
    milestones?: Array<{
      date?: string;
      description?: string;
    }>;
  };

  // ========== SECTION 4: KEY PLAYERS ==========
  /** Organizations driving the technology */
  keyPlayers?: {
    marketLeaders?: Array<{
      name?: string;
      role?: string;
      marketShare?: string;
    }>;
    emergingStartups?: Array<{
      name?: string;
      focus?: string;
      funding?: string;
    }>;
    researchInstitutions?: Array<{
      name?: string;
      contribution?: string;
    }>;
    openSourceProjects?: Array<{
      name?: string;
      stars?: number;
      description?: string;
    }>;
  };

  // ========== SECTION 5: USE CASES & APPLICATIONS ==========
  /** Practical applications and examples */
  useCasesAndApplications?: {
    byMaturity?: {
      production?: string[];
      piloting?: string[];
      experimental?: string[];
    };
    byIndustry?: Array<{
      industry?: string;
      useCases?: string[];
    }>;
    byFunction?: Array<{
      function?: string;
      applications?: string[];
    }>;
    flagshipExamples?: Array<{
      company?: string;
      useCase?: string;
      outcome?: string;
    }>;
  };

  // ========== SECTION 6: TECHNICAL DEEP-DIVE ==========
  /** Technical architecture and specifications */
  technicalDeepDive?: {
    architectureOverview?: string;
    coreComponents?: Array<{
      name?: string;
      purpose?: string;
    }>;
    competingParadigms?: Array<{
      name?: string;
      comparison?: string;
    }>;
    integrationRequirements?: string[];
    standards?: string[];
    protocols?: string[];
    interoperability?: {
      level?: 'high' | 'medium' | 'low';
      details?: string;
    };
  };

  // ========== SECTION 7: VALUE ASSESSMENT ==========
  /** Business value and ROI analysis */
  valueAssessment?: {
    maturityLevel?: 1 | 2 | 3 | 4 | 5;
    primaryValueDrivers?: string[];
    quantifiedBenefits?: Array<{
      benefit?: string;
      metric?: string;
    }>;
    evidenceLevel?: 'strong' | 'moderate' | 'limited' | 'anecdotal';
    roiAssessable?: boolean;
    typicalROI?: string;
    timeToValue?: string;
    paybackPeriod?: string;
    roiConfidence?: 'high' | 'medium' | 'low';
    strategicValue?: 'transformational' | 'significant' | 'incremental' | 'marginal';
    competitiveAdvantageType?: 'differentiation' | 'cost-leadership' | 'operational-excellence' | 'none';
  };

  // ========== SECTION 8: RISKS & BARRIERS ==========
  /** Adoption risks and implementation barriers */
  risksAndBarriers?: {
    technicalBarriers?: string[];
    adoptionBarriers?: string[];
    implementationChallenges?: string[];
    vendorLockInRisk?: 'high' | 'medium' | 'low';
    obsolescenceRisk?: 'high' | 'medium' | 'low';
    securityConsiderations?: string[];
  };

  // ========== SECTION 9: INVESTMENT LANDSCAPE ==========
  /** Funding and investment activity */
  investmentLandscape?: {
    vcActivityLevel?: 'very-high' | 'high' | 'moderate' | 'low' | 'minimal';
    governmentFunding?: {
      level?: 'significant' | 'moderate' | 'limited' | 'none';
      details?: string;
    };
    corporateRnD?: {
      level?: 'heavy' | 'moderate' | 'light' | 'minimal';
      majorPlayers?: string[];
    };
    totalFundingLast12Months?: string;
    notableFundingRounds?: Array<{
      company?: string;
      amount?: string;
      date?: string;
    }>;
    mnAActivity?: {
      level?: 'active' | 'moderate' | 'quiet';
      notableDeals?: string[];
    };
    investmentTrend?: 'accelerating' | 'stable' | 'declining';
  };

  // ========== SECTION 10: REGULATORY & COMPLIANCE ==========
  /** Regulatory landscape and compliance requirements */
  regulatoryAndCompliance?: {
    relevantRegulations?: string[];
    industryStandards?: string[];
    complianceRequirements?: string[];
    geopoliticalConsiderations?: string[];
    regulatoryTrajectory?: 'tightening' | 'stable' | 'loosening' | 'uncertain';
    upcomingRegulations?: Array<{
      name?: string;
      expectedDate?: string;
      impact?: string;
    }>;
  };

  // ========== SECTION 11: TALENT & SKILLS ==========
  /** Workforce and skills requirements */
  talentAndSkills?: {
    requiredCompetencies?: string[];
    talentAvailability?: 'abundant' | 'adequate' | 'limited' | 'scarce';
    trainingRequirements?: {
      timeToCompetency?: string;
      complexity?: 'high' | 'medium' | 'low';
    };
    certifications?: string[];
    buildVsBuy?: {
      recommendation?: 'build' | 'buy' | 'hybrid';
      rationale?: string;
    };
    talentCostIndicator?: 'premium' | 'above-average' | 'average' | 'below-average';
  };

  // ========== SECTION 12: FUTURE OUTLOOK ==========
  /** Predictions and future trends */
  futureOutlook?: {
    emergingTrends?: string[];
    predictedDevelopments?: Array<{
      timeframe?: string;
      prediction?: string;
    }>;
    convergenceOpportunities?: Array<{
      technology?: string;
      opportunity?: string;
    }>;
    watchSignals?: string[];
    disruptionPotential?: 'high' | 'medium' | 'low';
  };

  // ========== METADATA ==========
  /** Research sources and confidence */
  metadata?: {
    sources?: string[];
    confidenceScore?: number;
    model?: string;
    /** Epoch ms when an enrichment/expansion was last queued — used to skip
     * re-enriching an in-flight signal (no double token spend on rapid re-likes). */
    expansionQueuedAt?: number;
    /**
     * TEST-022 — present only when the payload was trimmed to fit the Firestore
     * document budget. Its absence means nothing was removed, so a reader can
     * distinguish a genuinely short research result from a truncated one.
     */
    bounded?: {
      originalBytes: number;
      finalBytes: number;
      sourcesDropped: number;
      sectionsDropped: string[];
      /** Added after the initial TEST-022 receipt; absent on older documents. */
      executiveSummaryTruncated?: boolean;
    };
    /**
     * TEST-022 — provider usage for this research run. Follows the AI-029
     * fail-closed rule: when a model's pricing is unlisted, `costUsd` is absent
     * and `costUnavailableReason` says why. A cost is never invented.
     */
    usage?: {
      model?: string;
      requestId?: string;
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
      costUnavailableReason?: string;
    };
  };
}
