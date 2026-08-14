/**
 * @file ai/tools/technology-decoupled.ts
 * @description AI tools for the decoupled Technology model (Phase 1)
 *
 * Provides AI capabilities for:
 * - Creating decoupled technologies (facts only, no radar placement)
 * - Updating decoupled technologies
 * - Placing technologies on radars (creating RadarPlacements)
 * - Moving technologies between rings
 * - Searching decoupled technologies
 *
 * These tools work with the new decoupled model where:
 * - Technology = facts (what the technology IS)
 * - RadarPlacement = opinion (where it's placed on a radar)
 *
 * @author Radarist Team
 * @created 2025-01-07
 */

import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';
import {
  adminCreateTechnology,
  adminUpdateTechnology,
  adminGetTechnologies,
  adminGetTechnologyById,
  adminDeleteTechnologyCompletely,
} from '@/lib/technology-admin';
import { claimResearchDispatch, releaseResearchPending } from '@/lib/technology-research-admin';
import {
  adminCreateRadarPlacementWithHandoff,
  adminUpdateRadarPlacementWithHandoff,
  adminGetRadarPlacements,
  adminGetPlacementForTechnologyOnRadar,
  adminDeleteRadarPlacementWithHandoff,
  PlacementAuthorizationError,
  type PlacementGraphHandoff,
} from '@/lib/radar-placement-admin';
import { resolveRadarReference } from '@/lib/radar-resolver-admin';
import { adminGetOwnedRadarById, RadarAuthorizationError } from '@/lib/radars-admin';
import { emitDataRefresh } from '@/lib/events/data-refresh';
import { cleanMarkdownFromText } from '@/lib/ai/signal-evaluation';
import { DuplicateEntityError } from '@/lib/entity-factory-shared';
import { inngest } from '@/lib/inngest/client';
import {
  resolveQuadrantReference,
  type TechnologyCategory,
  type Ring,
  type Status,
  type TimeToImpact,
} from '@/lib/types';
import { createLogger } from '@/lib/logger';
import { verifyEntityReality } from '@/lib/entity-reality-check';
import { verifyUrlsReachable } from '@/lib/scout-url-verifier';
import {
  confirmDestructiveAction,
  destructiveActionFingerprint,
  normalizeDestructiveIdentifier,
  type DestructiveGateRefusal,
} from '@/lib/ai/destructive-confirmation';
import { DELETION_MUTATED_ENTITY_TYPES } from '@/lib/ai/mutation-tracking';

const log = createLogger('ai/tech-decoupled');

/**
 * Minimal slice of the tool execution context that destructive executors need
 * for the server-verified confirmation gate (#121). Kept inline (not imported
 * from `@/lib/ai/tools`) to avoid an import cycle — `tools.ts` imports these
 * executors, so importing its types back would close the loop.
 */
type DeleteGateContext = {
  principal?: 'human' | 'machine';
  userId?: string;
  requestId?: string;
  confirmationText?: string;
};

/**
 * Generates a URL-friendly slug from a technology name. Byte-identical to
 * `technology-core.generateSlug` (re-exported as `@/lib/technology-service`'s
 * `generateSlug`) — inlined here so the server-side admin path doesn't pull in
 * the client-SDK `technology-service` module just for this pure helper.
 */
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ============================================================================
// Tool Definitions for Decoupled Technology Model
// ============================================================================

