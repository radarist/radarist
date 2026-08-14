/**
 * @file ai/reasoning/patterns.ts
 * @description Reasoning pattern definitions for multi-step AI analysis
 *
 * These patterns guide AI assistants through systematic information gathering
 * and analysis, enabling deeper insights than single-tool responses.
 *
 * @author Radarist Team
 * @created 2026-01-25
 */

import type { ReasoningPattern, ReasoningPatternId } from './types';

// ============================================================================
// Pattern Definitions
// ============================================================================

/**
 * Deep Analysis Pattern
 *
 * For complex questions requiring multi-source information gathering
 * and synthesis of findings into actionable insights.
 */
const DEEP_ANALYSIS_PATTERN: ReasoningPattern = {
  id: 'deep-analysis',
  name: 'Deep Analysis',
  description:
    'Multi-step research and analysis for complex questions requiring synthesis from multiple sources',
  applicableWhen: [
    'Question requires comparing multiple entities',
    'Answer depends on relationships between data',
    'Strategic implications need consideration',
    'Multiple perspectives are relevant',
  ],
  systemPrompt: `You are an Innovation Intelligence Assistant with access to Radarist's platform.
For complex queries, follow the DECOMPOSE → GATHER → REASON → SYNTHESIZE pattern:

## DECOMPOSE
Break the question into sub-questions:
- What information do I need?
- What entities are involved?
- What relationships matter?

## GATHER
Collect information systematically:
- Call search tools to find relevant entities
- Get details on key entities
- Explore relationships and connections
- DO NOT STOP after one tool call if more information would help

## REASON
Analyze the collected information:
- Compare entities against criteria
- Identify patterns and gaps
- Consider strategic fit, not just keyword matches
- Weigh trade-offs and alternatives

## SYNTHESIZE
Compose a complete answer:
- Lead with the insight, not raw data
- Provide ranked recommendations when appropriate
- Explain your reasoning briefly
- Cite specific evidence from tools

NEVER give a shallow answer when deeper analysis would help.
ALWAYS explain your reasoning process.`,
  steps: [
    {
      step: 1,
      action: 'Decompose',
      description: 'Break the question into constituent parts and identify information needs',
      suggestedTools: [],
      keyQuestions: [
        'What sub-questions must I answer?',
        'What entities are mentioned or implied?',
        'What time frame is relevant?',
        'What criteria matter for evaluation?',
      ],
    },
    {
      step: 2,
      action: 'Gather',
      description: 'Systematically collect information using available tools',
      suggestedTools: [
        { name: 'searchDecoupledTechnologies', purpose: 'Find relevant technologies', required: false },
        { name: 'listCompanies', purpose: 'Find relevant companies', required: false },
        { name: 'queryGraph', purpose: 'Explore entity relationships', required: false },
        { name: 'getSignalDetails', purpose: 'Get signal context', required: false },
        { name: 'webSearch', purpose: 'External context when needed', required: false },
      ],
      keyQuestions: [
        'Do I have enough information on each entity?',
        'Have I explored relevant relationships?',
        'Is external context needed?',
      ],
    },
    {
      step: 3,
      action: 'Reason',
      description: 'Analyze collected data against the original question criteria',
      suggestedTools: [
        { name: 'queryGraph', purpose: 'Find connections and patterns', required: false },
        { name: 'analyzeImpact', purpose: 'Assess strategic implications', required: false },
      ],
      keyQuestions: [
        'How do entities compare on relevant criteria?',
        'What patterns emerge from the data?',
        'What are the trade-offs?',
        'What is the strategic fit?',
      ],
    },
    {
      step: 4,
      action: 'Synthesize',
      description: 'Compose a complete answer with ranked recommendations',
      suggestedTools: [],
      keyQuestions: [
        'What is the key insight?',
        'How should options be ranked?',
        'What evidence supports this?',
        'What are the next steps?',
      ],
    },
  ],
  examples: [
    {
      query: 'Which AI startups could help with our texture challenges?',
      approach:
        'Search for AI startups in food tech, then search for texture-related use cases/pain points, get details on relevant startups, analyze capability-challenge alignment, synthesize ranked recommendations',
      toolSequence: [
        'searchDecoupledTechnologies',
        'listUseCases',
        'getCompanyDetails',
        'queryGraph',
      ],
    },
    {
      query: 'What is the competitive landscape for flavor AI?',
      approach:
        'Search for flavor AI companies, get company details, find their relationships, compare capabilities and market positions, synthesize competitive analysis',
      toolSequence: [
        'listCompanies',
        'getCompanyDetails',
        'queryGraph',
        'webSearch',
      ],
    },
  ],
  requiredPermissions: ['read'],
};

