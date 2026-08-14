import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ScoutBundle } from '@/lib/schemas/scout-bundle';
import { DIAGRAM_KIND_IDS } from '@/lib/super-graph/kind-contract';

/** Non-chart analytical grammars that can be authored as static HTML/CSS. */
export const STATIC_FIGURE_KINDS = [
  'table',
  'evidence-map',
  'decision-tree',
  'comparison',
  'risk-grid',
  'portfolio',
] as const;

const SUPPORTED_FIGURE_KINDS = new Set<string>([...DIAGRAM_KIND_IDS, ...STATIC_FIGURE_KINDS]);
const FIGURE_ID = /^fig-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const figurePlanEntrySchema = z.object({
  figureId: z.string().regex(FIGURE_ID, 'must be a stable kebab-case id beginning with fig-'),
  readerQuestion: z.string().trim().min(8).max(240),
  // AI-050 pattern: a rejection must name what WOULD satisfy it. The previous
  // message ("must be a supported chart or static analytical kind") never listed
  // the kinds, so an author who invented a plausible label had to guess — and
  // every guess costs a full report re-draft. Observed repeatedly in the
  // COORD-011 battle, where visualKind and sourceIds rejections were the
  // dominant budget sink and killed one mission outright at its cost ceiling.
  visualKind: z
    .string()
    .refine(
      (value) => SUPPORTED_FIGURE_KINDS.has(value),
      (value) =>
        ({
          message:
            `'${value}' is not a supported visualKind. Use exactly one of: ` +
            `${[...SUPPORTED_FIGURE_KINDS].sort().join(', ')}.`,
        }) as never
    ),
  findingIds: z.array(z.number().int().positive()).min(1).max(40),
  sourceIds: z.array(z.number().int().positive()).min(1).max(40),
});

export const figurePlanSchema = z
  .array(figurePlanEntrySchema)
  .min(1)
  .max(24)
  .superRefine((entries, ctx) => {
    const figureIds = new Set<string>();
    const questions = new Set<string>();
    entries.forEach((entry, index) => {
      if (figureIds.has(entry.figureId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'figureId'], message: 'duplicate figure id' });
      }
      figureIds.add(entry.figureId);
      const normalizedQuestion = entry.readerQuestion.toLocaleLowerCase();
      if (questions.has(normalizedQuestion)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'readerQuestion'], message: 'duplicate reader question' });
      }
      questions.add(normalizedQuestion);
      if (new Set(entry.findingIds).size !== entry.findingIds.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'findingIds'], message: 'contains duplicate ids' });
      }
      if (new Set(entry.sourceIds).size !== entry.sourceIds.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'sourceIds'], message: 'contains duplicate ids' });
      }
    });
  });

export type FigurePlanEntry = z.infer<typeof figurePlanEntrySchema>;
export type FigurePlan = z.infer<typeof figurePlanSchema>;

export class FigurePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FigurePlanError';
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function figurePlanSha256(plan: FigurePlan): string {
  return createHash('sha256').update(stableJson(plan), 'utf8').digest('hex');
}

