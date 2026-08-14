/**
 * @file lib/signals/expansion-prompts.ts
 * @description Prompt templates for signal expansion (Phase 4.2)
 *
 * Generates prompts for LLM to expand signals with:
 * - Deep entity analysis (company/technology/trend profiles)
 * - Strategic alignment assessment
 * - Actionable recommendations
 * - Related item discovery
 *
 * @author Radarist Team
 * @created 2025-11-26
 */

import type { Signal } from '@/lib/types';

/**
 * Strategy context for expansion
 */
export interface StrategyContext {
  id: string;
  name: string;
  description?: string;
  mainDirectives?: Array<{
    directive: string;
    priority?: string;
  }>;
}

/**
 * Generate expansion prompt for a signal
 *
 * @param signal - The signal to expand
 * @param strategies - Available strategies for alignment
 * @returns Formatted prompt for LLM
 */
export function getExpansionPrompt(
  signal: Signal,
  strategies: StrategyContext[]
): string {
  const strategyContext = formatStrategiesForPrompt(strategies);

  return `You are an innovation intelligence analyst expanding a detected signal with deep research and strategic insights.

# SIGNAL TO ANALYZE

**Title:** ${signal.title}
**Description:** ${signal.description}
**Source:** ${signal.source} (${signal.type})
**URL:** ${signal.url}
**AI Summary:** ${signal.aiSummary}

${signal.metadata ? `**Additional Context:** ${JSON.stringify(signal.metadata, null, 2)}` : ''}

# YOUR TASK

Expand this signal with comprehensive analysis and actionable intelligence. Return a JSON object with the following structure:

\`\`\`json
{
  "entityProfile": {
    "type": "company" | "technology" | "trend",
    "summary": "2-3 sentence overview of the entity",
    "keyFacts": ["Fact 1", "Fact 2", "Fact 3+"],
    "recentDevelopments": ["Development 1", "Development 2+"],
    "keyPlayers": ["Player 1", "Player 2+"] (optional),
    "maturityAssessment": "Assessment of technology/market maturity" (optional)
  },
  "strategicAnalysis": {
    "alignedStrategies": [
      {
        "strategyId": "strategy-id",
        "strategyName": "Strategy Name",
        "alignmentScore": 85,
        "alignmentReason": "Why this signal aligns with this strategy"
      }
    ],
    "radarImpact": "How this affects our technology radar",
    "competitiveImplications": "Competitive advantages or threats",
    "opportunityOrThreat": "opportunity" | "threat" | "neutral"
  },
  "recommendations": {
    "suggestedNextSteps": ["Action 1", "Action 2+"],
    "questionsForInvestigation": ["Question 1", "Question 2+"],
    "suggestedRadarPlacement": {
      "quadrant": "Quadrant name",
      "ring": "Ring name (Adopt/Trial/Assess/Hold)",
      "rationale": "Why this placement makes sense"
    }
  },
  "relatedItems": {
    "technologies": [{"id": "tech-id", "name": "Tech Name", "relevance": "Why related"}],
    "companies": [{"id": "company-id", "name": "Company Name", "relevance": "Why related"}],
    "signals": [{"id": "signal-id", "title": "Signal Title", "relevance": "Why related"}]
  },
  "sources": [
    {
      "title": "Source title",
      "url": "https://...",
      "verdict": "confirming" | "contradicting" | "inconclusive",
      "description": "Brief description of what this source provides" (optional),
      "date": "Publication date if available" (optional)
    }
  ] (Include 3-5 relevant sources used for this analysis)
}
\`\`\`

# STRATEGIC CONTEXT

${strategyContext}

# ANALYSIS GUIDELINES

## Entity Profile
- Identify whether this is primarily about a company, technology, or market trend
- Provide factual, verifiable information
- Focus on recent developments (last 6-12 months)
- Include key players/competitors if relevant
- Assess maturity level (emerging, growing, mature, declining)

## Strategic Analysis
- Review each strategy and determine alignment (0-100 score)
- Only include strategies with alignment > 50
- Explain WHY each aligned strategy is relevant
- Consider both opportunities and threats
- Think about impact on existing radar technologies

## Recommendations
- Suggest 3-5 concrete next steps
- Frame as actionable items (start with verbs)
- Include questions that need answering
- Suggest radar placement based on maturity and strategic fit
- Use standard quadrants: Techniques, Tools, Platforms, Languages & Frameworks
- Use standard rings: Adopt, Trial, Assess, Hold

## Related Items
- Suggest IDs for existing technologies, companies, or signals that relate
- Use format: "tech-{name}", "company-{name}", "signal-{id}"
- Explain the relationship briefly
- Focus on strong connections only

## Evidence Sources
- Include only pages actually consulted through web search; never invent a URL
- Classify each page relative to the signal's central claim as "confirming", "contradicting", or "inconclusive"
- Related companies, technologies, and linked entities are context, not independent evidence
- Contradicting and inconclusive pages must be retained and classified honestly, not presented as corroboration

# IMPORTANT
- Return ONLY valid JSON (no markdown, no extra text)
- Be specific and actionable
- Base analysis on available information + web search results
- If uncertain, indicate this in your reasoning
- Prioritize quality over quantity

Generate the expanded analysis now:`;
}

/**
 * Format strategies for inclusion in prompt
 */
function formatStrategiesForPrompt(strategies: StrategyContext[]): string {
  if (strategies.length === 0) {
    return 'No strategic directives available. Focus on general innovation value.';
  }

  return strategies
    .map((strategy, index) => {
      const directives = strategy.mainDirectives
        ?.map((d) => `  - [${d.priority}] ${d.directive}`)
        .join('\n');

      return `
## Strategy ${index + 1}: ${strategy.name}
${strategy.description || 'No description provided'}

**Key Directives:**
${directives || '  - No specific directives'}
`;
    })
    .join('\n');
}

/**
 * Generate a simplified expansion prompt for low-priority signals
 * (faster, less detailed)
 */
export function getQuickExpansionPrompt(signal: Signal): string {
  return `Analyze this innovation signal and provide a brief strategic assessment.

**Signal:** ${signal.title}
**Description:** ${signal.description}
**Source:** ${signal.source}

Return JSON with:
1. "summary": 2-3 sentence overview
2. "keyInsights": Array of 2-3 key insights
3. "recommendedAction": Single recommended next step
4. "opportunityOrThreat": "opportunity", "threat", or "neutral"

Return ONLY valid JSON.`;
}

/**
 * Generate prompt for re-expansion (when signal data has changed)
 */
export function getReExpansionPrompt(
  signal: Signal,
  previousExpansion: Record<string, unknown>,
  changeReason: string
): string {
  return `Update the expansion analysis for this signal based on new information.

**Signal:** ${signal.title}
**Change Reason:** ${changeReason}

**Previous Analysis:**
${JSON.stringify(previousExpansion, null, 2)}

**New Signal Data:**
${JSON.stringify({ description: signal.description, metadata: signal.metadata }, null, 2)}

Update the analysis focusing on what has changed. Return the full expanded JSON structure with updated information.`;
}