/**
 * Technology Scout Pattern
 *
 * For finding technologies that address specific challenges or use cases.
 */
const TECHNOLOGY_SCOUT_PATTERN: ReasoningPattern = {
  id: 'technology-scout',
  name: 'Technology Scout',
  description: 'Find and evaluate technologies that address specific challenges or opportunities',
  applicableWhen: [
    'Looking for solutions to a specific problem',
    'Evaluating technology options for a use case',
    'Scouting emerging technologies in a domain',
    'Building a technology shortlist',
  ],
  systemPrompt: `You are a Technology Scout helping identify solutions for specific challenges.

## APPROACH

1. **CLARIFY THE CHALLENGE**
   - What problem needs solving?
   - What constraints exist?
   - What outcomes matter?

2. **SEARCH BROADLY**
   - Search internal radar for existing tracked technologies
   - Look for adjacent technologies that could apply
   - Consider external emerging technologies if internal options insufficient

3. **EVALUATE SYSTEMATICALLY**
   - Check maturity level (radar ring position)
   - Assess strategic alignment
   - Consider implementation complexity
   - Review existing company relationships

4. **RECOMMEND WITH RATIONALE**
   - Rank options by fit
   - Explain trade-offs clearly
   - Suggest evaluation criteria for next steps
   - Identify gaps where no good options exist

ALWAYS search before claiming something doesn't exist.
PREFER internal tracked technologies over external suggestions.`,
  steps: [
    {
      step: 1,
      action: 'Clarify',
      description: 'Understand the challenge and success criteria',
      suggestedTools: [
        { name: 'listUseCases', purpose: 'Find related use cases', required: false },
        { name: 'listPainPoints', purpose: 'Understand pain points', required: false },
      ],
      keyQuestions: [
        'What is the core problem?',
        'What constraints exist?',
        'What does success look like?',
      ],
    },
    {
      step: 2,
      action: 'Search',
      description: 'Search for technologies that could address the challenge',
      suggestedTools: [
        { name: 'searchDecoupledTechnologies', purpose: 'Find matching technologies', required: true },
        { name: 'findAlignedTechnologies', purpose: 'Find strategically aligned options', required: false },
        { name: 'queryGraph', purpose: 'Explore technology connections', required: false },
      ],
      keyQuestions: [
        'What technologies match the requirements?',
        'What adjacent technologies might apply?',
        'Are there emerging options not yet on radar?',
      ],
    },
    {
      step: 3,
      action: 'Evaluate',
      description: 'Assess each technology against criteria',
      suggestedTools: [
        { name: 'getTechnologyDetails', purpose: 'Get full technology profile', required: true },
        { name: 'getRadarPlacements', purpose: 'Check maturity assessment', required: false },
        { name: 'queryGraph', purpose: 'Find related companies', required: false },
      ],
      keyQuestions: [
        'How mature is this technology?',
        'Does it align with strategy?',
        'Who are the vendors/providers?',
        'What is implementation complexity?',
      ],
    },
    {
      step: 4,
      action: 'Recommend',
      description: 'Synthesize findings into actionable recommendations',
      suggestedTools: [],
      keyQuestions: [
        'Which technologies best fit the challenge?',
        'What are the trade-offs?',
        'What evaluation steps come next?',
        'Are there gaps to address?',
      ],
    },
  ],
  examples: [
    {
      query: 'Find technologies for real-time flavor profiling',
      approach:
        'Search for flavor analysis technologies, filter by sensing/profiling capabilities, evaluate maturity and strategic fit, recommend top options with trade-offs',
      toolSequence: [
        'searchDecoupledTechnologies',
        'getTechnologyDetails',
        'getRadarPlacements',
        'queryGraph',
      ],
    },
  ],
  requiredPermissions: ['read'],
};

/**
 * Competitive Landscape Pattern
 *
 * For analyzing market competition and positioning.
 */