export const TECHNOLOGY_DECOUPLED_TOOLS: FunctionDeclaration[] = [
  {
    name: 'createDecoupledTechnology',
    description: `Add a new technology to the library (facts only, no radar placement).

WHEN TO USE THIS TOOL:
- "Add [technology] to our tech library"
- "Create an entry for [framework]"
- "Track [platform] in our system"
- "Register [tool] without placing it on radar"

KEY CONCEPT - DECOUPLED MODEL:
- Technology = FACTS (what it IS): name, description, URLs, category
- RadarPlacement = OPINION (where it goes): quadrant, ring, rationale
- This tool creates the FACTS only
- Use 'placeTechnologyOnRadar' to add the OPINION

TECHNOLOGY CATEGORIES:
- framework: React, Angular, Django, Spring Boot
- language: Python, TypeScript, Rust, Go
- platform: AWS, Kubernetes, Salesforce
- tool: Docker, Jenkins, VS Code
- library: NumPy, Lodash
- service: Auth0, Stripe
- methodology: DevOps, Agile
- infrastructure: PostgreSQL, Redis

EXAMPLE:
createDecoupledTechnology(
  name: "LangChain",
  description: "Framework for building LLM-powered applications",
  category: "framework",
  tags: ["AI", "LLM", "Python"],
  websiteUrl: "https://langchain.com",
  githubUrl: "https://github.com/langchain-ai/langchain"
)

NEXT STEPS:
After creating, optionally call 'placeTechnologyOnRadar' to add to a radar.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        name: {
          type: SchemaType.STRING,
          description: "Technology name (e.g., 'React', 'Kubernetes', 'GraphQL')",
        },
        description: {
          type: SchemaType.STRING,
          description: 'Technology description - what it is, what problems it solves',
        },
        category: {
          type: SchemaType.STRING,
          description:
            "Category: 'framework', 'language', 'platform', 'tool', 'library', 'service', 'methodology', 'infrastructure'",
        },
        tags: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: "Tags for categorization (e.g., ['frontend', 'javascript', 'ui'])",
        },
        websiteUrl: {
          type: SchemaType.STRING,
          description: 'Official website URL',
        },
        githubUrl: {
          type: SchemaType.STRING,
          description: 'GitHub repository URL',
        },
        documentationUrl: {
          type: SchemaType.STRING,
          description: 'Documentation URL',
        },
        skipRealityCheck: {
          type: SchemaType.BOOLEAN,
          description:
            'If true, skip the web-presence reality check. Default: false. Only set to true when the user confirms the technology is legitimate (e.g. a private internal tool without public presence).',
        },
      },
      required: ['name', 'description'],
    },
  },
  {
    name: 'updateDecoupledTechnology',
    description: `Update a decoupled technology's factual information.

Use this to update the technology itself (name, description, URLs, tags, etc.).
This does NOT change radar placement - use moveTechnologyRing for that.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        technologyId: {
          type: SchemaType.STRING,
          description: 'The technology ID to update',
        },
        updates: {
          type: SchemaType.OBJECT,
          properties: {
            name: { type: SchemaType.STRING },
            description: { type: SchemaType.STRING },
            category: { type: SchemaType.STRING },
            tags: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
            websiteUrl: { type: SchemaType.STRING },
            githubUrl: { type: SchemaType.STRING },
            documentationUrl: { type: SchemaType.STRING },
          },
          description: 'Fields to update',
        },
        confirmed: {
          type: SchemaType.BOOLEAN,
          description: 'Must be true to execute update. Ask for user confirmation first.',
        },
      },
      required: ['technologyId', 'updates'],
    },
  },
  {
    name: 'placeTechnologyOnRadar',
    description: `Add a technology to a radar at a specific position (quadrant + ring).

WHEN TO USE THIS TOOL:
- "Put React in the Adopt ring"
- "Place [technology] on the frontend radar"
- "Add [tech] to the radar in Trial"
- "Position [framework] in Languages & Frameworks quadrant"

RADAR QUADRANTS (what category):
- 'Languages & Frameworks': React, Python, Django, Spring
- 'Platforms': AWS, Kubernetes, Salesforce
- 'Tools': Docker, Jenkins, VS Code, Figma
- 'Techniques': Microservices, DevOps, MLOps

RADAR RINGS (what action to take):
- 'Adopt': We use it, recommended for production
- 'Trial': We're testing it, promising results
- 'Assess': We're evaluating it, worth researching
- 'Hold': We advise against it for now

STATUS INDICATORS:
- 'New': Recently added, first appearance
- 'Trending': Growing adoption, momentum up
- 'Stable': Consistent position, mature
- 'Fading': Declining interest, consider alternatives
- 'Warning': Concerns identified, review needed

NOTE: A technology can be on multiple radars with different positions!
Example: "React" might be "Adopt" on Frontend Radar but "Trial" on Mobile Radar

EXAMPLE (name-based; resolution happens server-side):
placeTechnologyOnRadar(
  technologyId: "tech-abc123",
  quadrant: "Languages & Frameworks",
  ring: "Adopt",
  status: "Stable",
  rationale: "Battle-tested in production for 3 years, strong ecosystem"
)

EXAMPLE (id-based; preferred when you already know the stable id from getRadarDetails):
placeTechnologyOnRadar(
  technologyId: "tech-abc123",
  quadrant: "q_languages_frameworks",
  ring: "Adopt",
  status: "Stable",
  rationale: "Battle-tested in production for 3 years, strong ecosystem"
)`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        technologyId: {
          type: SchemaType.STRING,
          description: 'The technology ID to place',
        },
        radarId: {
          type: SchemaType.STRING,
          description: 'The radar ID to place on (optional, uses default radar if not specified)',
        },
        quadrant: {
          type: SchemaType.STRING,
          description:
            'Target quadrant, resolved against the target radar. Accepts a stable quadrant id (e.g. "q_languages_frameworks") or a display name (case-insensitive). Call getRadarDetails first to see the available quadrants for a specific radar — the radar may have 1–8 quadrants, and they vary per radar.',
        },
        ring: {
          type: SchemaType.STRING,
          description:
            "Maturity ring (HATA): 'Adopt', 'Trial', 'Assess', 'Hold'. Displayed as the primary ring badge on the entry list.",
        },
        trlScore: {
          type: SchemaType.NUMBER,
          description:
            'Technology Readiness Level (optional, 1–9). Populates the TRL column on the entry list. 1 = basic research, 9 = proven in operation. Always provide a realistic estimate when placing a technology — omitting it renders "-" and leaves the entry looking unfinished.',
        },
        timeToImpact: {
          type: SchemaType.STRING,
          description:
            "Business-impact horizon (optional): 'H1' (0–6 months, near-term), 'H2' (6–18 months, medium-term), 'H3' (18+ months, long-term), or 'unknown'. Populates the Time-to-Impact column. Always provide when placing a technology — omitting it renders \"-\".",
        },
        rationale: {
          type: SchemaType.STRING,
          description: 'Reasoning for this placement',
        },
        status: {
          type: SchemaType.STRING,
          description: "Status indicator: 'Trending', 'Stable', 'Fading', 'New', 'Warning'",
        },
      },
      required: ['technologyId', 'quadrant', 'ring'],
    },
  },
  {
    name: 'moveDecoupledTechnologyRing',
    description: `Move a technology to a different ring on a radar.

Use this to change where a technology is positioned on a radar (e.g., from 'Trial' to 'Adopt').
Tracks movement history automatically.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        technologyId: {
          type: SchemaType.STRING,
          description: 'The technology ID to move',
        },
        radarId: {
          type: SchemaType.STRING,
          description: 'The radar ID where the technology is placed',
        },
        newRing: {
          type: SchemaType.STRING,
          description: "The new ring: 'Adopt', 'Trial', 'Assess', 'Hold'",
        },
        rationale: {
          type: SchemaType.STRING,
          description: 'Reasoning for this ring change',
        },
        confirmed: {
          type: SchemaType.BOOLEAN,
          description: 'Must be true to execute. Ask for confirmation first.',
        },
      },
      required: ['technologyId', 'radarId', 'newRing'],
    },
  },
  {
    name: 'searchDecoupledTechnologies',
    description: `Search the technology library for matching technologies.

WHEN TO USE THIS TOOL:
- "Find technologies related to AI"
- "Search for frontend frameworks"
- "Look for Python libraries"
- "What technologies do we have for data processing?"
- "Find React" (to get its ID before other operations)

SEARCH CAPABILITIES:
- Name matching: "React", "Kubernetes", "TensorFlow"
- Keyword search: "machine learning", "containerization"
- Category filter: "framework", "platform", "tool"
- Tag filter: ["AI", "frontend", "cloud"]

COMMON USE CASES:
1. Find a technology ID before placing on radar
2. Check if a technology already exists before creating
3. Browse technologies by category or tags
4. Find technologies to relate to a company/use case

EXAMPLE SEARCHES:
- searchDecoupledTechnologies(query: "react")
- searchDecoupledTechnologies(query: "machine learning", category: "library")
- searchDecoupledTechnologies(query: "kubernetes", tags: ["cloud", "container"])

RETURNS:
- List of matching technologies with ID, name, description
- Category and tags for each
- Number of radar placements (how many radars it's on)

TIP: Use the returned technology ID for placeTechnologyOnRadar, createRelation, etc.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description: 'Search query to match against names and descriptions',
        },
        category: {
          type: SchemaType.STRING,
          description: 'Filter by category (optional)',
        },
        tags: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Filter by tags (optional)',
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Maximum results (default: 10, max: 50)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'getDecoupledTechnologyDetails',
    description: `Get detailed information about a decoupled technology including all its radar placements.

Returns the technology facts plus where it's placed across all radars.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        technologyId: {
          type: SchemaType.STRING,
          description: 'The technology ID',
        },
      },
      required: ['technologyId'],
    },
  },
  {
    name: 'deleteDecoupledTechnology',
    description: `Delete a decoupled technology with its complete server-side cascade, including radar placements, relations, document links, and reverse references.

WARNING: This is destructive. It permanently removes the library entry and its linked data, and schedules the corresponding knowledge-graph deletion.

Interactive confirmation is server-verified: relay the exact action-bound phrase returned by the first call, stop for the turn, and retry only when the next raw user message exactly matches it.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        technologyId: {
          type: SchemaType.STRING,
          description: 'The technology ID to delete',
        },
        confirmed: {
          type: SchemaType.BOOLEAN,
          description:
            'Legacy explicit-confirm flag for automated (non-chat) callers only. Interactive chat must relay the exact action-bound phrase returned by the first call and retry only when the next raw user message exactly matches it.',
        },
      },
      required: ['technologyId'],
    },
  },
  {
    name: 'removeTechnologyFromRadar',
    description: `Remove a technology from a specific radar (delete its placement).

This removes the technology from one radar only. The technology itself remains in the library.

Interactive confirmation is server-verified: relay the exact action-bound phrase returned by the first call, stop for the turn, and retry only when the next raw user message exactly matches it.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        technologyId: {
          type: SchemaType.STRING,
          description: 'The technology ID',
        },
        radarId: {
          type: SchemaType.STRING,
          description: 'The radar ID to remove from',
        },
        confirmed: {
          type: SchemaType.BOOLEAN,
          description:
            'Legacy explicit-confirm flag for automated (non-chat) callers only. Interactive chat must relay the exact action-bound phrase returned by the first call and retry only when the next raw user message exactly matches it.',
        },
      },
      required: ['technologyId', 'radarId'],
    },
  },
  {
    name: 'researchTechnologyComprehensive',
    description: `Deep-dive AI research on a technology - generates comprehensive 12-section analysis.

WHEN TO USE THIS TOOL:
- "Research [technology] thoroughly"
- "Do a deep dive on [framework]"
- "Generate a technology assessment for [platform]"
- "I need detailed analysis of [tool]"
- "Prepare a technology report for [tech]"

WHAT IT RESEARCHES (12 sections):
1. Executive Summary & Key Insights
2. Maturity Assessment (Hype Cycle position, Technology Readiness Level)
3. Technology Metrics & Milestones (GitHub stars, npm downloads, etc.)
4. Key Players (Market leaders, innovative startups, research institutions)
5. Use Cases & Applications (Real-world implementations)
6. Technical Deep-Dive (Architecture, strengths, limitations)
7. Value Assessment & ROI (Business value, cost considerations)
8. Risks & Barriers (Adoption challenges, technical debt)
9. Investment Landscape (Funding, acquisitions, market trends)
10. Regulatory & Compliance (Security, privacy, standards)
11. Talent & Skills (Job market, learning curve)
12. Future Outlook & Trends (Predictions, roadmap)

HOW IT WORKS:
- Runs in background (doesn't block conversation)
- Uses AI to gather and synthesize web information
- Results saved to technology's "Research" tab
- Takes ~30-60 seconds to complete

PREREQUISITE: Technology must already exist in library. Use searchDecoupledTechnologies to find its ID.

EXAMPLE:
researchTechnologyComprehensive(
  technologyId: "tech-abc123",
  technologyName: "LangChain"
)

AFTER RESEARCH COMPLETES:
User can view the full report in the Technology Details → Research tab.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        technologyId: {
          type: SchemaType.STRING,
          description: 'The technology ID to research',
        },
        technologyName: {
          type: SchemaType.STRING,
          description: 'Technology name (optional, for display purposes)',
        },
      },
      required: ['technologyId'],
    },
  },
  {
    name: 'confirmPlacement',
    description: `Human-in-the-loop confirmation for radar placements (Task 0.4.1).

IMPORTANT: Always use this tool BEFORE calling placeTechnologyOnRadar or moveDecoupledTechnologyRing.

This tool presents the proposed placement to the user for review and approval.
The user can:
- Approve: Proceed with the placement as proposed
- Reject: Cancel the placement with a reason
- Modify: Suggest changes to the placement

After calling this tool and receiving approval, call the appropriate placement tool
(placeTechnologyOnRadar or moveDecoupledTechnologyRing) to execute the action.

Example flow:
1. AI analyzes technology and proposes placement
2. AI calls confirmPlacement with the proposal
3. User reviews and responds (approve/reject/modify)
4. If approved, AI calls placeTechnologyOnRadar to execute`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        technologyId: {
          type: SchemaType.STRING,
          description: 'The technology ID being placed',
        },
        technologyName: {
          type: SchemaType.STRING,
          description: 'The technology name (for display)',
        },
        radarId: {
          type: SchemaType.STRING,
          description: 'The radar ID for the placement',
        },
        radarName: {
          type: SchemaType.STRING,
          description: 'The radar name (for display, optional)',
        },
        proposedQuadrant: {
          type: SchemaType.STRING,
          description: "Proposed quadrant: 'Languages & Frameworks', 'Platforms', 'Tools', 'Techniques'",
        },
        proposedRing: {
          type: SchemaType.STRING,
          description: "Proposed ring: 'Adopt', 'Trial', 'Assess', 'Hold'",
        },
        rationale: {
          type: SchemaType.STRING,
          description: 'Explanation for why this placement is recommended',
        },
        evidencePoints: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Key evidence points supporting this placement decision',
        },
        alternatives: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              ring: { type: SchemaType.STRING },
              reason: { type: SchemaType.STRING },
            },
          },
          description: 'Alternative placements considered and why they were not chosen',
        },
        userDecision: {
          type: SchemaType.STRING,
          description: "User's decision: 'approved', 'rejected', or 'modify'. Leave empty when proposing.",
        },
        userFeedback: {
          type: SchemaType.STRING,
          description: "User's feedback or reason for rejection/modification (if applicable)",
        },
      },
      required: ['technologyId', 'technologyName', 'proposedQuadrant', 'proposedRing', 'rationale'],
    },
  },
];

