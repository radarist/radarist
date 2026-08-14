/**
 * @file ai/tools/signal-management.ts
 * @description Signal management tools for AI Assistant
 *
 * Provides capabilities for:
 * - Listing and filtering signals
 * - Approving signals
 * - Rejecting signals
 * - Importing signals as entities
 * - Expanding signal information
 *
 * @author Radarist Team
 * @created 2025-12-02
 */

import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';
import {
  adminGetSignals,
  adminGetSignalById,
  adminApproveSignal,
  adminRejectSignal,
  adminUpdateSignal,
  adminCreateSignal,
  adminMarkSignalAsImported,
} from '@/lib/signals-admin';
import { adminCreateTechnology, adminGetTechnologies } from '@/lib/technology-admin';
import {
  adminCreateRadarPlacementWithHandoff,
  PlacementAuthorizationError,
  type PlacementGraphHandoff,
} from '@/lib/radar-placement-admin';
import {
  adminListRadars,
  adminGetRadarById,
  adminGetOwnedRadarById,
  RadarAuthorizationError,
} from '@/lib/radars-admin';
import { emitDataRefresh } from '@/lib/events/data-refresh';
import { calculateTrustScore } from '@/lib/signals/trust-score';
import { canonicalHttpUrl } from '@/lib/signals/source-identity';
import { normalizeVerifiedEvidence } from '@/lib/signals/verified-evidence';
import { expandSignal } from '@/lib/signals/expand-signal';
import { queueEnrichOnLike } from '@/lib/signals/enrich-on-like';
import { fuzzySearch } from '@/lib/fuzzy-search';
import {
  resolveQuadrantReference,
  type Signal,
  type SignalStatus,
  type SignalType,
  type Ring,
  type Status,
  type TimeToImpact,
} from '@/lib/types';
import { createLogger } from '@/lib/logger';
import { SYSTEM_PRINCIPAL } from '@/lib/system-principals';
import { SIGNAL_STATUS_VALUES, resolveSignalStatus, signalStatusList } from '@/lib/ai/tool-vocabulary';

const log = createLogger('ai/signal-mgmt');

// ============================================================================
// Tool Definitions for Signal Management
// ============================================================================