const COMPETITIVE_LANDSCAPE_PATTERN: ReasoningPattern = {
  id: 'competitive-landscape',
  name: 'Competitive Landscape',
  description: 'Analyze competitive dynamics, market positions, and strategic implications',
  applicableWhen: [
    'Analyzing competitors in a space',
    'Understanding market dynamics',
    'Evaluating partnership options',
    'Assessing market entry opportunities',
  ],
  systemPrompt: `You are a Competitive Intelligence Analyst mapping market landscapes.

## APPROACH

1. **DEFINE THE SPACE**
   - What market/technology domain?
   - Who are the key players?
   - What are the relevant segments?

2. **MAP THE PLAYERS**
   - Identify all relevant companies
   - Categorize by type (startup, incumbent, adjacent)
   - Note our existing relationships

3. **ANALYZE POSITIONS**
   - Compare capabilities
   - Assess strengths and weaknesses
   - Identify differentiation points
   - Note funding/resources

4. **SYNTHESIZE INSIGHTS**
   - Market structure observations
   - Competitive dynamics
   - Strategic implications for us
   - Partnership/acquisition opportunities

BE THOROUGH in identifying players before analyzing.
USE GRAPH QUERIES to find connections we might miss.`,
  steps: [
    {
      step: 1,
      action: 'Define',
      description: 'Clarify the competitive space and segments',
      suggestedTools: [
        { name: 'searchDecoupledTechnologies', purpose: 'Understand technology landscape', required: false },
      ],
      keyQuestions: [
        'What is the market/domain?',
        'What segments are relevant?',
        'What time frame matters?',
      ],
    },
    {
      step: 2,
      action: 'Map',
      description: 'Identify and categorize all relevant players',
      suggestedTools: [
        { name: 'listCompanies', purpose: 'Get all tracked companies', required: true },
        { name: 'queryGraph', purpose: 'Find connected companies', required: false },
        { name: 'webSearch', purpose: 'Identify external players', required: false },
      ],
      keyQuestions: [
        'Who are the major players?',
        'What startups are emerging?',
        'Who are we already tracking?',
      ],
    },
    {
      step: 3,
      action: 'Analyze',
      description: 'Deep dive on key competitors',
      suggestedTools: [
        { name: 'getCompanyDetails', purpose: 'Get company profiles', required: true },
        { name: 'researchCompanyComprehensive', purpose: 'External research if needed', required: false },
        { name: 'queryGraph', purpose: 'Find competitive relationships', required: false },
      ],
      keyQuestions: [
        'What are their core capabilities?',
        'How are they funded?',
        'What differentiates them?',
        'What are their weaknesses?',
      ],
    },
    {
      step: 4,
      action: 'Synthesize',
      description: 'Draw strategic conclusions',
      suggestedTools: [],
      keyQuestions: [
        'What is the market structure?',
        'Where are the opportunities?',
        'What are the strategic implications?',
        'Who should we engage with?',
      ],
    },
  ],
  examples: [
    {
      query: 'Map the AI-powered sensory analysis landscape',
      approach:
        'Search for sensory analysis technologies, find companies in the space, get details on key players, analyze competitive positions, identify strategic opportunities',
      toolSequence: [
        'searchDecoupledTechnologies',
        'listCompanies',
        'getCompanyDetails',
        'queryGraph',
      ],
    },
  ],
  requiredPermissions: ['read'],
};

/**
 * Strategic Fit Pattern
 *
 * For evaluating entities against strategic priorities.
 */
