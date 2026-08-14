/**
 * @file ai/tools/radar-management.ts
 * @description AI tools for radar management - create, delete, configure radars and manage technologies on radars
 *
 * Provides AI capabilities for:
 * - Creating and deleting radars
 * - Configuring radar settings (quadrants, ring system)
 * - Searching technologies with advanced filters
 * - Bulk adding technologies to radars
 * - Workflow automation (research → create radar → populate)
 *
 * @author Radarist Team
 * @created 2025-01-19
 */

import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';
// Server-only narrow admin helpers — every read/write in this file runs from the
// stateless `/api/ai/chat` tool-executor context, where the Firebase CLIENT SDK
// (the `@/lib/radars`, `@/lib/technology-service`, `@/lib/radar-placement-service`
// service modules) times out / returns `unavailable` or poisons the in-process
// client with `a540`. These admin twins reproduce the client semantics exactly.
import {
  adminCreateRadar,
  adminUpdateRadar,
  adminGetAllRadars,
  adminListRadars,
  adminDeleteRadar,
  adminGetRadarById,
  adminGetOwnedRadarById,
  adminGetTechnologiesWithPlacementsForRadar,
  adminListTechnologies,
  adminGetRadarPlacements,
  adminSearchTechnologies,
  summarizeRadar,
  OrphanedPlacementsError,
  RadarAuthorizationError,
  type RadarStats,
  type UpdateRadarQuadrantsOptions,
} from '@/lib/radars-admin';
import { resolveRadarReference } from '@/lib/radar-resolver-admin';
import { adminGetTechnologies, adminCreateTechnology } from '@/lib/technology-admin';
import {
  adminCreateRadarPlacementWithHandoff,
  adminUpdateRadarPlacementWithHandoff,
  adminGetPlacementForTechnologyOnRadar,
  PlacementAuthorizationError,
  type PlacementGraphHandoff,
} from '@/lib/radar-placement-admin';
import { emitDataRefresh } from '@/lib/events/data-refresh';
import { cleanMarkdownFromText } from '@/lib/ai/signal-evaluation';
import {
  ensureQuadrantConfigs,
  reconcileQuadrantConfigs,
  getQuadrantById,
  resolveQuadrantReference,
  type QuadrantConfig,
  type ProposedQuadrantConfig,
  type Ring,
  type Status,
  type TimeToImpact,
  type TechnologyCategory,
} from '@/lib/types';
import { MIN_QUADRANTS, MAX_QUADRANTS, defaultQuadrantIdFromName } from '@/lib/constants';
import { createLogger } from '@/lib/logger';
import {
  confirmDestructiveAction,
  destructiveActionFingerprint,
  normalizeDestructiveIdentifier,
  type DestructiveGateRefusal,
} from '@/lib/ai/destructive-confirmation';
import { DELETION_MUTATED_ENTITY_TYPES } from '@/lib/ai/mutation-tracking';

const log = createLogger('ai/radar-mgmt');

/**
 * Minimal slice of the tool execution context the destructive `deleteRadar`
 * executor needs for its server-verified confirmation gate (#121). Inlined
 * (not imported from `@/lib/ai/tools`) to avoid an import cycle.
 */
type DeleteGateContext = {
  principal?: 'human' | 'machine';
  userId?: string;
  requestId?: string;
  confirmationText?: string;
};

// ============================================================================
// Tool Definitions for Radar Management
// ============================================================================