export const SIGNAL_MANAGEMENT_TOOLS: FunctionDeclaration[] = [
  {
    name: 'listSignals',
    description: `List and filter technology signals detected by the system. Signals are early indicators of emerging technologies, companies, trends, and innovations.

Use this tool when user asks about:
- "What signals do we have?" → List all signals
- "Show me pending signals" → List signals with status='Detected'
- "What patents were detected?" → List signals with type='patent'
- "Show approved signals" → List signals with status='Approved'
- "Find signals about AI" → Search for AI-related signals

SIGNAL TYPES: patent, paper, news, funding, github, trend
SIGNAL STATUSES: ${signalStatusList()}`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        status: {
          type: SchemaType.STRING,
          format: 'enum',
          enum: [...SIGNAL_STATUS_VALUES],
          description: `Filter by status: ${signalStatusList()}`,
        },
        type: {
          type: SchemaType.STRING,
          description:
            "Filter by type: 'patent', 'paper' (research), 'news', 'funding' (investments), 'github' (repos), 'trend'",
        },
        search: {
          type: SchemaType.STRING,
          description: 'Search query to match against signal titles and descriptions',
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Maximum number of signals to return (default: 10, max: 50)',
        },
        sortBy: {
          type: SchemaType.STRING,
          description: "Sort by: 'date' (newest first), 'relevance', 'alignment' (strategic fit)",
        },
      },
    },
  },
  {
    name: 'approveSignalForImport',
    description: `Approve a signal and mark it for import into the platform as an entity. Use this when a signal represents valuable technology, company, or use case to track.

WHEN TO USE THIS TOOL:
- "Approve this signal" or "Accept [signal title]"
- "Import this as a technology" or "Add this to our tech radar"
- "This looks interesting, let's track it"
- When user reviews signals and wants to accept one
- After reviewing signal details and deciding it's worth tracking

WORKFLOW:
1. listSignals (find pending signals)
2. getSignalDetails (review a specific signal)
3. approveSignalForImport (accept it) OR rejectSignalWithReason (decline it)

IMPORT TYPES:
- technology: Signal represents a tool, framework, platform, or tech
- company: Signal is about a startup, vendor, or organization
- useCase: Signal describes a problem/solution or application

EXAMPLE - Approve and import as technology:
{
  "signalId": "sig_abc123",
  "importAs": "technology",
  "notes": "Promising AI framework with strong community adoption"
}

EXAMPLE - Simple approval without import type:
{
  "signalId": "sig_abc123",
  "notes": "Relevant to our AI strategy"
}

TIP: If user doesn't specify import type, approve without importAs and let them decide later.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        signalId: {
          type: SchemaType.STRING,
          description: 'ID of the signal to approve. Get from listSignals results.',
        },
        importAs: {
          type: SchemaType.STRING,
          description:
            "Optional: Entity type to import as: 'technology', 'company', 'useCase'. If omitted, signal is approved but import type decided later.",
        },
        notes: {
          type: SchemaType.STRING,
          description:
            'Optional: Notes about why this signal was approved. Helps with audit trail and future reference.',
        },
      },
      required: ['signalId'],
    },
  },
  {
    name: 'rejectSignalWithReason',
    description: `Reject a signal with a documented reason. Use this to decline signals that aren't relevant, are duplicates, or don't meet quality standards.

WHEN TO USE THIS TOOL:
- "Reject this signal" or "This isn't relevant"
- "Skip this one" or "Not interested in [signal]"
- "This is a duplicate" or "We already track this"
- "Low quality signal" or "Not actionable"
- When user reviews signals and determines one isn't worth tracking

COMMON REJECTION REASONS:
- "Not relevant to our focus areas"
- "Duplicate of existing entity [name]"
- "Low quality/unreliable source"
- "Too early stage to track"
- "Outside our industry scope"
- "Already deprecated/discontinued"

EXAMPLE:
{
  "signalId": "sig_abc123",
  "reason": "Duplicate - already tracking this as 'TensorFlow' technology"
}

EXAMPLE - Multiple signals to reject:
For multiple similar signals, use bulkRejectSignals instead for efficiency.

TIP: Reasons are stored for analytics - use consistent wording to enable pattern analysis (e.g., always use "Duplicate" not "duplicate" or "dupe").`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        signalId: {
          type: SchemaType.STRING,
          description: 'ID of the signal to reject. Get from listSignals results.',
        },
        reason: {
          type: SchemaType.STRING,
          description:
            "REQUIRED: Reason for rejection. Be specific for audit trail. Common: 'Not relevant', 'Duplicate of [name]', 'Low quality', 'Out of scope', 'Too early stage'.",
        },
      },
      required: ['signalId', 'reason'],
    },
  },
  {
    name: 'bulkApproveSignals',
    description: `Approve multiple signals at once. Use this for efficient batch processing when several signals should all be accepted.

WHEN TO USE THIS TOOL:
- "Approve all these signals" or "Accept all of them"
- "Bulk approve the AI signals"
- When user reviews multiple signals and wants to approve several at once
- Processing a filtered list of signals (e.g., all high-relevance signals)

EXAMPLE - Approve specific signals:
{
  "signalIds": ["sig_001", "sig_002", "sig_003"],
  "notes": "All related to our Q2 AI initiative"
}

WORKFLOW:
1. listSignals with filters (e.g., status='Detected', type='patent')
2. User reviews the list
3. bulkApproveSignals for acceptable ones, bulkRejectSignals for others

RETURNS: Summary with count of approved vs failed, plus individual results for each signal.

TIP: Use single approveSignalForImport when you need to specify importAs type per signal. bulkApproveSignals doesn't support per-signal import types.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        signalIds: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Array of signal IDs to approve. Get from listSignals results.',
        },
        notes: {
          type: SchemaType.STRING,
          description: 'Optional: Shared notes for all approved signals. Applies same note to each signal.',
        },
      },
      required: ['signalIds'],
    },
  },
  {
    name: 'bulkRejectSignals',
    description: `Reject multiple signals at once with a shared reason. Use this for efficient cleanup of irrelevant or low-quality signals.

WHEN TO USE THIS TOOL:
- "Reject all these" or "Skip all the duplicates"
- "Clear out the low-quality signals"
- "Reject all patent signals" (after filtering with listSignals)
- When cleaning up a backlog of signals that share a common rejection reason

EXAMPLE - Reject duplicates:
{
  "signalIds": ["sig_001", "sig_002", "sig_003"],
  "reason": "Duplicates of existing tracked technologies"
}

EXAMPLE - Reject out-of-scope:
{
  "signalIds": ["sig_004", "sig_005"],
  "reason": "Healthcare sector - outside our focus areas"
}

WORKFLOW:
1. listSignals with filters to find signals to reject
2. Review the list with user
3. bulkRejectSignals with appropriate reason

RETURNS: Summary with count of rejected vs failed, plus individual results.

NOTE: All signals get the SAME reason. If you need different reasons per signal, use individual rejectSignalWithReason calls.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        signalIds: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Array of signal IDs to reject. Get from listSignals results.',
        },
        reason: {
          type: SchemaType.STRING,
          description: 'REQUIRED: Shared reason for rejecting all these signals. Applied to each signal.',
        },
      },
      required: ['signalIds', 'reason'],
    },
  },
  {
    name: 'getSignalDetails',
    description: `Get full details about a specific signal including AI analysis, source info, scores, and related entities. Use this to review a signal before deciding to approve or reject.

WHEN TO USE THIS TOOL:
- "Tell me more about this signal" or "What's signal [id] about?"
- "Show details for [signal title]"
- "I want to review this signal before approving"
- Before calling approveSignalForImport or rejectSignalWithReason
- When user asks about a specific signal from the list

RETURNS DETAILED INFO:
- Basic: id, title, description, type, source URL
- Analysis: aiSummary, sentiment, relevanceScore, alignmentScore
- Metadata: date detected, status, related entities
- Source: original URL, publication date, author (if available)

EXAMPLE:
{
  "signalId": "sig_abc123"
}

TYPICAL WORKFLOW:
1. listSignals → returns summary of signals
2. User picks one to review
3. getSignalDetails → full information
4. User decides: approveSignalForImport or rejectSignalWithReason

TIP: Use this before approve/reject decisions to make informed choices. The AI summary and scores help evaluate signal quality.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        signalId: {
          type: SchemaType.STRING,
          description: 'ID of the signal to get details for. Get from listSignals results.',
        },
      },
      required: ['signalId'],
    },
  },
  {
    name: 'expandSignal',
    description: `EXTEND / ENRICH the data INSIDE an existing signal in place. Runs a deep research
expansion on the signal and UPDATES that same signal record (richer summary, expanded content,
trust score, related context) — it does NOT create a new signal.

WHEN TO USE THIS TOOL:
- "Extend/enrich the data in this signal" / "add more data to these signals"
- "These signals are weak/thin — can we deepen them?"
- "Expand signal [id]" / after the user accepts an offer to dig deeper into a signal
Call it once per signalId (you can call it for several signals in one turn). To enrich the
"Fable 5" signals, call expandSignal with each of their ids — NOT createVerifiedSignal (that
would make a duplicate).

EXAMPLE:
{
  "signalId": "sig_abc123"
}`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        signalId: {
          type: SchemaType.STRING,
          description: 'ID of the EXISTING signal to expand/enrich in place.',
        },
      },
      required: ['signalId'],
    },
  },
  {
    name: 'resetSignalToDetected',
    description: `Reset a signal back to Detected status for re-triage. Use when a signal was incorrectly approved/rejected and needs to be reviewed again.

WHEN TO USE:
- "Reset this signal" or "Move back to detected"
- "Undo approval" or "Revert signal status"
- When user wants to re-triage a previously processed signal`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        signalId: {
          type: SchemaType.STRING,
          description: 'Signal ID to reset',
        },
        reason: {
          type: SchemaType.STRING,
          description: 'Why the signal is being reset',
        },
      },
      required: ['signalId'],
    },
  },
  {
    name: 'createVerifiedSignal',
    description: `Create a new signal with mandatory quality validation. Requires URL, description (50+ chars), and at least 1 evidence item. Computes trust score automatically.

WHEN TO USE:
- Agent discovers a new signal during research
- User asks to create a signal from a web source
- Pipeline detects a signal that needs to be recorded

QUALITY GATES:
- URL must be non-empty
- Description must be at least 50 characters
- At least 1 evidence item (url + snippet) required
- Trust score is computed automatically from source, evidence, and confidence`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        title: {
          type: SchemaType.STRING,
          description: 'Signal title',
        },
        description: {
          type: SchemaType.STRING,
          description: 'Detailed signal description (minimum 50 characters)',
        },
        url: {
          type: SchemaType.STRING,
          description: 'Source URL (required)',
        },
        source: {
          type: SchemaType.STRING,
          description: 'Source name (e.g., TechCrunch, ArXiv)',
        },
        type: {
          type: SchemaType.STRING,
          description: 'Signal type (technology_release, market_shift, regulation, etc.)',
        },
        evidence: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              url: {
                type: SchemaType.STRING,
                description:
                  'Absolute http(s) URL of the source page. Must be a real, resolvable publisher URL — not a search-redirect link and not invented.',
              },
              snippet: { type: SchemaType.STRING, description: 'Relevant snippet from the source' },
            },
            required: ['url', 'snippet'],
          },
          description:
            'At least 1 evidence item required. Trust is measured in DISTINCT INDEPENDENT PUBLISHERS, not item count: repeating the same URL, citing several articles from one publisher, or citing the signal own site does NOT raise trust. Items with no resolvable publisher URL are recorded as unverifiable.',
        },
        confidence: {
          type: SchemaType.STRING,
          description: 'Confidence level: high, medium, or low',
        },
        confidenceReason: {
          type: SchemaType.STRING,
          description: 'Why this confidence level was assigned',
        },
        strategyAlignment: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              strategyId: { type: SchemaType.STRING },
              reason: { type: SchemaType.STRING },
              score: { type: SchemaType.NUMBER },
            },
          },
          description: 'Optional strategy alignment data',
        },
      },
      required: ['title', 'description', 'url', 'source', 'type', 'evidence', 'confidence', 'confidenceReason'],
    },
  },
  {
    name: 'getSignalFeedbackPatterns',
    description: `Read how the user's signal 👍/👎 feedback breaks down — overall approval rate, the breakdown BY SOURCE (which sources they keep rejecting), and recent down-voted signals. Use it to answer "what am I rejecting?" / "which sources are noisy?" and to proactively suggest muting a low-approval source.

WHEN TO USE:
- The user asks about their signal feedback, rejected signals, or source quality.
- To proactively surface "you've rejected 80% of signals from source X — want to mute it in Settings?".

RETURNS: { stats, bySource (approval rate per source), recentRejections }. Read-only; suggests a mute, the user acts on it.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        limit: { type: SchemaType.NUMBER, description: 'Max recent rejected signals to return (default 10).' },
      },
    },
  },
  {
    name: 'importSignalToRadar',
    description: `Import a signal onto a technology radar as a blip — one prompt, one action. Creates a Technology from the signal's content, places it on the radar (the blip), and marks the signal Imported so it leaves the triage queue with a provenance link back to the signal.

WHEN TO USE THIS TOOL:
- "Import this signal as a radar blip"
- "Put signal <id> on the AI radar in the Trial ring"
- "Add this signal to my radar as a technology"

BEHAVIOR:
- Reads the signal by id (fails clearly if it doesn't exist or is already imported).
- Creates a decoupled Technology from the signal (name = signal title, description = signal summary, tags carried over). If an identical technology already exists it is reused, not duplicated.
- Places it on the target radar; then marks the signal Imported.

QUADRANT / RING:
- 'quadrant' is REQUIRED — pass a quadrant name or id that exists on the target radar. If you don't know the radar's quadrants, call listRadars/getRadarDetails first, or ask the user.
- 'ring' defaults to 'Assess' (signals are early-stage); pass Trial/Adopt/Hold only if the user specifies.
- 'radarId' is optional — omit to use the user's first/default radar.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        signalId: { type: SchemaType.STRING, description: 'The id of the signal to import.' },
        radarId: {
          type: SchemaType.STRING,
          description: "Target radar id. Omit to use the user's first/default radar.",
        },
        quadrant: {
          type: SchemaType.STRING,
          description:
            "Quadrant name or id on the target radar to place the blip in (REQUIRED). Resolve against the radar's quadrants; call listRadars/getRadarDetails if unknown.",
        },
        ring: {
          type: SchemaType.STRING,
          description:
            "Ring: 'Assess' | 'Trial' | 'Adopt' | 'Hold'. Defaults to 'Assess' for a freshly-imported signal.",
        },
        trlScore: { type: SchemaType.NUMBER, description: 'Optional Technology Readiness Level 1-9.' },
        timeToImpact: {
          type: SchemaType.STRING,
          description: "Optional time-to-impact horizon (e.g. '0-1 years', '1-2 years').",
        },
        rationale: { type: SchemaType.STRING, description: 'Optional one-line rationale for the placement.' },
      },
      required: ['signalId', 'quadrant'],
    },
  },
];