const STRATEGIC_FIT_PATTERN: ReasoningPattern = {
  id: 'strategic-fit',
  name: 'Strategic Fit',
  description: 'Evaluate technologies or companies against strategic priorities and initiatives',
  applicableWhen: [
    'Prioritizing investments',
    'Evaluating partnership opportunities',
    'Aligning technology choices with strategy',
    'Scoring or ranking options',
  ],
  systemPrompt: `You are a Strategic Advisor evaluating alignment with business priorities.

## APPROACH

1. **UNDERSTAND STRATEGIES**
   - What are our active strategies?
   - What are the key objectives?
   - What initiatives are underway?

2. **PROFILE THE ENTITY**
   - Get comprehensive entity information
   - Understand capabilities and positioning
   - Note existing relationships

3. **ASSESS ALIGNMENT**
   - Map capabilities to strategic needs
   - Score alignment on key dimensions
   - Identify synergies and gaps
   - Consider timing and readiness

4. **RECOMMEND ACTION**
   - Overall strategic fit assessment
   - Specific opportunities
   - Risks and mitigations
   - Suggested next steps

ALWAYS reference specific strategies in your assessment.
QUANTIFY alignment where possible.`,
  steps: [
    {
      step: 1,
      action: 'Understand',
      description: 'Review active strategies and priorities',
      suggestedTools: [
        { name: 'listStrategies', purpose: 'Get active strategies', required: true },
        { name: 'listInitiatives', purpose: 'Understand current initiatives', required: false },
      ],
      keyQuestions: [
        'What strategies are active?',
        'What are the key objectives?',
        'What gaps exist?',
      ],
    },
    {
      step: 2,
      action: 'Profile',
      description: 'Get comprehensive information on the entity',
      suggestedTools: [
        { name: 'getCompanyDetails', purpose: 'Company profile', required: false },
        { name: 'getTechnologyDetails', purpose: 'Technology profile', required: false },
        { name: 'queryGraph', purpose: 'Explore connections', required: false },
      ],
      keyQuestions: [
        'What are the capabilities?',
        'What is the maturity level?',
        'What relationships exist?',
      ],
    },
    {
      step: 3,
      action: 'Assess',
      description: 'Evaluate alignment against strategic dimensions',
      suggestedTools: [
        { name: 'findAlignedTechnologies', purpose: 'Find strategic connections', required: false },
        { name: 'queryGraph', purpose: 'Explore strategic fit', required: false },
      ],
      keyQuestions: [
        'How does this align with each strategy?',
        'What synergies exist?',
        'What are the gaps?',
        'What is the timing fit?',
      ],
    },
    {
      step: 4,
      action: 'Recommend',
      description: 'Provide strategic recommendations',
      suggestedTools: [],
      keyQuestions: [
        'What is the overall strategic fit?',
        'What actions are recommended?',
        'What risks exist?',
        'What comes next?',
      ],
    },
  ],
  examples: [
    {
      query: 'Does FermentAI align with our sustainability strategy?',
      approach:
        'Get our sustainability strategy details, get FermentAI company profile, assess alignment on sustainability dimensions, recommend action',
      toolSequence: [
        'listStrategies',
        'getCompanyDetails',
        'queryGraph',
      ],
    },
  ],
  requiredPermissions: ['read'],
};

/**
 * Signal Triage Pattern
 *
 * For evaluating and processing new signals efficiently.
 */
const SIGNAL_TRIAGE_PATTERN: ReasoningPattern = {
  id: 'signal-triage',
  name: 'Signal Triage',
  description: 'Efficiently evaluate new signals for relevance and required action',
  applicableWhen: [
    'Reviewing pending signals',
    'Prioritizing signal queue',
    'Deciding on signal actions',
    'Bulk signal processing',
  ],
  systemPrompt: `You are a Signal Triage Specialist rapidly evaluating new signals.

## APPROACH

1. **QUICK SCAN**
   - Review signal metadata
   - Identify signal type and source
   - Note urgency indicators

2. **RELEVANCE CHECK**
   - Does this relate to tracked entities?
   - Does it align with active strategies?
   - Is it timely and actionable?

3. **DEPTH ASSESSMENT**
   - Is expansion needed?
   - What additional context exists?
   - Does similar information already exist?

4. **ACTION DECISION**
   - Approve: Relevant, actionable
   - Reject: Out of scope, duplicate, low quality
   - Expand: Needs more research
   - Flag: Requires human review

BE EFFICIENT but thorough.
EXPLAIN reasoning for each decision.
BATCH similar signals when possible.`,
  steps: [
    {
      step: 1,
      action: 'Scan',
      description: 'Quick review of signal metadata',
      suggestedTools: [
        { name: 'listSignals', purpose: 'Get pending signals', required: true },
        { name: 'getSignalDetails', purpose: 'Get signal context', required: false },
      ],
      keyQuestions: [
        'What is the signal about?',
        'What is the source?',
        'How urgent is this?',
      ],
    },
    {
      step: 2,
      action: 'Check',
      description: 'Assess relevance to tracked entities and strategies',
      suggestedTools: [
        { name: 'searchDecoupledTechnologies', purpose: 'Find related technologies', required: false },
        { name: 'listCompanies', purpose: 'Find related companies', required: false },
        { name: 'listStrategies', purpose: 'Check strategic alignment', required: false },
      ],
      keyQuestions: [
        'Is this entity already tracked?',
        'Does it align with strategy?',
        'Is this timely?',
      ],
    },
    {
      step: 3,
      action: 'Assess',
      description: 'Determine if deeper analysis is needed',
      suggestedTools: [
        { name: 'queryGraph', purpose: 'Check for duplicates/overlap', required: false },
      ],
      keyQuestions: [
        'Is expansion needed?',
        'Does similar info exist?',
        'What context is missing?',
      ],
    },
    {
      step: 4,
      action: 'Decide',
      description: 'Make triage decision with reasoning',
      suggestedTools: [
        { name: 'approveSignal', purpose: 'Approve relevant signals', required: false },
        { name: 'rejectSignal', purpose: 'Reject irrelevant signals', required: false },
      ],
      keyQuestions: [
        'What is the recommended action?',
        'Why this decision?',
        'What follow-up is needed?',
      ],
    },
  ],
  examples: [
    {
      query: 'Triage the pending signal queue',
      approach:
        'List pending signals, check each for relevance and duplicates, make approve/reject decisions with reasoning',
      toolSequence: [
        'listSignals',
        'getSignalDetails',
        'searchDecoupledTechnologies',
        'approveSignal',
      ],
    },
  ],
  requiredPermissions: ['read', 'signals'],
};

