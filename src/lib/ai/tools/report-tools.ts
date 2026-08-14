/**
 * @file ai/tools/report-tools.ts
 * @description AI tools for drafting, publishing, and managing HTML reports.
 *
 * The Creator agent uses draftReport (FS scratch) and publishReport (Firestore
 * upsert keyed on missionId+slotName) to persist professional HTML reports.
 * HTML is sanitized before storage to prevent XSS.
 *
 * listReports and getReportById resolve through the owner-scoped service
 * boundary in lib/reports.ts (SEC-009). HTML content is intentionally
 * excluded from results (too large for chat context). REPORT-002: every
 * result carries the private `reportUrl` (/reports/{id}) plus the report's
 * lifecycle `state`; a public `shareUrl` is emitted ONLY when the persisted
 * document is verifiably shared (shared === true and not needs-review).
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import type { FunctionDeclaration } from '@google/generative-ai';
import { SchemaType } from '@google/generative-ai';
import {
  upsertReportBySlot,
  updateReport,
  restoreReportVersion,
  deleteReport as deletePersistedReport,
  getReportOwnedBy,
  listReportsOwnedBy,
  reportLifecycleState,
  type ReportLifecycleState,
} from '@/lib/reports';
import type { UpdateReportInput } from '@/lib/schemas/report';
import { ReportPublicationError } from '@/lib/reports/publication-policy';
import { normalizeSourceUrlText } from '@/lib/reports/publication-contract';
import { normalizeReferenceAnchors } from '@/lib/reports/reference-anchors';
import { ReportReferenceIntegrityError } from '@/lib/reports/reference-integrity';
import {
  assertReportPublicationConformance,
  ReportPublicationConformanceError,
} from '@/lib/reports/publication-conformance';
import { isReportComposerEnabled } from '@/lib/reports/report-composer-mode';
import type { GeminiModel } from '@/lib/ai/client';
import { sanitizeReportHtml } from '@/lib/html-sanitizer';
import { createLogger } from '@/lib/logger';
import { slotSchema, type Slot } from '@/lib/schemas/mission';
import {
  confirmDestructiveAction,
  destructiveActionFingerprint,
  normalizeDestructiveIdentifier,
  type DestructiveGateRefusal,
} from '@/lib/ai/destructive-confirmation';

const log = createLogger('ai/report-tools');

// Draft HTML is written under the OS temp dir, NOT the project tree. A draft
// write under <project>/tmp/ trips the Next.js dev file-watcher mid-mission
// (right at compose/publish time), reloading the dev server and killing the
// agent subprocess before the report is published. os.tmpdir() is outside the
// watched tree.
const DRAFT_ROOT = path.join(os.tmpdir(), 'impulse-missions');

/**
 * Build the canonical FS path for a mission's draft slot. Defends against
 * path traversal by resolving and validating the result stays inside DRAFT_ROOT.
 *
 * Returns the absolute file path on success, or null if the inputs would
 * escape DRAFT_ROOT (e.g. missionId or slotName containing '..' segments).
 */
function getDraftPath(missionId: string, slotName: string): string | null {
  const resolved = path.resolve(DRAFT_ROOT, missionId, `${slotName}.html`);
  if (!resolved.startsWith(DRAFT_ROOT + path.sep)) {
    return null;
  }
  return resolved;
}

/**
 * REPORT-012 T2.6: canonical FS path for a mission slot's structured-blocks
 * draft (`<slot>.blocks.json`). Same traversal guard as getDraftPath.
 */
function getBlocksPath(missionId: string, slotName: string): string | null {
  const resolved = path.resolve(DRAFT_ROOT, missionId, `${slotName}.blocks.json`);
  if (!resolved.startsWith(DRAFT_ROOT + path.sep)) {
    return null;
  }
  return resolved;
}

function getFigurePlanPath(missionId: string, slotName: string): string | null {
  const resolved = path.resolve(DRAFT_ROOT, missionId, `${slotName}.figure-plan.json`);
  if (!resolved.startsWith(DRAFT_ROOT + path.sep)) return null;
  return resolved;
}

function getFinalExportPath(missionId: string, slotName: string): string | null {
  const resolved = path.resolve(DRAFT_ROOT, missionId, `${slotName}.final-export.html`);
  if (!resolved.startsWith(DRAFT_ROOT + path.sep)) return null;
  return resolved;
}

function getFinalExportReceiptPath(missionId: string, slotName: string): string | null {
  const resolved = path.resolve(DRAFT_ROOT, missionId, `${slotName}.final-export.json`);
  if (!resolved.startsWith(DRAFT_ROOT + path.sep)) return null;
  return resolved;
}

interface StagedExportReceipt {
  schemaVersion: 1;
  title: string;
  sourceSha256: string;
  exportSha256: string;
  cssSha256: string;
  bytes: number;
  revisionNumber: number;
  stagedAt: string;
}

function exportSourceSha256(title: string, html: string): string {
  return createHash('sha256').update(`${title}\0${html}`, 'utf8').digest('hex');
}

function isStagedExportReceipt(value: unknown): value is StagedExportReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Partial<StagedExportReceipt>;
  return (
    receipt.schemaVersion === 1 &&
    typeof receipt.title === 'string' &&
    /^[a-f0-9]{64}$/.test(receipt.sourceSha256 ?? '') &&
    /^[a-f0-9]{64}$/.test(receipt.exportSha256 ?? '') &&
    /^[a-f0-9]{64}$/.test(receipt.cssSha256 ?? '') &&
    Number.isSafeInteger(receipt.bytes) &&
    Number.isSafeInteger(receipt.revisionNumber) &&
    typeof receipt.stagedAt === 'string'
  );
}

async function readStagedExportReceipt(receiptPath: string): Promise<StagedExportReceipt | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    return isStagedExportReceipt(parsed) ? parsed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function stageFinalExport(input: {
  missionId: string;
  slotName: string;
  title: string;
  html: string;
  oneRevisionOnly: boolean;
}): Promise<{ receipt: StagedExportReceipt; html: string }> {
  const exportPath = getFinalExportPath(input.missionId, input.slotName);
  const receiptPath = getFinalExportReceiptPath(input.missionId, input.slotName);
  if (!exportPath || !receiptPath) throw new Error('invalid missionId or slotName (final-export path escape)');
  const sourceSha256 = exportSourceSha256(input.title, input.html);
  const previous = await readStagedExportReceipt(receiptPath);
  if (previous?.sourceSha256 === sourceSha256 && previous.title === input.title) {
    const existingHtml = await fs.readFile(exportPath, 'utf8');
    const existingSha = createHash('sha256').update(existingHtml, 'utf8').digest('hex');
    if (existingSha === previous.exportSha256) return { receipt: previous, html: existingHtml };
    throw new Error('staged export bytes do not match their receipt');
  }
  const revisionNumber = previous ? previous.revisionNumber + 1 : 0;
  if (input.oneRevisionOnly && revisionNumber > 1) {
    throw new Error('corrective revision limit reached: one revised export is permitted for this report');
  }
  const { buildFinalReportExport } = await import('@/lib/reports/final-export');
  const exported = await buildFinalReportExport(input.html, input.title);
  const receipt: StagedExportReceipt = {
    schemaVersion: 1,
    title: input.title,
    sourceSha256,
    exportSha256: exported.sha256,
    cssSha256: exported.cssSha256,
    bytes: exported.bytes,
    revisionNumber,
    stagedAt: new Date().toISOString(),
  };
  await fs.writeFile(exportPath, exported.html, 'utf8');
  await fs.writeFile(receiptPath, JSON.stringify(receipt), 'utf8');
  return { receipt, html: exported.html };
}

async function verifyStagedExport(input: {
  missionId: string;
  slotName: string;
  title: string;
  html: string;
  expectedExportSha256: string;
}): Promise<{ receipt: StagedExportReceipt; html: string }> {
  const exportPath = getFinalExportPath(input.missionId, input.slotName);
  const receiptPath = getFinalExportReceiptPath(input.missionId, input.slotName);
  if (!exportPath || !receiptPath) throw new Error('invalid missionId or slotName (final-export path escape)');
  const receipt = await readStagedExportReceipt(receiptPath);
  if (!receipt) throw new Error('no staged final export; call draftReport with title first');
  const exportedHtml = await fs.readFile(exportPath, 'utf8');
  const actualSha256 = createHash('sha256').update(exportedHtml, 'utf8').digest('hex');
  if (input.expectedExportSha256 !== receipt.exportSha256 || actualSha256 !== receipt.exportSha256) {
    throw new Error(`expected export SHA ${input.expectedExportSha256} does not match staged bytes ${actualSha256}`);
  }
  if (receipt.title !== input.title || receipt.sourceSha256 !== exportSourceSha256(input.title, input.html)) {
    throw new Error(
      'draft or title changed after export staging; call draftReport again and re-review the new export SHA'
    );
  }
  return { receipt, html: exportedHtml };
}