// ============================================================================
// Tool Execution Functions
// ============================================================================

interface SignalListItem {
  id: string;
  type: string;
  title: string;
  source: string;
  status: string;
  relevanceScore: number;
  alignmentScore: number;
  date: number;
  sentiment?: string;
}

/**
 * List signals with filters
 */
export async function executeListSignals(
  args: Record<string, unknown>
): Promise<{ success: boolean; data?: { signals: SignalListItem[]; total: number }; error?: string }> {
  try {
    const rawStatus = args.status;
    const status = rawStatus === undefined ? undefined : resolveSignalStatus(rawStatus);
    const type = args.type as Signal['type'] | undefined;
    const search = args.search as string | undefined;
    const limit = Math.min((args.limit as number) || 10, 50);
    const sortBy = (args.sortBy as string) || 'date';

    if (rawStatus !== undefined && !status) {
      return {
        success: false,
        error: `Unknown signal status '${String(rawStatus)}'. Valid statuses: ${signalStatusList()}`,
      };
    }

    log.debug('Listing signals', { status, type, search });

    // Get all signals
    let signals = await adminGetSignals();

    // Filter by status
    if (status) {
      signals = signals.filter((s) => s.status === status);
    }

    // Filter by type
    if (type) {
      signals = signals.filter((s) => s.type === type);
    }

    // Filter by search query. fuzzySearch tokenizes on whitespace, so a query like
    // "fable5" (one token) scored 0 against a title "Claude Fable 5" (tokens "fable"+"5")
    // and the assistant wrongly reported "no signals". Use a whitespace-collapsed,
    // case-insensitive substring match so "fable5", "fable", and "fable 5" all match
    // "...Fable 5...". Keep fuzzy as a fallback so loose/typo queries still match.
    if (search) {
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');
      const q = norm(search);
      const exact = signals.filter((s) =>
        norm(`${s.title ?? ''} ${s.description ?? ''} ${s.aiSummary ?? ''}`).includes(q)
      );
      signals =
        exact.length > 0
          ? exact
          : fuzzySearch(signals, search, {
              keys: ['title', 'description', 'aiSummary'] as (keyof Signal)[],
              threshold: 0.2,
            });
    }

    // Sort
    signals.sort((a, b) => {
      switch (sortBy) {
        case 'relevance':
          return (b.relevanceScore || 0) - (a.relevanceScore || 0);
        case 'alignment':
          return (b.alignmentScore || 0) - (a.alignmentScore || 0);
        case 'date':
        default:
          return (b.date || 0) - (a.date || 0);
      }
    });

    // Limit results
    const total = signals.length;
    signals = signals.slice(0, limit);

    // Map to list items
    const items: SignalListItem[] = signals.map((s) => ({
      id: s.id,
      type: s.type,
      title: s.title,
      source: s.source,
      status: s.status,
      relevanceScore: s.relevanceScore || 0,
      alignmentScore: s.alignmentScore || 0,
      date: s.date,
      sentiment: s.sentiment,
    }));

    return {
      success: true,
      data: { signals: items, total },
    };
  } catch (error) {
    log.error('Failed to list signals', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list signals',
    };
  }
}

