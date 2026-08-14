/**
 * @file ai/signal-evaluation.ts
 * @description AI-powered signal evaluation using Gemini
 *
 * Provides semantic analysis of signals against keywords and strategies
 * for relevance scoring, alignment scoring, and summary generation.
 *
 * @author Radarist Team
 * @created 2025-12-02
 */

import { z } from 'zod';
import { generateStructuredContent, generateContent, type GeminiModel } from './client';
import { geminiTextModel } from './model-config';
import type { Strategy } from '@/lib/types';
import { createLogger } from '@/lib/logger';

const log = createLogger('ai/signal-evaluation');

// ============================================================================
// Schemas for AI Output Validation
// ============================================================================

/**
 * Schema for signal evaluation result
 */
export const SignalEvaluationSchema = z.object({
  relevanceScore: z.number().min(0).max(100).describe('How relevant the signal is to the monitored keywords (0-100)'),
  alignmentScore: z.number().min(0).max(100).describe('How well the signal aligns with strategic directives (0-100)'),
  summary: z.string().max(500).describe('A concise 2-3 sentence summary of the signal content'),
  sentiment: z.enum(['positive', 'neutral', 'negative']).describe('Overall sentiment of the signal'),
  keyEntities: z.object({
    technologies: z.array(z.string()).describe('Technology names or tools mentioned'),
    companies: z.array(z.string()).describe('Company names mentioned'),
    concepts: z.array(z.string()).describe('Key concepts or trends mentioned'),
  }),
  reasoning: z.string().describe('Brief explanation of why these scores were assigned'),
  trustFactors: z.object({
    sourceCredibility: z.number().min(0).max(100).describe('Credibility of the source'),
    contentQuality: z.number().min(0).max(100).describe('Quality and depth of the content'),
    recency: z.number().min(0).max(100).describe('How recent and timely the information is'),
  }),
});

export type SignalEvaluationResult = z.infer<typeof SignalEvaluationSchema>;

/**
 * Schema for strategy alignment evaluation
 */
export const StrategyAlignmentSchema = z.object({
  strategyId: z.string(),
  strategyName: z.string(),
  score: z.number().min(0).max(100),
  matchedDirectives: z.array(z.string()).describe('Which directives this signal supports'),
  reasoning: z.string(),
});

export type StrategyAlignmentResult = z.infer<typeof StrategyAlignmentSchema>;

/**
 * Schema for technology maturity analysis
 */
export const TechnologyMaturitySchema = z.object({
  maturityScore: z.number().min(0).max(100),
  maturityLevel: z.enum(['emerging', 'growing', 'mature', 'declining']),
  indicators: z.object({
    communityActivity: z.number().min(0).max(100),
    productionReadiness: z.number().min(0).max(100),
    marketAdoption: z.number().min(0).max(100),
    vendorSupport: z.number().min(0).max(100),
  }),
  trendDirection: z.enum(['up', 'stable', 'down']),
  reasoning: z.string(),
});

export type TechnologyMaturityResult = z.infer<typeof TechnologyMaturitySchema>;

// ============================================================================
// AI Evaluation Functions
// ============================================================================

/**
 * Evaluates a signal candidate using Gemini AI
 *
 * @param title - Signal title
 * @param content - Signal content/description
 * @param source - Source of the signal
 * @param keywords - Keywords being monitored
 * @param strategies - Strategies to evaluate against (optional)
 * @returns AI evaluation result
 */