// ============================================================================
// Tool Execution Functions
// ============================================================================

/**
 * Create a decoupled technology (facts only)
 */
export async function executeCreateDecoupledTechnology(
  args: Record<string, unknown>
): Promise<{ success: boolean; data?: { id: string; name: string; slug: string }; error?: string }> {
  try {
    // Reality-check gate: prevent hallucinated technology creations.
    if (args.skipRealityCheck !== true) {
      const websiteArg = typeof args.websiteUrl === 'string' ? args.websiteUrl.trim() : '';
      const githubArg = typeof args.githubUrl === 'string' ? args.githubUrl.trim() : '';
      const urls = [websiteArg, githubArg].filter((u) => u.length > 0);
      let providedUrlsReachable = false;
      if (urls.length > 0) {
        try {
          const urlCheck = await verifyUrlsReachable(urls);
          providedUrlsReachable = urlCheck.ok;
        } catch {
          providedUrlsReachable = false;
        }
      }
      // Reality check gated by DEFENSE_MINISTER_ENABLED. When disabled, skip
      // the Gemini grounded-search call and proceed with entity creation.
      if (!providedUrlsReachable && process.env.DEFENSE_MINISTER_ENABLED === 'true') {
        const verdict = await verifyEntityReality(cleanMarkdownFromText(args.name as string));
        if (!verdict.ok) {
          log.warn('Reality check failed for decoupled technology', {
            name: args.name,
            reason: verdict.reason,
          });
          return {
            success: false,
            error: `Reality check failed for "${String(args.name)}" (${verdict.reason}). No web presence found. Provide a verifiable websiteUrl or githubUrl, or set skipRealityCheck: true to override.`,
            data: {
              id: '',
              name: String(args.name ?? ''),
              slug: '',
              realityCheckFailed: true,
              reason: verdict.reason,
            } as unknown as { id: string; name: string; slug: string },
          };
        }
      }
    }

    const name = cleanMarkdownFromText(args.name as string);
    const technology = await adminCreateTechnology({
      name,
      slug: generateSlug(name),
      description: cleanMarkdownFromText((args.description as string) || ''),
      category: args.category as TechnologyCategory | undefined,
      tags: (args.tags as string[]) || [],
      websiteUrl: args.websiteUrl as string | undefined,
      githubUrl: args.githubUrl as string | undefined,
      documentationUrl: args.documentationUrl as string | undefined,
      createdBy: 'ai-assistant',
    });

    log.info('Created technology', { technologyName: technology.name, technologyId: technology.id });

    // Emit refresh event
    emitDataRefresh('technologies', 'ai-assistant');

    return {
      success: true,
      data: {
        id: technology.id,
        name: technology.name,
        slug: technology.slug,
      },
    };
  } catch (error) {
    if (error instanceof DuplicateEntityError) {
      return {
        success: true,
        data: {
          alreadyExists: true,
          existingId: error.existingId,
          message: `Technology already exists (ID: ${error.existingId}). Use updateDecoupledTechnology to modify it.`,
        },
      } as unknown as { success: boolean; data: { id: string; name: string; slug: string }; error?: string };
    }
    log.error('Failed to create technology', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create technology',
    };
  }
}