/**
 * Approve a signal
 *
 * `context.userId` (T27), when present, is threaded to `adminApproveSignal` as
 * `feedbackUserId` so an AI-executor approval also folds into the interest-steering
 * posterior (the same one a triage-UI thumbs-up records) instead of skipping it. The
 * options arg is omitted entirely (not passed as `undefined`) when no identity is
 * available — an explicit trailing `undefined` still counts as a 3rd argument and would
 * break exact call-signature assertions in callers/tests that invoke this without context.
 */
export async function executeApproveSignal(
  args: Record<string, unknown>,
  context?: { userId?: string }
): Promise<{ success: boolean; data?: { signalId: string; message: string }; error?: string }> {
  try {
    const signalId = args.signalId as string;
    const importAs = args.importAs as string | undefined;
    const notes = (args.notes as string) || 'Approved via AI Assistant';

    log.info('Approving signal', { signalId });

    if (context?.userId) {
      await adminApproveSignal(signalId, notes, { feedbackUserId: context.userId });
    } else {
      await adminApproveSignal(signalId, notes);
    }

    // Enrich-on-like: approving IS liking. FIRE-AND-FORGET — enrichment is a slow deep-
    // research pass, so don't block the approve. Idempotent (skips already-expanded /
    // in-flight signals; no-op in batch/off mode).
    void queueEnrichOnLike(signalId).catch((enrichErr) => {
      log.warn('enrich-on-like skipped (non-fatal)', {
        signalId,
        error: enrichErr instanceof Error ? enrichErr.message : String(enrichErr),
      });
    });

    // If importAs is specified, we could trigger import here
    // For now, just approve the signal
    const message = importAs ? `Signal approved and marked for import as ${importAs}` : 'Signal approved successfully';

    return {
      success: true,
      data: { signalId, message },
    };
  } catch (error) {
    log.error('Failed to approve signal', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to approve signal',
    };
  }
}