export async function evaluateSignalWithAI(
  title: string,
  content: string,
  source: string,
  keywords: string[],
  strategies?: Strategy[]
): Promise<SignalEvaluationResult> {
  const strategiesContext =
    strategies && strategies.length > 0
      ? `\n\nStrategic Directives to evaluate against:\n${strategies
          .map((s) => `- ${s.name}: ${s.mainDirectives?.map((d) => d.directive).join('; ') || s.description}`)
          .join('\n')}`
      : '';

  const prompt = `You are an innovation intelligence analyst. Evaluate this signal for an enterprise innovation platform.

Signal Title: ${title}
Signal Content: ${content}
Source: ${source}

Keywords being monitored: ${keywords.join(', ')}
${strategiesContext}

Analyze this signal and provide:
1. Relevance Score (0-100): How relevant is this to the monitored keywords and domain?
2. Alignment Score (0-100): How well does this support strategic objectives? (If no strategies provided, base on general innovation value)
3. Summary: A clear, actionable 2-3 sentence summary (avoid markdown formatting like **bold**)
4. Sentiment: Is this positive, neutral, or negative news for innovation?
5. Key Entities: Extract technology names, company names, and key concepts mentioned
6. Reasoning: Brief explanation of your scoring
7. Trust Factors: Rate source credibility, content quality, and recency

Be objective and focus on actionable intelligence. Avoid hype.`;

  try {
    const result = await generateStructuredContent(prompt, SignalEvaluationSchema, {
      model: geminiTextModel() as GeminiModel,
      temperature: 0.3, // Lower temperature for more consistent scoring
    });

    return result;
  } catch (error) {
    log.error('Failed to evaluate signal', error instanceof Error ? error : undefined);
    // Return fallback scores
    return {
      relevanceScore: 50,
      alignmentScore: 50,
      summary: content.substring(0, 200) + (content.length > 200 ? '...' : ''),
      sentiment: 'neutral',
      keyEntities: {
        technologies: [],
        companies: [],
        concepts: [],
      },
      reasoning: 'AI evaluation failed, using default scores',
      trustFactors: {
        sourceCredibility: 50,
        contentQuality: 50,
        recency: 50,
      },
    };
  }
}

/**
 * Evaluates an entity against a specific strategy using AI
 *
 * @param entity - Entity to evaluate (title and description)
 * @param strategy - Strategy to evaluate against
 * @returns Strategy alignment result
 */
export async function evaluateStrategyAlignmentWithAI(
  entity: { title: string; description: string },
  strategy: Strategy
): Promise<StrategyAlignmentResult> {
  const directives = strategy.mainDirectives?.map((d) => d.directive).join('\n- ') || strategy.description;

  const prompt = `You are a strategic alignment analyst. Evaluate how well this entity aligns with the strategic directives.

Entity:
Title: ${entity.title}
Description: ${entity.description}

Strategy: ${strategy.name}
Description: ${strategy.description || 'No description'}
Directives:
- ${directives}

Analyze alignment and provide:
1. Score (0-100): How well does this entity support the strategy?
2. Matched Directives: Which specific directives does this entity support?
3. Reasoning: Why does this entity align or not align with the strategy?

Be specific about which directives are supported and why.`;

  try {
    const result = await generateStructuredContent(prompt, StrategyAlignmentSchema, {
      model: geminiTextModel() as GeminiModel,
      temperature: 0.3,
    });

    return {
      ...result,
      strategyId: strategy.id,
      strategyName: strategy.name,
    };
  } catch (error) {
    log.error('Failed to evaluate strategy alignment', error instanceof Error ? error : undefined);
    return {
      strategyId: strategy.id,
      strategyName: strategy.name,
      score: 50,
      matchedDirectives: [],
      reasoning: 'AI evaluation failed, using default score',
    };
  }
}

/**
 * Analyzes technology maturity using AI and web context
 *
 * @param technologyName - Name of the technology
 * @param currentData - Current data about the technology (optional)
 * @returns Maturity analysis result
 */