/**
 * Update a decoupled technology
 */
export async function executeUpdateDecoupledTechnology(
  args: Record<string, unknown>
): Promise<{ success: boolean; data?: { id: string; name: string; updated: string[] }; error?: string }> {
  const technologyId = args.technologyId as string;
  const updates = args.updates as Record<string, unknown>;
  const confirmed = args.confirmed as boolean;

  if (!confirmed) {
    return {
      success: false,
      error: 'Update requires user confirmation. Please describe the changes and ask the user to confirm.',
      data: {
        id: technologyId,
        name: '',
        updated: Object.keys(updates),
      },
    };
  }

  try {
    // Clean markdown from text fields
    const cleanUpdates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (typeof value === 'string') {
        cleanUpdates[key] = cleanMarkdownFromText(value);
      } else {
        cleanUpdates[key] = value;
      }
    }

    const technology = await adminUpdateTechnology(technologyId, cleanUpdates);

    log.info('Updated technology', { technologyName: technology.name, technologyId: technology.id });

    // Emit refresh event
    emitDataRefresh('technologies', 'ai-assistant');

    return {
      success: true,
      data: {
        id: technology.id,
        name: technology.name,
        updated: Object.keys(updates),
      },
    };
  } catch (error) {
    log.error('Failed to update technology', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update technology',
    };
  }
}

/**
 * Place a technology on a radar
 */