async function assertExactArtifactReviews(missionId: string, receipt: StagedExportReceipt): Promise<void> {
  const { getMissionById } = await import('@/lib/missions');
  const mission = await getMissionById(missionId);
  if (!mission) throw new Error('mission disappeared before exact-artifact review verification');
  const invocations = mission.skillInvocations ?? [];
  const stagedAt = Date.parse(receipt.stagedAt);
  for (const skill of ['design-pass', 'critique-report'] as const) {
    const bound = invocations.some(
      (invocation) =>
        invocation.skill === skill &&
        Date.parse(invocation.firedAt) >= stagedAt &&
        typeof invocation.args === 'string' &&
        invocation.args.toLowerCase().includes(receipt.exportSha256)
    );
    if (!bound) {
      throw new Error(
        `${skill} must run after export staging and cite the full export SHA ${receipt.exportSha256}; re-review the exact export before publishing`
      );
    }
  }
}

// ============================================================================
// Tool Declarations
// ============================================================================

export const REPORT_TOOLS: FunctionDeclaration[] = [
  {
    name: 'draftReport',
    description:
      'Write a working report draft for the current mission. Legacy HTML is the default unless the mission prompt explicitly says REPORT AUTHORING MODE: template. The server enforces that mode before writing. Drafts are unlimited and idempotent — re-calling overwrites the active draft for the same slotName. Drafts are NOT visible to users; only publishReport persists to Firestore.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        slotName: {
          type: SchemaType.STRING,
          description: 'Slot identifier (kebab-case). Must match a slot from the mission manifest.',
        },
        title: {
          type: SchemaType.STRING,
          description:
            'Final report title. Required for rich-executive research reports so draftReport can stage the exact self-contained product export before review.',
        },
        html: {
          type: SchemaType.STRING,
          description:
            'Self-contained HTML+CSS for the draft. Required when template mode is off (the default); provide it on the first attempt when the mission says REPORT AUTHORING MODE: legacy.',
        },
        blocks: {
          type: SchemaType.STRING,
          description:
            'Use ONLY when the mission explicitly says REPORT AUTHORING MODE: template. Otherwise blocks are rejected before any draft is changed. JSON-encoded ReportBlocksDoc — {"title","subtitle?","audience?","blocks":[…typed content blocks…]}. The server composes the design (brand template, charts by chartId, images by imageId); you author CONTENT only. Validation errors return the exact schema issues to fix.',
        },
        figurePlan: {
          type: SchemaType.STRING,
          description:
            'JSON array of evidence-bound analytical figures: [{"figureId":"fig-...","readerQuestion":"...","visualKind":"...","findingIds":[1],"sourceIds":[1]}]. Every finding/source id is checked against the persisted filtered research bundle. Each legacy HTML figure must render once as <figure data-figure-id="fig-...">; template chart-ref blocks carry the same figureId. Rich-executive research missions require this plan, but the three-figure/two-non-tabular threshold is battle acceptance only, not a universal publication count gate.',
        },
      },
      // Startup env is immutable for the served tool catalog. In legacy mode,
      // make HTML structurally required as well as executor-enforced so the
      // model cannot choose blocks on its first attempt.
      required: isReportComposerEnabled() ? ['slotName'] : ['slotName', 'html'],
    },
  },
  {
    name: 'publishReport',
    description:
      'Promote a draft report to the platform (Firestore). Reads the latest draftReport for the given slotName from the FS, sanitizes, and upserts by (missionId, slotName). Each slot in the mission manifest can be published exactly once (revisions upsert in place). HTML is NOT passed in this call — call draftReport first. Rich-executive research reports must pass the exportSha256 returned by draftReport after design-pass and critique-report review that exact hash. Returns the private reportUrl (/reports/{id}); a published report is NOT publicly shared — never present its URL as a public share link.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        slotName: {
          type: SchemaType.STRING,
          description: 'Slot identifier (must match a slot in the mission manifest).',
        },
        title: { type: SchemaType.STRING, description: 'Report title' },
        description: { type: SchemaType.STRING, description: 'Brief metadata description' },
        entityIds: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'IDs of entities referenced in the report',
        },
        expectedExportSha256: {
          type: SchemaType.STRING,
          description:
            'The exact 64-character exportSha256 returned by draftReport. Required for rich-executive research reports after design-pass and critique-report have reviewed that hash.',
        },
      },
      required: ['slotName', 'title', 'description'],
    },
  },
  {
    name: 'listReports',
    description:
      "List the user's reports. Returns metadata (title, description, creation date, agent type), each report's lifecycle state (needs-review draft | private | shared), and its private reportUrl (/reports/{id}) — plus a public shareUrl ONLY for reports that are already explicitly shared. NOT the HTML content. Use when the user asks to see reports, find a report, or check what has been generated.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        limit: {
          type: SchemaType.NUMBER,
          description: 'Maximum reports to return (default: 10, max: 50)',
        },
      },
    },
  },
  {
    name: 'getReportById',
    description:
      "Get metadata for a specific report by ID. Returns title, description, creation date, agent type, entity IDs, the lifecycle state (needs-review draft | private | shared), and the private reportUrl (/reports/{id}); a public shareUrl is included ONLY when the report is already explicitly shared. Does NOT return HTML content by default. Within a mission revision turn, pass includeHtml: true to load the report's EXACT persisted HTML (plus its sha256) so you revise the real artifact instead of rebuilding from memory.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        reportId: {
          type: SchemaType.STRING,
          description: 'The report ID to look up',
        },
        includeHtml: {
          type: SchemaType.BOOLEAN,
          description:
            'Mission-bound only: return the exact persisted HTML of this report (REPORT-004 revision context). Ignored outside a mission turn or for reports of other missions.',
        },
      },
      required: ['reportId'],
    },
  },
  {
    name: 'updateReport',
    description:
      'Update an existing report. Can change title, metadata, toggle sharing, or apply AI-driven edits to the HTML content. When the user asks to edit a report (e.g., "change the styling", "add a section"), provide the editInstruction parameter and the AI will modify the HTML accordingly. The report must already exist.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        reportId: {
          type: SchemaType.STRING,
          description: 'The ID of the report to update',
        },
        title: {
          type: SchemaType.STRING,
          description: 'New title for the report',
        },
        shared: {
          type: SchemaType.BOOLEAN,
          description:
            'Whether the report should have a public share link. Sharing is refused for needs-review drafts — the user must review and approve the draft first. The result reports the persisted state; only trust a shareUrl the result actually contains.',
        },
        description: {
          type: SchemaType.STRING,
          description: 'Updated description for the report metadata',
        },
        editInstruction: {
          type: SchemaType.STRING,
          description:
            'Natural language instruction for how to modify the report HTML (e.g., "change the color scheme to dark", "add a summary section at the top")',
        },
      },
      required: ['reportId'],
    },
  },
  {
    name: 'restoreReport',
    description:
      'Restore a report to its previous version (undo the last edit). Only works if the report was previously edited using updateReport. Use when an edit went wrong and the user wants to go back to the previous version.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        reportId: {
          type: SchemaType.STRING,
          description: 'The ID of the report to restore',
        },
      },
      required: ['reportId'],
    },
  },
  {
    name: 'deleteReport',
    description:
      'Permanently delete a report and its version history by ID. Interactive chat requires the exact action-bound confirmation phrase returned by the first call on a later user turn. Automated callers must set confirmed=true. This cannot be undone.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        reportId: {
          type: SchemaType.STRING,
          description: 'The ID of the report to delete',
        },
        confirmed: {
          type: SchemaType.BOOLEAN,
          description:
            'Explicit confirmation for automated callers. Interactive chat uses the server-issued exact phrase.',
        },
      },
      required: ['reportId'],
    },
  },
];

