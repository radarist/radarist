/**
 * @file lib/schemas/signal.ts
 * @description Zod validation schemas for Signal enhancements (Phase 4.2)
 *
 * These schemas provide runtime validation for the new Signal fields:
 * - expandedContent: Deep analysis and recommendations
 * - trustScore: Quality and confidence metrics
 * - feedback: User feedback for agent improvement
 *
 * @author Radarist Team
 * @created 2025-11-26
 */

import { z } from 'zod';

/**
 * Schema for expanded signal content
 */
export const expandedContentSchema = z.object({
  // Entity Profile
  entityProfile: z.object({
    type: z.enum(['company', 'technology', 'trend']),
    summary: z.string().min(10),
    keyFacts: z.array(z.string()).min(1),
    recentDevelopments: z.array(z.string()).min(1),
    keyPlayers: z.array(z.string()).optional(),
    maturityAssessment: z.string().optional(),
  }).optional(),

  // Strategic Analysis
  strategicAnalysis: z.object({
    alignedStrategies: z.array(z.object({
      strategyId: z.string(),
      strategyName: z.string(),
      alignmentScore: z.number().min(0).max(100),
      alignmentReason: z.string(),
    })),
    radarImpact: z.string().optional(),
    competitiveImplications: z.string().optional(),
    opportunityOrThreat: z.enum(['opportunity', 'threat', 'neutral']),
  }).optional(),

  // Recommendations
  recommendations: z.object({
    suggestedNextSteps: z.array(z.string()).min(1),
    questionsForInvestigation: z.array(z.string()).min(1),
    suggestedRadarPlacement: z.object({
      quadrant: z.string(),
      ring: z.string(),
      rationale: z.string(),
    }).optional(),
  }).optional(),

  // Related Items
  relatedItems: z.object({
    technologies: z.array(z.object({
      id: z.string(),
      name: z.string(),
      relevance: z.string(),
    })),
    companies: z.array(z.object({
      id: z.string(),
      name: z.string(),
      relevance: z.string(),
    })),
    signals: z.array(z.object({
      id: z.string(),
      title: z.string(),
      relevance: z.string(),
    })),
  }).optional(),

  // Reference Sources
  sources: z.array(z.object({
    title: z.string(),
    url: z.string().url(),
    verdict: z.enum(['confirming', 'contradicting', 'inconclusive']).optional(),
    description: z.string().optional(),
    date: z.string().optional(),
  })).optional(),

  // Expansion Metadata
  expandedAt: z.number().positive(),
  expansionModel: z.string(),
  expansionDuration: z.number().positive(), // milliseconds
});

export type ExpandedContent = z.infer<typeof expandedContentSchema>;

/**
 * Schema for trust score
 */
export const trustScoreSchema = z.object({
  overall: z.number().min(0).max(100),
  breakdown: z.object({
    sourceReliability: z.number().min(0).max(100),
    dataCompleteness: z.number().min(0).max(100),
    corroboration: z.number().min(0).max(100),
    aiConfidence: z.number().min(0).max(100),
  }),
  factors: z.array(z.string()).min(1),
});

export type TrustScore = z.infer<typeof trustScoreSchema>;

/**
 * Schema for user feedback
 */
export const feedbackSchema = z.object({
  vote: z.enum(['up', 'down']).optional(),
  votedAt: z.number().positive().optional(),
  votedBy: z.string().optional(),
  reason: z.string().optional(),
  includedInFeedbackLoop: z.boolean(),
});

export type Feedback = z.infer<typeof feedbackSchema>;

/**
 * Partial schema for creating/updating expanded content
 * All fields optional for partial updates
 */
export const partialExpandedContentSchema = expandedContentSchema.partial();

/**
 * Partial schema for creating/updating trust score
 */
export const partialTrustScoreSchema = trustScoreSchema.partial({
  breakdown: true,
  factors: true,
});

/**
 * Partial schema for creating/updating feedback
 */
export const partialFeedbackSchema = feedbackSchema.partial();

/**
 * Helper function to validate expanded content
 */
export function validateExpandedContent(data: unknown): ExpandedContent {
  return expandedContentSchema.parse(data);
}

/**
 * Helper function to validate trust score
 */
export function validateTrustScore(data: unknown): TrustScore {
  return trustScoreSchema.parse(data);
}

/**
 * Helper function to validate feedback
 */
export function validateFeedback(data: unknown): Feedback {
  return feedbackSchema.parse(data);
}

/**
 * Safe validation that returns success/error instead of throwing
 */
export function safeValidateExpandedContent(data: unknown): {
  success: boolean;
  data?: ExpandedContent;
  error?: z.ZodError;
} {
  const result = expandedContentSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Safe validation for trust score
 */
export function safeValidateTrustScore(data: unknown): {
  success: boolean;
  data?: TrustScore;
  error?: z.ZodError;
} {
  const result = trustScoreSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Safe validation for feedback
 */
export function safeValidateFeedback(data: unknown): {
  success: boolean;
  data?: Feedback;
  error?: z.ZodError;
} {
  const result = feedbackSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