export async function executePlaceTechnologyOnRadar(
  args: Record<string, unknown>,
  context?: { userId?: string }
): Promise<{
  success: boolean;
  data?: {
    placementId: string;
    technologyId: string;
    radarId: string;
    ring: string;
    quadrant: string;
    graphHandoff?: PlacementGraphHandoff;
  };
  error?: string;
}> {
  // GRAPH-060 #1 — the authenticated user owns the placement; fail closed if absent.
  const ownerId = context?.userId;
  if (!ownerId) {
    return { success: false, error: 'You must be signed in to place a technology on a radar.' };
  }

  try {
    const technologyId = args.technologyId as string;

    // Verify technology exists
    const technology = await adminGetTechnologyById(technologyId);
    if (!technology) {
      return {
        success: false,
        error: `Technology ${technologyId} not found`,
      };
    }

    // AI-022: the ONE shared exact resolver — stable ID first, then unique
    // normalized exact name. Ambiguity, absence, and fuzzy references fail
    // closed with candidates; nothing is written.
    const resolution = await resolveRadarReference(args.radarId as string | undefined);
    if (!resolution.ok) {
      return { success: false, error: resolution.message };
    }
    const targetRadar = resolution.radar;
    const radarId = targetRadar.id;

    // GRAPH-060 #2 — owner-only: the Assistant places only on radars the acting
    // user owns. This throws RadarAuthorizationError for missing, foreign, or
    // ownerless radars, so the caller gets a uniform permission denial.
    await adminGetOwnedRadarById(radarId, ownerId);

    if (!Array.isArray(targetRadar.quadrants) || targetRadar.quadrants.length === 0) {
      return {
        success: false,
        error: `Radar ${radarId} has no quadrants`,
      };
    }

    // Resolve `args.quadrant` (display name from the agent) against the
    // RESOLVED radar's current quadrant configuration — same name-first
    // precedence as the bulk tool, so single and bulk placement agree.
    const quadrantArg = args.quadrant as string;
    const hitQuadrant = resolveQuadrantReference(targetRadar, quadrantArg, {
      precedence: 'name-first',
    });
    if (!hitQuadrant) {
      const available = targetRadar.quadrants
        .map((q) => (typeof q === 'object' && q !== null && 'name' in q ? (q.name as string) : ''))
        .filter(Boolean)
        .join(', ');
      return {
        success: false,
        error: `Quadrant "${quadrantArg}" not found on radar "${targetRadar.name}". Available quadrants: ${available}`,
      };
    }
    const resolvedQuadrantId = hitQuadrant.id;
    const resolvedQuadrantName = hitQuadrant.name ?? resolvedQuadrantId;

    // Forward optional annotations (trlScore, timeToImpact) so the entry
    // list renders full metadata instead of "-". Undefined fields are
    // omitted via conditional spreads — Firestore rejects undefined values.
    const rawTrlScore = args.trlScore;
    const trlScore = typeof rawTrlScore === 'number' ? rawTrlScore : undefined;
    const rawTimeToImpact = args.timeToImpact;
    const timeToImpact =
      typeof rawTimeToImpact === 'string' && rawTimeToImpact.length > 0 ? (rawTimeToImpact as TimeToImpact) : undefined;

    // AI-022: repeated identical placements converge — an existing placement
    // for this technology on this radar is updated in place, never duplicated
    // and never reported as a failure.
    const existingPlacement = await adminGetPlacementForTechnologyOnRadar(technologyId, radarId);
    let placementId: string;
    let placedRing: string;
    let graphHandoff: PlacementGraphHandoff | undefined;
    if (existingPlacement) {
      const result = await adminUpdateRadarPlacementWithHandoff(
        existingPlacement.id,
        {
          quadrantId: resolvedQuadrantId,
          ring: args.ring as Ring,
          ...(typeof args.rationale === 'string' && args.rationale ? { rationale: args.rationale as string } : {}),
          ...(typeof args.status === 'string' && args.status ? { status: args.status as Status } : {}),
          ...(trlScore !== undefined ? { trlScore } : {}),
          ...(timeToImpact !== undefined ? { timeToImpact } : {}),
        },
        { requireOwnerId: ownerId }
      );
      placementId = result.placement.id;
      placedRing = result.placement.ring;
      graphHandoff = result.graphHandoff;
    } else {
      const result = await adminCreateRadarPlacementWithHandoff(
        {
          technologyId,
          radarId,
          quadrantId: resolvedQuadrantId,
          ring: args.ring as Ring,
          rationale: (args.rationale as string) || '',
          status: (args.status as Status) || 'New',
          placedBy: ownerId,
          ...(trlScore !== undefined ? { trlScore } : {}),
          ...(timeToImpact !== undefined ? { timeToImpact } : {}),
        },
        { requireOwnerId: ownerId }
      );
      placementId = result.placement.id;
      placedRing = result.placement.ring;
      graphHandoff = result.graphHandoff;
    }

    log.info('Placed technology on radar', {
      technologyName: technology.name,
      radarId,
      updatedExisting: Boolean(existingPlacement),
      trlScore,
      timeToImpact,
    });

    // Emit refresh events
    emitDataRefresh('technologies', 'ai-assistant');

    return {
      success: true,
      data: {
        placementId,
        technologyId,
        radarId,
        ring: placedRing,
        quadrant: resolvedQuadrantName,
        graphHandoff,
      },
    };
  } catch (error) {
    log.error('Failed to place technology', error instanceof Error ? error : undefined);
    if (error instanceof RadarAuthorizationError || error instanceof PlacementAuthorizationError) {
      return { success: false, error: 'You do not have permission to place a technology on this radar.' };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to place technology on radar',
    };
  }
}

/**
 * Move a technology to a different ring
 */