// ============================================================================
// Tool Executors
// ============================================================================

// ============================================================================
// draftReport
// ============================================================================

export interface ExecuteDraftReportContext {
  missionId?: string;
  userId?: string;
  slots?: Slot[];
  designBrief?: import('@/lib/schemas/design-brief').DesignBrief;
  /** Exact bundle parsed from the persisted mission input. */
  evidenceBundle?: import('@/lib/schemas/scout-bundle').ScoutBundle;
  evidenceProvenance?: import('@/lib/schemas/scout-bundle').EvidenceProvenanceReceipt;
}

export interface ExecuteDraftReportResult {
  success: boolean;
  path?: string;
  bytesWritten?: number;
  figurePlanSha256?: string;
  exportSha256?: string;
  exportBytes?: number;
  exportRevisionNumber?: number;
  exportStagedAt?: string;
  error?: string;
}

/**
 * Write a working draft of an HTML report to the local filesystem.
 *
 * Drafts live at `tmp/missions/<missionId>/<slotName>.html`. Idempotent —
 * re-calling overwrites the previous draft for the same slot. publishReport
 * (Task 8) reads the latest draft from this path.
 */
export async function executeDraftReport(
  args: { slotName: string; title?: string; html?: string; blocks?: string; figurePlan?: string },
  context: ExecuteDraftReportContext
): Promise<ExecuteDraftReportResult> {
  if (!context.missionId) {
    log.warn('draftReport called without missionId in context', { slotName: args.slotName });
    return {
      success: false,
      error: 'missionId not bound — draftReport is only valid within a mission orchestrator turn',
    };
  }
  // Validate slotName via slotSchema's name field.
  const nameCheck = slotSchema.shape.name.safeParse(args.slotName);
  if (!nameCheck.success) {
    return {
      success: false,
      error: `slotName invalid: ${nameCheck.error.errors[0].message}`,
    };
  }
  if (!args.html && !args.blocks) {
    return { success: false, error: 'draftReport requires either `html` (legacy) or `blocks` (template mode)' };
  }

  let figurePlan: import('@/lib/reports/figure-plan').FigurePlan | undefined;
  if (args.figurePlan) {
    try {
      const { parseFigurePlan } = await import('@/lib/reports/figure-plan');
      figurePlan = parseFigurePlan(args.figurePlan, context.evidenceBundle);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // COORD-011: a gate rejection that reaches only the model is invisible to the
      // operator. The tool CALL is logged, the tool RESULT is not, so a validator
      // that never converges looks identical to an agent choosing to redraft — that
      // makes repeated rejection look identical to voluntary redrafting. Return the
      // exact validation reason so the next draft can correct the offending field.
      log.warn('draftReport rejected figurePlan', {
        missionId: context.missionId,
        slotName: args.slotName,
        reason,
      });
      return { success: false, error: reason };
    }
  } else if (context.designBrief?.visualAmbition === 'rich-executive' && context.evidenceBundle) {
    return {
      success: false,
      error:
        'rich-executive research drafts require figurePlan so every analytical visual is bound to persisted findings and sources',
    };
  }
  const exactArtifactRequired =
    context.designBrief?.visualAmbition === 'rich-executive' && Boolean(context.evidenceBundle);
  if (exactArtifactRequired && !context.evidenceProvenance) {
    return {
      success: false,
      error: 'rich-executive research drafts require a persisted Firestore-resolution receipt for the evidence bundle',
    };
  }
  if (exactArtifactRequired && !args.title?.trim()) {
    return { success: false, error: 'rich-executive research drafts require title so the final export can be staged' };
  }

  // The composer is opt-in. Reject before parsing or touching either sibling:
  // accepting blocks here while publishReport followed the default HTML path
  // deleted a valid HTML draft and turned a paid mission into a redraft loop.
  if (args.blocks && !isReportComposerEnabled()) {
    return {
      success: false,
      error:
        'template mode is disabled; draftReport requires `html`. Do not retry with blocks unless REPORT AUTHORING MODE: template is explicitly present in the mission prompt.',
    };
  }

  // REPORT-012 T2.6 — structured-blocks draft (template mode). Validated HERE
  // so the agent gets actionable zod issues at draft time, not at publish.
  if (args.blocks) {
    const blocksPath = getBlocksPath(context.missionId, args.slotName);
    if (!blocksPath) {
      return { success: false, error: 'invalid missionId or slotName (path escape)' };
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(args.blocks);
    } catch (err) {
      return { success: false, error: `blocks is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
    const { reportBlocksDocSchema } = await import('@/lib/schemas/report-blocks');
    const parsed = reportBlocksDocSchema.safeParse(parsedJson);
    if (!parsed.success) {
      const issues = parsed.error.errors
        .slice(0, 8)
        .map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`)
        .join(' | ');
      return { success: false, error: `blocks failed schema validation — fix and re-draft: ${issues}` };
    }
    if (figurePlan) {
      const declared = new Set<string>();
      for (const block of parsed.data.blocks) {
        if (block.type === 'chart-ref' && block.figureId) declared.add(block.figureId);
        if (block.type === 'html-embed') {
          for (const match of block.html.matchAll(/<figure\b[^>]*data-figure-id\s*=\s*["']([^"']+)["']/gi)) {
            declared.add(match[1]);
          }
        }
      }
      const missing = figurePlan.filter((entry) => !declared.has(entry.figureId)).map((entry) => entry.figureId);
      if (missing.length > 0) {
        return {
          success: false,
          error: `figurePlan entries missing from blocks (set chart-ref.figureId or data-figure-id): ${missing.join(', ')}`,
        };
      }
    }
    await fs.mkdir(path.dirname(blocksPath), { recursive: true });
    await fs.writeFile(blocksPath, JSON.stringify(parsed.data), 'utf-8');
    const planPath = getFigurePlanPath(context.missionId, args.slotName);
    if (planPath) {
      if (figurePlan) await fs.writeFile(planPath, JSON.stringify(figurePlan), 'utf-8');
      else await fs.rm(planPath, { force: true });
    }
    // One ACTIVE draft per slot: a blocks draft supersedes any html draft so a
    // later publish can never resurrect stale content (adversarial review
    // 2026-07-20 — the REVISE flow republished old blocks otherwise).
    try {
      const htmlSibling = getDraftPath(context.missionId, args.slotName);
      if (htmlSibling) await fs.rm(htmlSibling, { force: true });
    } catch {
      // best-effort supersede — a missing sibling is the normal case
    }
    const bytesWritten = Buffer.byteLength(args.blocks, 'utf-8');
    log.info('blocks draft written', {
      missionId: context.missionId,
      slotName: args.slotName,
      path: blocksPath,
      blocks: parsed.data.blocks.length,
      bytesWritten,
    });
    const draftResult: ExecuteDraftReportResult = {
      success: true,
      path: blocksPath,
      bytesWritten,
      ...(figurePlan
        ? { figurePlanSha256: (await import('@/lib/reports/figure-plan')).figurePlanSha256(figurePlan) }
        : {}),
    };
    return stageDraftExportIfRequired(args, context, draftResult, exactArtifactRequired);
  }

  const filePath = getDraftPath(context.missionId, args.slotName);
  if (!filePath) {
    log.warn('draftReport rejected — path escapes DRAFT_ROOT', {
      missionId: context.missionId,
      slotName: args.slotName,
    });
    return { success: false, error: 'invalid missionId or slotName (path escape)' };
  }
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  let draftHtml = args.html as string;
  if (figurePlan) {
    try {
      const { bindFigurePlanToHtml } = await import('@/lib/reports/figure-plan');
      draftHtml = bindFigurePlanToHtml(draftHtml, figurePlan);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  await fs.writeFile(filePath, draftHtml, 'utf-8');
  const planPath = getFigurePlanPath(context.missionId, args.slotName);
  if (planPath) {
    if (figurePlan) await fs.writeFile(planPath, JSON.stringify(figurePlan), 'utf-8');
    else await fs.rm(planPath, { force: true });
  }
  // Symmetric supersede: an html draft (e.g. the platform's own REVISE turn,
  // which edits exact HTML) must beat any earlier blocks draft at publish.
  try {
    const blocksSibling = getBlocksPath(context.missionId, args.slotName);
    if (blocksSibling) await fs.rm(blocksSibling, { force: true });
  } catch {
    // best-effort supersede — a missing sibling is the normal case
  }
  const bytesWritten = Buffer.byteLength(draftHtml, 'utf-8');
  log.info('draft written', {
    missionId: context.missionId,
    slotName: args.slotName,
    path: filePath,
    bytesWritten,
  });
  const draftResult: ExecuteDraftReportResult = {
    success: true,
    path: filePath,
    bytesWritten,
    ...(figurePlan
      ? { figurePlanSha256: (await import('@/lib/reports/figure-plan')).figurePlanSha256(figurePlan) }
      : {}),
  };
  return stageDraftExportIfRequired(args, context, draftResult, exactArtifactRequired);
}

async function stageDraftExportIfRequired(
  args: { slotName: string; title?: string },
  context: ExecuteDraftReportContext,
  draftResult: ExecuteDraftReportResult,
  required: boolean
): Promise<ExecuteDraftReportResult> {
  if (!required) return draftResult;
  if (!context.missionId || !context.userId || !context.slots || !args.title) {
    return { success: false, error: 'exact export staging requires bound mission, owner, slots, and title context' };
  }
  const staged = await executePublishReport(
    { slotName: args.slotName, title: args.title, description: 'pre-publication export staging' },
    {
      missionId: context.missionId,
      userId: context.userId,
      slots: context.slots,
      designBrief: context.designBrief,
      evidenceBundle: context.evidenceBundle,
      evidenceProvenance: context.evidenceProvenance,
      stageOnly: true,
    }
  );
  if (!staged.success || !staged.stagedExport) {
    return { success: false, error: staged.error ?? 'final export staging failed' };
  }
  return {
    ...draftResult,
    exportSha256: staged.stagedExport.exportSha256,
    exportBytes: staged.stagedExport.bytes,
    exportRevisionNumber: staged.stagedExport.revisionNumber,
    exportStagedAt: staged.stagedExport.stagedAt,
  };
}

// ============================================================================
// publishReport
// ============================================================================

export interface ExecutePublishReportContext {
  missionId?: string;
  slots?: Slot[];
  /**
   * Effective userId for the call — for mission-bound calls this is
   * mission.userId (the dispatcher), resolved server-side by the MCP route.
   * Required so the published report can be stamped with the real owner
   * (not the orchestrator's 'system' identity).
   */
  userId?: string;
  /** Mission design brief — drives the design-pass soft gate (fail-open). */
  designBrief?: import('@/lib/schemas/design-brief').DesignBrief;
  evidenceBundle?: import('@/lib/schemas/scout-bundle').ScoutBundle;
  evidenceProvenance?: import('@/lib/schemas/scout-bundle').EvidenceProvenanceReceipt;
  /** Internal draftReport pre-publication staging pass; never persists. */
  stageOnly?: boolean;
}

export interface ExecutePublishReportResult {
  success: boolean;
  /**
   * REPORT-002: `reportUrl` is the authenticated private route. A fresh
   * publish is never publicly shared, so no share link is returned here —
   * sharing is a separate explicit approval (updateReport shared:true).
   */
  data?: { reportId: string; reportUrl: string; isUpsert: boolean };
  error?: string;
  /**
   * Design-review verdict for the published html (recorded, never blocks the
   * publish call). A non-PASS verdict retains the report as `needs-review`.
   * UNREVIEWED = the analyzer errored (visibly unreviewed, not a silent pass).
   */
  designPassVerdict?: 'PASS' | 'FAIL' | 'UNREVIEWED';
  /** Concrete design-review findings when the verdict is FAIL or UNREVIEWED. */
  designPassDetails?: string;
  /** REPORT-001 lifecycle status the artifact was persisted with (absent when no design review ran). */
  reviewStatus?: 'published' | 'needs-review';
  stagedExport?: {
    exportSha256: string;
    cssSha256: string;
    bytes: number;
    revisionNumber: number;
    stagedAt: string;
  };
}

/**
 * Promote the latest draft for a slot to Firestore.
 *
 * Validates: missionId bound (server-side, from context), slotName in mission
 * manifest, draft file exists. Reads HTML from FS, sanitizes, upserts via
 * `upsertReportBySlot` keyed on `(missionId, slotName)` so revisions overwrite
 * in place and `/share/report/<id>` URLs stay stable.
 */
export async function executePublishReport(
  args: {
    slotName: string;
    title: string;
    description: string;
    entityIds?: string[];
    expectedExportSha256?: string;
  },
  context: ExecutePublishReportContext
): Promise<ExecutePublishReportResult> {
  if (!context.missionId) {
    return { success: false, error: 'missionId not bound — publishReport requires mission context' };
  }
  if (!context.userId) {
    return { success: false, error: 'userId not bound — publishReport requires authenticated user context' };
  }
  // Preserve the authenticated owner across nested async resolver callbacks;
  // TypeScript cannot retain the guard on a mutable object property there.
  const ownerId = context.userId;
  const nameCheck = slotSchema.shape.name.safeParse(args.slotName);
  if (!nameCheck.success) {
    return { success: false, error: `slotName invalid: ${nameCheck.error.errors[0].message}` };
  }
  const slots = context.slots ?? [];
  const slotNames = slots.map((s) => s.name);
  if (!slotNames.includes(args.slotName)) {
    return {
      success: false,
      error: `slotName '${args.slotName}' not in manifest. Allowed: [${slotNames.join(', ')}]`,
    };
  }
  const filePath = getDraftPath(context.missionId, args.slotName);
  if (!filePath) {
    return { success: false, error: 'invalid missionId or slotName (path escape)' };
  }

  // REPORT-012 T2.6 — template mode: when the flag is on and a structured
  // blocks draft exists, the SERVER composes the design (brand template,
  // charts by reference, bounded image inlining) and verifies it with the
  // deterministic composer gate. Blockable: findings here are actionable
  // content/palette errors with ~zero false positives by construction.
  let html: string | undefined;
  let composed = false;
  if (isReportComposerEnabled()) {
    const blocksPath = getBlocksPath(context.missionId, args.slotName);
    if (blocksPath) {
      let blocksRaw: string | null = null;
      try {
        blocksRaw = await fs.readFile(blocksPath, 'utf-8');
      } catch {
        blocksRaw = null; // no structured draft — fall through to legacy html
      }
      if (blocksRaw) {
        try {
          const { reportBlocksDocSchema } = await import('@/lib/schemas/report-blocks');
          const doc = reportBlocksDocSchema.parse(JSON.parse(blocksRaw));
          const imageRefs = doc.blocks.filter((b) => b.type === 'image-ref').length;
          if (imageRefs > 2) {
            return {
              success: false,
              error: `composition rejected: ${imageRefs} image-ref blocks (max 2 per report — the stored document has a 1MB budget)`,
            };
          }
          const { composeReport } = await import('@/lib/reports/report-composer');
          const { verifyComposition } = await import('@/lib/reports/composer-verify');
          const { getChartSvg, getImageUrl } = await import('@/lib/super-graph/chart-cache');
          const { inlineImage } = await import('@/lib/reports/image-inline');
          const missionId = context.missionId;
          const brief =
            context.designBrief ?? (await import('@/lib/schemas/design-brief')).resolveDesignBrief(context.userId);
          const result = await composeReport({
            doc,
            brief,
            missionId,
            charts: (chartId) => getChartSvg(missionId, chartId),
            images: async (imageId) => {
              const url = await getImageUrl(missionId, imageId);
              if (!url) return null;
              try {
                return { dataUri: (await inlineImage(url, { ownerId })).dataUri };
              } catch (imgErr) {
                log.warn('image-ref inlining failed', {
                  missionId,
                  imageId,
                  error: imgErr instanceof Error ? imgErr.message : String(imgErr),
                });
                return null;
              }
            },
            generatedAt: new Date().toISOString(),
          });
          const verdict = verifyComposition(doc, brief, result.warnings, { strict: true });
          if (!verdict.ok) {
            const briefLevel = verdict.findings.filter((f) => f.startsWith('palette-contrast'));
            const contentLevel = verdict.findings.filter((f) => !f.startsWith('palette-contrast'));
            const guidance = [
              contentLevel.length > 0 ? `fix in the blocks draft: ${contentLevel.join(' | ')}` : '',
              briefLevel.length > 0
                ? `brief-level (NOT fixable by re-drafting — the mission's design palette fails contrast; use the default theme or ask for a palette change): ${briefLevel.join(' | ')}`
                : '',
            ]
              .filter(Boolean)
              .join(' || ');
            return { success: false, error: `composition verify failed — ${guidance}` };
          }
          html = result.html;
          composed = true;
          log.info('report composed for publish', {
            missionId,
            slotName: args.slotName,
            blocks: doc.blocks.length,
            warnings: result.warnings.length,
          });
        } catch (composeErr) {
          return {
            success: false,
            error: `composition failed: ${composeErr instanceof Error ? composeErr.message : String(composeErr)}`,
          };
        }
      }
    }
  }

  if (html === undefined) {
    try {
      html = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { success: false, error: `no draft for slot '${args.slotName}'. Call draftReport first.` };
      }
      return {
        success: false,
        error: `failed to read draft: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Bind the server-validated plan to the exact rendered form (legacy HTML or
  // composed blocks). The binder is idempotent, so a legacy draft already
  // stamped at draft time receives no duplicate provenance caption.
  if (/\bdata-figure-id\s*=/i.test(html)) {
    const planPath = getFigurePlanPath(context.missionId, args.slotName);
    if (!planPath) return { success: false, error: 'invalid missionId or slotName (figure-plan path escape)' };
    try {
      const planRaw = await fs.readFile(planPath, 'utf-8');
      const { figurePlanSchema, bindFigurePlanToHtml } = await import('@/lib/reports/figure-plan');
      const plan = figurePlanSchema.parse(JSON.parse(planRaw));
      html = bindFigurePlanToHtml(html, plan);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' && /\bdata-figure-plan-sha256\s*=/i.test(html)) {
        return { success: false, error: 'figurePlan binding failed: persisted plan sidecar is missing' };
      }
      if (code !== 'ENOENT') {
        return {
          success: false,
          error: `figurePlan binding failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
  }

  // REPORT-013 — the legacy (release-path) counterpart of the composer's
  // image-ref inlining. A draft references a generated image by the id the
  // image tool minted for THIS mission; publication resolves it through the
  // same owner-scoped `inlineImage` boundary into a bounded data: URI, which is
  // the only image form the publication policy and the viewer CSP allow.
  // Nothing here widens either: an id that cannot be resolved is converted to a
  // truthful diagnostic notice, then publication fails closed so a missing
  // visual never reaches a reader-facing artifact.
  let imageEmbedFailures: { imageId: string; reason: string }[] = [];
  if (!composed) {
    try {
      const { resolveReportImageEmbeds } = await import('@/lib/reports/report-image-embed');
      const { getImageUrl } = await import('@/lib/super-graph/chart-cache');
      const { inlineImage } = await import('@/lib/reports/image-inline');
      const missionIdForImages = context.missionId;
      const embedded = await resolveReportImageEmbeds(html, {
        resolveImageUrl: (imageId) => getImageUrl(missionIdForImages, imageId),
        inlineImage: async (url, maxBytes) =>
          inlineImage(url, maxBytes === undefined ? { ownerId } : { ownerId, maxBytes }),
      });
      html = embedded.html;
      imageEmbedFailures = embedded.failures;
      if (embedded.embedded > 0 || embedded.failures.length > 0) {
        log.info('legacy report image embedding', {
          missionId: context.missionId,
          slotName: args.slotName,
          embedded: embedded.embedded,
          bytes: embedded.bytes,
          failures: embedded.failures.length,
        });
      }
      if (imageEmbedFailures.length > 0) {
        return {
          success: false,
          error: [
            'image embedding failed; regenerate the missing visual or remove the unsupported figure before publication',
            ...imageEmbedFailures.map((failure) => `${failure.imageId}: ${failure.reason}`),
          ].join(' | '),
        };
      }
    } catch (embedErr) {
      // A draft over the image cap is an authoring error the agent can fix.
      return {
        success: false,
        error: `image embedding rejected: ${embedErr instanceof Error ? embedErr.message : String(embedErr)}`,
      };
    }
  }

  // REPORT-013: the composer escapes source URLs as it renders them, so composed
  // reports were already publishable. Legacy drafts are author-written, and a
  // legitimate source carrying a `?url=https://…` parameter matches the gate's
  // external-resource rule and refuses the WHOLE report. Normalize the one
  // element the cite-ieee contract defines as plain source text so both
  // authoring paths expose the same full, copyable URL, then make the emitted
  // reference list navigable.
  //
  // A well-formed IEEE reference list still needs `id="ref-N"` targets so
  // in-text markers can reach their entries. The anchor
  // normalizer links markers to entries the author already wrote — fragment-only,
  // idempotent, and inert for any marker with no matching entry, so it can never
  // mint a dangling citation the integrity gate would then refuse.
  if (!composed) {
    html = normalizeSourceUrlText(html);
    html = normalizeReferenceAnchors(html);
  }

  const sanitized = sanitizeReportHtml(html);
  try {
    assertReportPublicationConformance(sanitized);
  } catch (error) {
    if (error instanceof ReportPublicationConformanceError) {
      return { success: false, error: error.message };
    }
    throw error;
  }

  // Theme first, then review the bytes that will actually be persisted. The
  // platform-generated suffix is excluded only from author-ownership checks
  // (otherwise our own :root variables look like agent shadowing); contrast is
  // evaluated over the complete final document, including that suffix.
  let themedHtml = sanitized;
  if (context.designBrief && !composed) {
    const { applyPageTheme } = await import('@/lib/report-theme');
    themedHtml = applyPageTheme(sanitized, context.designBrief);
  }
  // The analyzer's link/provenance checks run against the authored+themed
  // document, before the trusted product exporter replaces the canonical link
  // with CSS bytes — which is why the link check is authoring-method
  // TELEMETRY, never withholding authority (COORD-017): the export inlines
  // the brand CSS whether or not the authored bytes carried the link.
  // Geometry/contrast below still inspect the exact export.
  const brandReviewHtml = themedHtml;
  const exactArtifactRequired =
    context.designBrief?.visualAmbition === 'rich-executive' && Boolean(context.evidenceBundle);
  let exactArtifactIdentity: StagedExportReceipt | undefined;
  if (context.stageOnly) {
    try {
      if (exactArtifactRequired) {
        if (!context.evidenceBundle || !context.evidenceProvenance) {
          throw new Error('persisted evidence bundle and Firestore-resolution receipt are required');
        }
        const { verifyPublishedReportEvidence } = await import('@/lib/reports/evidence-provenance');
        const evidence = verifyPublishedReportEvidence(themedHtml, context.evidenceBundle, context.evidenceProvenance);
        if (!evidence.ok) throw new Error(`evidence verification failed: ${evidence.errors.join('; ')}`);
      }
      const staged = await stageFinalExport({
        missionId: context.missionId,
        slotName: args.slotName,
        title: args.title,
        html: themedHtml,
        oneRevisionOnly: exactArtifactRequired,
      });
      return {
        success: true,
        stagedExport: {
          exportSha256: staged.receipt.exportSha256,
          cssSha256: staged.receipt.cssSha256,
          bytes: staged.receipt.bytes,
          revisionNumber: staged.receipt.revisionNumber,
          stagedAt: staged.receipt.stagedAt,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `final export staging failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  if (exactArtifactRequired) {
    if (!args.expectedExportSha256 || !/^[a-f0-9]{64}$/.test(args.expectedExportSha256)) {
      return {
        success: false,
        error:
          'rich-executive research publication requires the exact 64-character exportSha256 returned by draftReport',
      };
    }
    try {
      const verified = await verifyStagedExport({
        missionId: context.missionId,
        slotName: args.slotName,
        title: args.title,
        html: themedHtml,
        expectedExportSha256: args.expectedExportSha256,
      });
      await assertExactArtifactReviews(context.missionId, verified.receipt);
      themedHtml = verified.html;
      exactArtifactIdentity = verified.receipt;
      assertReportPublicationConformance(themedHtml, { trustProductStyles: true });
    } catch (error) {
      return {
        success: false,
        error: `exact artifact verification failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  // REPORT-015: the analyzer now excludes platform-owned style blocks itself
  // (`<style data-design-pass="page-theme">` / `<style data-composer="v1">`), so
  // every caller — this publish gate, the L1 soft check, the quality rubric —
  // agrees on what "author-owned CSS" means. The previous per-call-site slice
  // used string `endsWith` and protected only this one path, which is why the
  // stored artifact still recorded `no-variable-shadowing` for the server's own
  // `:root`. Contrast is still evaluated over the COMPLETE themed document.
  // REPORT-001/REPORT-003 design-review gate — runs on EVERY HTML publish,
  // designBrief or not. A brief-less publish must not skip the gate. The publish
  // itself is never BLOCKED (a gate bug must not stop the mission), but a
  // report whose design review did not PASS is retained as `needs-review` —
  // withheld from the public share surface, owner-visible with its findings —
  // rather than shipping as a final report. An analyzer ERROR is treated as
  // UNREVIEWED (visibly unreviewed, still withheld) — never silently a PASS.
  //
  // Only HARD violations fail the review: brand violations (analyzer `!ok`)
  // and confident WCAG-contrast failures below 3.0:1 (REPORT-003 —
  // report-design-contrast.ts). Advisories (chart palette, 3.0–4.5 contrast)
  // are recorded for visibility but never withhold — mirroring the L1 brand
  // check, so a report the mission never REVISEs isn't left permanently
  // invisible with no recovery path.
  let designPassVerdict: 'PASS' | 'FAIL' | 'UNREVIEWED' | undefined;
  let designPassDetails: string | undefined;
  // T1.1 (REPORT-011): deterministic hard-contrast violations withhold the
  // artifact. Brand-analyzer violations were telemetry while the writer had
  // not been given the corresponding rules. REPORT-015 gives it the brief,
  // so the two checks it makes satisfiable are armed again below; the rest stay
  // recorded-only.
  let designWithhold = false;
  {
    try {
      const { analyzeCreatorBrand } = await import('@/lib/mission-quality/analyzers/creator-brand-analyzer');
      const { analyzeReportContrast } = await import('@/lib/mission-quality/analyzers/report-design-contrast');
      const v = analyzeCreatorBrand(brandReviewHtml, context.designBrief);
      const contrast = analyzeReportContrast(themedHtml);
      const violations = [...(v.ok ? [] : v.violations), ...contrast.violations];
      const advisories = [...(v.advisories ?? []), ...contrast.advisories];
      designPassVerdict = violations.length > 0 ? 'FAIL' : 'PASS';
      // REPORT-015: brand checks may withhold ONLY when the writer was handed the
      // exact value they require AND the check measures the final pixels.
      // COORD-017 disarmed `brand-stylesheet-linked`: the product exporter
      // strips every <link> and inlines the brand CSS bytes unconditionally,
      // so the authored link is an export/materialization marker that cannot
      // change a rendered pixel — withholding a pixel-identical artifact on it
      // was a pure false-positive class (byte-identical exports proved it).
      // It stays recorded in designPassVerdict/designPassDetails and in the
      // L1 REVISE loop. `no-variable-shadowing` remains armed because
      // authored CSS SURVIVES into the export and a shadowed brand token does
      // change pixels. Arming rules the writer cannot satisfy — or that the
      // export makes irrelevant — is what stranded 16/16 reports in
      // needs-review. Armed only when a brief actually reached the writer.
      const armedBrandViolations = context.designBrief
        ? (v.ok ? [] : v.violations).filter((violation) => violation.check === 'no-variable-shadowing')
        : [];
      designWithhold = contrast.violations.length > 0 || armedBrandViolations.length > 0;
      const allIssues = [...violations, ...advisories];
      if (allIssues.length > 0) {
        // Record every issue (advisories included) for visibility, but the
        // verdict/withholding above is driven by hard violations only.
        designPassDetails = allIssues
          .map((i) => `${i.check}: ${i.detail}`)
          .join(' | ')
          .slice(0, 1000);
        if (violations.length > 0) {
          log.warn('design-review gate: report failed design review — retained as needs-review draft', {
            missionId: context.missionId,
            slotName: args.slotName,
            designPassDetails,
          });
        }
      }
    } catch (err) {
      // A gate error must not block publish, but it must NOT read as a pass —
      // mark it visibly UNREVIEWED so the artifact is withheld, not shipped
      // as if it had passed design review.
      designPassVerdict = 'UNREVIEWED';
      designWithhold = true; // cannot rule out a hard-contrast defect → withhold
      designPassDetails =
        `design review could not be completed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 1000);
      log.warn('design-review gate errored — report retained as needs-review (unreviewed)', {
        missionId: context.missionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Withholding is driven by designWithhold: hard contrast, an unreviewed
  // analyzer error, or one of the two armed brand checks. A FAIL verdict from
  // the recorded-only brand checks still publishes with the verdict retained.
  const reviewStatus: 'published' | 'needs-review' | undefined =
    designPassVerdict === undefined ? undefined : designWithhold ? 'needs-review' : 'published';

  let result: Awaited<ReturnType<typeof upsertReportBySlot>>;
  try {
    result = await upsertReportBySlot({
      missionId: context.missionId,
      slotName: args.slotName,
      title: args.title,
      description: args.description,
      html: themedHtml,
      createdBy: 'agent',
      ownerId: context.userId,
      agentType: 'creator',
      entityIds: args.entityIds ?? [],
      // DISC-014: attribute a revision's captured version to the creator agent.
      savedBy: 'agent:creator',
      ...(reviewStatus ? { reviewStatus } : {}),
      ...(designPassVerdict ? { designPassVerdict } : {}),
      ...(designPassDetails ? { designPassDetails } : {}),
      ...(exactArtifactIdentity
        ? {
            artifactIdentity: {
              sha256: exactArtifactIdentity.exportSha256,
              cssSha256: exactArtifactIdentity.cssSha256,
              bytes: exactArtifactIdentity.bytes,
              stagedAt: exactArtifactIdentity.stagedAt,
              revisionNumber: exactArtifactIdentity.revisionNumber,
              reviewedBy: ['design-pass', 'critique-report'] as const,
              evidenceBundleSha256: context.evidenceProvenance!.bundleSha256,
            },
          }
        : {}),
    });
  } catch (err) {
    // UX-021: executable/off-origin HTML is rejected at publication. Return the
    // actionable conversion guidance as a normal tool error so the agent can
    // regenerate a static report (inline <svg>, data: images) and retry.
    if (err instanceof ReportPublicationError) {
      return { success: false, error: err.message };
    }
    // REPORT-013: a citation that resolves to nothing is an authoring error the
    // agent can fix, so return the guidance instead of failing the mission.
    if (err instanceof ReportReferenceIntegrityError) {
      return { success: false, error: err.message };
    }
    throw err;
  }
  log.info('report published', {
    missionId: context.missionId,
    slotName: args.slotName,
    reportId: result.reportId,
    isUpsert: result.isUpsert,
    htmlBytesIn: Buffer.byteLength(html),
    htmlBytesOut: Buffer.byteLength(sanitized),
    designPassVerdict,
  });
  return {
    success: true,
    data: result,
    ...(designPassVerdict ? { designPassVerdict } : {}),
    ...(designPassDetails ? { designPassDetails } : {}),
    ...(reviewStatus ? { reviewStatus } : {}),
  };
}

// ============================================================================
// listReports
// ============================================================================

export interface ListReportsResult {
  reports: Array<{
    id: string;
    title: string;
    description: string;
    createdAt: string;
    createdBy: string;
    agentType?: string;
    missionId?: string;
    /** REPORT-002: one truthful lifecycle state (needs-review | private | shared). */
    state: ReportLifecycleState;
    /** Authenticated private route — always valid for the owner. */
    reportUrl: string;
    /** Public link — present ONLY when the persisted doc is verifiably shared. */
    shareUrl?: string;
  }>;
}

/**
 * List reports ordered by creation date (newest first).
 *
 * Returns metadata only — HTML content is intentionally excluded
 * because it is too large for the chat context window.
 *
 * @param args.limit - Maximum reports to return (default: 10, max: 50)
 */
/**
 * Per-call context for the platform-side report tools. Carried in from the
 * MCP route via the orchestrator's apiKey → userId mapping. Without this,
 * any caller could read/update/delete any user's reports (C4).
 */
export interface ExecuteReportToolContext {
  userId: string;
  principal?: 'human' | 'machine';
  requestId?: string;
  confirmationText?: string;
  /**
   * REPORT-004: bound mission id for orchestrator/revision turns. Gates
   * getReportById's includeHtml — exact persisted HTML is returned only for
   * reports belonging to THIS mission (owner check still applies).
   */
  missionId?: string;
}

export async function executeListReports(
  args: { limit?: number },
  context: ExecuteReportToolContext
): Promise<ListReportsResult> {
  if (!context?.userId) {
    log.warn('listReports called without userId — rejecting');
    throw new Error('listReports requires an authenticated user context');
  }
  const limit = Math.min(args.limit ?? 10, 50);

  // SEC-009: one ownership boundary — the same owner-scoped service listing
  // the /api/reports route uses (which also owns the single read-boundary
  // title decode; a second decode here would double-decode). Newest-first,
  // bounded in Firestore so a large catalog is never fully read for chat.
  const items = await listReportsOwnedBy(context.userId, { limit });

  return {
    reports: items.map((data) => {
      const state = reportLifecycleState(data);
      return {
        id: data.id,
        title: data.title,
        description: data.metadata?.description ?? '',
        createdAt: data.createdAt,
        createdBy: data.createdBy,
        agentType: data.agentType,
        missionId: data.missionId,
        state,
        reportUrl: `/reports/${data.id}`,
        // REPORT-002: never advertise a /share link that would render
        // "Report Not Shared" — only verifiably shared reports carry one.
        ...(state === 'shared' ? { shareUrl: `/share/report/${data.id}` } : {}),
      };
    }),
  };
}

// ============================================================================
// getReportById
// ============================================================================

export interface GetReportByIdResult {
  found: boolean;
  report?: {
    id: string;
    title: string;
    description: string;
    createdAt: string;
    createdBy: string;
    agentType?: string;
    missionId?: string;
    entityIds: string[];
    /** REPORT-002: one truthful lifecycle state (needs-review | private | shared). */
    state: ReportLifecycleState;
    /** Authenticated private route — always valid for the owner. */
    reportUrl: string;
    /** Public link — present ONLY when the persisted doc is verifiably shared. */
    shareUrl?: string;
    /** REPORT-004: exact persisted HTML — mission-bound includeHtml only. */
    html?: string;
    /** REPORT-004: sha256 of the returned html (revision-reference identity). */
    htmlSha256?: string;
  };
}

/**
 * Get a single report by ID, returning metadata without HTML.
 *
 * @param args.reportId - The Firestore document ID of the report
 */
export async function executeGetReportById(
  args: { reportId: string; includeHtml?: boolean },
  context: ExecuteReportToolContext
): Promise<GetReportByIdResult> {
  if (!context?.userId) {
    log.warn('getReportById called without userId — rejecting', { reportId: args.reportId });
    throw new Error('getReportById requires an authenticated user context');
  }
  // SEC-009: owner-scoped service read — absent, foreign, and ownerless
  // reports are one indistinguishable found:false (no existence leak).
  const data = await getReportOwnedBy(args.reportId, context.userId);
  if (!data) {
    log.warn('getReportById denied (missing or not owned)', {
      reportId: args.reportId,
      requestedBy: context.userId,
    });
    return { found: false };
  }
  const state = reportLifecycleState(data);
  // REPORT-004: exact-HTML loading for the revision context. Gated to the
  // BOUND mission's own reports so chat calls (and other missions) never pull
  // megabyte HTML bodies into their context by accident.
  const htmlAllowed =
    args.includeHtml === true &&
    Boolean(context.missionId) &&
    data.missionId === context.missionId &&
    Boolean(data.html);
  const htmlFields = htmlAllowed
    ? {
        html: data.html,
        htmlSha256: createHash('sha256').update(data.html, 'utf8').digest('hex'),
      }
    : {};
  return {
    found: true,
    report: {
      id: data.id,
      // Title already decoded once at the service read boundary.
      title: data.title,
      description: data.metadata?.description ?? '',
      createdAt: data.createdAt,
      createdBy: data.createdBy,
      agentType: data.agentType,
      missionId: data.missionId,
      entityIds: data.entityIds ?? [],
      state,
      reportUrl: `/reports/${data.id}`,
      ...(state === 'shared' ? { shareUrl: `/share/report/${data.id}` } : {}),
      ...htmlFields,
    },
  };
}

// ============================================================================
// updateReport
// ============================================================================

export interface UpdateReportResult {
  success: boolean;
  reportId: string;
  /** Authenticated private route — always valid for the owner. */
  reportUrl: string;
  /** REPORT-002: persisted lifecycle state AFTER the update (re-read, not assumed). */
  state: ReportLifecycleState;
  /**
   * Public link — present ONLY when the RE-READ persisted document has
   * shared === true and is not a needs-review draft. Callers must treat its
   * absence as "no public link exists".
   */
  shareUrl?: string;
  updatedFields: string[];
}

/**
 * Update an existing report. Supports changing metadata fields and
 * AI-driven HTML editing via an editInstruction prompt.
 *
 * @param args.reportId - The Firestore document ID of the report to update
 * @param args.title - New title (optional)
 * @param args.shared - Whether the report is publicly shared (optional)
 * @param args.description - Updated metadata description (optional)
 * @param args.editInstruction - Natural language instruction for AI HTML editing (optional)
 */
export async function executeUpdateReport(
  args: {
    reportId: string;
    title?: string;
    shared?: boolean;
    description?: string;
    editInstruction?: string;
  },
  context: ExecuteReportToolContext
): Promise<UpdateReportResult> {
  if (!context?.userId) {
    log.warn('updateReport called without userId — rejecting', { reportId: args.reportId });
    throw new Error('updateReport requires an authenticated user context');
  }
  const { reportId, title, shared, description, editInstruction } = args;

  // SEC-009: owner preflight through the one service boundary. Same error
  // shape as the not-found path so we don't leak existence to callers
  // without ownership; the write below ALSO re-checks inside its transaction
  // via requireOwnerId (no TOCTOU window).
  const owned = await getReportOwnedBy(reportId, context.userId);
  if (!owned) {
    log.warn('updateReport denied (owner mismatch or missing)', {
      reportId,
      requestedBy: context.userId,
    });
    throw new Error(`Report ${reportId} not found`);
  }

  // REPORT-002: public sharing is unavailable for review drafts. Refuse with
  // the concrete repair path instead of letting the service throw, so the
  // Assistant can relay what the user must do. (The service enforces the same
  // rule inside its transaction — this is the friendly message, not the gate.)
  if (shared === true && reportLifecycleState(owned) === 'needs-review') {
    throw new Error(
      `Report ${reportId} is a needs-review draft and cannot be publicly shared. ` +
        'Review it at /reports/' +
        reportId +
        ' and approve it (set reviewStatus to published) before sharing.'
    );
  }

  // Build the update input for the reports.ts chokepoint. Delegating the write
  // (rather than a direct db.update here) means version-history capture,
  // previousHtml backup, and the design-review gate all happen in ONE place —
  // and this edit is captured into history attributed to the acting user.
  // `title` is passed RAW: updateReportSchema decodes it once (a pre-decode here
  // would double-decode).
  const updateInput: UpdateReportInput = {};
  const updatedFieldNames: string[] = [];
  if (title !== undefined) {
    updateInput.title = title;
    updatedFieldNames.push('title');
  }
  if (shared !== undefined) {
    updateInput.shared = shared;
    updatedFieldNames.push('shared');
  }
  if (description !== undefined) {
    updateInput.metadata = { description };
    updatedFieldNames.push('metadata.description');
  }

  // AI-driven HTML edit — operates on the html the owner preflight just read.
  if (editInstruction) {
    const currentHtml = owned.html ?? '';

    if (!currentHtml) {
      throw new Error(`Report ${reportId} has no HTML content to edit`);
    }

    const { generateContent } = await import('@/lib/ai/client');
    const { geminiProModel } = await import('@/lib/ai/model-config');
    const prompt = `You are an expert HTML report editor. Your job is to apply TARGETED edits to an existing HTML report.

CRITICAL RULES:
1. Return the COMPLETE, FULL HTML document — every section, every paragraph, every element.
2. Only modify what the user's instruction asks for. Do NOT remove, shorten, or summarize any other content.
3. The output HTML must be at LEAST as long as the input (unless the user explicitly asked to remove something).
4. Return ONLY the HTML. No markdown fences (\`\`\`), no explanation, no preamble.
5. Preserve ALL inline CSS, all <style> blocks, all data attributes.
6. If you cannot fit the full document, DO NOT truncate — instead return exactly the original HTML unchanged.
7. Preserve the <style data-design-pass="page-theme"> block and all :root CSS variables EXACTLY — they carry the report's brand theme. Only change them if the user's instruction explicitly asks to change the theme, colours, or palette.

The original HTML is ${currentHtml.length.toLocaleString()} characters long. Your output MUST be close to that length (within 20% unless the user asked to add or remove sections).

--- CURRENT HTML START ---
${currentHtml}
--- CURRENT HTML END ---

User instruction: ${editInstruction}`;

    // Size the output budget to the report: a full rewrite must emit the WHOLE
    // document, but generateContent defaults to 8192 output tokens — far short of
    // a real report (~69KB ≈ 20–30K tokens), so the model truncated and the
    // content-loss guard below then rejected every edit. ~2 chars/token
    // over-allocates so we never clip; capped at the model's 65536 ceiling.
    const editMaxTokens = Math.min(65536, Math.max(16384, Math.ceil(currentHtml.length / 2)));
    const result = await generateContent(prompt, {
      model: geminiProModel() as GeminiModel,
      maxOutputTokens: editMaxTokens,
    });
    const newHtml = sanitizeReportHtml(result.trim());

    // Content-loss guard. Byte length alone conflates a legitimate restyle/reflow
    // (a light-theme switch or image-embed can SHRINK the HTML — less CSS, tighter
    // prose) with real truncation. So we gate on STRUCTURE (heading count) plus a
    // catastrophic floor, and we do NOT reject a structure-preserving style edit
    // just because it got shorter. This unblocks legitimate "switch to white
    // background / embed the infographics" edits that the old 50% byte gate killed.
    const countHeadings = (html: string): number => (html.match(/<h[1-3][\s>]/gi) ?? []).length;
    const origHeadings = countHeadings(currentHtml);
    const newHeadings = countHeadings(newHtml);
    const removalRequested = /\b(remove|delete|drop|shorten|trim|cut|condense|summari[sz]e)\b/i.test(editInstruction);
    const catastrophic = newHtml.length < Math.floor(currentHtml.length * 0.1) || newHtml.length < 200;
    const structureLost = origHeadings > 0 && newHeadings < Math.ceil(origHeadings * 0.7) && !removalRequested;

    if (catastrophic || structureLost) {
      const reason = catastrophic
        ? `output is only ${Math.round((newHtml.length / Math.max(1, currentHtml.length)) * 100)}% of the original size`
        : `section count dropped from ${origHeadings} to ${newHeadings}`;
      log.warn('AI edit appears to have lost content — rejecting to protect the report', {
        reportId,
        originalLength: currentHtml.length,
        newLength: newHtml.length,
        origHeadings,
        newHeadings,
        reason,
      });
      throw new Error(
        `The edit was rejected because ${reason}, which likely means content was lost. ` +
          `The original report is unchanged. If you intended a full restyle, keep all sections/headings; ` +
          `if you intended to remove content, say so explicitly in the instruction.`
      );
    }

    updateInput.html = newHtml;
    updatedFieldNames.push('html');
  }

  // Delegate to the reports.ts chokepoint (transactional: captures the outgoing
  // html into version history + keeps the previousHtml backup), attributing the
  // edit to the acting user and re-enforcing ownership inside the transaction.
  await updateReport(reportId, updateInput, {
    savedBy: `user:${context.userId}`,
    requireOwnerId: context.userId,
  });

  // REPORT-002: report the PERSISTED state, not the requested one. The share
  // link is emitted only after re-reading the document and verifying
  // shared === true actually landed on a non-draft report.
  const persisted = await getReportOwnedBy(reportId, context.userId);
  const state = persisted ? reportLifecycleState(persisted) : 'private';

  log.info('Report updated via AI tool', { reportId, fields: updatedFieldNames, state });
  return {
    success: true,
    reportId,
    reportUrl: `/reports/${reportId}`,
    state,
    ...(state === 'shared' ? { shareUrl: `/share/report/${reportId}` } : {}),
    updatedFields: updatedFieldNames,
  };
}

// ============================================================================
// restoreReport
// ============================================================================

export interface RestoreReportResult {
  success: boolean;
  reportId: string;
  message: string;
}

/**
 * Restore a report to its previous version by swapping html and previousHtml.
 *
 * @param args.reportId - The Firestore document ID of the report to restore
 */
export async function executeRestoreReport(
  args: { reportId: string },
  context: ExecuteReportToolContext
): Promise<RestoreReportResult> {
  if (!context?.userId) {
    log.warn('restoreReport called without userId — rejecting', { reportId: args.reportId });
    throw new Error('restoreReport requires an authenticated user context');
  }

  // Delegate to the reports.ts chokepoint (transactional: also snapshots the
  // current head into version history before swapping, so the restore is never
  // destructive) and attribute it to the acting user. SEC-009: ownership is
  // enforced inside the same transaction; absent, foreign, and ownerless
  // reports share one not-found. A missing backup stays a soft failure,
  // matching this tool's original contract.
  try {
    await restoreReportVersion(args.reportId, {
      savedBy: `user:${context.userId}`,
      requireOwnerId: context.userId,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Report not found') {
      log.warn('restoreReport denied (owner mismatch or missing)', {
        reportId: args.reportId,
        requestedBy: context.userId,
      });
      throw new Error(`Report ${args.reportId} not found`);
    }
    if (error instanceof Error && error.message === 'No previous version available') {
      return {
        success: false,
        reportId: args.reportId,
        message:
          'No previous version available. The report has not been edited via updateReport, or the backup was already used.',
      };
    }
    throw error;
  }

  log.info('Report restored to previous version', { reportId: args.reportId });

  return {
    success: true,
    reportId: args.reportId,
    message:
      'Report restored to the previous version. You can undo this restore by calling restoreReport again (it swaps back and forth).',
  };
}

// ============================================================================
// deleteReport
// ============================================================================

export interface DeleteReportArgs {
  reportId?: unknown;
  confirmed?: unknown;
}

interface DeleteReportMutationData {
  mutatedEntityTypes: ['report'];
}

export type DeleteReportResult =
  | { success: true; reportId: string; mutatedEntityTypes: ['report'] }
  | { success: false; error: string; data?: DestructiveGateRefusal | DeleteReportMutationData };

/**
 * Permanently delete a report by its ID.
 *
 * @param args.reportId - The Firestore document ID of the report to delete
 */
export async function executeDeleteReport(
  args: DeleteReportArgs,
  context: ExecuteReportToolContext
): Promise<DeleteReportResult> {
  if (!context?.userId) {
    log.warn('deleteReport called without userId — rejecting', { reportId: args.reportId });
    throw new Error('deleteReport requires an authenticated user context');
  }

  const reportId = normalizeDestructiveIdentifier(args.reportId);
  if (!reportId) {
    return { success: false, error: 'A non-empty report ID is required for deletion.' };
  }

  const gate = confirmDestructiveAction({
    fingerprint: destructiveActionFingerprint('deleteReport', reportId),
    summary: `delete report "${reportId}" and its version history`,
    confirmed: args.confirmed === true ? true : undefined,
    principal: context.principal,
    userId: context.userId,
    requestId: context.requestId,
    confirmationText: context.confirmationText,
  });
  if (!gate.ok) {
    return { success: false, error: gate.error, data: gate.data };
  }

  // SEC-009: owner check before delete through the one service boundary.
  // Same error shape as not-found so non-owners cannot probe for the
  // existence of other users' reports.
  const owned = await getReportOwnedBy(reportId, context.userId);
  if (!owned) {
    log.warn('deleteReport denied (owner mismatch or missing)', {
      reportId,
      requestedBy: context.userId,
    });
    throw new Error(`Report ${reportId} not found`);
  }
  try {
    await deletePersistedReport(reportId);
    log.info('Report deleted via AI tool', { reportId });
    return { success: true, reportId, mutatedEntityTypes: ['report'] };
  } catch (error) {
    // recursiveDelete can reject after removing part of the tree. Report the
    // possible mutation so callers invalidate caches and re-read Firestore.
    log.error('Report deletion failed after ownership verification', error instanceof Error ? error : undefined, {
      reportId,
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete report',
      data: { mutatedEntityTypes: ['report'] },
    };
  }
}