export async function analyzeTechnologyMaturityWithAI(
  technologyName: string,
  currentData?: { description?: string; currentMaturity?: number }
): Promise<TechnologyMaturityResult> {
  const currentContext = currentData
    ? `\nCurrent data:\n- Description: ${currentData.description || 'None'}\n- Current maturity score: ${currentData.currentMaturity || 'Unknown'}`
    : '';

  const prompt = `You are a technology maturity analyst. Analyze the current maturity level of this technology.

Technology: ${technologyName}
${currentContext}

Based on your knowledge of this technology (as of early 2025), analyze:
1. Maturity Score (0-100): Overall technology maturity
2. Maturity Level: Is it emerging, growing, mature, or declining?
3. Indicators:
   - Community Activity: GitHub stars, contributors, Stack Overflow activity
   - Production Readiness: Enterprise adoption, stability, documentation
   - Market Adoption: How widely is it used in production?
   - Vendor Support: Commercial support, cloud provider offerings
4. Trend Direction: Is adoption trending up, stable, or down?
5. Reasoning: Brief explanation of your assessment

Be realistic and based on current market conditions.`;

  try {
    const result = await generateStructuredContent(prompt, TechnologyMaturitySchema, {
      model: geminiTextModel() as GeminiModel,
      temperature: 0.4,
      useGoogleSearch: true, // Enable search for more current data
    });

    return result;
  } catch (error) {
    log.error('Failed to analyze technology maturity', error instanceof Error ? error : undefined);
    return {
      maturityScore: currentData?.currentMaturity || 50,
      maturityLevel: 'growing',
      indicators: {
        communityActivity: 50,
        productionReadiness: 50,
        marketAdoption: 50,
        vendorSupport: 50,
      },
      trendDirection: 'stable',
      reasoning: 'AI analysis failed, using default values',
    };
  }
}

/**
 * Generates an AI summary for a signal
 *
 * @param title - Signal title
 * @param content - Signal content
 * @returns Clean, formatted summary
 */
export async function generateSignalSummary(title: string, content: string): Promise<string> {
  const prompt = `Summarize this innovation signal in 2-3 clear sentences. Focus on what it means for enterprise innovation teams. Do NOT use markdown formatting like **bold** or *italic*.

Title: ${title}
Content: ${content}

Provide a plain text summary that is actionable and informative.`;

  try {
    const summary = await generateContent(prompt, {
      model: geminiTextModel() as GeminiModel,
      temperature: 0.4,
      maxOutputTokens: 256,
    });

    // Clean any markdown artifacts that might have slipped through
    return cleanMarkdownFromText(summary);
  } catch (error) {
    log.error('Failed to generate summary', error instanceof Error ? error : undefined);
    return content.substring(0, 200) + (content.length > 200 ? '...' : '');
  }
}

/**
 * Removes markdown formatting from text
 * Used to ensure clean display in text fields
 */
export function cleanMarkdownFromText(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1') // Remove **bold**
    .replace(/\*([^*]+)\*/g, '$1') // Remove *italic*
    .replace(/__([^_]+)__/g, '$1') // Remove __bold__
    .replace(/_([^_]+)_/g, '$1') // Remove _italic_
    .replace(/~~([^~]+)~~/g, '$1') // Remove ~~strikethrough~~
    .replace(/`([^`]+)`/g, '$1') // Remove `code`
    .replace(/#{1,6}\s/g, '') // Remove headers
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Remove links, keep text
    .replace(/^\s*[-*+]\s/gm, '') // Remove list markers
    .replace(/^\s*\d+\.\s/gm, '') // Remove numbered list markers
    .replace(/>\s/g, '') // Remove blockquotes
    .replace(/\n{3,}/g, '\n\n') // Normalize multiple newlines
    .trim();
}

/**
 * Calculates overall trust score from individual factors
 */
export function calculateTrustScore(factors: {
  sourceCredibility: number;
  contentQuality: number;
  recency: number;
}): number {
  // Weighted average
  const weights = {
    sourceCredibility: 0.4,
    contentQuality: 0.35,
    recency: 0.25,
  };

  return Math.round(
    factors.sourceCredibility * weights.sourceCredibility +
      factors.contentQuality * weights.contentQuality +
      factors.recency * weights.recency
  );
}