export async function executeMoveDecoupledTechnologyRing(
  args: Record<string, unknown>,
  context?: { userId?: string }
): Promise<{
  success: boolean;
  data?: { placementId: string; oldRing: string; newRing: string; graphHandoff?: PlacementGraphHandoff };
  error?: string;
}> {
  // GRAPH-060 #1 — the authenticated user owns the placement; fail closed if absent.
  const ownerId = context?.userId;
  if (!ownerId) {
    return { success: false, error: 'You must be signed in to move a technology ring.' };
  }

  const technologyId = args.technologyId as string;
  const radarId = args.radarId as string;
  const newRing = args.newRing as Ring;
  const rationale = args.rationale as string | undefined;
  const confirmed = args.confirmed as boolean;

  if (!confirmed) {
    return {
      success: false,
      error: `Ring change requires confirmation. Moving technology to ${newRing}. Please confirm.`,
    };
  }

  try {
    // GRAPH-060 #2 — owner-only: the Assistant mutates only radars the acting
    // user owns. A missing/foreign/ownerless radar throws RadarAuthorizationError
    // and surfaces as a uniform permission denial.
    await adminGetOwnedRadarById(radarId, ownerId);

    // Find the placement for this technology on this radar
    const placement = await adminGetPlacementForTechnologyOnRadar(technologyId, radarId);
    if (!placement) {
      return {
        success: false,
        error: `Technology ${technologyId} is not placed on radar ${radarId}`,
      };
    }

    const oldRing = placement.ring;
    // GRAPH-060 #3 — replicate the ring move through the acknowledged handoff
    // primitive so the graph layer is notified of the mutation.
    const result = await adminUpdateRadarPlacementWithHandoff(
      placement.id,
      {
        ring: newRing,
        rationale,
      },
      { requireOwnerId: ownerId }
    );

    log.info('Moved technology ring', { oldRing, newRing });

    // Emit refresh events
    emitDataRefresh('technologies', 'ai-assistant');

    return {
      success: true,
      data: {
        placementId: result.placement.id,
        oldRing,
        newRing,
        graphHandoff: result.graphHandoff,
      },
    };
  } catch (error) {
    log.error('Failed to move technology ring', error instanceof Error ? error : undefined);
    if (error instanceof RadarAuthorizationError || error instanceof PlacementAuthorizationError) {
      return { success: false, error: 'You do not have permission to move this technology ring.' };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to move technology ring',
    };
  }
}

/**
 * Search for decoupled technologies
 */