export const RADAR_MANAGEMENT_TOOLS: FunctionDeclaration[] = [
  // =========== Radar CRUD Tools ===========
  {
    name: 'createRadar',
    description: `Create a new technology radar for organizing and evaluating technologies.

WHEN TO USE THIS TOOL:
- "Create an AI radar"
- "Make a new radar for frontend technologies"
- "Set up a cloud infrastructure radar"
- "I need a radar for mobile development"

RADAR STRUCTURE:
- 4 Quadrants (categories): How technologies are grouped
- Ring System (maturity): How technologies are assessed

DEFAULT QUADRANTS:
- Languages & Frameworks
- Platforms
- Tools
- Techniques

CUSTOM QUADRANTS EXAMPLES:
- AI Radar: ["LLMs", "ML Frameworks", "AI Tools", "AI Platforms"]
- Frontend: ["Frameworks", "Build Tools", "Testing", "Design Systems"]
- Data: ["Databases", "Processing", "Visualization", "Governance"]

RING SYSTEMS:
- Standard: Adopt → Trial → Assess → Hold (recommendation-based)
- TRL: Levels 1-9 (Technology Readiness Level, maturity-based)
- Time-to-Impact: H1 → H2 → H3 (horizon-based, when will it matter)

EXAMPLE:
createRadar(
  name: "AI & Machine Learning Radar",
  description: "Tracking AI/ML technologies for enterprise adoption",
  quadrants: ["LLM Models", "ML Frameworks", "AI Tools", "AI Platforms"],
  ringSystem: "Standard"
)

NEXT STEPS: After creating, use 'addTechnologiesToRadar' to populate it.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        name: {
          type: SchemaType.STRING,
          description: "Radar name (e.g., 'Cloud Infrastructure Radar', 'AI & ML Radar')",
        },
        description: {
          type: SchemaType.STRING,
          description: 'Description of what this radar tracks',
        },
        quadrants: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description:
            'Custom quadrant names (1 to 8). Defaults to: Languages & Frameworks, Platforms, Tools, Techniques',
        },
        ringSystem: {
          type: SchemaType.STRING,
          description:
            "Ring system type: 'Standard' (Adopt/Trial/Assess/Hold), 'TRL' (1-9), or 'Time-to-Impact' (H1/H2/H3)",
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'deleteRadar',
    description: `Delete a radar and optionally all its technology placements.

WARNING: This is destructive. With cascadeDelete=true (default), all technologies will be removed from this radar.
The technologies themselves remain in the library, only their placements on this radar are deleted.

Interactive confirmation is server-verified: relay the exact action-bound phrase returned by the first call, stop for the turn, and retry only when the next raw user message exactly matches it.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        radarId: {
          type: SchemaType.STRING,
          description: 'The radar ID to delete',
        },
        cascadeDelete: {
          type: SchemaType.BOOLEAN,
          description: 'Delete all placements on this radar (default: true)',
        },
        confirmed: {
          type: SchemaType.BOOLEAN,
          description:
            'Legacy explicit-confirm flag for automated (non-chat) callers only. Interactive chat must relay the exact action-bound phrase returned by the first call and retry only when the next raw user message exactly matches it.',
        },
      },
      required: ['radarId'],
    },
  },
  {
    name: 'updateRadarSettings',
    description: `Update a radar's configuration (name, description, quadrants, ring system).

Use this to rename a radar, change its description, or reconfigure its quadrants (a radar may have 1 to 8 quadrants).

EDITING QUADRANTS OF AN EXISTING RADAR PRESERVES ITS TECHNOLOGY PLACEMENTS when done correctly — you do NOT need to reset or recreate the radar:
1. First call getRadarDetails to read the radar's current quadrants; each has a stable "id".
2. To KEEP or RENAME an existing quadrant, include its existing "id" (and a new "name" to rename it). Its placements stay attached to that id.
3. To ADD a quadrant, include an item with a "name" but NO "id".
4. To REMOVE a quadrant, omit it from the list. If placements still live in a removed quadrant they would be orphaned — resolve them with "reassignments" (move to a surviving quadrant) or "deleteOrphans", rather than rebuilding the radar.
(If you pass plain names without ids, the tool will keep the id of any quadrant whose name is unchanged, but passing ids is the reliable way to preserve placements across renames.)`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        radarId: {
          type: SchemaType.STRING,
          description: 'The radar ID to update',
        },
        name: {
          type: SchemaType.STRING,
          description: 'New radar name',
        },
        description: {
          type: SchemaType.STRING,
          description: 'New description',
        },
        quadrants: {
          type: SchemaType.ARRAY,
          description:
            'New quadrant list (1 to 8). Include the existing "id" (from getRadarDetails) to keep/rename a quadrant and preserve its placements; omit "id" to add a new quadrant; omit a quadrant entirely to remove it.',
          items: {
            type: SchemaType.OBJECT,
            properties: {
              id: {
                type: SchemaType.STRING,
                description:
                  'Existing quadrant id to preserve/rename (from getRadarDetails). Omit to create a NEW quadrant.',
              },
              name: { type: SchemaType.STRING, description: 'Quadrant display name' },
              description: { type: SchemaType.STRING, description: 'Optional quadrant description' },
            },
            required: ['name'],
          },
        },
        reassignments: {
          type: SchemaType.ARRAY,
          description:
            'Optional — only when REMOVING a quadrant that still has placements. Move those placements to a surviving quadrant instead of failing.',
          items: {
            type: SchemaType.OBJECT,
            properties: {
              fromQuadrantId: {
                type: SchemaType.STRING,
                description: 'The removed quadrant id whose placements should move',
              },
              toQuadrantId: {
                type: SchemaType.STRING,
                description: 'A surviving quadrant id to move those placements to',
              },
            },
            required: ['fromQuadrantId', 'toQuadrantId'],
          },
        },
        deleteOrphans: {
          type: SchemaType.BOOLEAN,
          description:
            'Optional — set true to DELETE placements left in removed quadrants (destructive). Prefer "reassignments" unless the user explicitly wants those placements removed.',
        },
        ringSystem: {
          type: SchemaType.STRING,
          description: "Ring system: 'Standard', 'TRL', or 'Time-to-Impact'",
        },
      },
      required: ['radarId'],
    },
  },
  {
    name: 'listRadars',
    description: `List all technology radars in the system.

WHEN TO USE THIS TOOL:
- "What radars do we have?"
- "Show me all our radars"
- "List available radars"
- "Which radar should I add this technology to?"

RETURNS:
- Radar ID, name, description
- Quadrant configuration
- Ring system type
- Creation date

BY DEFAULT (includeStats, on unless you pass false) ALSO RETURNS per radar:
- Total technology count
- Exact count per ring in \`stats\` (e.g. stats.trial, stats.adopt) and \`stats.byRing\`
- Count per quadrant

For "how many technologies are in the <ring> ring" questions, read the exact
\`stats.<ring>\` for the relevant radar — never count placements yourself.

USE CASES:
1. Before adding technology: Find the right radar ID
2. Overview: See all radars and their sizes
3. Planning: Identify gaps or overlaps between radars

EXAMPLE:
listRadars(includeStats: true)

RETURNS:
[
  {
    id: "radar-123",
    name: "Cloud Infrastructure Radar",
    quadrants: ["Compute", "Storage", "Networking", "Security"],
    stats: { total: 24, adopt: 8, trial: 6, assess: 7, hold: 3 }
  },
  ...
]`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        includeStats: {
          type: SchemaType.BOOLEAN,
          description:
            'Include placement statistics (total, exact count by ring, by quadrant). Defaults to true; pass false only to skip the stats read.',
        },
      },
    },
  },
  {
    name: 'getRadarDetails',
    description: `Get complete information about a specific radar including all its technologies.

WHEN TO USE THIS TOOL:
- "Show me the [radar name] radar"
- "What technologies are on the [radar]?"
- "Get details of radar [ID]"
- "What's in the Adopt ring of [radar]?"

RETURNS:
- Radar configuration (name, description, quadrants, ring system)
- All technologies with their placements:
  - Name, description, category
  - Quadrant and ring position
  - Status, TRL score, time-to-impact (omitted when not yet assessed)
  - Rationale for placement
- Statistics (counts by ring, quadrant)

CONTEXT GUARD: technology descriptions are truncated to 280 characters by
default (some carry multi-thousand-char research dossiers). Pass
descriptionMaxLength: 0 for full text, or fetch one technology's full
description via getEntityDetails.

WITH includeUnplacedInLibrary=true:
- Also shows technologies in library NOT yet on this radar
- Helpful for finding technologies to add

EXAMPLE:
getRadarDetails(radarId: "radar-abc123", includeUnplacedInLibrary: true)

USE CASES:
1. Review a radar's contents before a meeting
2. Find technologies to add (unplaced from library)
3. Analyze distribution across rings/quadrants
4. Export radar data for reporting`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        radarId: {
          type: SchemaType.STRING,
          description: 'The radar ID',
        },
        includeUnplacedInLibrary: {
          type: SchemaType.BOOLEAN,
          description: 'Include technologies in the library not yet on this radar',
        },
        descriptionMaxLength: {
          type: SchemaType.NUMBER,
          description:
            'Max characters per technology description (default: 280, longer text is truncated with an ellipsis). Pass 0 for unlimited. Full descriptions are always available via getEntityDetails.',
        },
      },
      required: ['radarId'],
    },
  },

  // =========== Technology-Radar Tools ===========
  {
    name: 'searchTechnologiesAdvanced',
    description: `Power search for technologies with multiple filter options.

WHEN TO USE THIS TOOL:
- "Find all AI technologies in the Adopt ring"
- "Search for frameworks with TRL > 7"
- "What frontend tools are trending?"
- "Find technologies tagged with 'cloud' in Trial"

FILTER OPTIONS:
- query: Text search in name/description
- tags: Filter by tags (e.g., ["AI", "cloud"])
- category: framework, language, platform, tool, library, service
- quadrant: Filter by stable quadrant id or exact display name; requires radarId (call getRadarDetails first)
- ring: Adopt, Trial, Assess, Hold
- status: Trending, Stable, Fading, New, Warning
- trlScoreMin/Max: Technology Readiness Level (1-9)
- timeToImpact: H1, H2, H3
- radarId: Search within specific radar only

EXAMPLE SEARCHES:

Find AI frameworks in Adopt:
searchTechnologiesAdvanced(query: "AI", category: "framework", ring: "Adopt")

Find high-maturity technologies:
searchTechnologiesAdvanced(trlScoreMin: 7, status: "Stable")

Find trending tools on a specific radar:
searchTechnologiesAdvanced(radarId: "radar-123", category: "tool", status: "Trending")

USE BEFORE:
- Adding technologies to radar (avoid duplicates)
- Creating relations (find technology IDs)
- Analyzing technology landscape`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description: 'Text search in name and description',
        },
        tags: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Filter by tags (any match)',
        },
        category: {
          type: SchemaType.STRING,
          description:
            'Filter by category: framework, language, platform, tool, library, service, methodology, infrastructure',
        },
        quadrant: {
          type: SchemaType.STRING,
          description:
            'Filter by stable quadrant id or exact display name. Requires radarId; call getRadarDetails first. Names are case-insensitive but whitespace-sensitive.',
        },
        ring: {
          type: SchemaType.STRING,
          description: 'Filter by ring: Adopt, Trial, Assess, Hold',
        },
        status: {
          type: SchemaType.STRING,
          description: 'Filter by status: Trending, Stable, Fading, New, Warning',
        },
        trlScoreMin: {
          type: SchemaType.NUMBER,
          description: 'Minimum TRL score (1-9)',
        },
        trlScoreMax: {
          type: SchemaType.NUMBER,
          description: 'Maximum TRL score (1-9)',
        },
        timeToImpact: {
          type: SchemaType.STRING,
          description: 'Filter by time-to-impact horizon: H1, H2, H3',
        },
        radarId: {
          type: SchemaType.STRING,
          description: 'Only search within a specific radar',
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Maximum results (default: 20, max: 100)',
        },
      },
    },
  },
  {
    name: 'addTechnologiesToRadar',
    description: `Bulk add multiple technologies to a radar in one operation.

WHEN TO USE THIS TOOL:
- "Add React, Vue, and Angular to the frontend radar"
- "Put these AI frameworks on the ML radar"
- "Populate the cloud radar with AWS, Azure, GCP"

TWO MODES:

1. EXISTING TECHNOLOGIES (already in library):
   Provide technologyId + quadrant + ring

2. NEW TECHNOLOGIES (not yet in library):
   Provide name + description + quadrant + ring
   (Technology will be created automatically)

REQUIRED FOR EACH TECHNOLOGY:
- quadrant: Target quadrant — either a stable quadrant id (from getRadarDetails) or a display name (resolved server-side, case-insensitive). Radars have 1–8 quadrants that vary per radar; call getRadarDetails to see the available ones before batch-adding.
- ring: What recommendation (Adopt, Trial, Assess, Hold)

OPTIONAL METADATA:
- status: Trending, Stable, Fading, New, Warning
- trlScore: 1-9 (Technology Readiness Level)
- timeToImpact: H1, H2, H3 (when will it matter)
- rationale: Why this placement?

EXAMPLE:
addTechnologiesToRadar(
  radarId: "radar-frontend",
  technologies: [
    { name: "React", description: "UI library by Meta", quadrant: "Languages & Frameworks", ring: "Adopt", status: "Stable" },
    { name: "Solid.js", description: "Reactive UI library", quadrant: "Languages & Frameworks", ring: "Trial", status: "Trending" },
    { technologyId: "tech-vue", quadrant: "Languages & Frameworks", ring: "Adopt" }
  ]
)

TIP: Use skipExisting=true (default) to ignore technologies already on this radar.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        radarId: {
          type: SchemaType.STRING,
          description: 'Target radar ID',
        },
        technologies: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              technologyId: {
                type: SchemaType.STRING,
                description: 'Existing technology ID (if already in library)',
              },
              name: {
                type: SchemaType.STRING,
                description: 'Technology name (if creating new)',
              },
              description: {
                type: SchemaType.STRING,
                description: 'Technology description (if creating new)',
              },
              category: {
                type: SchemaType.STRING,
                description: 'Category (if creating new): framework, language, platform, tool, library, service',
              },
              tags: {
                type: SchemaType.ARRAY,
                items: { type: SchemaType.STRING },
                description: 'Tags (if creating new)',
              },
              quadrant: {
                type: SchemaType.STRING,
                description: 'Quadrant for placement (required)',
              },
              ring: {
                type: SchemaType.STRING,
                description: 'Ring for placement: Adopt, Trial, Assess, Hold (required)',
              },
              status: {
                type: SchemaType.STRING,
                description: 'Status: Trending, Stable, Fading, New, Warning',
              },
              trlScore: {
                type: SchemaType.NUMBER,
                description: 'Technology Readiness Level (1-9)',
              },
              timeToImpact: {
                type: SchemaType.STRING,
                description: 'Time-to-impact horizon: H1, H2, H3',
              },
              rationale: {
                type: SchemaType.STRING,
                description: 'Reason for this placement',
              },
            },
            required: ['quadrant', 'ring'],
          },
          description: 'Array of technologies to add with their placements',
        },
        skipExisting: {
          type: SchemaType.BOOLEAN,
          description: 'Skip technologies already on this radar (default: true)',
        },
      },
      required: ['radarId', 'technologies'],
    },
  },
  {
    name: 'updateTechnologyOnRadar',
    description: `Update a technology's position or assessment on a radar.

WHEN TO USE THIS TOOL:
- "Move React from Trial to Adopt"
- "Update Kubernetes status to Stable"
- "Change [technology] TRL score to 8"
- "Move [tech] to the Hold ring"

WHAT YOU CAN UPDATE:
- ring: Move between Adopt/Trial/Assess/Hold
- quadrant: Recategorize (rare, usually stays same)
- status: Trending, Stable, Fading, New, Warning
- trlScore: 1-9 maturity level
- timeToImpact: H1, H2, H3 horizon
- rationale: Why this change?

COMMON SCENARIOS:

Promote from Trial to Adopt:
updateTechnologyOnRadar(technologyId: "tech-123", radarId: "radar-456", ring: "Adopt", rationale: "Proven in production for 6 months")

Mark as fading:
updateTechnologyOnRadar(technologyId: "tech-123", radarId: "radar-456", status: "Fading", rationale: "Declining community activity")

Update maturity assessment:
updateTechnologyOnRadar(technologyId: "tech-123", radarId: "radar-456", trlScore: 8, rationale: "Now has enterprise support")

NOTE: Movement history is tracked automatically. You can see previous ring positions in technology details.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        technologyId: {
          type: SchemaType.STRING,
          description: 'The technology ID',
        },
        radarId: {
          type: SchemaType.STRING,
          description: 'The radar ID where the technology is placed',
        },
        quadrant: {
          type: SchemaType.STRING,
          description: 'New quadrant (if changing)',
        },
        ring: {
          type: SchemaType.STRING,
          description: 'New ring: Adopt, Trial, Assess, Hold',
        },
        status: {
          type: SchemaType.STRING,
          description: 'New status: Trending, Stable, Fading, New, Warning',
        },
        trlScore: {
          type: SchemaType.NUMBER,
          description: 'New TRL score (1-9)',
        },
        timeToImpact: {
          type: SchemaType.STRING,
          description: 'New time-to-impact: H1, H2, H3',
        },
        rationale: {
          type: SchemaType.STRING,
          description: 'Rationale for this update',
        },
      },
      required: ['technologyId', 'radarId'],
    },
  },

  // =========== Workflow Tool ===========
  {
    name: 'populateRadarFromContext',
    description: `One-shot radar population from research or conversation context.

WHEN TO USE THIS TOOL:
- "Create an AI radar and add these technologies"
- "Research AI frameworks and put them on a new radar"
- "Build a frontend radar with React, Vue, Angular"
- After webSearch/researchTechnologyComprehensive results

WORKFLOW (recommended):
1. User: "Create an AI radar with popular frameworks"
2. AI researches AI frameworks (webSearch)
3. AI calls populateRadarFromContext with findings
4. Radar created (if new) + technologies added with classifications

KEY FEATURES:
- Can CREATE radar if it doesn't exist (createMissingRadar=true)
- Can CREATE technologies if new (not in library)
- Auto-suggests quadrant/ring based on research
- Handles duplicates gracefully

INPUT: Array of technologies with:
- name, description (required)
- suggestedQuadrant, suggestedRing (required - AI classifies each placement)
- rationale (why this placement)

EXAMPLE:
populateRadarFromContext(
  radarName: "AI & Machine Learning Radar",
  createMissingRadar: true,
  technologies: [
    { name: "TensorFlow", description: "ML framework by Google", suggestedQuadrant: "ML Frameworks", suggestedRing: "Adopt", rationale: "Industry standard" },
    { name: "PyTorch", description: "ML framework by Meta", suggestedQuadrant: "ML Frameworks", suggestedRing: "Adopt", rationale: "Preferred for research" },
    { name: "LangChain", description: "LLM application framework", suggestedQuadrant: "LLM Tools", suggestedRing: "Trial", rationale: "Rapidly evolving" }
  ]
)

BEST FOR: End-to-end radar creation from research in one operation.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        radarId: {
          type: SchemaType.STRING,
          description: 'Target radar ID (if existing)',
        },
        radarName: {
          type: SchemaType.STRING,
          description: 'Radar name (used if creating new)',
        },
        technologies: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              name: {
                type: SchemaType.STRING,
                description: 'Technology name (required)',
              },
              description: {
                type: SchemaType.STRING,
                description: 'Technology description',
              },
              category: {
                type: SchemaType.STRING,
                description: 'Category',
              },
              tags: {
                type: SchemaType.ARRAY,
                items: { type: SchemaType.STRING },
                description: 'Tags for the technology',
              },
              suggestedQuadrant: {
                type: SchemaType.STRING,
                description: 'Suggested quadrant (required)',
              },
              suggestedRing: {
                type: SchemaType.STRING,
                description: 'Suggested ring: Adopt, Trial, Assess, Hold (required)',
              },
              suggestedStatus: {
                type: SchemaType.STRING,
                description: 'Suggested status',
              },
              suggestedTrl: {
                type: SchemaType.NUMBER,
                description: 'Suggested TRL (1-9)',
              },
              suggestedTimeToImpact: {
                type: SchemaType.STRING,
                description: 'Suggested time horizon: H1, H2, H3',
              },
              rationale: {
                type: SchemaType.STRING,
                description: 'Reasoning for the suggested placement',
              },
            },
            required: ['name', 'suggestedQuadrant', 'suggestedRing'],
          },
          description: 'Technologies to add with suggested classifications',
        },
        createMissingRadar: {
          type: SchemaType.BOOLEAN,
          description: "Create radar if it doesn't exist",
        },
        customQuadrants: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Custom quadrants if creating new radar (1 to 8)',
        },
      },
      required: ['technologies'],
    },
  },
];

// ============================================================================
// Tool Execution Functions
// ============================================================================

/**
 * Create a new radar
 */
export async function executeCreateRadar(
  args: Record<string, unknown>,
  context?: { userId?: string }
): Promise<{
  success: boolean;
  data?: {
    id: string;
    name: string;
    slug: string;
    quadrants: Array<{ id: string; name: string; order: number }>;
    guidance: string;
  };
  error?: string;
}> {
  try {
    // GRAPH-060 #1 — the authenticated creator owns the radar; fail closed if absent.
    const ownerId = context?.userId;
    if (!ownerId) {
      return { success: false, error: 'You must be signed in to create a radar.' };
    }
    const name = cleanMarkdownFromText(args.name as string);
    const description = args.description ? cleanMarkdownFromText(args.description as string) : undefined;
    const rawQuadrants = args.quadrants as string[] | undefined;
    const ringSystem = args.ringSystem as string | undefined;

    // Validate and convert custom quadrants (if provided) into QuadrantConfig[]
    let quadrantConfigs: QuadrantConfig[] | undefined;
    if (rawQuadrants && rawQuadrants.length > 0) {
      if (rawQuadrants.length < MIN_QUADRANTS || rawQuadrants.length > MAX_QUADRANTS) {
        return {
          success: false,
          error: `Quadrants count out of range: expected ${MIN_QUADRANTS}..${MAX_QUADRANTS}, got ${rawQuadrants.length}`,
        };
      }
      quadrantConfigs = ensureQuadrantConfigs(rawQuadrants, defaultQuadrantIdFromName);
    }

    // Create the radar with custom quadrants in a single round-trip
    const radar = await adminCreateRadar(ownerId, name, description, quadrantConfigs);

    // Apply ring system if provided (doesn't require custom quadrants). The
    // creator owns the just-created radar, so `ownerId` authorizes the update.
    if (ringSystem) {
      await adminUpdateRadar(radar.id, ownerId, { ringSystem });
    }

    log.info('Created radar', { radarName: radar.name, radarId: radar.id, quadrantCount: radar.quadrants.length });
    emitDataRefresh('radars', 'ai-assistant');

    return {
      success: true,
      data: {
        id: radar.id,
        name: radar.name,
        slug: radar.slug || radar.id,
        quadrants: radar.quadrants.map((q) => ({ id: q.id, name: q.name, order: q.order })),
        guidance: 'Confirm the creation to the user, mentioning the radar name and its quadrants.',
      },
    };
  } catch (error) {
    log.error('Failed to create radar', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create radar',
    };
  }
}

/**
 * Delete a radar
 */
export async function executeDeleteRadar(
  args: Record<string, unknown>,
  context?: DeleteGateContext
): Promise<{
  success: boolean;
  data?:
    | {
        message: string;
        placementsDeleted?: number;
        guidance?: string;
        mutatedEntityTypes: typeof DELETION_MUTATED_ENTITY_TYPES.radar;
      }
    | DestructiveGateRefusal;
  error?: string;
}> {
  const radarId = normalizeDestructiveIdentifier(args.radarId);
  if (!radarId) {
    return { success: false, error: 'A non-empty radar ID is required for deletion.' };
  }

  // GRAPH-060 #2 — resolve the acting owner BEFORE any read or confirmation. An
  // unauthenticated caller refuses here; we never thread an absent `userId` into
  // the mutation primitive (the silent-bypass footgun this closes).
  const ownerId = context?.userId;
  if (!ownerId) {
    return { success: false, error: 'You must be signed in to delete a radar.' };
  }
  const cascadeDelete = args.cascadeDelete !== false; // Default true

  // GRAPH-060 #2 — resolve the target through an OWNER-SCOPED boundary BEFORE we
  // read the name or mint a confirmation. A foreign-owned, ownerless, or missing
  // radar all throw the same RadarAuthorizationError, so a non-owner receives one
  // uniform denial that reveals neither the radar's name nor whether it exists.
  // Only an owner ever reaches the confirmation prompt (which embeds the name).
  let radarName: string;
  try {
    const radar = await adminGetOwnedRadarById(radarId, ownerId);
    radarName = radar.name;
  } catch (error) {
    if (error instanceof RadarAuthorizationError) {
      return { success: false, error: 'You do not have permission to delete this radar.' };
    }
    // An unexpected read failure must not leak facts either — fail generically.
    log.error('Failed to resolve radar for deletion', error instanceof Error ? error : undefined);
    return { success: false, error: 'Failed to delete radar' };
  }

  const gate = confirmDestructiveAction({
    fingerprint: destructiveActionFingerprint('deleteRadar', radarId, cascadeDelete),
    summary: `delete radar "${radarName}"${cascadeDelete ? ' and all its technology placements' : ''}`,
    confirmed: args.confirmed as boolean | undefined,
    principal: context?.principal,
    userId: context?.userId,
    requestId: context?.requestId,
    confirmationText: context?.confirmationText,
  });
  if (!gate.ok) {
    return { success: false, error: gate.error, data: gate.data };
  }

  try {
    // GRAPH-060 #2 — owner-only: the Assistant deletes only radars the acting user
    // owns. `ownerId` is a definite string (refused above if absent).
    const result = await adminDeleteRadar(radarId, ownerId, { cascade: cascadeDelete });

    log.info('Deleted radar', { radarId });
    emitDataRefresh('radars', 'ai-assistant');

    return {
      success: true,
      data: {
        message: `Radar deleted successfully${cascadeDelete ? ` with ${result.placementsDeleted} placements` : ''}`,
        placementsDeleted: result.placementsDeleted,
        guidance: 'Confirm the deletion to the user, mentioning the radar and how many placements were removed.',
        mutatedEntityTypes: DELETION_MUTATED_ENTITY_TYPES.radar,
      },
    };
  } catch (error) {
    log.error('Failed to delete radar', error instanceof Error ? error : undefined);
    // GRAPH-060 #1 — surface an ownership refusal as a clear, non-retryable message.
    const errorMessage =
      error instanceof RadarAuthorizationError
        ? 'You do not have permission to delete this radar.'
        : error instanceof Error
          ? error.message
          : 'Failed to delete radar';
    return {
      success: false,
      error: errorMessage,
      data: {
        message: errorMessage,
        mutatedEntityTypes: DELETION_MUTATED_ENTITY_TYPES.radar,
      },
    };
  }
}

/**
 * Update radar settings
 */
export async function executeUpdateRadarSettings(
  args: Record<string, unknown>,
  context?: { userId?: string }
): Promise<{ success: boolean; data?: { id: string; updated: string[]; guidance: string }; error?: string }> {
  try {
    const radarId = args.radarId as string;

    // GRAPH-060 #2 — resolve the acting owner BEFORE any read or write. An
    // unauthenticated caller refuses here; the mutation primitive is never
    // reached with an absent owner.
    const ownerId = context?.userId;
    if (!ownerId) {
      return { success: false, error: 'You must be signed in to update a radar.' };
    }

    const updates: {
      name?: string;
      description?: string;
      quadrants?: QuadrantConfig[];
      ringSystem?: string;
    } = {};

    if (args.name) {
      updates.name = cleanMarkdownFromText(args.name as string);
    }
    if (args.description !== undefined) {
      updates.description = args.description as string;
    }
    if (args.quadrants) {
      // Range-check the raw input first (cheap, no radar read needed).
      const rawCount = Array.isArray(args.quadrants) ? (args.quadrants as unknown[]).length : 0;
      if (rawCount < MIN_QUADRANTS || rawCount > MAX_QUADRANTS) {
        return {
          success: false,
          error: `Quadrants count out of range: expected ${MIN_QUADRANTS}..${MAX_QUADRANTS}, got ${rawCount}`,
        };
      }
      // Reconcile against the radar's CURRENT quadrants so existing ids are
      // preserved on keep/rename. This is what keeps placements attached when
      // editing quadrants of a radar that already has technologies — the prior
      // names-only path minted fresh ids from names and falsely orphaned them.
      const radar = await adminGetRadarById(radarId);
      if (!radar) {
        return { success: false, error: `Radar ${radarId} not found` };
      }
      const existing = ensureQuadrantConfigs(radar.quadrants, defaultQuadrantIdFromName);
      const proposed = normalizeProposedQuadrants(args.quadrants, existing);
      const reconciled = reconcileQuadrantConfigs(existing, proposed, defaultQuadrantIdFromName);
      if (reconciled.errors.length > 0) {
        return { success: false, error: reconciled.errors.join('; ') };
      }
      updates.quadrants = reconciled.next;
    }
    if (args.ringSystem) {
      updates.ringSystem = args.ringSystem as string;
    }

    if (Object.keys(updates).length === 0) {
      return {
        success: false,
        error: 'No updates provided',
      };
    }

    // GRAPH-060 #2 — owner-only: the Assistant updates only radars the acting user
    // owns. `ownerId` is a definite string (refused above if absent).
    await adminUpdateRadar(radarId, ownerId, updates, buildQuadrantOptions(args));

    log.info('Updated radar', { radarId });
    emitDataRefresh('radars', 'ai-assistant');

    return {
      success: true,
      data: {
        id: radarId,
        updated: Object.keys(updates),
        guidance: 'Confirm the settings change to the user, listing the updated fields.',
      },
    };
  } catch (error) {
    // An orphan situation is recoverable IN PLACE — surface it as actionable
    // guidance so the model retries with reassignments/deleteOrphans instead of
    // falling back to a destructive reset + recreate of the radar.
    if (error instanceof OrphanedPlacementsError) {
      const groups = error.report.orphans
        .map((g) => `"${g.quadrantName ?? g.quadrantId}" (id: ${g.quadrantId}) → ${g.placements.length} placement(s)`)
        .join('; ');
      log.info('Radar quadrant update would orphan placements', {
        radarId: args.radarId,
        totalPlacements: error.report.totalPlacements,
      });
      return {
        success: false,
        error:
          `Removing those quadrants would orphan ${error.report.totalPlacements} placement(s): ${groups}. ` +
          `Do NOT reset or recreate the radar. Retry updateRadarSettings keeping the quadrant ids you want, and either ` +
          `pass "reassignments" to move each orphaned placement to a surviving quadrant id, or "deleteOrphans": true to remove them.`,
      };
    }
    log.error('Failed to update radar', error instanceof Error ? error : undefined);
    return {
      success: false,
      // GRAPH-060 #1 — an ownership refusal is a clear, non-retryable message.
      error:
        error instanceof RadarAuthorizationError
          ? 'You do not have permission to update this radar.'
          : error instanceof Error
            ? error.message
            : 'Failed to update radar settings',
    };
  }
}

/**
 * Build an id-aware `ProposedQuadrantConfig[]` from the `updateRadarSettings`
 * `quadrants` argument. The argument may be the canonical id-bearing object form
 * (`{ id?, name, description? }[]`) or a legacy name-only `string[]`. In BOTH
 * forms we back-fill the stable id of any quadrant whose name still matches an
 * existing one (case-insensitive), so editing the quadrants of a radar that
 * already has placements preserves those placements instead of regenerating
 * every id. An explicit `id` always wins over a name match.
 */
function normalizeProposedQuadrants(raw: unknown, existing: readonly QuadrantConfig[]): ProposedQuadrantConfig[] {
  if (!Array.isArray(raw)) return [];
  const byName = new Map<string, QuadrantConfig>();
  for (const q of existing) byName.set(q.name.trim().toLowerCase(), q);

  return raw.map((item): ProposedQuadrantConfig => {
    if (typeof item === 'string') {
      const match = byName.get(item.trim().toLowerCase());
      return match ? { id: match.id, name: item } : { name: item };
    }
    if (item && typeof item === 'object') {
      const obj = item as { id?: unknown; name?: unknown; description?: unknown };
      const name = typeof obj.name === 'string' ? obj.name : String(obj.name ?? '');
      const proposed: ProposedQuadrantConfig = { name };
      if (typeof obj.id === 'string' && obj.id) {
        proposed.id = obj.id;
      } else {
        const match = byName.get(name.trim().toLowerCase());
        if (match) proposed.id = match.id;
      }
      if (typeof obj.description === 'string') proposed.description = obj.description;
      return proposed;
    }
    return { name: String(item) };
  });
}

/**
 * Translate the optional orphan-resolution args (`reassignments` as an array of
 * `{ fromQuadrantId, toQuadrantId }`, `deleteOrphans` boolean) into the
 * `UpdateRadarQuadrantsOptions` the service layer expects. Returns `undefined`
 * when no resolution was requested, so the orphan guard still fires by default.
 */
function buildQuadrantOptions(args: Record<string, unknown>): UpdateRadarQuadrantsOptions | undefined {
  const options: UpdateRadarQuadrantsOptions = {};
  if (Array.isArray(args.reassignments)) {
    const map: Record<string, string> = {};
    for (const r of args.reassignments) {
      if (r && typeof r === 'object') {
        const { fromQuadrantId, toQuadrantId } = r as { fromQuadrantId?: unknown; toQuadrantId?: unknown };
        if (typeof fromQuadrantId === 'string' && typeof toQuadrantId === 'string') {
          map[fromQuadrantId] = toQuadrantId;
        }
      }
    }
    if (Object.keys(map).length > 0) options.reassignments = map;
  }
  if (args.deleteOrphans === true) options.deleteOrphans = true;
  return options.reassignments || options.deleteOrphans ? options : undefined;
}

/**
 * Stats projection promised by the `listRadars` tool description —
 * flat `total/adopt/trial/assess/hold` keys for the standard ring
 * system, plus the raw `byRing`/`byQuadrant` maps so TRL and
 * Time-to-Impact radars still report their counts.
 */
interface ListRadarsStats {
  total: number;
  adopt: number;
  trial: number;
  assess: number;
  hold: number;
  byRing: Record<string, number>;
  byQuadrant: Record<string, { name: string; count: number }>;
}

function toListRadarsStats(stats?: RadarStats): ListRadarsStats {
  const byRing = stats?.byRing ?? {};
  return {
    total: stats?.totalPlacements ?? 0,
    adopt: byRing.Adopt ?? 0,
    trial: byRing.Trial ?? 0,
    assess: byRing.Assess ?? 0,
    hold: byRing.Hold ?? 0,
    byRing,
    byQuadrant: stats?.byQuadrant ?? {},
  };
}

/**
 * List all radars
 */
export async function executeListRadars(args: Record<string, unknown>): Promise<{
  success: boolean;
  data?: {
    count: number;
    radars: Array<{
      id: string;
      name: string;
      description: string;
      ringSystem: string;
      quadrants: Array<{ id: string; name: string; order: number }>;
      stats?: ListRadarsStats;
    }>;
  };
  error?: string;
}> {
  try {
    // 2.3 — default ON so "how many technologies in the <ring> ring" questions
    // always get exact per-ring counts (stats.byRing). The model used to omit the
    // flag and guess (the A-CONSIST 3-vs-10 inconsistency). Opt out with false.
    const includeStats = args.includeStats !== false;

    if (!includeStats) {
      // Cheap path — radar docs only, no placement reads.
      const radars = await adminListRadars();
      return {
        success: true,
        data: {
          count: radars.length,
          radars: radars.map((r) => summarizeRadar(r)),
        },
      };
    }

    // Stats path — `adminGetAllRadars(true)` performs ONE bounded
    // `radarPlacements` collection read and buckets per radar in-memory
    // (no per-radar fan-out), so 36 radars still cost exactly two
    // Firestore queries.
    const radarsWithStats = await adminGetAllRadars(true);
    return {
      success: true,
      data: {
        count: radarsWithStats.length,
        radars: radarsWithStats.map((r) => ({
          ...summarizeRadar(r),
          stats: toListRadarsStats(r.stats),
        })),
      },
    };
  } catch (error) {
    log.error('Failed to list radars', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list radars',
    };
  }
}

/**
 * Default clip for technology descriptions returned by `getRadarDetails`.
 * One placement carried a ~15,000-char research dossier — a 106-entry
 * radar at that size blows up agent context. Full text stays reachable
 * via `getEntityDetails` or `descriptionMaxLength: 0`.
 */
const DEFAULT_DESCRIPTION_MAX_LENGTH = 280;

/**
 * Get detailed radar information
 */
export async function executeGetRadarDetails(args: Record<string, unknown>): Promise<{
  success: boolean;
  data?: { radar: unknown; technologies: unknown[]; stats: unknown; unplacedTechnologies?: unknown[]; note?: string };
  error?: string;
}> {
  try {
    const radarId = args.radarId as string;
    const includeUnplacedInLibrary = (args.includeUnplacedInLibrary as boolean) || false;

    // 0 = unlimited (explicit opt-out); anything non-numeric falls back to the default clip.
    const rawMaxLength = args.descriptionMaxLength;
    const descriptionMaxLength =
      typeof rawMaxLength === 'number' && Number.isFinite(rawMaxLength)
        ? Math.max(0, Math.floor(rawMaxLength))
        : DEFAULT_DESCRIPTION_MAX_LENGTH;

    let truncatedCount = 0;
    const clipDescription = (text: unknown): unknown => {
      if (typeof text !== 'string' || descriptionMaxLength === 0 || text.length <= descriptionMaxLength) {
        return text;
      }
      truncatedCount += 1;
      return `${text.slice(0, descriptionMaxLength)}…`;
    };

    // Admin SDK path — the client SDK reach into `@/lib/radars` +
    // `@/lib/radar-placement-service` from this server-side route
    // surfaces "internal Firestore error" to the model. Same failure
    // mode the listRadars / deleteRadar tools hit on 2026-05-13.
    const radar = await adminGetRadarById(radarId);
    if (!radar) {
      return {
        success: false,
        error: `Radar ${radarId} not found`,
      };
    }

    // Get technologies with placements (admin SDK)
    const technologiesWithPlacements = await adminGetTechnologiesWithPlacementsForRadar(radarId);

    // Calculate stats
    const stats = {
      total: technologiesWithPlacements.length,
      byRing: {
        Adopt: 0,
        Trial: 0,
        Assess: 0,
        Hold: 0,
      } as Record<string, number>,
      byQuadrant: {} as Record<string, number>,
    };

    technologiesWithPlacements.forEach((t) => {
      if (t.placement?.ring) {
        stats.byRing[t.placement.ring] = (stats.byRing[t.placement.ring] || 0) + 1;
      }
      if (t.placement?.quadrantId) {
        // Stats key by stable quadrantId; the tool result below exposes the
        // display name via `getQuadrantById` for agent-facing reports.
        stats.byQuadrant[t.placement.quadrantId] = (stats.byQuadrant[t.placement.quadrantId] || 0) + 1;
      }
    });

    const result: {
      radar: unknown;
      technologies: unknown[];
      stats: typeof stats;
      unplacedTechnologies?: unknown[];
      note?: string;
    } = {
      radar: {
        id: radar.id,
        name: radar.name,
        // Always-present keys so every radar serializes with the same shape.
        description: radar.description ?? '',
        ringSystem: radar.ringSystem ?? 'Standard',
        quadrants: radar.quadrants,
        slug: radar.slug,
      },
      technologies: technologiesWithPlacements.map((t) => ({
        id: t.id,
        name: t.name,
        description: clipDescription(t.description),
        category: t.category,
        tags: t.tags,
        placement: t.placement
          ? {
              quadrantId: t.placement.quadrantId,
              // Denormalized name for agent-facing reports — falls back to id when unknown.
              quadrant: getQuadrantById(radar, t.placement.quadrantId)?.name ?? t.placement.quadrantId,
              ring: t.placement.ring,
              status: t.placement.status,
              trlScore: t.placement.trlScore,
              // Emit `timeToImpact` only when actually assessed — the legacy
              // 'unknown' string vs absent-field split confused agents.
              ...(t.placement.timeToImpact && t.placement.timeToImpact !== 'unknown'
                ? { timeToImpact: t.placement.timeToImpact }
                : {}),
              rationale: t.placement.rationale,
            }
          : undefined,
      })),
      stats,
    };

    if (truncatedCount > 0) {
      result.note = `${truncatedCount} technology description(s) truncated to ${descriptionMaxLength} characters ("…" suffix). Full text is available via getEntityDetails, or pass descriptionMaxLength: 0 for untruncated output.`;
    }

    // Get unplaced technologies if requested (admin SDK so /api/ai/chat
    // doesn't time out on the technologies collection read).
    if (includeUnplacedInLibrary) {
      const allTechnologies = await adminListTechnologies();
      const placedIds = new Set(technologiesWithPlacements.map((t) => t.id));
      result.unplacedTechnologies = allTechnologies
        .filter((t) => !placedIds.has(t.id))
        .slice(0, 50) // Limit to prevent overwhelming response
        .map((t) => ({
          id: t.id,
          name: t.name,
          category: t.category,
          tags: t.tags,
        }));
    }

    return {
      success: true,
      data: result,
    };
  } catch (error) {
    log.error('Failed to get radar details', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get radar details',
    };
  }
}

/**
 * Advanced technology search
 */
export async function executeSearchTechnologiesAdvanced(args: Record<string, unknown>): Promise<{
  success: boolean;
  data?: {
    count: number;
    results: Array<{
      id: string;
      name: string;
      /** Navigable entity type — makes the chat entity chips deep-linkable. */
      type: 'technology';
      category?: string;
      tags: string[];
      placements?: Array<{ radarId: string; ring: string; quadrant: string }>;
    }>;
  };
  error?: string;
}> {
  try {
    const query = args.query as string | undefined;
    const tags = args.tags as string[] | undefined;
    const category = args.category as TechnologyCategory | undefined;
    const radarId = args.radarId as string | undefined;
    const ring = args.ring as Ring | undefined;
    const rawQuadrantArg = args.quadrant;
    if (rawQuadrantArg !== undefined && typeof rawQuadrantArg !== 'string') {
      return {
        success: false,
        error:
          'quadrant must be a string containing a stable quadrant id or display name. Call getRadarDetails and retry.',
      };
    }
    const quadrantArg = rawQuadrantArg;
    const status = args.status as Status | undefined;
    const trlScoreMin = args.trlScoreMin as number | undefined;
    const trlScoreMax = args.trlScoreMax as number | undefined;
    const timeToImpact = args.timeToImpact as TimeToImpact | undefined;
    const limit = Math.min((args.limit as number) || 20, 100);

    // Resolve the `quadrant` arg (name or id) before reading technologies. A
    // requested filter must never disappear and silently broaden the search.
    let filterQuadrantId: string | undefined;
    if (quadrantArg) {
      if (typeof radarId !== 'string' || radarId.length === 0) {
        return {
          success: false,
          error:
            'A radarId is required when filtering by quadrant. Call listRadars or getRadarDetails and retry with a valid radarId.',
        };
      }

      const targetRadar = await adminGetRadarById(radarId);
      if (!targetRadar) {
        return {
          success: false,
          error: `Radar ${radarId} not found. Call listRadars and retry with a valid radarId.`,
        };
      }

      filterQuadrantId = resolveQuadrantReference(targetRadar, quadrantArg)?.id;
      if (!filterQuadrantId) {
        return {
          success: false,
          error: `Quadrant ${JSON.stringify(quadrantArg)} was not found on radar ${radarId}. Call getRadarDetails for that radar and retry with an exact quadrant id or name.`,
        };
      }
    }

    const hasPlacementFilters = Boolean(
      radarId || ring || filterQuadrantId || status || trlScoreMin || trlScoreMax || timeToImpact
    );

    // Get base technologies from the library (admin SDK — same reason as
    // executeGetRadarDetails: the client SDK times out from /api/ai/chat).
    // When placement predicates follow, defer the result limit until after
    // their intersection; otherwise a valid placed technology beyond the
    // first candidate page is silently omitted.
    let technologies = await adminSearchTechnologies({
      search: query,
      category,
      tags,
      ...(hasPlacementFilters ? {} : { limit }),
    });

    // If radar-specific filters, apply them
    if (hasPlacementFilters) {
      // Get all placements and filter (admin SDK)
      const placements = await adminGetRadarPlacements(radarId ? { radarId } : {});

      // Build a map of technology placements
      const techPlacementMap = new Map<string, typeof placements>();
      placements.forEach((p) => {
        if (!techPlacementMap.has(p.technologyId)) {
          techPlacementMap.set(p.technologyId, []);
        }
        techPlacementMap.get(p.technologyId)!.push(p);
      });

      // Filter technologies based on placement criteria
      technologies = technologies.filter((tech) => {
        const techPlacements = techPlacementMap.get(tech.id) || [];
        if (
          techPlacements.length === 0 &&
          (ring || filterQuadrantId || status || trlScoreMin || trlScoreMax || timeToImpact)
        ) {
          return false; // No placements, can't match placement filters
        }

        // Check if any placement matches all criteria
        return techPlacements.some((p) => {
          if (ring && p.ring !== ring) return false;
          if (filterQuadrantId && p.quadrantId !== filterQuadrantId) return false;
          if (status && p.status !== status) return false;
          if (trlScoreMin && (!p.trlScore || p.trlScore < trlScoreMin)) return false;
          if (trlScoreMax && (!p.trlScore || p.trlScore > trlScoreMax)) return false;
          if (timeToImpact && p.timeToImpact !== timeToImpact) return false;
          return true;
        });
      });

      // Add placement info to results
      const resultsWithPlacements = technologies.slice(0, limit).map((tech) => ({
        id: tech.id,
        name: tech.name,
        type: 'technology' as const,
        description: tech.description,
        category: tech.category,
        tags: tech.tags,
        placements: (techPlacementMap.get(tech.id) || []).map((p) => ({
          radarId: p.radarId,
          ring: p.ring,
          quadrantId: p.quadrantId,
          // Denormalized display name if the adapter populated it; fallback to id.
          quadrant: p.quadrantName ?? p.quadrantId,
          status: p.status,
          trlScore: p.trlScore,
          timeToImpact: p.timeToImpact,
        })),
      }));

      return {
        success: true,
        data: {
          count: resultsWithPlacements.length,
          results: resultsWithPlacements,
        },
      };
    }

    // Simple search without placement filters
    return {
      success: true,
      data: {
        count: Math.min(technologies.length, limit),
        results: technologies.slice(0, limit).map((tech) => ({
          id: tech.id,
          name: tech.name,
          type: 'technology' as const,
          description: tech.description,
          category: tech.category,
          tags: tech.tags,
        })),
      },
    };
  } catch (error) {
    log.error('Failed to search technologies', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to search technologies',
    };
  }
}

/**
 * Bulk add technologies to a radar
 */
export async function executeAddTechnologiesToRadar(
  args: Record<string, unknown>,
  context?: { userId?: string }
): Promise<{
  success: boolean;
  data?: {
    added: number;
    committed: number;
    skipped: number;
    created: number;
    graphAcknowledged: number;
    reconciliationRequired: number;
    pendingReconciliation: number;
    failed: number;
    authorizationLost: boolean;
    complete: boolean;
    placements: Array<{
      technologyId: string;
      name: string;
      ring: string;
      quadrant: string;
      graphHandoff: PlacementGraphHandoff;
    }>;
    failures: Array<{ technologyId?: string; name?: string; reason: string }>;
    guidance: string;
  };
  error?: string;
}> {
  try {
    // GRAPH-060 — this is a user-triggered mutation. Refuse before resolving a
    // radar or touching Technology/Placement storage when no authenticated
    // principal reached the executor.
    const ownerId = context?.userId;
    if (!ownerId) {
      return {
        success: false,
        error: 'You must be signed in to add technologies to a radar.',
      };
    }

    const technologies = args.technologies as Array<{
      technologyId?: string;
      name?: string;
      description?: string;
      category?: string;
      tags?: string[];
      quadrant: string;
      ring: string;
      status?: string;
      trlScore?: number;
      timeToImpact?: string;
      rationale?: string;
    }>;
    const skipExisting = args.skipExisting !== false;

    // AI-022: the ONE shared exact resolver — stable ID first, then unique
    // normalized exact name; ambiguity/absence fail closed with candidates.
    const resolution = await resolveRadarReference(args.radarId as string | undefined);
    if (!resolution.ok) {
      return {
        success: false,
        error: resolution.message,
      };
    }
    // Resolve names/ids through the shared resolver, then enforce owner-only
    // mutation before any child Technology read or write. Placement commits
    // repeat this check transactionally through `requireOwnerId`, closing an
    // ownership-change race between resolution and commit.
    const radar = await adminGetOwnedRadarById(resolution.radar.id, ownerId);
    // Every write below uses the RESOLVED canonical radar ID — never the raw
    // reference, which may have been a display name.
    const radarId = radar.id;

    const results = {
      added: 0,
      skipped: 0,
      created: 0,
      graphAcknowledged: 0,
      reconciliationRequired: 0,
      failed: 0,
      authorizationLost: false,
      placements: [] as Array<{
        technologyId: string;
        name: string;
        ring: string;
        quadrant: string;
        graphHandoff: PlacementGraphHandoff;
      }>,
      failures: [] as Array<{ technologyId?: string; name?: string; reason: string }>,
    };

    const recordFailure = (
      tech: (typeof technologies)[number],
      reason: string,
    ): void => {
      results.failed++;
      if (results.failures.length >= 10) return;
      results.failures.push({
        ...(typeof tech.technologyId === 'string'
          ? { technologyId: tech.technologyId }
          : {}),
        ...(typeof tech.name === 'string'
          ? { name: cleanMarkdownFromText(tech.name).slice(0, 120) }
          : {}),
        reason: reason.slice(0, 240),
      });
    };

    for (const tech of technologies) {
      try {
        let technologyId = tech.technologyId;
        let technologyName = tech.name || '';

        // If no technology ID, try to find by name or create new
        if (!technologyId && tech.name) {
          // Search for existing technology
          // Do not limit before exact selection: the Admin reader sorts fuzzy
          // results alphabetically, so a predecessor such as "Preact" could
          // otherwise hide the exact "React" row and provoke a duplicate
          // create attempt.
          const existing = await adminGetTechnologies({ search: tech.name });
          const exactMatch = existing.find((t) => t.name.toLowerCase() === tech.name!.toLowerCase());

          if (exactMatch) {
            technologyId = exactMatch.id;
            technologyName = exactMatch.name;
          } else {
            // Create new technology. `adminCreateTechnology` reproduces the
            // client `createTechnology` path exactly (own tech-id, slug
            // uniqueness transaction, dedicated `app/technology.sync.requested`
            // event). The slug is still derived from the RAW `tech.name` via the
            // same kebab-case transform the client `generateSlug` applied, so the
            // generated slug is byte-for-byte identical to the pre-migration path.
            const newTech = await adminCreateTechnology({
              name: cleanMarkdownFromText(tech.name),
              slug: tech.name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, ''),
              description: tech.description ? cleanMarkdownFromText(tech.description) : '',
              category: tech.category as TechnologyCategory | undefined,
              tags: tech.tags || [],
              createdBy: ownerId,
            });
            technologyId = newTech.id;
            technologyName = newTech.name;
            results.created++;
          }
        }

        if (!technologyId) {
          const reason = 'Technology row must include a technologyId or name.';
          log.warn('Rejecting technology row - no ID or name provided');
          recordFailure(tech, reason);
          continue;
        }

        // Check if already placed on this radar
        const existingPlacement = await adminGetPlacementForTechnologyOnRadar(technologyId, radarId);
        if (existingPlacement && skipExisting) {
          results.skipped++;
          continue;
        }

        // Resolve `tech.quadrant` (a display name from the agent) against the
        // target radar's stable quadrantIds. This is an invalid requested row,
        // not an intentional no-op: it must keep the batch incomplete.
        const resolvedQuadrant = resolveQuadrantReference(radar, tech.quadrant, { precedence: 'name-first' });
        if (!resolvedQuadrant) {
          const reason = `Quadrant "${String(tech.quadrant)}" does not resolve on this radar.`;
          log.warn('Rejecting technology row - unresolved quadrant', {
            technologyId,
            attempted: tech.quadrant,
            availableQuadrants: radar.quadrants.map((q) =>
              typeof q === 'object' && q !== null && 'name' in q ? (q.name as string) : ''
            ),
          });
          recordFailure(tech, reason);
          continue;
        }
        const resolvedQuadrantId = resolvedQuadrant.id;
        const resolvedQuadrantName = resolvedQuadrant.name;

        // Create or update placement
        const mutationResult = existingPlacement
          ? await adminUpdateRadarPlacementWithHandoff(
              existingPlacement.id,
              {
                quadrantId: resolvedQuadrantId,
                ring: tech.ring as Ring,
                status: tech.status as Status | undefined,
                trlScore: tech.trlScore,
                timeToImpact: tech.timeToImpact as TimeToImpact | undefined,
                rationale: tech.rationale,
              },
              { requireOwnerId: ownerId }
            )
          : await adminCreateRadarPlacementWithHandoff(
              {
                technologyId,
                radarId,
                quadrantId: resolvedQuadrantId,
                ring: tech.ring as Ring,
                status: (tech.status as Status) || 'New',
                trlScore: tech.trlScore,
                timeToImpact: tech.timeToImpact as TimeToImpact | undefined,
                rationale: tech.rationale,
                placedBy: ownerId,
              },
              { requireOwnerId: ownerId }
            );

        if (mutationResult.graphHandoff.acknowledged) {
          results.graphAcknowledged++;
        }
        if (mutationResult.graphHandoff.reconciliationRequired) {
          results.reconciliationRequired++;
        }

        /*
         * Firestore has committed by the time a handoff result exists. Count it
         * as added even when graph acknowledgement is pending; the caller must
         * never recreate/retry that row blindly.
         */
        results.added++;
        results.placements.push({
          technologyId,
          name: technologyName,
          ring: tech.ring,
          quadrant: resolvedQuadrantName,
          graphHandoff: mutationResult.graphHandoff,
        });
      } catch (techError) {
        const authorizationLost =
          techError instanceof PlacementAuthorizationError ||
          techError instanceof RadarAuthorizationError;
        const reason = authorizationLost
          ? 'Authorization was lost while updating this radar; remaining rows were not attempted.'
          : techError instanceof Error
            ? techError.message.slice(0, 240)
            : String(techError).slice(0, 240);
        log.warn('Failed to add technology', { error: reason });
        recordFailure(tech, reason);
        if (authorizationLost) {
          results.authorizationLost = true;
          break;
        }
      }
    }

    log.info('Added technologies to radar', {
      added: results.added,
      created: results.created,
      skipped: results.skipped,
      failed: results.failed,
      authorizationLost: results.authorizationLost,
      graphAcknowledged: results.graphAcknowledged,
      reconciliationRequired: results.reconciliationRequired,
      radarId,
    });
    emitDataRefresh('technologies', 'ai-assistant');

    return {
      success: true,
      data: {
        ...results,
        committed: results.added,
        pendingReconciliation: results.reconciliationRequired,
        complete:
          results.failed === 0 &&
          results.reconciliationRequired === 0,
        guidance:
          results.authorizationLost
            ? 'Report the committed rows and the authorization failure exactly. Remaining rows were not attempted; do not retry or recreate committed placements.'
            : results.failed > 0 || results.reconciliationRequired > 0
              ? 'Report committed, skipped, failed, and pending-reconciliation counts separately. Do not retry or recreate committed placements; reconciliation will recover unacknowledged graph handoffs.'
            : 'Confirm the additions to the user, summarizing the added/created/skipped counts and ring placements.',
      },
    };
  } catch (error) {
    log.error('Failed to add technologies to radar', error instanceof Error ? error : undefined);
    return {
      success: false,
      error:
        error instanceof RadarAuthorizationError
          ? 'You do not have permission to add technologies to this radar.'
          : error instanceof Error
            ? error.message
            : 'Failed to add technologies to radar',
    };
  }
}

/**
 * Update a technology's placement on a radar
 */
export async function executeUpdateTechnologyOnRadar(
  args: Record<string, unknown>,
  context?: { userId?: string }
): Promise<{
  success: boolean;
  data?: {
    placementId: string;
    updated: string[];
    movedFrom?: string;
    movedTo?: string;
    graphHandoff: PlacementGraphHandoff;
    guidance: string;
  };
  error?: string;
}> {
  try {
    const ownerId = context?.userId;
    if (!ownerId) {
      return {
        success: false,
        error: 'You must be signed in to update a technology placement.',
      };
    }

    const technologyId = args.technologyId as string;
    const rawRadarId = args.radarId as string;

    // Authorize the radar before reading or writing. This also keeps a missing
    // radar indistinguishable from a foreign-owned radar for the caller.
    const radar = await adminGetOwnedRadarById(rawRadarId, ownerId);
    const radarId = radar.id;

    // Find the placement
    const placement = await adminGetPlacementForTechnologyOnRadar(technologyId, radarId);
    if (!placement) {
      return {
        success: false,
        error: `Technology ${technologyId} is not placed on radar ${radarId}`,
      };
    }

    const updates: {
      quadrantId?: string;
      ring?: Ring;
      status?: Status;
      trlScore?: number;
      timeToImpact?: TimeToImpact;
      rationale?: string;
    } = {};

    const oldRing = placement.ring;

    // Resolve `args.quadrant` (a display name from the agent) against the
    // target radar's stable quadrantIds. Required for the ID-first model.
    if (args.quadrant) {
      const quadrantArg = args.quadrant as string;
      const hit = resolveQuadrantReference(radar, quadrantArg);
      if (!hit) {
        return {
          success: false,
          error: `Quadrant "${quadrantArg}" not found on radar ${radarId}`,
        };
      }
      updates.quadrantId = hit.id;
    }
    if (args.ring) updates.ring = args.ring as Ring;
    if (args.status) updates.status = args.status as Status;
    if (args.trlScore !== undefined) updates.trlScore = args.trlScore as number;
    if (args.timeToImpact) updates.timeToImpact = args.timeToImpact as TimeToImpact;
    if (args.rationale) updates.rationale = args.rationale as string;

    if (Object.keys(updates).length === 0) {
      return {
        success: false,
        error: 'No updates provided',
      };
    }

    const { graphHandoff } = await adminUpdateRadarPlacementWithHandoff(
      placement.id,
      updates,
      { requireOwnerId: ownerId }
    );

    log.info('Updated placement', { placementId: placement.id, graphAcknowledged: graphHandoff.acknowledged });
    emitDataRefresh('technologies', 'ai-assistant');

    const result: {
      placementId: string;
      updated: string[];
      movedFrom?: string;
      movedTo?: string;
      graphHandoff: PlacementGraphHandoff;
      guidance: string;
    } = {
      placementId: placement.id,
      updated: Object.keys(updates),
      graphHandoff,
      guidance: graphHandoff.acknowledged
        ? 'Confirm the change to the user, mentioning before/after ring.'
        : 'Confirm the change was committed, but note the graph handoff is pending reconciliation.',
    };

    if (updates.ring && updates.ring !== oldRing) {
      result.movedFrom = oldRing;
      result.movedTo = updates.ring;
    }

    return {
      success: true,
      data: result,
    };
  } catch (error) {
    log.error('Failed to update technology placement', error instanceof Error ? error : undefined);
    return {
      success: false,
      error:
        error instanceof RadarAuthorizationError || error instanceof PlacementAuthorizationError
          ? 'You do not have permission to update this radar.'
          : error instanceof Error
            ? error.message
            : 'Failed to update technology on radar',
    };
  }
}

/**
 * Populate a radar from conversation context (workflow tool)
 */
export async function executePopulateRadarFromContext(
  args: Record<string, unknown>,
  context?: { userId?: string }
): Promise<{
  success: boolean;
  data?: {
    radarId: string;
    radarName: string;
    radarCreated: boolean;
    technologiesCreated: number;
    placementsCreated: number;
    committed: number;
    graphAcknowledged: number;
    reconciliationRequired: number;
    pendingReconciliation: number;
    skipped: number;
    failed: number;
    authorizationLost: boolean;
    complete: boolean;
    placements: Array<{
      technologyId: string;
      name: string;
      ring: string;
      quadrant: string;
      graphHandoff: PlacementGraphHandoff;
    }>;
    failures: Array<{ technologyId?: string; name?: string; reason: string }>;
    summary: string;
    guidance: string;
  };
  error?: string;
}> {
  try {
    if (!context?.userId) {
      return {
        success: false,
        error: 'You must be signed in to populate a radar.',
      };
    }

    let radarId = args.radarId as string | undefined;
    const radarName = args.radarName as string | undefined;
    const technologies = args.technologies as Array<{
      name: string;
      description?: string;
      category?: string;
      tags?: string[];
      suggestedQuadrant: string;
      suggestedRing: string;
      suggestedStatus?: string;
      suggestedTrl?: number;
      suggestedTimeToImpact?: string;
      rationale?: string;
    }>;
    const createMissingRadar = (args.createMissingRadar as boolean) || false;
    const customQuadrants = args.customQuadrants as string[] | undefined;

    let radarCreated = false;
    let actualRadarName = radarName || '';

    // Find or create radar
    if (!radarId) {
      if (radarName) {
        // AI-022: shared exact resolver — an ambiguous name must error (ask
        // the user), never silently pick the first match or create a twin.
        const resolution = await resolveRadarReference(radarName);
        if (resolution.ok) {
          radarId = resolution.radar.id;
          actualRadarName = resolution.radar.name;
        } else if (resolution.reason === 'ambiguous') {
          return {
            success: false,
            error: resolution.message,
          };
        }
      }

      // Create if needed
      if (!radarId && createMissingRadar && radarName) {
        // GRAPH-060 #1 — creating a radar requires the authenticated owner; fail closed.
        let customConfigs: QuadrantConfig[] | undefined;
        if (customQuadrants) {
          if (customQuadrants.length < MIN_QUADRANTS || customQuadrants.length > MAX_QUADRANTS) {
            return {
              success: false,
              error: `Custom quadrants count out of range: expected ${MIN_QUADRANTS}..${MAX_QUADRANTS}, got ${customQuadrants.length}`,
            };
          }
          customConfigs = ensureQuadrantConfigs(customQuadrants, defaultQuadrantIdFromName);
        }

        const newRadar = await adminCreateRadar(
          context.userId,
          cleanMarkdownFromText(radarName),
          undefined,
          customConfigs
        );
        radarId = newRadar.id;
        actualRadarName = newRadar.name;
        radarCreated = true;
      }

      if (!radarId) {
        return {
          success: false,
          error: 'No radar ID or name provided, and createMissingRadar is false',
        };
      }
    } else {
      // Verify radar exists
      const radar = await adminGetRadarById(radarId);
      if (!radar) {
        return {
          success: false,
          error: `Radar ${radarId} not found`,
        };
      }
      actualRadarName = radar.name;
    }

    // Convert to format expected by addTechnologiesToRadar
    const techsToAdd = technologies.map((t) => ({
      name: t.name,
      description: t.description,
      category: t.category,
      tags: t.tags,
      quadrant: t.suggestedQuadrant,
      ring: t.suggestedRing,
      status: t.suggestedStatus,
      trlScore: t.suggestedTrl,
      timeToImpact: t.suggestedTimeToImpact,
      rationale: t.rationale,
    }));

    const result = await executeAddTechnologiesToRadar(
      {
        radarId,
        technologies: techsToAdd,
        skipExisting: true,
      },
      context
    );

    if (!result.success) {
      return result as { success: false; error: string };
    }

    const addResult = result.data!;

    log.info('Populated radar', { radarName: actualRadarName, technologiesAdded: addResult.added });
    emitDataRefresh('radars', 'ai-assistant');

    // Build summary
    const ringCounts: Record<string, number> = {};
    addResult.placements.forEach((p) => {
      ringCounts[p.ring] = (ringCounts[p.ring] || 0) + 1;
    });
    const ringSummary = Object.entries(ringCounts)
      .map(([ring, count]) => `${count} in ${ring}`)
      .join(', ');

    return {
      success: true,
      data: {
        radarId: radarId!,
        radarName: actualRadarName,
        radarCreated,
        technologiesCreated: addResult.created,
        placementsCreated: addResult.added,
        committed: addResult.committed,
        graphAcknowledged: addResult.graphAcknowledged,
        reconciliationRequired: addResult.reconciliationRequired,
        pendingReconciliation: addResult.pendingReconciliation,
        skipped: addResult.skipped,
        failed: addResult.failed,
        authorizationLost: addResult.authorizationLost,
        complete: addResult.complete,
        placements: addResult.placements,
        failures: addResult.failures,
        summary:
          `Committed ${addResult.committed} technologies to "${actualRadarName}" radar${radarCreated ? ' (newly created)' : ''}: ${ringSummary}. ` +
          `${addResult.created} new technologies were created in the library; ${addResult.skipped} were already placed; ` +
          `${addResult.failed} rows failed and ` +
          `${addResult.pendingReconciliation} committed placements are pending graph reconciliation.`,
        guidance: addResult.complete
          ? 'Confirm the result to the user using the summary, mentioning the radar name and ring distribution.'
          : addResult.guidance,
      },
    };
  } catch (error) {
    log.error('Failed to populate radar', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to populate radar from context',
    };
  }
}
