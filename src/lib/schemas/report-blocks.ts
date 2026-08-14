/**
 * @file lib/schemas/report-blocks.ts
 * @description REPORT-012 — the typed-block authoring contract for composed
 * reports. The creator agent emits CONTENT as these blocks (prose fields are
 * markdown); the server-side composer (`lib/reports/report-composer.ts`) owns
 * every pixel: it renders blocks with the `report-brand.css` component
 * vocabulary, binds the mission DesignBrief as CSS variables, inlines charts
 * by reference, and embeds images as bounded data: URIs.
 *
 * Pure (zod only — no firebase/service imports) so the tool layer, the
 * composer, the MCP schema mirror, and tests can all import it freely.
 *
 * Uses the established Notion/Docs/Word block-model pattern: the
 * LLM never writes CSS; its failure surface is content-shaped and visible.
 */
import { z } from 'zod';

/** Markdown prose field — rendered by the composer with inline semantics
 * (`[N]` cite links, `[validated, …]`/`[assumption, …]` provenance spans,
 * `Confidence: 0.x` badges). */
const md = z.string().min(1).max(20_000);

export const statSchema = z.object({
  number: z.string().min(1).max(24),
  label: z.string().min(1).max(80),
  source: z.string().max(120).optional(),
});

const cellTone = z.enum(['good', 'bad', 'neutral']);

export const reportBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('section'),
    label: z.string().min(1).max(40),
    title: z.string().min(1).max(120),
    intro: md.optional(),
  }),
  z.object({ type: z.literal('prose'), body: md }),
  z.object({
    type: z.literal('stat-grid'),
    stats: z.array(statSchema).min(2).max(8),
    variant: z.enum(['default', 'compact']).optional(),
  }),
  z.object({
    type: z.literal('table'),
    caption: z.string().max(160).optional(),
    header: z.array(z.string().max(80)).min(1).max(10),
    rows: z
      .array(z.array(z.string().max(400)).min(1).max(10))
      .min(1)
      .max(60),
    /** Sparse cell tones keyed `"row,col"` (0-indexed). */
    cellTags: z.record(cellTone).optional(),
  }),
  z.object({
    type: z.literal('compare-table'),
    header: z.array(z.string().max(80)).min(1).max(8),
    rows: z
      .array(
        z.object({
          label: z.string().min(1).max(120),
          cells: z
            .array(z.object({ text: z.string().max(300), tone: cellTone.default('neutral') }))
            .min(1)
            .max(8),
        })
      )
      .min(1)
      .max(30),
  }),
  z.object({
    type: z.literal('benchmark-grid'),
    cards: z
      .array(
        z.object({
          org: z.string().min(1).max(60),
          model: z.string().min(1).max(80),
          body: md,
          tags: z.array(z.string().max(24)).max(6).default([]),
          tone: z.enum(['blue', 'green', 'purple']).optional(),
        })
      )
      .min(1)
      .max(8),
  }),
  // Skill-mandated blocks — field sets mirror the fenced contracts in
  // agent/runtime-plugin/skills/{jtbd-framing,evolution-stage,three-horizons}/SKILL.md 1:1.
  z.object({
    type: z.literal('jtbd-block'),
    technology: z.string().min(1).max(80),
    job: z.string().min(1).max(300),
    context: z.string().min(1).max(200),
    competing: z.array(z.string().max(120)).min(2).max(5),
    struggling: z.string().min(1).max(300),
  }),
  z.object({
    type: z.literal('evolution-tag'),
    technology: z.string().min(1).max(80),
    stage: z.enum(['Genesis', 'Custom-built', 'Product', 'Commodity']),
    rationale: z.string().min(1).max(300),
    methodFit: z.string().min(1).max(120),
  }),
  z.object({
    type: z.literal('horizon-card'),
    bet: z.string().min(1).max(120),
    horizon: z.enum(['H1', 'H2', 'H3']),
    timeToRevenue: z.string().min(1).max(60),
    evidenceBar: z.string().min(1).max(120),
    method: z.string().min(1).max(80),
    implication: z.string().min(1).max(300),
  }),
  z.object({
    type: z.literal('portfolio-summary'),
    h1: z.array(z.string().max(120)).max(10).default([]),
    h2: z.array(z.string().max(120)).max(10).default([]),
    h3: z.array(z.string().max(120)).max(10).default([]),
    mix: z.string().min(1).max(200),
  }),
  z.object({ type: z.literal('insight-box'), quote: md, source: z.string().max(160).optional() }),
  z.object({
    type: z.literal('callout'),
    tone: z.enum(['warning', 'success', 'counter-evidence']),
    body: md,
  }),
  z.object({
    type: z.literal('steps-list'),
    steps: z
      .array(z.object({ title: z.string().min(1).max(120), body: md }))
      .min(2)
      .max(12),
  }),
  z.object({
    type: z.literal('action-grid'),
    cards: z
      .array(
        z.object({
          phase: z.string().min(1).max(40),
          title: z.string().min(1).max(120),
          items: z.array(z.string().max(200)).min(1).max(8),
        })
      )
      .min(1)
      .max(6),
    variant: z.enum(['default', 'compact', 'spacious']).optional(),
  }),
  z.object({
    type: z.literal('chart-ref'),
    chartId: z.string().regex(/^[a-z0-9-]{4,64}$/),
    /** Stable id referenced by draftReport.figurePlan. Optional for legacy docs. */
    figureId: z.string().regex(/^fig-[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
    title: z.string().min(1).max(140),
    caption: z.string().max(300).optional(),
  }),
  z.object({
    type: z.literal('image-ref'),
    imageId: z.string().regex(/^[a-z0-9-]{4,64}$/),
    alt: z.string().min(4).max(200),
    caption: z.string().max(300).optional(),
  }),
  z.object({
    type: z.literal('references'),
    items: z
      .array(
        z.object({
          n: z.number().int().min(1).max(200),
          text: z.string().min(1).max(400),
          url: z.string().url().optional(),
          admiralty: z
            .string()
            .regex(/^[A-F][1-6]$/)
            .optional(),
        })
      )
      .min(1)
      .max(60),
  }),
  z.object({
    type: z.literal('html-embed'),
    /** Why a stock block could not express this visual — recorded for review. */
    rationale: z.string().min(1).max(200),
    html: z
      .string()
      .min(1)
      .max(40_000)
      .refine((h) => !/<\s*(script|style|link|iframe|object|embed)\b/i.test(h), {
        message: 'html-embed allows inline-styled markup + svg only (no script/style/link/iframe/object/embed)',
      }),
  }),
]);

export const reportBlocksDocSchema = z.object({
  title: z.string().min(4).max(160),
  subtitle: z.string().max(240).optional(),
  audience: z.string().max(120).optional(),
  blocks: z.array(reportBlockSchema).min(3).max(120),
});

export type ReportBlock = z.infer<typeof reportBlockSchema>;
export type ReportBlocksDoc = z.infer<typeof reportBlocksDocSchema>;