/** Parse and bind a plan only to ids in the persisted, filtered Scout bundle. */
export function parseFigurePlan(value: string, bundle: ScoutBundle | undefined): FigurePlan {
  if (!bundle) {
    throw new FigurePlanError('figurePlan requires a persisted research bundle for this mission');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch (error) {
    throw new FigurePlanError(`figurePlan is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = figurePlanSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join(' | ');
    throw new FigurePlanError(`figurePlan failed schema validation: ${issues}`);
  }

  const validSources = new Set(bundle.sources.map((source) => source.id));
  const problems: string[] = [];
  for (const entry of parsed.data) {
    const citedBySelectedFindings = new Set<number>();
    // Every source the planned findings cite, INDEPENDENT of what the author
    // listed. The intersection below cannot serve this role: when the author
    // lists the wrong sourceIds the intersection is empty, and an error that
    // says "those findings cite no sources" is both false and unactionable.
    const citableByPlannedFindings = new Set<number>();
    for (const findingId of entry.findingIds) {
      if (findingId > bundle.findings.length) {
        problems.push(`${entry.figureId}: finding ${findingId} is absent`);
        continue;
      }
      const findingCitations = new Set<number>();
      for (const marker of bundle.findings[findingId - 1].matchAll(/\[([^\]]+)\]/g)) {
        for (const token of marker[1].split(/[;,]/)) {
          const id = Number(token.trim());
          if (Number.isSafeInteger(id) && id > 0) findingCitations.add(id);
        }
      }
      findingCitations.forEach((sourceId) => citableByPlannedFindings.add(sourceId));
      const listedSupport = entry.sourceIds.filter((sourceId) => findingCitations.has(sourceId));
      if (listedSupport.length === 0) {
        const cites = [...findingCitations].sort((a, b) => a - b);
        problems.push(
          `${entry.figureId}: finding ${findingId} cites none of its planned sources. ` +
            `F${findingId} cites ${cites.length > 0 ? `[${cites.join('], [')}]` : 'nothing'}; ` +
            `the plan lists [${entry.sourceIds.join('], [')}].`
        );
      }
      listedSupport.forEach((sourceId) => citedBySelectedFindings.add(sourceId));
    }
    // Same AI-050 treatment: name the sources the planned findings ACTUALLY cite,
    // so the author can correct the bind in one step instead of guessing across
    // several re-drafts.
    const citable = [...citableByPlannedFindings].sort((a, b) => a - b);
    for (const sourceId of entry.sourceIds) {
      if (!validSources.has(sourceId)) problems.push(`${entry.figureId}: source ${sourceId} is absent`);
      else if (!citedBySelectedFindings.has(sourceId)) {
        problems.push(
          `${entry.figureId}: source ${sourceId} is not cited by its planned findings ` +
            `(${entry.findingIds.map((id) => `F${id}`).join(', ')}). Those findings cite ` +
            `${citable.length > 0 ? `[${citable.join('], [')}]` : 'no sources'} — use sourceIds from that set, ` +
            `or plan different findingIds.`
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new FigurePlanError(`figurePlan does not resolve against the persisted bundle: ${problems.slice(0, 8).join(' | ')}`);
  }
  return parsed.data;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripAttribute(tag: string, name: string): string {
  return tag.replace(new RegExp(`\\s${escapeRegExp(name)}\\s*=\\s*(?:"[^"]*"|'[^']*')`, 'gi'), '');
}

function figureMatches(html: string, figureId: string): RegExpMatchArray[] {
  const escaped = escapeRegExp(figureId);
  const tag = `<figure\\b(?=[^>]*(?:data-figure-id|id)\\s*=\\s*(?:"${escaped}"|'${escaped}'))[^>]*>[\\s\\S]*?<\\/figure>`;
  return [...html.matchAll(new RegExp(tag, 'gi'))];
}

const FIGURE_PROVENANCE_ATTRIBUTE = /\bdata-figure-provenance\s*=\s*(?:"[^"]*"|'[^']*')/i;

/** Remove prior canonical provenance spans without overlapping wildcard regexes. */
function stripFigureProvenanceSpans(html: string): string {
  const openingPattern = /<span\b/gi;
  const closingPattern = /<\/span>/gi;
  const chunks: string[] = [];
  let cursor = 0;

  for (let opening = openingPattern.exec(html); opening; opening = openingPattern.exec(html)) {
    const openingStart = opening.index;
    const openingEnd = html.indexOf('>', openingPattern.lastIndex);
    if (openingEnd < 0) break;
    const openingTag = html.slice(openingStart, openingEnd + 1);
    if (!FIGURE_PROVENANCE_ATTRIBUTE.test(openingTag)) {
      openingPattern.lastIndex = openingEnd + 1;
      continue;
    }

    closingPattern.lastIndex = openingEnd + 1;
    const closing = closingPattern.exec(html);
    if (!closing) break;

    chunks.push(html.slice(cursor, openingStart));
    cursor = closing.index + closing[0].length;
    openingPattern.lastIndex = cursor;
  }

  if (chunks.length === 0) return html;
  chunks.push(html.slice(cursor));
  return chunks.join('');
}

/**
 * Bind the verified plan to the exact rendered figures. Each planned figure is
 * required exactly once; the platform owns the canonical provenance attributes
 * and appends a source-bearing caption to the authored caption.
 */
export function bindFigurePlanToHtml(html: string, plan: FigurePlan): string {
  let bound = html;
  const planSha256 = figurePlanSha256(plan);
  for (const entry of plan) {
    const matches = figureMatches(bound, entry.figureId);
    if (matches.length !== 1) {
      throw new FigurePlanError(
        `${entry.figureId} must render exactly once as <figure data-figure-id="${entry.figureId}">; found ${matches.length}`
      );
    }
    const original = matches[0][0];
    const openingEnd = original.indexOf('>');
    let opening = original.slice(0, openingEnd + 1);
    for (const name of [
      'id',
      'data-figure-id',
      'data-figure-plan-sha256',
      'data-visual-kind',
      'data-finding-ids',
      'data-source-ids',
    ]) {
      opening = stripAttribute(opening, name);
    }
    opening = opening.replace(
      />$/,
      ` id="${escapeAttribute(entry.figureId)}" data-figure-id="${escapeAttribute(entry.figureId)}"` +
        ` data-figure-plan-sha256="${planSha256}"` +
        ` data-visual-kind="${escapeAttribute(entry.visualKind)}"` +
        ` data-finding-ids="${entry.findingIds.join(' ')}" data-source-ids="${entry.sourceIds.join(' ')}">`
    );
    const provenance = `<span class="figure-provenance" data-figure-provenance="${escapeAttribute(
      entry.figureId
    )}">Evidence: findings ${entry.findingIds.map((id) => `F${id}`).join(', ')}; sources ${entry.sourceIds
      .map((id) => `[${id}]`)
      .join(', ')}.</span>`;
    let replacement = opening + original.slice(openingEnd + 1);
    replacement = stripFigureProvenanceSpans(replacement);
    const captionClose = replacement.match(/<\/figcaption\s*>/i);
    if (captionClose?.index !== undefined) {
      // The author's caption ends in running prose, so the provenance span has to
      // introduce itself. Without a separator every figure in every report reads
      // "…to stay legible.Evidence: findings F2" — a defect each blind reviewer
      // flagged on each variant. Only add the space when the caption does not
      // already end in whitespace, so re-binding an already-bound caption cannot
      // accumulate them.
      // Separate only from CAPTION TEXT. A head ending in `>` means the caption
      // is empty (or ends with an element), so no separator is wanted — and
      // re-binding an already-bound caption must not accumulate spaces, which is
      // what the idempotency test pins.
      const head = replacement.slice(0, captionClose.index);
      const separator = head.length === 0 || /[\s>]$/.test(head) ? '' : ' ';
      replacement = head + separator + provenance + replacement.slice(captionClose.index);
    } else {
      replacement = replacement.replace(/<\/figure\s*>$/i, `<figcaption>${provenance}</figcaption></figure>`);
    }
    bound = bound.replace(original, replacement);
  }
  return bound;
}

export interface RichExecutiveFigureAcceptance {
  ok: boolean;
  figureCount: number;
  nonTabularCount: number;
  distinctKindCount: number;
  errors: string[];
}

/** Frozen-battle acceptance only; this is deliberately not a publication gate. */
export function evaluateRichExecutiveFigurePlan(plan: FigurePlan): RichExecutiveFigureAcceptance {
  const nonTabularCount = plan.filter((entry) => entry.visualKind !== 'table').length;
  const distinctKindCount = new Set(plan.map((entry) => entry.visualKind)).size;
  const errors: string[] = [];
  if (plan.length < 3) errors.push(`requires at least 3 evidence-bound figures; found ${plan.length}`);
  if (nonTabularCount < 2) errors.push(`requires at least 2 non-tabular figures; found ${nonTabularCount}`);
  if (distinctKindCount < 3) errors.push(`requires 3 distinct analytical kinds; found ${distinctKindCount}`);
  return { ok: errors.length === 0, figureCount: plan.length, nonTabularCount, distinctKindCount, errors };
}