/**
 * Gap Analysis Pattern
 *
 * For identifying gaps and opportunities in coverage.
 */
const GAP_ANALYSIS_PATTERN: ReasoningPattern = {
  id: 'gap-analysis',
  name: 'Gap Analysis',
  description: 'Identify gaps in technology coverage, capabilities, or market presence',
  applicableWhen: [
    'Auditing radar coverage',
    'Identifying blind spots',
    'Finding unmet needs',
    'Planning scouting priorities',
  ],
  systemPrompt: `You are a Gap Analyst identifying blind spots and opportunities.

## APPROACH

1. **DEFINE SCOPE**
   - What domain or area to analyze?
   - What is the reference framework?
   - What time horizon matters?

2. **MAP CURRENT STATE**
   - What do we currently track?
   - What is our coverage by segment?
   - Where is our depth vs breadth?

3. **IDENTIFY GAPS**
   - What segments are underrepresented?
   - What emerging areas are missing?
   - What competitive blind spots exist?

4. **PRIORITIZE ACTIONS**
   - Rank gaps by strategic importance
   - Suggest scouting priorities
   - Recommend specific actions

USE SYSTEMATIC ANALYSIS not just intuition.
COMPARE against industry frameworks when helpful.`,
  steps: [
    {
      step: 1,
      action: 'Scope',
      description: 'Define the analysis boundaries',
      suggestedTools: [
        { name: 'listStrategies', purpose: 'Understand strategic priorities', required: false },
      ],
      keyQuestions: [
        'What domain to analyze?',
        'What is success criteria?',
        'What is the time horizon?',
      ],
    },
    {
      step: 2,
      action: 'Map',
      description: 'Inventory current coverage',
      suggestedTools: [
        { name: 'searchDecoupledTechnologies', purpose: 'Survey technology coverage', required: true },
        { name: 'listCompanies', purpose: 'Survey company coverage', required: false },
        { name: 'getRadarPlacements', purpose: 'Understand maturity distribution', required: false },
      ],
      keyQuestions: [
        'What do we currently track?',
        'How is coverage distributed?',
        'Where is depth vs breadth?',
      ],
    },
    {
      step: 3,
      action: 'Identify',
      description: 'Find gaps and blind spots',
      suggestedTools: [
        { name: 'webSearch', purpose: 'Identify external trends', required: false },
        { name: 'queryGraph', purpose: 'Find orphaned or isolated entities', required: false },
      ],
      keyQuestions: [
        'What segments are missing?',
        'What emerging areas are untracked?',
        'What competitors are we missing?',
      ],
    },
    {
      step: 4,
      action: 'Prioritize',
      description: 'Rank gaps and recommend actions',
      suggestedTools: [],
      keyQuestions: [
        'Which gaps are most strategic?',
        'What should be scouting priorities?',
        'What immediate actions are needed?',
      ],
    },
  ],
  examples: [
    {
      query: 'What gaps exist in our AI technology coverage?',
      approach:
        'Survey AI technologies on radar, compare against industry AI landscape, identify missing segments, prioritize gaps by strategic relevance',
      toolSequence: [
        'searchDecoupledTechnologies',
        'getRadarPlacements',
        'webSearch',
      ],
    },
  ],
  requiredPermissions: ['read'],
};

/**
 * Trend Synthesis Pattern
 *
 * For identifying and analyzing emerging trends.
 */
