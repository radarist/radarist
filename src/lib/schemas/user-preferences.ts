/**
 * @file lib/schemas/user-preferences.ts
 * @description Schema for the passive preference-harvester output.
 *
 * Populated nightly by an Inngest cron that reads the user's last 30 days
 * of missions and detects recurring patterns: structure (IMRAD/SBAR),
 * citation style, confidence-score usage, favorite agents, top topics.
 * Stored at `userPreferences/{uid}` in Firestore and read by the
 * orchestrator at mission dispatch to seed the prompt preamble.
 */

import { z } from 'zod';

export const preferredStructureSchema = z.enum(['IMRAD', 'SBAR', 'radar', 'none']);
export type PreferredStructure = z.infer<typeof preferredStructureSchema>;

export const preferredCitationStyleSchema = z.enum(['IEEE', 'none']);
export type PreferredCitationStyle = z.infer<typeof preferredCitationStyleSchema>;

export const agentCountSchema = z.object({
  agent: z.string().min(1),
  count: z.number().int().nonnegative(),
});
export type AgentCount = z.infer<typeof agentCountSchema>;

/**
 * AI-005 — explicit user pins over the harvested defaults. Every field here is
 * OPTIONAL: present means "the user explicitly pinned this value; it wins over
 * whatever the nightly harvest detects", absent means "no pin — harvested value
 * (if any) applies". Set/cleared via PATCH /api/user/preferences; the nightly
 * harvester must preserve this sub-object across its full-doc rewrite.
 */
export const pinnedPreferencesSchema = z.object({
  preferredStructure: preferredStructureSchema.optional(),
  preferredCitationStyle: preferredCitationStyleSchema.optional(),
  requestsConfidenceScores: z.boolean().optional(),
});
export type PinnedPreferences = z.infer<typeof pinnedPreferencesSchema>;

export const userPreferencesSchema = z.object({
  /** Firebase UID — matches the Firestore doc ID under userPreferences/ */
  userId: z.string().min(1),
  /** ISO timestamp of the most recent harvest run */
  updatedAt: z.string(),
  /** How many past missions the harvester analyzed */
  missionsAnalyzed: z.number().int().nonnegative(),
  /** Most-requested structure across mission prompts (null if <60% majority) */
  preferredStructure: preferredStructureSchema.optional(),
  /** Confidence 0–1 that the user genuinely prefers `preferredStructure` */
  structureConfidence: z.number().min(0).max(1),
  /** IEEE if the user requests citations in ≥40% of prompts */
  preferredCitationStyle: preferredCitationStyleSchema.optional(),
  /** True if the user asks for calibrated confidence in ≥40% of prompts */
  requestsConfidenceScores: z.boolean(),
  /** Top 3 agents by usage count */
  preferredAgents: z.array(agentCountSchema).max(5),
  /** Top 10 capitalized multi-word phrases across prompts (rough topic proxy) */
  topTopics: z.array(z.string()).max(10),
  /** Average length of the user's prompts in chars */
  avgPromptLength: z.number().nonnegative(),
  /** AI-005 — explicit user pins; win over harvested values, survive re-harvests */
  pinned: pinnedPreferencesSchema.optional(),
});

export type UserPreferences = z.infer<typeof userPreferencesSchema>;