/**
 * Reject a signal
 *
 * `context.userId` (T27): same feedbackUserId threading as `executeApproveSignal` — see its
 * doc comment for why the options arg is conditionally omitted.
 */
export async function executeRejectSignal(
  args: Record<string, unknown>,
  context?: { userId?: string }
): Promise<{ success: boolean; data?: { signalId: string; message: string }; error?: string }> {
  try {
    const signalId = args.signalId as string;
    const reason = args.reason as string;

    log.info('Rejecting signal', { signalId, reason });

    if (context?.userId) {
      await adminRejectSignal(signalId, reason, { feedbackUserId: context.userId });
    } else {
      await adminRejectSignal(signalId, reason);
    }

    return {
      success: true,
      data: { signalId, message: `Signal rejected: ${reason}` },
    };
  } catch (error) {
    log.error('Failed to reject signal', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reject signal',
    };
  }
}

/**
 * Bulk approve signals
 *
 * `context.userId` (T27): threaded to `adminApproveSignal` per signal — see
 * `executeApproveSignal`'s doc comment for why the options arg is conditionally omitted.
 */
export async function executeBulkApproveSignals(
  args: Record<string, unknown>,
  context?: { userId?: string }
): Promise<{
  success: boolean;
  data?: { approved: number; failed: number; results: Array<{ id: string; success: boolean }> };
  error?: string;
}> {
  try {
    const signalIds = args.signalIds as string[];
    const notes = (args.notes as string) || 'Bulk approved via AI Assistant';

    log.info('Bulk approving signals', { count: signalIds.length });

    const results: Array<{ id: string; success: boolean; error?: string }> = [];
    let approved = 0;
    let failed = 0;

    for (const signalId of signalIds) {
      try {
        if (context?.userId) {
          await adminApproveSignal(signalId, notes, { feedbackUserId: context.userId });
        } else {
          await adminApproveSignal(signalId, notes);
        }
        results.push({ id: signalId, success: true });
        approved++;
      } catch (error) {
        results.push({
          id: signalId,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        failed++;
      }
    }

    return {
      success: true,
      data: { approved, failed, results },
    };
  } catch (error) {
    log.error('Bulk approve failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Bulk approve failed',
    };
  }
}

/**
 * Bulk reject signals
 *
 * `context.userId` (T27): threaded to `adminRejectSignal` per signal — see
 * `executeApproveSignal`'s doc comment for why the options arg is conditionally omitted.
 */
export async function executeBulkRejectSignals(
  args: Record<string, unknown>,
  context?: { userId?: string }
): Promise<{
  success: boolean;
  data?: { rejected: number; failed: number; results: Array<{ id: string; success: boolean }> };
  error?: string;
}> {
  try {
    const signalIds = args.signalIds as string[];
    const reason = args.reason as string;

    log.info('Bulk rejecting signals', { count: signalIds.length });

    const results: Array<{ id: string; success: boolean; error?: string }> = [];
    let rejected = 0;
    let failed = 0;

    for (const signalId of signalIds) {
      try {
        if (context?.userId) {
          await adminRejectSignal(signalId, reason, { feedbackUserId: context.userId });
        } else {
          await adminRejectSignal(signalId, reason);
        }
        results.push({ id: signalId, success: true });
        rejected++;
      } catch (error) {
        results.push({
          id: signalId,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        failed++;
      }
    }

    return {
      success: true,
      data: { rejected, failed, results },
    };
  } catch (error) {
    log.error('Bulk reject failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Bulk reject failed',
    };
  }
}

/**
 * Get signal details
 */
export async function executeGetSignalDetails(
  args: Record<string, unknown>
): Promise<{ success: boolean; data?: Signal; error?: string }> {
  try {
    const signalId = args.signalId as string;

    log.debug('Getting signal details', { signalId });

    const signal = await adminGetSignalById(signalId);

    if (!signal) {
      return {
        success: false,
        error: `Signal not found: ${signalId}`,
      };
    }

    return {
      success: true,
      data: signal,
    };
  } catch (error) {
    log.error('Failed to get signal details', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get signal details',
    };
  }
}

/**
 * Extend/enrich an EXISTING signal in place — deep-research expansion that updates the
 * same signal record (not a new one). Thin wrapper over the platform's expandSignal
 * service so the chat can do what it offers ("extend the data inside the signal").
 */
export async function executeExpandSignal(args: Record<string, unknown>): Promise<{
  success: boolean;
  data?: { signalId: string; trustScore?: unknown; endpointResolution?: unknown };
  error?: string;
}> {
  try {
    const signalId = args.signalId as string;
    if (!signalId) return { success: false, error: 'signalId is required' };

    log.debug('Expanding signal', { signalId });
    const result = await expandSignal(signalId);

    if (!result.success) {
      return { success: false, error: result.error ?? `Failed to expand signal ${signalId}` };
    }
    return {
      success: true,
      data: {
        signalId: result.signalId,
        trustScore: result.trustScore,
        // GRAPH-063: report the endpoints the expansion invented and lost.
        // Reporting plain success would hide that the model proposed links to
        // entities this workspace does not have.
        ...(result.endpointResolution ? { endpointResolution: result.endpointResolution } : {}),
      },
    };
  } catch (error) {
    log.error('Failed to expand signal', error instanceof Error ? error : undefined);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to expand signal' };
  }
}

/**
 * Reset a signal back to Detected status
 */
export async function executeResetSignalToDetected(
  args: Record<string, unknown>
): Promise<{ success: boolean; data?: { signalId: string; newStatus: string; reason: string }; error?: string }> {
  try {
    const signalId = args.signalId as string;
    const reason = (args.reason as string) || 'Reset for re-triage';

    log.info('Resetting signal to Detected', { signalId, reason });

    await adminUpdateSignal(signalId, {
      status: 'Detected' as SignalStatus,
      reviewedAt: undefined,
      validationNotes: reason !== 'Reset for re-triage' ? `Reset: ${reason}` : undefined,
    });

    return {
      success: true,
      data: { signalId, newStatus: 'Detected', reason },
    };
  } catch (error) {
    log.error('Failed to reset signal', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reset signal',
    };
  }
}

/**
 * Create a verified signal with quality gates and trust score computation
 */
export async function executeCreateVerifiedSignal(args: Record<string, unknown>): Promise<{
  success: boolean;
  data?: {
    signalId: string;
    title: string;
    trustScore: { overall: number; breakdown: Record<string, number>; factors: string[] };
  };
  error?: string;
}> {
  try {
    const { title, description, url, source, type, evidence, confidence, confidenceReason, strategyAlignment } =
      args as {
        title: string;
        description: string;
        url: string;
        source: string;
        type: SignalType;
        evidence: Array<{ url: string; snippet: string }>;
        confidence: 'high' | 'medium' | 'low';
        confidenceReason: string;
        strategyAlignment?: Array<{ strategyId: string; reason: string; score: number }>;
      };

    // Validation gates
    if (!url || url.trim().length === 0) {
      return { success: false, error: 'URL is required and must be non-empty' };
    }
    // AI-032 — the signal's own URL is the anchor for first-party detection and
    // is persisted as the citation, so it must be a usable absolute http(s) URL
    // before anything downstream relies on it. Nothing is fetched.
    if (!canonicalHttpUrl(url)) {
      return {
        success: false,
        error: 'URL must be an absolute http(s) URL without embedded credentials',
      };
    }
    if (!description || description.length < 50) {
      return { success: false, error: 'Signal description must be at least 50 characters' };
    }
    if (!evidence || evidence.length === 0) {
      return { success: false, error: 'At least 1 evidence item is required' };
    }

    // AI-032 — corroboration follows source identity and independence, never raw
    // array length. Aliased URLs, repeated publishers, first-party echoes and
    // items with no resolvable publisher are labelled and excluded from the
    // tally, so duplicates and replay cannot inflate trust.
    const normalizedEvidence = normalizeVerifiedEvidence(evidence, url);

    const confidenceMap: Record<string, number> = { high: 0.9, medium: 0.7, low: 0.4 };

    // Build a partial signal object for trust score calculation
    const signalForScoring = {
      title,
      description,
      url,
      source,
      type,
      date: Date.now(),
      status: 'Detected' as SignalStatus,
      relevanceScore: confidenceMap[confidence] * 100,
      alignmentScore: 0,
      alignedStrategies: strategyAlignment?.map((a) => a.strategyId) ?? [],
      linkedEntities: [],
      metadata: { evidence: normalizedEvidence.items, confidenceReason },
    } as unknown as Signal;

    const trustScore = calculateTrustScore({
      signal: signalForScoring,
      aiConfidence: confidenceMap[confidence],
      hasCorroboration: normalizedEvidence.independentPublisherCount >= 2,
      corroboratingSourceCount: normalizedEvidence.independentPublisherCount,
    });

    const signalData = {
      title,
      description,
      url,
      source,
      type,
      status: 'Detected' as const,
      date: Date.now(),
      detectedAt: Date.now(),
      relevanceScore: confidenceMap[confidence] * 100,
      alignmentScore: 0,
      alignedStrategies: strategyAlignment?.map((a) => a.strategyId) ?? [],
      linkedEntities: {},
      sentiment: 'neutral' as const,
      aiSummary: description.substring(0, 200),
      metadata: {
        // Persist the labelled evidence, not the raw model payload, so the
        // provenance of every item stays auditable after the fact.
        evidence: normalizedEvidence.items,
        evidenceSummary: {
          independentPublisherCount: normalizedEvidence.independentPublisherCount,
          independentPublishers: normalizedEvidence.independentPublishers,
          firstPartyCount: normalizedEvidence.firstPartyCount,
          unverifiableCount: normalizedEvidence.unverifiableCount,
          droppedDuplicateCount: normalizedEvidence.droppedDuplicateCount,
        },
        confidenceReason,
        trustScore,
        ...(strategyAlignment ? { strategyAlignment } : {}),
      },
    };

    log.info('Creating verified signal', { title, trustScore: trustScore.overall });

    const signal = await adminCreateSignal(signalData);

    // Emit agent.discovery event (best-effort, non-blocking)
    try {
      const { emitAgentEvent } = await import('@/lib/agent-events');
      await emitAgentEvent({
        type: 'agent.discovery',
        userId: SYSTEM_PRINCIPAL,
        data: {
          discoveryType: 'signal',
          signalId: signal.id,
          title: signal.title,
          trustScore: trustScore.overall,
        },
      });
    } catch {
      // Event emission must never break signal creation
    }

    return {
      success: true,
      data: { signalId: signal.id, title: signal.title, trustScore },
    };
  } catch (error) {
    log.error('Failed to create verified signal', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create verified signal',
    };
  }
}

/**
 * Read the user's signal-feedback patterns (P2 — surfacing). Admin-SDK reads ONLY; the
 * client-SDK analytics in signals/feedback.ts would a540 from the server-side executor.
 */
export async function executeGetSignalFeedbackPatterns(
  args: Record<string, unknown>
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  try {
    const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 50) : 10;
    const { getSourceFeedbackBreakdown, adminGetFeedbackStats, adminGetSignalsWithNegativeFeedback } =
      await import('@/lib/signals-admin');
    const [stats, bySource, recentRejections] = await Promise.all([
      adminGetFeedbackStats(),
      getSourceFeedbackBreakdown(),
      adminGetSignalsWithNegativeFeedback(limit),
    ]);
    return { success: true, data: { stats, bySource, recentRejections } };
  } catch (error) {
    log.error('Failed to read signal feedback patterns', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to read signal feedback patterns',
    };
  }
}

/**
 * Import a signal onto a radar as a blip (#93). One assistant action that:
 *   1. reads the signal (rejects a missing or already-imported one),
 *   2. reuses an identically-named technology or creates one from the signal,
 *   3. places it on the target radar (the blip), and
 *   4. marks the signal Imported with a provenance back-pointer.
 *
 * Prompt-driven — there is deliberately no UI button (owner decision #93). The
 * radar-page drag-to-place flow is unchanged; this is the conversational path.
 */
export async function executeImportSignalToRadar(
  args: Record<string, unknown>,
  context?: { userId?: string }
): Promise<{
  success: boolean;
  data?: {
    signalId: string;
    technologyId: string;
    placementId: string;
    radarId: string;
    radarName: string;
    quadrant: string;
    ring: string;
    reusedExistingTechnology: boolean;
    message: string;
    graphHandoff?: PlacementGraphHandoff;
  };
  error?: string;
}> {
  // GRAPH-060 #1 — the authenticated user owns the placement; fail closed if absent.
  const ownerId = context?.userId;
  if (!ownerId) {
    return { success: false, error: 'You must be signed in to import a signal to a radar.' };
  }

  const signalId = args.signalId as string;
  const quadrantArg = args.quadrant as string;
  let radarId = args.radarId as string | undefined;

  try {
    // 1. Read the signal.
    const signal = await adminGetSignalById(signalId);
    if (!signal) {
      return { success: false, error: `Signal ${signalId} not found.` };
    }
    if (signal.status === 'Imported') {
      return {
        success: false,
        error: `Signal "${signal.title}" is already imported (${signal.importedAs?.type ?? 'entity'} ${signal.importedAs?.id ?? ''}).`,
      };
    }

    // 2. Resolve the radar (default to the first one).
    if (!radarId) {
      const radars = await adminListRadars();
      if (radars.length === 0) {
        return { success: false, error: 'No radars exist yet. Create a radar first, then import the signal.' };
      }
      radarId = radars[0].id;
    }
    const radar = await adminGetRadarById(radarId);
    if (!radar || !Array.isArray(radar.quadrants) || radar.quadrants.length === 0) {
      return { success: false, error: `Radar ${radarId} not found or has no quadrants.` };
    }

    // GRAPH-060 #2 — owner-only: the Assistant imports only onto radars the acting
    // user owns. A missing/foreign/ownerless radar throws RadarAuthorizationError
    // and surfaces as a uniform permission denial.
    await adminGetOwnedRadarById(radarId, ownerId);

    // 3. Resolve the quadrant against the radar's stable quadrantIds.
    const hit = resolveQuadrantReference(radar, quadrantArg);
    if (!hit?.id) {
      const available = radar.quadrants
        .map((q) => q.name ?? q.id)
        .filter(Boolean)
        .join(', ');
      return {
        success: false,
        error: `Quadrant "${quadrantArg}" not found on radar "${radar.name}". Available quadrants: ${available}.`,
      };
    }
    const quadrantName = hit.name ?? hit.id;

    // 4. Reuse an identically-named technology, else create one from the signal.
    const name = signal.title.trim();
    const matches = await adminGetTechnologies({ search: name, limit: 5 });
    const exact = matches.find((t) => t.name.toLowerCase() === name.toLowerCase());
    let technologyId: string;
    let reusedExistingTechnology = false;
    if (exact) {
      technologyId = exact.id;
      reusedExistingTechnology = true;
    } else {
      const tech = await adminCreateTechnology({
        name,
        slug: signalTechSlug(name),
        description: signal.description || signal.aiSummary || '',
        tags: deriveSignalTags(signal),
        createdBy: 'ai-assistant',
      });
      technologyId = tech.id;
    }

    // 5. Place it on the radar (the blip). Signals are early → default 'Assess'.
    const ring = (args.ring as Ring) || 'Assess';
    const trlScore = typeof args.trlScore === 'number' ? args.trlScore : undefined;
    const rawTimeToImpact = args.timeToImpact;
    const timeToImpact =
      typeof rawTimeToImpact === 'string' && rawTimeToImpact.length > 0 ? (rawTimeToImpact as TimeToImpact) : undefined;
    const { placement, graphHandoff } = await adminCreateRadarPlacementWithHandoff(
      {
        technologyId,
        radarId,
        quadrantId: hit.id,
        ring,
        rationale: (args.rationale as string) || `Imported from signal: ${signal.title}`,
        status: 'New' as Status,
        placedBy: ownerId,
        ...(trlScore !== undefined ? { trlScore } : {}),
        ...(timeToImpact !== undefined ? { timeToImpact } : {}),
      },
      { requireOwnerId: ownerId }
    );

    // 6. Mark the signal Imported with the BARE Technology id (AUDIT-010):
    // the sync layer's BECAME MATCH and both Firestore consumers key on the
    // technologies doc id — the old `${radarId}:${placementId}` composite
    // matched nothing anywhere.
    await adminMarkSignalAsImported(signalId, 'technology', technologyId);

    emitDataRefresh('technologies', 'ai-assistant');
    emitDataRefresh('signals', 'ai-assistant');

    log.info('Imported signal to radar', { signalId, technologyId, radarId, ring, reusedExistingTechnology });

    return {
      success: true,
      data: {
        signalId,
        technologyId,
        placementId: placement.id,
        radarId,
        radarName: radar.name,
        quadrant: quadrantName,
        ring,
        reusedExistingTechnology,
        message: `Imported "${signal.title}" onto radar "${radar.name}" as a ${ring} blip in ${quadrantName}${reusedExistingTechnology ? ' (reused the existing technology)' : ''}. The signal is now marked Imported.`,
        graphHandoff,
      },
    };
  } catch (error) {
    log.error('Failed to import signal to radar', error instanceof Error ? error : undefined, { signalId });
    if (error instanceof RadarAuthorizationError || error instanceof PlacementAuthorizationError) {
      return { success: false, error: 'You do not have permission to import a signal to this radar.' };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to import signal to radar',
    };
  }
}

/** URL-friendly slug for a technology minted from a signal. Byte-identical to
 *  the technology-core/entity-factory slug rule (`adminCreateTechnology`
 *  requires a slug field); inlined so this server-side path doesn't pull in a
 *  client-SDK service module just for a pure helper. */
function signalTechSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Best-effort tags for a technology minted from a signal: the discovery topic
 *  / matched keyword the sweep recorded, if any. Empty when the signal carries
 *  no usable hint — the technology can be tagged later. */
function deriveSignalTags(signal: Signal): string[] {
  const meta = (signal.metadata ?? {}) as Record<string, unknown>;
  const candidates = [meta.discoveryTopic, meta.matchedKeyword];
  const tags = candidates.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return Array.from(new Set(tags.map((t) => t.trim())));
}