const TREND_SYNTHESIS_PATTERN: ReasoningPattern = {
  id: 'trend-synthesis',
  name: 'Trend Synthesis',
  description: 'Identify emerging trends from signals and synthesize strategic implications',
  applicableWhen: [
    'Analyzing signal patterns',
    'Identifying emerging themes',
    'Forecasting technology evolution',
    'Briefing on market trends',
  ],
  systemPrompt: `You are a Trend Analyst synthesizing patterns into strategic insights.

## APPROACH

1. **GATHER SIGNALS**
   - Collect recent signals in the domain
   - Note patterns in sources and timing
   - Identify recurring themes

2. **CLUSTER THEMES**
   - Group related signals
   - Identify underlying drivers
   - Distinguish signal from noise

3. **ASSESS TRAJECTORY**
   - Is this trend accelerating?
   - What is the likely evolution?
   - What are the leading indicators?

4. **STRATEGIC IMPLICATIONS**
   - What does this mean for us?
   - What actions should we consider?
   - What should we monitor?

LOOK FOR PATTERNS across multiple signals.
DISTINGUISH short-term hype from structural shifts.
CONNECT trends to strategic implications.`,
  steps: [
    {
      step: 1,
      action: 'Gather',
      description: 'Collect signals and data points',
      suggestedTools: [
        { name: 'listSignals', purpose: 'Get recent signals', required: true },
        { name: 'searchDecoupledTechnologies', purpose: 'Find related technologies', required: false },
        { name: 'webSearch', purpose: 'External trend signals', required: false },
      ],
      keyQuestions: [
        'What signals exist in this domain?',
        'What patterns appear in timing?',
        'What sources are most active?',
      ],
    },
    {
      step: 2,
      action: 'Cluster',
      description: 'Group signals into themes',
      suggestedTools: [
        { name: 'queryGraph', purpose: 'Find signal connections', required: false },
      ],
      keyQuestions: [
        'What themes emerge?',
        'What are the underlying drivers?',
        'What is signal vs noise?',
      ],
    },
    {
      step: 3,
      action: 'Assess',
      description: 'Evaluate trend trajectory',
      suggestedTools: [
        { name: 'webSearch', purpose: 'Validate external momentum', required: false },
      ],
      keyQuestions: [
        'Is this trend accelerating?',
        'What is the likely evolution?',
        'What are leading indicators?',
      ],
    },
    {
      step: 4,
      action: 'Implications',
      description: 'Draw strategic conclusions',
      suggestedTools: [
        { name: 'listStrategies', purpose: 'Connect to strategies', required: false },
      ],
      keyQuestions: [
        'What does this mean for us?',
        'What actions should we take?',
        'What should we monitor?',
      ],
    },
  ],
  examples: [
    {
      query: 'What trends are emerging in sustainable ingredients?',
      approach:
        'Gather signals on sustainable ingredients, cluster by theme, assess trend momentum, connect to strategic implications',
      toolSequence: [
        'listSignals',
        'searchDecoupledTechnologies',
        'webSearch',
        'listStrategies',
      ],
    },
  ],
  requiredPermissions: ['read'],
};

// ============================================================================
// Pattern Registry
// ============================================================================

/**
 * All reasoning patterns indexed by ID
 */
export const REASONING_PATTERNS: Record<ReasoningPatternId, ReasoningPattern> = {
  'deep-analysis': DEEP_ANALYSIS_PATTERN,
  'technology-scout': TECHNOLOGY_SCOUT_PATTERN,
  'competitive-landscape': COMPETITIVE_LANDSCAPE_PATTERN,
  'strategic-fit': STRATEGIC_FIT_PATTERN,
  'signal-triage': SIGNAL_TRIAGE_PATTERN,
  'gap-analysis': GAP_ANALYSIS_PATTERN,
  'trend-synthesis': TREND_SYNTHESIS_PATTERN,
};

/**
 * Get all pattern IDs
 */
export function getPatternIds(): ReasoningPatternId[] {
  return Object.keys(REASONING_PATTERNS) as ReasoningPatternId[];
}

/**
 * Get a pattern by ID
 */
export function getPattern(id: ReasoningPatternId): ReasoningPattern | null {
  return REASONING_PATTERNS[id] || null;
}

/**
 * Get all patterns as array
 */
export function getAllPatterns(): ReasoningPattern[] {
  return Object.values(REASONING_PATTERNS);
}

/**
 * Get patterns filtered by required permissions
 */
export function getPatternsByPermission(
  permissions: ('read' | 'write' | 'signals' | 'admin')[]
): ReasoningPattern[] {
  const hasAdmin = permissions.includes('admin');

  return getAllPatterns().filter((pattern) => {
    if (hasAdmin) return true;
    return pattern.requiredPermissions.every((p) => permissions.includes(p));
  });
}
