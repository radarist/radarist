/**
 * @file lib/schemas/scout-bundle.ts
 * @description Zod schema for the structured research bundle scout MUST emit.
 *
 * Every source carries provenance: the MCP that fetched it (`fetched_via`),
 * the SDK-assigned `tool_call_id` of the fetch, an Admiralty code, and the
 * date accessed. This structure is what the research-first chain hands to
 * creator; the parser rejects any output missing these fields, which then
 * becomes an L1 critical failure and halts the chain before creator runs.
 */

import { z } from 'zod';

/** MCPs Scout is allowed to cite as the source of fetched evidence. */
export const SCOUT_FETCHED_VIA_VALUES = [
  'exa',
  'arxiv',
  'firecrawl',
  'playwright',
  'github',
  // scout's config.yaml grants the gemini-grounding MCP as a research source,
  // so the bundle schema must accept it (otherwise scout L1-fails whenever it
  // grounds via Gemini — halting the chain before creator runs).
  'gemini-grounding',
  // Radarist platform truth is evidence too. Scout is explicitly granted
  // these servers and report prompts routinely require the graph, stored
  // entities, retained signals, and first-party research state.
  'impulse-entities',
  'impulse-graph',
  'impulse-signals',
  'impulse-research',
] as const;

export const scoutFetchedViaSchema = z.enum(SCOUT_FETCHED_VIA_VALUES);

export type ScoutFetchedVia = z.infer<typeof scoutFetchedViaSchema>;

/** NATO Admiralty Code (A1–F6) for source grading. */
export const admiraltyCodeSchema = z.string().regex(/^[A-F][1-6]$/, 'must be an Admiralty code like A2, B3, F6');

export const scoutBundleSourceSchema = z.object({
  /** Ordinal for [N] citations in findings — scout's own numbering. */
  id: z.number().int().positive(),
  /** Title of the source (paper, article, vendor page). */
  title: z.string().min(1),
  /** Canonical URL scout fetched. */
  url: z.string().url(),
  /** Which MCP scout actually called to retrieve the content. */
  fetched_via: scoutFetchedViaSchema,
  /**
   * The SDK `tool_use_id` of the fetch call. Scout is told to copy this from
   * its own tool-call trace. A literal "fabricated" value will still pass
   * schema (the string isn't cross-checked here), but forcing scout to emit
   * this field restructures how it thinks about each source.
   */
  tool_call_id: z.string().min(1),
  /** Admiralty grade (A1 = most reliable, F6 = least). */
  admiralty: admiraltyCodeSchema,
  /** ISO date (YYYY-MM-DD) when scout accessed the source. */
  date_accessed: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
  /** Optional one-line snippet scout extracted. */
  snippet: z.string().optional(),
});

export type ScoutBundleSource = z.infer<typeof scoutBundleSourceSchema>;

export const scoutBundleSchema = z.object({
  /**
   * The Step-1 research queries scout formulated before calling any tools.
   * Minimum 3 required so downstream analysts can reproduce the research
   * path. Without this, `reproducible` L2 dimension stays stuck at ~60%.
   */
  queries: z.array(z.string().min(1)).min(3),
  /** At least one source; a bundle with zero sources is a failed mission. */
  sources: z.array(scoutBundleSourceSchema).min(1),
  /**
   * Bulleted findings with inline [N] citations referencing `sources[].id`.
   * The parser does not cross-check citation integrity — that's a future
   * enhancement if fabrication persists.
   */
  findings: z.array(z.string().min(1)).min(1),
  /** Gaps scout could not fill after reasonable search. Empty is allowed. */
  unresolved: z.array(z.string()).default([]),
});

export type ScoutBundle = z.infer<typeof scoutBundleSchema>;

export const evidenceProvenanceReceiptSchema = z.object({
  sourceMissionId: z.string().min(1),
  bundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceIds: z.array(z.number().int().positive()),
  sourceCount: z.number().int().nonnegative(),
  findingCount: z.number().int().nonnegative(),
  graphDerivedChecked: z.number().int().nonnegative(),
  eligibleGraphSourceIds: z.array(z.number().int().positive()),
  withheldAbsentSourceIds: z.array(z.number().int().positive()),
  withheldUnavailableSourceIds: z.array(z.number().int().positive()),
  filteredAt: z.string().datetime(),
});
export type EvidenceProvenanceReceipt = z.infer<typeof evidenceProvenanceReceiptSchema>;