export async function executeSearchDecoupledTechnologies(args: Record<string, unknown>): Promise<{
  success: boolean;
  data?: {
    count: number;
    results: Array<{
      id: string;
      name: string;
      /** Navigable entity type — makes the chat entity chips deep-linkable. */
      type: 'technology';
      description: string;
      category?: string;
      tags: string[];
      placementsCount: number;
    }>;
  };
  error?: string;
}> {
  try {
    const query = (args.query as string).toLowerCase();
    const category = args.category as TechnologyCategory | undefined;
    const tags = args.tags as string[] | undefined;
    const limit = Math.min((args.limit as number) || 10, 50);

    const technologies = await adminGetTechnologies({
      search: query,
      category,
      tags,
      limit,
    });

    // Get placement counts for each technology
    const resultsWithPlacements = await Promise.all(
      technologies.map(async (tech) => {
        // No admin getPlacementsForTechnology twin; it is exactly
        // getRadarPlacements({ technologyId }) — use adminGetRadarPlacements.
        const placements = await adminGetRadarPlacements({ technologyId: tech.id });
        return {
          id: tech.id,
          name: tech.name,
          type: 'technology' as const,
          description: tech.description,
          category: tech.category,
          tags: tech.tags,
          placementsCount: placements.length,
        };
      })
    );

    return {
      success: true,
      data: {
        count: resultsWithPlacements.length,
        results: resultsWithPlacements,
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
 * Get detailed technology information with placements
 */
export async function executeGetDecoupledTechnologyDetails(
  args: Record<string, unknown>
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  try {
    const technologyId = args.technologyId as string;

    const technology = await adminGetTechnologyById(technologyId);
    if (!technology) {
      return {
        success: false,
        error: `Technology ${technologyId} not found`,
      };
    }

    const placements = await adminGetRadarPlacements({ technologyId });

    return {
      success: true,
      data: {
        technology: {
          id: technology.id,
          name: technology.name,
          slug: technology.slug,
          description: technology.description,
          category: technology.category,
          tags: technology.tags,
          websiteUrl: technology.websiteUrl,
          githubUrl: technology.githubUrl,
          documentationUrl: technology.documentationUrl,
          linkedCompanies: technology.linkedCompanies,
          linkedUseCases: technology.linkedUseCases,
          createdAt: technology.createdAt,
          updatedAt: technology.updatedAt,
        },
        placements: placements.map((p) => ({
          id: p.id,
          radarId: p.radarId,
          quadrantId: p.quadrantId,
          quadrant: p.quadrantName ?? p.quadrantId,
          ring: p.ring,
          status: p.status,
          rationale: p.rationale,
          movedFrom: p.movedFrom,
          movedAt: p.movedAt,
        })),
        placementsCount: placements.length,
      },
    };
  } catch (error) {
    log.error('Failed to get technology details', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get technology details',
    };
  }
}

/**
 * Delete a technology through the complete server-side cascade.
 */
export async function executeDeleteDecoupledTechnology(
  args: Record<string, unknown>,
  context?: DeleteGateContext
): Promise<{
  success: boolean;
  data?:
    | {
        message: string;
        placementsDeleted?: number;
        relationsDeleted?: number;
        neo4jDeleted?: boolean;
        mutatedEntityTypes: typeof DELETION_MUTATED_ENTITY_TYPES.technology;
      }
    | DestructiveGateRefusal;
  error?: string;
}> {
  const technologyId = normalizeDestructiveIdentifier(args.technologyId);
  if (!technologyId) {
    return { success: false, error: 'A non-empty technology ID is required for deletion.' };
  }

  const gate = confirmDestructiveAction({
    fingerprint: destructiveActionFingerprint('deleteDecoupledTechnology', technologyId),
    summary: `delete technology ${technologyId} and its linked data`,
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
    const deletion = await adminDeleteTechnologyCompletely(technologyId);
    const cleanup = {
      placementsDeleted: deletion.placementsDeleted,
      relationsDeleted: deletion.relationsDeleted,
      neo4jDeleted: deletion.neo4jDeleted,
    };

    if (!deletion.success) {
      return {
        success: false,
        error: deletion.error ?? `Failed to completely delete technology ${technologyId}`,
        data: {
          message: `Technology ${technologyId} was not completely deleted`,
          ...cleanup,
          mutatedEntityTypes: DELETION_MUTATED_ENTITY_TYPES.technology,
        },
      };
    }

    log.info('Deleted technology', { technologyId, ...cleanup });

    // Emit refresh events
    emitDataRefresh('technologies', 'ai-assistant');

    return {
      success: true,
      data: {
        message: `Technology deleted along with ${cleanup.placementsDeleted} radar placement(s)`,
        ...cleanup,
        mutatedEntityTypes: DELETION_MUTATED_ENTITY_TYPES.technology,
      },
    };
  } catch (error) {
    log.error('Failed to delete technology', error instanceof Error ? error : undefined);
    const errorMessage = error instanceof Error ? error.message : 'Failed to delete technology';
    return {
      success: false,
      error: errorMessage,
      data: {
        message: errorMessage,
        mutatedEntityTypes: DELETION_MUTATED_ENTITY_TYPES.technology,
      },
    };
  }
}

/**
 * Remove a technology from a specific radar
 */
export async function executeRemoveTechnologyFromRadar(
  args: Record<string, unknown>,
  context?: DeleteGateContext
): Promise<{
  success: boolean;
  data?:
    | {
        message: string;
        mutatedEntityTypes?: typeof DELETION_MUTATED_ENTITY_TYPES.radarPlacement;
        graphHandoff?: PlacementGraphHandoff;
      }
    | DestructiveGateRefusal;
  error?: string;
}> {
  // GRAPH-060 #1 — the authenticated user owns the placement; fail closed if
  // absent. A destructive-confirmation gate proves the caller MEANT the removal;
  // it says nothing about whether they may perform it, so the owner check has to
  // reach the mutation itself like every sibling placement writer.
  const ownerId = context?.userId;
  if (!ownerId) {
    return { success: false, error: 'You must be signed in to remove a technology from a radar.' };
  }

  const technologyId = normalizeDestructiveIdentifier(args.technologyId);
  const radarId = normalizeDestructiveIdentifier(args.radarId);
  if (!technologyId || !radarId) {
    return {
      success: false,
      error: 'Non-empty technology and radar IDs are required to remove a placement.',
    };
  }

  const gate = confirmDestructiveAction({
    fingerprint: destructiveActionFingerprint('removeTechnologyFromRadar', technologyId, radarId),
    summary: `remove technology ${technologyId} from radar ${radarId}`,
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
    const placement = await adminGetPlacementForTechnologyOnRadar(technologyId, radarId);
    if (!placement) {
      return {
        success: false,
        error: `Technology ${technologyId} is not placed on radar ${radarId}`,
      };
    }

    // GRAPH-060 — remove through the acknowledged handoff so the caller learns
    // whether the graph projection was accepted, not just that Firestore
    // committed. An unacknowledged dispatch is reconciliation-pending, never a
    // rollback and never a silent success.
    const { graphHandoff } = await adminDeleteRadarPlacementWithHandoff(placement.id, {
      requireOwnerId: ownerId,
    });

    log.info('Removed technology from radar', { technologyId, radarId });

    // Emit refresh events
    emitDataRefresh('technologies', 'ai-assistant');

    return {
      success: true,
      data: {
        message: `Technology removed from radar ${radarId}`,
        mutatedEntityTypes: DELETION_MUTATED_ENTITY_TYPES.radarPlacement,
        graphHandoff,
      },
    };
  } catch (error) {
    log.error('Failed to remove technology from radar', error instanceof Error ? error : undefined);
    const errorMessage = error instanceof Error ? error.message : 'Failed to remove technology from radar';
    return {
      success: false,
      error: errorMessage,
      data: {
        message: errorMessage,
        mutatedEntityTypes: DELETION_MUTATED_ENTITY_TYPES.radarPlacement,
      },
    };
  }
}

// ============================================================================
// Research Technology Comprehensive Tool
// ============================================================================

/**
 * Result type for researchTechnologyComprehensive tool
 */
export interface ResearchTechnologyResult {
  success: boolean;
  status: 'pending' | 'completed' | 'failed';
  technologyId: string;
  technologyName?: string;
  message: string;
  error?: string;
}

/**
 * Execute comprehensive AI research for a technology
 *
 * This triggers a background Inngest job that performs detailed research
 * across 12 sections and saves results to the technology's comprehensiveResearch field.
 *
 * NOTE: This function calls Inngest directly instead of going through the HTTP API
 * to avoid URL configuration issues (NEXT_PUBLIC_APP_URL not being available in all contexts).
 */
export async function executeResearchTechnologyComprehensive(
  args: Record<string, unknown>
): Promise<ResearchTechnologyResult> {
  const technologyId = args.technologyId as string;

  if (!technologyId) {
    return {
      success: false,
      status: 'failed',
      technologyId: '',
      message: 'Technology ID is required',
      error: 'Missing technologyId parameter',
    };
  }

  try {
    // Get the technology to verify it exists and get its details
    const technology = await adminGetTechnologyById(technologyId);

    if (!technology) {
      return {
        success: false,
        status: 'failed',
        technologyId,
        message: `Technology with ID ${technologyId} not found`,
        error: 'Technology not found',
      };
    }

    // The stable ID is authoritative. A model-supplied display name can be
    // stale or refer to another entity, so it must never steer paid research.
    const name = technology.name;

    // TEST-022: the same shared dispatch contract the HTTP route uses, so the
    // two trigger paths cannot drift apart.
    const startedAt = Date.now();
    const claim = await claimResearchDispatch(technologyId, startedAt);
    if (!claim.claimed) {
      if (claim.reason === 'not-found') {
        return {
          success: false,
          status: 'failed',
          technologyId,
          technologyName: name,
          message: `Technology with ID ${technologyId} not found`,
          error: 'Technology not found',
        };
      }
      return {
        success: false,
        status: 'pending',
        technologyId,
        technologyName: name,
        message: `Research is already in progress for "${name}". Please wait for it to complete.`,
        error: 'Research already in progress',
      };
    }

    // Send Inngest event directly (no HTTP call needed)
    try {
      await inngest.send({
        name: 'app/technology.comprehensive-research.requested',
        data: {
          technologyId,
          technologyName: name,
          technologyDescription: technology.description,
          category: technology.category,
          websiteUrl: technology.websiteUrl,
          triggeredAt: startedAt,
        },
      });
    } catch (dispatchError) {
      // TEST-022: without this the tool told the model "failed" while Firestore
      // still said "pending" — the Assistant reported one truth and the UI
      // showed another for the whole stale window.
      await releaseResearchPending(technologyId, 'dispatch-failed', startedAt);
      throw dispatchError;
    }

    log.info('Started comprehensive research', { name, technologyId });

    return {
      success: true,
      status: 'pending',
      technologyId,
      technologyName: name,
      message: `Started comprehensive research for "${name}". The research will run in the background and results will be available in the Technology Research tab. This typically takes 1-2 minutes.`,
    };
  } catch (error) {
    log.error('Failed to start technology research', error instanceof Error ? error : undefined);
    return {
      success: false,
      status: 'failed',
      technologyId,
      message: 'Failed to start technology research',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ============================================================================
// Confirm Placement Tool (Task 0.4.1 - Human-in-the-Loop)
// ============================================================================

/**
 * Result type for confirmPlacement tool
 */
export interface ConfirmPlacementResult {
  success: boolean;
  /** Current status of the confirmation request */
  status: 'pending' | 'approved' | 'rejected' | 'modified';
  /** The proposal being presented for confirmation */
  proposal: {
    technologyId: string;
    technologyName: string;
    radarId?: string;
    radarName?: string;
    quadrant: string;
    ring: string;
    rationale: string;
    evidencePoints?: string[];
    alternatives?: Array<{ ring: string; reason: string }>;
  };
  /** User's decision if provided */
  userDecision?: 'approved' | 'rejected' | 'modify';
  /** User's feedback or modification request */
  userFeedback?: string;
  /** Message to display to the user */
  message: string;
}

/**
 * Execute the confirmPlacement tool for human-in-the-loop confirmation
 *
 * This tool presents a proposed placement to the user for review.
 * The AI should:
 * 1. Call this tool with a proposal (no userDecision)
 * 2. Present the proposal to the user and ask for confirmation
 * 3. Call this tool again with the userDecision after the user responds
 *
 * @param args - Tool arguments containing the proposal and optional user decision
 * @returns ConfirmPlacementResult with the status and proposal details
 */
export async function executeConfirmPlacement(args: Record<string, unknown>): Promise<ConfirmPlacementResult> {
  const technologyId = args.technologyId as string;
  const technologyName = args.technologyName as string;
  const radarId = args.radarId as string | undefined;
  const radarName = args.radarName as string | undefined;
  const proposedQuadrant = args.proposedQuadrant as string;
  const proposedRing = args.proposedRing as string;
  const rationale = args.rationale as string;
  const evidencePoints = args.evidencePoints as string[] | undefined;
  const alternatives = args.alternatives as Array<{ ring: string; reason: string }> | undefined;
  const userDecision = args.userDecision as string | undefined;
  const userFeedback = args.userFeedback as string | undefined;

  // Build the proposal object
  const proposal = {
    technologyId,
    technologyName,
    radarId,
    radarName,
    quadrant: proposedQuadrant,
    ring: proposedRing,
    rationale,
    evidencePoints,
    alternatives,
  };

  // If no user decision provided, this is a proposal request
  if (!userDecision) {
    log.info('Proposing placement', { technologyName, proposedRing });

    // Build a detailed message for the user
    let message = `**Proposed Placement:**\n`;
    message += `- **Technology:** ${technologyName}\n`;
    message += `- **Quadrant:** ${proposedQuadrant}\n`;
    message += `- **Ring:** ${proposedRing}\n`;
    if (radarName) {
      message += `- **Radar:** ${radarName}\n`;
    }
    message += `\n**Rationale:** ${rationale}\n`;

    if (evidencePoints && evidencePoints.length > 0) {
      message += `\n**Evidence:**\n`;
      evidencePoints.forEach((point, i) => {
        message += `${i + 1}. ${point}\n`;
      });
    }

    if (alternatives && alternatives.length > 0) {
      message += `\n**Alternatives Considered:**\n`;
      alternatives.forEach((alt) => {
        message += `- ${alt.ring}: ${alt.reason}\n`;
      });
    }

    message += `\n---\n`;
    message += `Please respond with one of:\n`;
    message += `- **Approve**: Accept this placement\n`;
    message += `- **Reject**: Cancel with a reason\n`;
    message += `- **Modify**: Suggest changes (e.g., different ring)`;

    return {
      success: true,
      status: 'pending',
      proposal,
      message,
    };
  }

  // User has provided a decision
  const normalizedDecision = userDecision.toLowerCase().trim();

  if (normalizedDecision === 'approved' || normalizedDecision === 'approve' || normalizedDecision === 'yes') {
    log.info('User approved placement', { technologyName, proposedRing });
    return {
      success: true,
      status: 'approved',
      proposal,
      userDecision: 'approved',
      userFeedback,
      message: `✅ Placement approved! You can now proceed to place **${technologyName}** in the **${proposedRing}** ring using the placeTechnologyOnRadar tool.`,
    };
  }

  if (normalizedDecision === 'rejected' || normalizedDecision === 'reject' || normalizedDecision === 'no') {
    log.info('User rejected placement', { technologyName, proposedRing });
    return {
      success: true,
      status: 'rejected',
      proposal,
      userDecision: 'rejected',
      userFeedback,
      message: `❌ Placement rejected.${userFeedback ? ` Reason: ${userFeedback}` : ''} The placement will not be made.`,
    };
  }

  if (normalizedDecision === 'modify' || normalizedDecision === 'modified' || normalizedDecision === 'change') {
    log.info('User requested modification', { technologyName });
    return {
      success: true,
      status: 'modified',
      proposal,
      userDecision: 'modify',
      userFeedback,
      message: `🔄 Modification requested.${userFeedback ? ` Feedback: ${userFeedback}` : ''} Please propose an updated placement based on the user's feedback.`,
    };
  }

  // Unknown decision
  return {
    success: false,
    status: 'pending',
    proposal,
    message: `Unknown decision "${userDecision}". Please respond with "approve", "reject", or "modify".`,
  };
}
