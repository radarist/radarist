/**
 * @file ai/tools/entity-creation.ts
 * @description Entity creation tools for AI Assistant
 *
 * Provides capabilities for:
 * - Creating companies
 * - Creating technologies
 * - Creating use cases
 * - Creating prototypes
 * - Creating strategies
 * - Creating signals
 *
 * @author Radarist Team
 * @created 2025-12-02
 */

import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';
import { adminCreateCompany, adminDeleteCompany, adminGetCompanies, adminUpdateCompany } from '@/lib/companies-admin';
import { persistSourcedCompanyResearch } from '@/lib/company-research-persistence';
import type { PersistableCompanyFacts } from '@/lib/ai/company-research-contract';
import { canonicalHttpUrl } from '@/lib/signals/source-identity';
import { resolveQuadrantReference } from '@/lib/types';
import type { ComprehensiveCompanyResearchResult } from './web-research';
import { adminCreateUseCase, adminDeleteUseCase, adminGetUseCases } from '@/lib/use-cases-admin';
import { adminCreatePrototype, adminDeletePrototype, adminGetPrototypes } from '@/lib/prototypes-admin';
import { adminCreateStrategy, adminDeleteStrategy, adminGetStrategies } from '@/lib/strategies-admin';
import { adminCreateSignal, adminDeleteSignals, adminGetSignals } from '@/lib/signals-admin';
import {
  adminGetOwnedRadarById,
  adminGetRadarById,
  adminListRadars,
  RadarAuthorizationError,
} from '@/lib/radars-admin';
import {
  adminCreateTechnology as createDecoupledTech,
  adminDeleteTechnologyCompletely,
  adminGetTechnologies as getDecoupledTechnologies,
} from '@/lib/technology-admin';
import { adminDeleteOrgUnit, adminGetOrgUnits } from '@/lib/org-units-admin';
import { adminDeleteInitiative, adminGetInitiatives } from '@/lib/initiatives-admin';
import { adminDeletePainPoint, adminGetPainPoints } from '@/lib/pain-points-admin';
import { normalizeTechnologyCategory } from '@/lib/schemas/technology-schema';
import {
  adminCreateRadarPlacementWithHandoff,
  PlacementAuthorizationError,
  type PlacementGraphHandoff,
} from '@/lib/radar-placement-admin';
import { emitDataRefresh } from '@/lib/events/data-refresh';
import { researchCompanyComprehensive } from '@/ai/flows/research-company-comprehensive';
import {
  confirmDestructiveAction,
  destructiveActionFingerprint,
  normalizeDestructiveIdentifier,
  type DestructiveGateRefusal,
} from '@/lib/ai/destructive-confirmation';

import type {
  CompanyType,
  CompanySize,
  CompanyStage,
  CompanyStatus,
  CompanyIndustry,
  PrototypeStatus,
  Status,
  SignalType,
  TimeToImpact,
} from '@/lib/types';
import { cleanMarkdownFromText } from '@/lib/ai/signal-evaluation';
import { DuplicateEntityError } from '@/lib/entity-factory-shared';
import { createLogger } from '@/lib/logger';
import {
  LINKED_ENTITY_NAME_CAP,
  resolveLinkedEntityNames,
  type ResolvedLinkedEntity,
} from '@/lib/ai/tools/helpers/resolve-linked-entities';
import {
  createMutationLatch,
  noMutationProof,
  thrownFailureProof,
  type PreWriteRefusalStage,
  type ToolNoMutationProof,
} from '@/lib/ai/tool-side-effects';
import { verifyEntityReality } from '@/lib/entity-reality-check';
import { verifyUrlsReachable } from '@/lib/scout-url-verifier';
import {
  getEntityDeletionBlockedDetails,
  type EntityDeletionBlockedDetails,
} from '@/lib/entity-deletion-reference-policy';
import {
  DELETION_MUTATED_ENTITY_TYPES,
  type DeletionMutationSource,
  type EntityType as MutationEntityType,
} from '@/lib/ai/mutation-tracking';

const log = createLogger('ai/entity-creation');

const DELETABLE_ENTITY_TYPES = new Set([
  'company',
  'technology',
  'useCase',
  'prototype',
  'strategy',
  'signal',
  'orgUnit',
  'initiative',
  'painPoint',
]);

/**
 * Minimal slice of the tool execution context the destructive `deleteEntity`
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
// Tool Definitions for Entity Creation
// ============================================================================

export const ENTITY_CREATION_TOOLS: FunctionDeclaration[] = [
  {
    name: 'createCompany',
    description: `Create a new company in the platform. Use this when user wants to add a vendor, partner, competitor, startup, or any organization.

WHEN TO USE THIS TOOL:
- "Add [company name] to our vendor list"
- "Create a company profile for [name]"
- "Track [startup name] as a potential partner"
- "Register [company] as a competitor"

COMPANY TYPES (use multiple if applicable):
- startup: Early-stage company, typically <5 years old
- scaleup: Growing company, proven product-market fit
- sme: Small/medium enterprise
- corporate: Large established company
- research: Research institution, university lab
- consultancy: Consulting firm, professional services

INDUSTRIES: healthcare, food_agriculture, technology, manufacturing, energy, consumer, financial, logistics, media, professional, other

COMPANY SIZES: micro (<10 employees), small (10-50), medium (50-250), large (250-1000), enterprise (1000+)

TIP: To research an existing company, use 'researchCompany'. It saves an unverified draft for review and does not auto-fill canonical profile fields.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        name: {
          type: SchemaType.STRING,
          description: 'Company name',
        },
        description: {
          type: SchemaType.STRING,
          description: 'Company description (what they do, value proposition)',
        },
        type: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description:
            'Company types. Values: startup, scaleup, sme, corporate, spinoff, joint_venture, research, accelerator, venture_studio, consultancy',
        },
        website: {
          type: SchemaType.STRING,
          description: 'Company website URL',
        },
        industry: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description:
            'Industries. Values: healthcare, food_agriculture, technology, manufacturing, energy, consumer, financial, logistics, media, professional, other',
        },
        size: {
          type: SchemaType.STRING,
          description: 'Company size. Values: micro, small, medium, large, enterprise',
        },
        headquarters: {
          type: SchemaType.STRING,
          description: 'Company headquarters location',
        },
        foundedYear: {
          type: SchemaType.NUMBER,
          description: 'Year the company was founded',
        },
        skipResearch: {
          type: SchemaType.BOOLEAN,
          description:
            'If true, skip automatic background research after creation. Default: false (research runs automatically).',
        },
        skipRealityCheck: {
          type: SchemaType.BOOLEAN,
          description:
            'If true, skip the web-presence reality check. Default: false. Only set to true when the user has confirmed the entity is legitimate (e.g. a known internal name or a stealth-mode startup without web presence yet).',
        },
      },
      required: ['name', 'description'],
    },
  },
  {
    name: 'createTechnology',
    description: `Add a new technology to the technology library. Use this when tracking frameworks, tools, platforms, languages, or any tech.

WHEN TO USE THIS TOOL:
- "Add React to our tech library"
- "Create an entry for Kubernetes"
- "Track TensorFlow as a technology"
- "Add this new AI framework we discovered"

TECHNOLOGY CATEGORIES:
- framework: React, Angular, Spring Boot, Django
- language: Python, TypeScript, Rust, Go
- platform: AWS, Azure, Kubernetes, Salesforce
- tool: Docker, Jenkins, Git, VS Code
- library: NumPy, Lodash, TensorFlow
- service: Auth0, Stripe, Twilio
- methodology: Agile, DevOps, MLOps
- infrastructure: PostgreSQL, Redis, Kafka

RADAR PLACEMENT (optional):
- Quadrants: 'Languages & Frameworks', 'Platforms', 'Tools', 'Techniques'
- Rings: 'Adopt' (use it), 'Trial' (test it), 'Assess' (research it), 'Hold' (avoid it)
- If you don't provide quadrant/ring, the tech goes to library only (not on radar)
- When you DO provide quadrant/ring (i.e. you're placing it on a radar), also
  populate trlScore and timeToImpact so the radar entry is fully annotated.
  Leaving them blank shows "-" in the entry list, which looks unfinished.
- Use 'placeTechnologyOnRadar' tool later to add an existing tech to a radar

STATUS OPTIONS: 'Trending', 'Stable', 'Fading', 'New', 'Warning'

EXAMPLE (library only):
createTechnology(name: "LangChain", description: "Framework for building LLM applications", category: "framework", tags: ["AI", "LLM", "Python"])

EXAMPLE (placed on a radar with full annotations):
createTechnology(
  name: "LangChain",
  description: "Framework for building LLM applications",
  category: "framework",
  tags: ["AI", "LLM", "Python"],
  quadrant: "Tools",
  ring: "Trial",
  trlScore: 6,
  timeToImpact: "H2",
  status: "Trending",
  analysis: "Strong community, rapidly evolving API — trial before broad adoption"
)`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        name: {
          type: SchemaType.STRING,
          description: 'Technology name',
        },
        description: {
          type: SchemaType.STRING,
          description: 'Technology description - what it is, what problems it solves',
        },
        quadrant: {
          type: SchemaType.STRING,
          description:
            'Radar quadrant (optional). Accepts either a stable quadrant id or a display name resolved against the target radar. Call getRadarDetails first to see the available quadrants — the radar may have 1–8 quadrants that vary per radar. Only provide if you want to place the technology on a radar.',
        },
        ring: {
          type: SchemaType.STRING,
          description:
            "Maturity ring (required when placing on a radar): 'Adopt', 'Trial', 'Assess', 'Hold'. This is the HATA ring displayed on entry list badges.",
        },
        trlScore: {
          type: SchemaType.NUMBER,
          description:
            'Technology Readiness Level (optional, 1–9). Populates the TRL column on the entry list. 1 = basic research, 9 = proven in operation. Provide a realistic estimate when placing a technology on a radar; omitting it renders "-".',
        },
        timeToImpact: {
          type: SchemaType.STRING,
          description:
            "Business-impact horizon (optional): 'H1' (0–6 months, near-term), 'H2' (6–18 months, medium-term), 'H3' (18+ months, long-term), or 'unknown'. Populates the Time-to-Impact column. Provide when placing on a radar so the entry list isn't empty; omitting it renders \"-\".",
        },
        radarId: {
          type: SchemaType.STRING,
          description: 'ID of the radar to add to (optional, uses default radar if quadrant/ring are specified)',
        },
        tags: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: "Tags for categorization (e.g., ['AI', 'Frontend', 'Open Source'])",
        },
        category: {
          type: SchemaType.STRING,
          description:
            "Technology category: 'framework', 'language', 'platform', 'tool', 'library', 'service', 'methodology', 'infrastructure'",
        },
        websiteUrl: {
          type: SchemaType.STRING,
          description: 'Technology website URL',
        },
        githubUrl: {
          type: SchemaType.STRING,
          description: 'GitHub repository URL',
        },
        status: {
          type: SchemaType.STRING,
          description: "Technology status: 'Trending', 'Stable', 'Fading', 'New', 'Warning'",
        },
        analysis: {
          type: SchemaType.STRING,
          description: 'Detailed analysis, pros/cons, or reasoning for the technology placement',
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
    name: 'createUseCase',
    description: `Create a new use case documenting a business problem and potential technology solution.

WHEN TO USE THIS TOOL:
- "Create a use case for customer onboarding automation"
- "Document the predictive maintenance scenario"
- "Add a use case for real-time inventory tracking"
- "We need a use case for AI-powered customer support"

USE CASE CATEGORIES:
- Automation: Process automation, workflow optimization
- Analytics: Data analysis, reporting, business intelligence
- Customer Experience: CX improvements, personalization
- Operations: Supply chain, logistics, manufacturing
- Security: Cybersecurity, compliance, risk management
- Innovation: New products, digital transformation

STATUS VALUES:
- 'Proposed': Initial idea, needs evaluation
- 'In Progress': Currently being implemented
- 'Implemented': Successfully deployed
- 'Archived': No longer active

STRUCTURE (recommended):
- title: Clear, descriptive name
- problem: What business problem does this solve?
- solution: How will technology address this?
- description: Detailed context and requirements

EXAMPLE:
createUseCase(title: "AI-Powered Invoice Processing", problem: "Manual invoice processing takes 5 days", solution: "Use OCR and ML to automate extraction and validation", category: "Automation")`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        title: {
          type: SchemaType.STRING,
          description: 'Use case title',
        },
        description: {
          type: SchemaType.STRING,
          description: 'Detailed description of the use case',
        },
        category: {
          type: SchemaType.STRING,
          description: "Use case category (e.g., 'Automation', 'Analytics', 'Customer Experience')",
        },
        problem: {
          type: SchemaType.STRING,
          description: 'The problem this use case aims to solve',
        },
        solution: {
          type: SchemaType.STRING,
          description: 'The proposed solution or approach',
        },
        tags: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Tags for categorization',
        },
        status: {
          type: SchemaType.STRING,
          description: "Status: 'Proposed', 'In Progress', 'Implemented', 'Archived'",
        },
      },
      required: ['title', 'description'],
    },
  },
  {
    name: 'createPrototype',
    description: `Create a new prototype, POC (proof of concept), pilot project, or innovation experiment.

WHEN TO USE THIS TOOL:
- "Create a prototype for the chatbot project"
- "Start a POC for blockchain supply chain"
- "Add our new AI pilot project"
- "Document the innovation experiment we're running"

PROTOTYPE STATUS:
- 'Ideation': Early concept phase, exploring ideas
- 'In Development': Actively being built
- 'Demo Ready': Can be demonstrated to stakeholders
- 'Delivered': Completed and handed off
- 'Archived': Discontinued or superseded

BUSINESS UNIT:
- targetBusinessUnit should be the name of an existing Business Unit org unit (see the Org Units library)
- If the prototype spans the whole organization or no matching org unit exists, use the organization's own wording for the sponsoring unit
- If unspecified, it defaults to 'Unassigned'

TIP: After creating, use 'createRelation' to link the prototype to:
- Technologies it uses
- Companies involved (vendors, partners)
- Use cases it addresses
- Strategies it supports

EXAMPLE:
createPrototype(name: "GenAI Customer Service Bot", description: "Pilot testing LLM-powered support automation", targetBusinessUnit: "Customer Service", status: "In Development", team: ["John Smith", "Jane Doe"])`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        name: {
          type: SchemaType.STRING,
          description: 'Prototype name',
        },
        description: {
          type: SchemaType.STRING,
          description: 'Prototype description and objectives',
        },
        targetBusinessUnit: {
          type: SchemaType.STRING,
          description: 'Name of an existing Business Unit org unit that sponsors this prototype',
        },
        team: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Team member names',
        },
        status: {
          type: SchemaType.STRING,
          description: "Status: 'Ideation', 'In Development', 'Demo Ready', 'Delivered', 'Archived'",
        },
      },
      required: ['name', 'description'],
    },
  },
  {
    name: 'createStrategy',
    description: `Create a new strategy document with strategic directives and priorities.

WHEN TO USE THIS TOOL:
- "Create our digital transformation strategy"
- "Add the AI adoption roadmap"
- "Document our cloud migration strategy"
- "Define the data platform strategy"

STRATEGY EXAMPLES:
- Digital Transformation Strategy
- AI/ML Adoption Roadmap
- Cloud Migration Strategy
- Data & Analytics Strategy
- Cybersecurity Strategy
- Platform Modernization Strategy
- Customer Experience Strategy

DIRECTIVES STRUCTURE:
Each directive should have:
- directive: Clear statement of what to do
- priority: 'High', 'Medium', or 'Low'

EXAMPLE DIRECTIVES:
- { directive: "Migrate 80% of workloads to cloud by Q4", priority: "High" }
- { directive: "Implement AI-powered customer analytics", priority: "Medium" }
- { directive: "Establish data governance framework", priority: "High" }

TIP: After creating, use 'createRelation' to link the strategy to:
- Technologies that enable it
- Use cases it drives
- Companies that can help implement it

EXAMPLE:
createStrategy(name: "Enterprise AI Strategy 2026", description: "Roadmap for adopting AI across the organization", directives: [{directive: "Deploy LLM for internal knowledge base", priority: "High"}, {directive: "Train ML models for demand forecasting", priority: "Medium"}])`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        name: {
          type: SchemaType.STRING,
          description: 'Strategy name',
        },
        description: {
          type: SchemaType.STRING,
          description: 'Strategy description and goals',
        },
        directives: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              directive: { type: SchemaType.STRING },
              priority: { type: SchemaType.STRING },
            },
          },
          description: 'Strategic directives with priorities (High, Medium, Low)',
        },
      },
      required: ['name', 'description'],
    },
  },
  {
    name: 'createSignalManual',
    description: `Create a new signal manually in the Signal Feed.

YOU HAVE THIS CAPABILITY. Use it whenever the user asks you to create, add, capture,
track, log, record, save, or register a signal — including requests to "create these
as signals" referencing items you showed in a prior turn.

FIELD GUIDANCE:
- type: one of patent, paper, news, funding, github, trend (pick the closest fit)
- title: the headline of the signal
- description: 2-4 sentences of detail
- summary: optional 1-2 sentence synthesis (separate from description; becomes the aiSummary)
- source: publication or platform (e.g. "TechCrunch", "arXiv", "GitHub")
- url: original URL when available
- sentiment: positive / neutral / negative based on the signal's implications
- relevanceScore (0-100): score honestly using these anchors —
    90-100: breakthrough, high-impact intelligence
    70-89:  significant development worth tracking (triggers background enrichment)
    50-69:  notable but not urgent
    below 50: minor or tangential
  Default of 50 means the signal will be SKIPPED by enrichment — do not default when
  the signal is clearly significant.
- linkedEntityNames: names of companies or technologies ALREADY IN THE LIBRARY that this
  signal mentions (the server resolves each name to an ID). ALL-OR-NOTHING, max 10: if any
  name matches no existing company or technology, NO signal is created and the error names
  the ones that failed. Never guess — pass names exactly as they appear in the conversation,
  omit the field entirely when unsure, or create the missing entity first and retry.
- publishedAt (epoch ms): original publication date when known.

When the user asks for multiple signals in one turn, make multiple parallel tool calls.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        type: {
          type: SchemaType.STRING,
          description: "Signal type: 'patent', 'paper', 'news', 'funding', 'github', 'trend'",
        },
        title: {
          type: SchemaType.STRING,
          description: 'Signal title/headline',
        },
        description: {
          type: SchemaType.STRING,
          description: 'Signal description (2-4 sentences)',
        },
        summary: {
          type: SchemaType.STRING,
          description: 'Optional 1-2 sentence synthesis, used as the aiSummary',
        },
        source: {
          type: SchemaType.STRING,
          description: 'Source publication or platform',
        },
        url: {
          type: SchemaType.STRING,
          description: 'URL to the original source',
        },
        sentiment: {
          type: SchemaType.STRING,
          description: "Sentiment: 'positive', 'neutral', or 'negative'",
        },
        relevanceScore: {
          type: SchemaType.NUMBER,
          description: 'Relevance score (0-100). 90+ breakthrough, 70-89 significant, 50-69 notable, <50 minor.',
        },
        linkedEntityNames: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description:
            'Names of EXISTING companies or technologies this signal mentions (max 10). The server resolves each to an ID and refuses the whole call — creating nothing — if any name matches no library record. Omit when unsure.',
        },
        publishedAt: {
          type: SchemaType.NUMBER,
          description: 'Original publication date as epoch milliseconds',
        },
      },
      required: ['type', 'title', 'description'],
    },
  },
  {
    name: 'deleteEntity',
    description: `Delete an entity from the platform. DESTRUCTIVE ACTION - requires user confirmation.

WHEN TO USE THIS TOOL:
- "Delete the [company name] company"
- "Remove [technology] from the system"
- "Delete the [prototype name] prototype"
- "Remove [use case] use case"

SUPPORTED ENTITY TYPES:
- company: Vendors, partners, competitors
- technology: Tech in the library
- useCase: Business use cases
- prototype: POCs, pilots, experiments
- strategy: Strategy documents
- signal: Detected signals
- orgUnit: Departments, teams
- initiative: Projects, programs
- painPoint: Problems, challenges

IDENTIFICATION:
- By ID: Provide 'id' if you know it
- By Name: Provide 'name' to search first (will ask to clarify if multiple matches)

CONFIRMATION REQUIRED (server-verified — you cannot self-confirm):
- First call: the tool returns an exact action-bound "CONFIRM DELETE ..." phrase
  and does NOT delete. Relay that phrase verbatim and STOP for the turn.
- Re-issue the exact same call only when the user's NEXT raw message is exactly
  that phrase. Generic confirmation or a modified phrase is not authorization.

EXAMPLE WORKFLOW:
1. User: "Delete the Acme Corp company"
2. AI calls: deleteEntity(entityType: "company", name: "Acme Corp")
3. Tool returns the exact "CONFIRM DELETE ..." phrase (nothing deleted yet)
4. AI relays that phrase verbatim, then waits for the user's next message
5. User sends that exact phrase
6. AI calls the SAME tool again: deleteEntity(entityType: "company", name: "Acme Corp")

WARNING: Deletion is permanent. Each entity type's current server-side cascade rules are applied.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        entityType: {
          type: SchemaType.STRING,
          description:
            "Type of entity to delete: 'company', 'technology', 'useCase', 'prototype', 'strategy', 'signal', 'orgUnit', 'initiative', 'painPoint'",
        },
        id: {
          type: SchemaType.STRING,
          description:
            "Entity ID (if known). For decoupled technologies use 'tech-xxx' format; for legacy technologies use 'radarId:techId' format.",
        },
        name: {
          type: SchemaType.STRING,
          description:
            'Entity name (alternative to id). If provided instead of id, will search for the entity by name first.',
        },
        confirmed: {
          type: SchemaType.BOOLEAN,
          description:
            'Legacy explicit-confirm flag for automated (non-chat) callers only. Interactive chat must relay the exact action-bound phrase returned by the first call and retry only when the next raw user message exactly matches it.',
        },
      },
      required: ['entityType'],
    },
  },
  {
    name: 'createCompanyWithResearch',
    description:
      'Unsupported and superseded for Assistant workflows. Use createCompany with only user-approved fields. This legacy compatibility path persists only receipt-backed profile facts plus draft provenance; it does not materialize contacts, SWOT, or competitor relations.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        name: {
          type: SchemaType.STRING,
          description: 'Company name',
        },
        description: {
          type: SchemaType.STRING,
          description: 'Company description',
        },
        website: {
          type: SchemaType.STRING,
          description: 'Company website URL',
        },
        industry: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description:
            'Industries. Values: healthcare, food_agriculture, technology, manufacturing, energy, consumer, financial, logistics, media, professional, other',
        },
        size: {
          type: SchemaType.STRING,
          description: 'Company size. Values: micro, small, medium, large, enterprise',
        },
        stage: {
          type: SchemaType.STRING,
          description:
            'Funding stage. Values: pre_seed, seed, series_a, series_b, series_c_plus, bootstrapped, private, public, ipo, nonprofit',
        },
        location: {
          type: SchemaType.OBJECT,
          properties: {
            city: { type: SchemaType.STRING },
            country: { type: SchemaType.STRING },
          },
          description: 'Company headquarters location',
        },
        socialLinks: {
          type: SchemaType.OBJECT,
          properties: {
            linkedin: { type: SchemaType.STRING },
            twitter: { type: SchemaType.STRING },
            github: { type: SchemaType.STRING },
          },
          description: 'Social media links',
        },
        technologyStack: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Technologies the company uses or provides',
        },
        tags: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Tags for categorization',
        },
        contacts: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              name: { type: SchemaType.STRING },
              role: { type: SchemaType.STRING },
              linkedin: { type: SchemaType.STRING },
            },
          },
          description: 'Key contacts/executives',
        },
        competitors: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Competitor company names',
        },
        swot: {
          type: SchemaType.OBJECT,
          properties: {
            strengths: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
            weaknesses: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
            opportunities: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
            threats: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
          },
          description: 'SWOT analysis',
        },
      },
      required: ['name', 'description'],
    },
  },
];

// ============================================================================
// Tool Execution Functions
// ============================================================================

/**
 * Parse AI-generated headquarters string into city/country.
 * Handles malformed inputs like "locationBarcelona", "SpainSocial media linksLinkedin",
 * and other AI pollution patterns.
 */
export function parseHeadquarters(raw: string): { city: string; country: string } {
  if (!raw) return { city: '', country: '' };
  // Strip common prefixes AI prepends
  let cleaned = raw.replace(/^(location|headquarters|based in|hq|located in)[:\s]*/i, '').trim();
  // Strip social media / URL pollution that gets concatenated
  cleaned = cleaned.split(/(?:Social media|LinkedIn|Twitter|GitHub|https?:\/\/)/i)[0].trim();
  // Remove trailing punctuation in one reverse pass. An end-anchored `+`
  // regex can retry at every input position when model text is very long.
  let suffixStart = cleaned.length;
  while (suffixStart > 0) {
    const char = cleaned[suffixStart - 1];
    if (char !== ',' && char !== ';' && char !== '.' && char.trim().length > 0) break;
    suffixStart -= 1;
  }
  cleaned = cleaned.slice(0, suffixStart);
  if (!cleaned) return { city: '', country: '' };
  const parts = cleaned
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return { city: parts[0] || '', country: parts[1] || '' };
}

/**
 * Create a company
 */
export async function executeCreateCompany(
  args: Record<string, unknown>
): Promise<{ success: boolean; data?: { id: string; name: string }; error?: string }> {
  try {
    // Reality-check gate: prevent hallucinated company creations.
    if (args.skipRealityCheck !== true) {
      const websiteArg = typeof args.website === 'string' ? args.website.trim() : '';
      let websiteReachable = false;
      if (websiteArg.length > 0) {
        try {
          const urlCheck = await verifyUrlsReachable([websiteArg]);
          websiteReachable = urlCheck.ok;
        } catch {
          websiteReachable = false;
        }
      }
      // Reality check gated by DEFENSE_MINISTER_ENABLED. When disabled, skip
      // the Gemini grounded-search call and proceed with entity creation.
      if (!websiteReachable && process.env.DEFENSE_MINISTER_ENABLED === 'true') {
        const verdict = await verifyEntityReality(cleanMarkdownFromText(args.name as string));
        if (!verdict.ok) {
          log.warn('Reality check failed for company', {
            name: args.name,
            reason: verdict.reason,
          });
          return {
            success: false,
            error: `Reality check failed for "${String(args.name)}" (${verdict.reason}). No web presence found. Provide a verifiable website, or set skipRealityCheck: true to override.`,
            data: {
              realityCheckFailed: true,
              reason: verdict.reason,
            },
          } as unknown as { success: boolean; data: { id: string; name: string }; error?: string };
        }
      }
    }

    // Parse headquarters into location object (handles AI-generated malformed strings)
    const location = parseHeadquarters((args.headquarters as string) || '');

    // Phase 4: Updated to use new lowercase enum values
    const company = await adminCreateCompany({
      name: cleanMarkdownFromText(args.name as string),
      description: cleanMarkdownFromText((args.description as string) || ''),
      type: (args.type as CompanyType[]) || ['sme'],
      website: (args.website as string) || '',
      industry: (args.industry as CompanyIndustry[]) || [],
      // AI-028 — abstain: only persist size/stage when the caller actually
      // supplied them, rather than fabricating medium/private as a finding.
      ...(typeof args.size === 'string' && args.size ? { size: args.size as CompanySize } : {}),
      ...(typeof args.stage === 'string' && args.stage ? { stage: args.stage as CompanyStage } : {}),
      location,
      tags: [],
      socialLinks: {},
      technologyStack: [],
      documents: [],
      status: 'Watching' as CompanyStatus,
    });

    log.info('Created company', { companyName: company.name, companyId: company.id });

    // Emit refresh event for companies
    emitDataRefresh('companies', 'ai-assistant');

    // Auto-trigger background research unless explicitly skipped
    if (!args.skipResearch) {
      researchCompanyComprehensive({
        name: company.name,
        website: (args.website as string) || '',
        description: (args.description as string) || '',
      })
        .then(async (research) => {
          try {
            await adminUpdateCompany(company.id, { research });
            emitDataRefresh('companies', 'ai-assistant');
          } catch (e) {
            log.warn('Background research save failed', { error: e instanceof Error ? e.message : String(e) });
          }
        })
        .catch((e) => {
          log.warn('Background research failed', { error: e instanceof Error ? e.message : String(e) });
        });
    }

    return {
      success: true,
      data: { id: company.id, name: company.name },
    };
  } catch (error) {
    if (error instanceof DuplicateEntityError) {
      return {
        success: true,
        data: {
          alreadyExists: true,
          existingId: error.existingId,
          message: `Company already exists (ID: ${error.existingId}). Use update to modify it.`,
        },
      } as unknown as { success: boolean; data: { id: string; name: string }; error?: string };
    }
    log.error('Failed to create company', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create company',
    };
  }
}

/**
 * Create a technology
 *
 * With technology/radar decoupling:
 * - If quadrant and ring are NOT provided: Create technology in library only (no radar placement)
 * - If quadrant and ring ARE provided: Create technology AND place on radar
 */
export async function executeCreateTechnology(
  args: Record<string, unknown>,
  context?: { userId?: string }
): Promise<{
  success: boolean;
  data?: {
    id: string;
    name: string;
    radarId?: string;
    placedOnRadar?: boolean;
    created?: boolean;
    alreadyExists?: boolean;
    graphHandoff?: PlacementGraphHandoff;
  };
  error?: string;
}> {
  log.debug('executeCreateTechnology called', { args: JSON.stringify(args) });

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
          log.warn('Reality check failed for technology', {
            name: args.name,
            reason: verdict.reason,
          });
          return {
            success: false,
            error: `Reality check failed for "${String(args.name)}" (${verdict.reason}). No web presence found. Provide a verifiable websiteUrl or githubUrl, or set skipRealityCheck: true to override.`,
            data: {
              id: '',
              name: String(args.name ?? ''),
              realityCheckFailed: true,
              reason: verdict.reason,
            } as unknown as { id: string; name: string; radarId?: string; placedOnRadar?: boolean },
          };
        }
      }
    }

    const name = cleanMarkdownFromText(args.name as string);
    const description = cleanMarkdownFromText((args.description as string) || '');
    const quadrant = args.quadrant as string | undefined;
    const ring = args.ring as string | undefined;
    const hasRadarPlacement = Boolean(quadrant && ring);

    log.debug('hasRadarPlacement', { hasRadarPlacement });

    // Create the technology entity (facts only)
    // Normalize category to ensure valid enum value
    const normalizedCategory = args.category ? normalizeTechnologyCategory(args.category) : undefined;
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    let technology: Awaited<ReturnType<typeof createDecoupledTech>>;
    let created = true;

    try {
      technology = await createDecoupledTech({
        name,
        slug,
        description,
        tags: (args.tags as string[]) || [],
        category: normalizedCategory,
        websiteUrl: args.websiteUrl as string,
        githubUrl: args.githubUrl as string,
        createdBy: 'ai-assistant',
      });
    } catch (error) {
      const duplicateSuffix = `A technology with slug "${slug}" already exists`;
      if (!(error instanceof Error) || !error.message.endsWith(duplicateSuffix)) {
        throw error;
      }

      const normalizeExactName = (value: string): string =>
        value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
      const requestedName = normalizeExactName(name);
      const exactMatches = (await getDecoupledTechnologies()).filter(
        (candidate) => candidate.slug === slug && normalizeExactName(candidate.name) === requestedName
      );

      // Slug collisions and duplicate legacy identities remain explicit errors.
      // Only one canonical record with the same normalized name can converge.
      if (exactMatches.length !== 1) {
        throw error;
      }

      technology = exactMatches[0];
      created = false;
      log.info('Technology already exists; converged exact repeated create', {
        technologyName: technology.name,
        technologyId: technology.id,
      });
    }

    if (created) {
      log.info('Created technology', { technologyName: technology.name, technologyId: technology.id });
    }

    // If quadrant and ring are provided, also create a radar placement
    let radarId: string | undefined;
    let placedOnRadar = false;
    let placementHandoff: PlacementGraphHandoff | undefined;

    if (hasRadarPlacement) {
      // GRAPH-060 #1 — user-triggered mutation through the Assistant; require an
      // authenticated principal before any radar or storage access.
      if (!context?.userId) {
        return {
          success: false,
          error: 'You must be signed in to create and place a technology on a radar.',
        };
      }
      const ownerId = context.userId;

      // Get radar ID - use provided or get default
      radarId = args.radarId as string;
      if (!radarId) {
        const radars = await adminListRadars();
        if (radars.length > 0) {
          radarId = radars[0].id;
        }
      }

      if (radarId) {
        // Resolve the agent's `quadrant` arg (display name) against the
        // target radar's stable quadrantIds.
        const targetRadar = await adminGetRadarById(radarId);
        if (!targetRadar || !Array.isArray(targetRadar.quadrants) || targetRadar.quadrants.length === 0) {
          log.warn('Skipping placement — radar not found or has no quadrants', { radarId });
        } else {
          // GRAPH-060 #2 — owner-only: the Assistant mutates only radars that
          // belong to the acting user. Missing/foreign/ownerless radars throw
          // RadarAuthorizationError and surface below as a permission denial.
          await adminGetOwnedRadarById(radarId, ownerId);

          const quadrantStr = String(quadrant);
          const hit = resolveQuadrantReference(targetRadar, quadrantStr);
          if (!hit) {
            log.warn('Skipping placement — quadrant not found on target radar', {
              radarId,
              attempted: quadrantStr,
            });
          } else {
            // Build the placement payload. `trlScore` and `timeToImpact` are
            // optional on the schema but we forward whatever the agent sent
            // so the entry list columns render properly instead of showing
            // "-". Undefined fields are structurally omitted (Firestore
            // rejects `undefined` field values outright) via conditional
            // spreads.
            const rawTrlScore = args.trlScore;
            const trlScore = typeof rawTrlScore === 'number' ? rawTrlScore : undefined;
            const rawTimeToImpact = args.timeToImpact;
            const timeToImpact =
              typeof rawTimeToImpact === 'string' && rawTimeToImpact.length > 0
                ? (rawTimeToImpact as TimeToImpact)
                : undefined;

            const result = await adminCreateRadarPlacementWithHandoff(
              {
                technologyId: technology.id,
                radarId,
                quadrantId: hit.id,
                ring: ring as string,
                status: (args.status as Status) || 'New',
                rationale: args.analysis ? cleanMarkdownFromText(args.analysis as string) : undefined,
                placedBy: ownerId,
                ...(trlScore !== undefined ? { trlScore } : {}),
                ...(timeToImpact !== undefined ? { timeToImpact } : {}),
              },
              { requireOwnerId: ownerId }
            );
            placedOnRadar = true;
            placementHandoff = result.graphHandoff;
            log.info('Placed technology on radar', {
              radarId,
              quadrantId: hit.id,
              ring,
              trlScore,
              timeToImpact,
            });
          }
        }
      }
    }

    // Emit refresh event for technologies
    emitDataRefresh('technologies', 'ai-assistant');

    return {
      success: true,
      data: {
        id: technology.id,
        name: technology.name,
        radarId: radarId,
        placedOnRadar,
        created,
        alreadyExists: !created,
        graphHandoff: placementHandoff,
      },
    };
  } catch (error) {
    log.error('Failed to create technology', error instanceof Error ? error : undefined);
    if (error instanceof RadarAuthorizationError || error instanceof PlacementAuthorizationError) {
      return { success: false, error: 'You do not have permission to create a placement on this radar.' };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create technology',
    };
  }
}

/**
 * Create a use case
 */
export async function executeCreateUseCase(
  args: Record<string, unknown>
): Promise<{ success: boolean; data?: { id: string; title: string }; error?: string }> {
  try {
    const title = cleanMarkdownFromText(args.title as string);
    const description = cleanMarkdownFromText((args.description as string) || '');

    // Generate default problem/solution from title if not provided
    // Firebase rejects undefined values, so we must provide defaults
    const defaultProblem = `Business need related to: ${title}`;
    const defaultSolution = description
      ? `Proposed approach: ${description.substring(0, 200)}${description.length > 200 ? '...' : ''}`
      : `Solution for: ${title}`;

    const useCase = await adminCreateUseCase({
      title,
      description,
      problem: args.problem ? cleanMarkdownFromText(args.problem as string) : defaultProblem,
      solution: args.solution ? cleanMarkdownFromText(args.solution as string) : defaultSolution,
      category: (args.category as string) || 'General',
      tags: (args.tags as string[]) || [],
      status: (args.status as 'Proposed' | 'In Progress' | 'Implemented' | 'Archived') || 'Proposed',
      radarTechnologyIds: [],
      companyIds: [],
    });

    log.info('Created use case', { title: useCase.title, id: useCase.id });

    // Emit refresh event for use cases
    emitDataRefresh('useCases', 'ai-assistant');

    return {
      success: true,
      data: { id: useCase.id, title: useCase.title },
    };
  } catch (error) {
    log.error('Failed to create use case', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create use case',
    };
  }
}

/**
 * Create a prototype
 */
export async function executeCreatePrototype(
  args: Record<string, unknown>
): Promise<{ success: boolean; data?: { id: string; name: string }; error?: string }> {
  try {
    const prototype = await adminCreatePrototype({
      name: cleanMarkdownFromText(args.name as string),
      description: cleanMarkdownFromText((args.description as string) || ''),
      targetBusinessUnit: (args.targetBusinessUnit as string) || 'Unassigned',
      team: (args.team as string[]) || [],
      status: (args.status as PrototypeStatus) || 'Ideation',
      linkedTechnologies: [],
      linkedCompanies: [],
      linkedUseCases: [],
      linkedStrategies: [],
      presentedTo: [],
      artifacts: {
        presentations: [],
      },
      impact: {
        type: 'Business Transformation',
        estimatedValue: 0,
        timeToImpact: 'TBD',
        confidence: 50,
        notes: '',
      },
    });

    log.info('Created prototype', { name: prototype.name, id: prototype.id });

    // Emit refresh event for prototypes
    emitDataRefresh('prototypes', 'ai-assistant');

    return {
      success: true,
      data: { id: prototype.id, name: prototype.name },
    };
  } catch (error) {
    log.error('Failed to create prototype', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create prototype',
    };
  }
}

/**
 * Create a strategy
 */
export async function executeCreateStrategy(
  args: Record<string, unknown>
): Promise<{ success: boolean; data?: { id: string; name: string }; error?: string }> {
  try {
    const directives = args.directives as Array<{ directive: string; priority?: string }> | undefined;
    const description = cleanMarkdownFromText((args.description as string) || '');

    const strategy = await adminCreateStrategy({
      name: cleanMarkdownFromText(args.name as string),
      description,
      content: description, // Use description as initial content
      mainDirectives: (directives || []).map((d, index) => ({
        id: `directive-${index + 1}`,
        directive: cleanMarkdownFromText(d.directive),
        category: 'Custom' as const,
        priority: d.priority === 'High' ? 10 : d.priority === 'Low' ? 3 : 5,
      })),
      documents: [],
      links: [],
      aiGeneratedSummary: description, // Provide a default value
    });

    log.info('Created strategy', { name: strategy.name, id: strategy.id });

    // Emit refresh event for strategies
    emitDataRefresh('strategies', 'ai-assistant');

    return {
      success: true,
      data: { id: strategy.id, name: strategy.name },
    };
  } catch (error) {
    log.error('Failed to create strategy', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create strategy',
    };
  }
}

/** The signal that was created, plus exactly which links it carries. */
export interface CreateSignalResultData {
  id: string;
  title: string;
  /** Identity of every name that was linked. Empty when none were requested. */
  linkedEntities: ResolvedLinkedEntity[];
}

export interface CreateSignalResult {
  success: boolean;
  data?: CreateSignalResultData;
  error?: string;
  noMutation?: ToolNoMutationProof;
}

type SignalLinkedEntityOutcome =
  | {
      ok: true;
      linkedEntities: { companies?: string[]; technologies?: string[] };
      resolvedLinks: ResolvedLinkedEntity[];
    }
  | { ok: false; refusal: CreateSignalResult };

/** Every refusal from linked-entity resolution: no signal exists, nothing was written. */
function linkedEntityRefusal(stage: PreWriteRefusalStage, error: string): SignalLinkedEntityOutcome {
  return { ok: false, refusal: { success: false, error, noMutation: noMutationProof(stage) } };
}

/**
 * AI-040 — resolve `linkedEntityNames` into Firestore link buckets, or refuse.
 *
 * The old behaviour swallowed every failure mode into `linkedEntities: {}`, so a
 * signal that had lost all of its links looked identical to one the user never
 * asked to link. Each mode is now a distinct, actionable, provably write-free
 * refusal:
 *  - malformed argument (not an array / non-string entries) → `validation`
 *  - more names than the resolver's cap → `validation`
 *  - the entity libraries could not be read → `lookup` (INCONCLUSIVE: the names
 *    are not reported as missing, because that is not what was learned)
 *  - one or more names matched nothing → `lookup`, naming them
 */
async function resolveSignalLinkedEntities(namesArg: unknown): Promise<SignalLinkedEntityOutcome> {
  const empty: SignalLinkedEntityOutcome = { ok: true, linkedEntities: {}, resolvedLinks: [] };
  if (namesArg === undefined || namesArg === null) return empty;

  if (!Array.isArray(namesArg)) {
    return linkedEntityRefusal(
      'validation',
      'No signal was created: linkedEntityNames must be an array of entity names.'
    );
  }
  if (namesArg.length === 0) return empty;

  const invalid = namesArg.filter((name) => typeof name !== 'string' || name.trim().length === 0);
  if (invalid.length > 0) {
    return linkedEntityRefusal(
      'validation',
      `No signal was created: every linkedEntityNames entry must be a non-empty string (${invalid.length} of ${namesArg.length} were not).`
    );
  }

  const names = (namesArg as string[]).map((name) => name.trim());
  if (names.length > LINKED_ENTITY_NAME_CAP) {
    return linkedEntityRefusal(
      'validation',
      `No signal was created: linkedEntityNames accepts at most ${LINKED_ENTITY_NAME_CAP} names, ${names.length} were supplied. Create the signal with the most relevant names, then link the rest.`
    );
  }

  let resolution: Awaited<ReturnType<typeof resolveLinkedEntityNames>>;
  try {
    resolution = await resolveLinkedEntityNames(names);
  } catch (error) {
    // A library read failure proves nothing about whether the names exist, so
    // the message must not claim they are missing.
    const detail = error instanceof Error ? error.message : String(error);
    log.error(
      'Linked-entity resolution failed; refusing to create a signal with dropped links',
      error instanceof Error ? error : undefined
    );
    return linkedEntityRefusal(
      'lookup',
      `No signal was created: the entity libraries could not be read, so ${names.length} linked entity name(s) could not be resolved. ${detail}`
    );
  }

  if (resolution.unresolved.length > 0) {
    const resolvedSummary =
      resolution.resolved.length > 0
        ? ` Resolved: ${resolution.resolved.map((entity) => `"${entity.requestedName}" -> ${entity.kind} ${entity.id}`).join(', ')}.`
        : '';
    return linkedEntityRefusal(
      'lookup',
      `No signal was created: ${resolution.unresolved.length} linked entity name(s) matched no company or technology — ${resolution.unresolved
        .map((name) => `"${name}"`)
        .join(', ')}.${resolvedSummary} Create those entities first, or retry with only the names that exist.`
    );
  }

  const linkedEntities: { companies?: string[]; technologies?: string[] } = {};
  if (resolution.companies.length > 0) linkedEntities.companies = resolution.companies;
  if (resolution.technologies.length > 0) linkedEntities.technologies = resolution.technologies;
  return { ok: true, linkedEntities, resolvedLinks: resolution.resolved };
}

/**
 * Create a signal manually.
 *
 * Widened 2026-04-19 to accept sentiment, summary, publishedAt, and
 * linkedEntityNames so the model can populate richer fields at creation
 * time — which also lets the existing expand-signal Inngest job trip
 * (it requires relevanceScore >= 70).
 *
 * AI-040 — `linkedEntityNames` is all-or-nothing: an unresolvable name refuses
 * the whole call with a `noMutation` proof rather than persisting a signal whose
 * links were silently discarded.
 */
export async function executeCreateSignal(args: Record<string, unknown>): Promise<CreateSignalResult> {
  const latch = createMutationLatch();
  try {
    // Sentiment validation — fail-fast with a structured error so the model
    // can retry with a valid value via the tool-result loop.
    const sentimentArg = args.sentiment;
    const allowedSentiments = ['positive', 'neutral', 'negative'] as const;
    let sentiment: (typeof allowedSentiments)[number] = 'neutral';
    if (typeof sentimentArg === 'string') {
      if (!(allowedSentiments as readonly string[]).includes(sentimentArg)) {
        return {
          success: false,
          error: `sentiment must be one of: ${allowedSentiments.join(', ')}`,
          noMutation: noMutationProof('validation'),
        };
      }
      sentiment = sentimentArg as (typeof allowedSentiments)[number];
    }

    // Signal-type validation — same fail-fast: `type` is a required parameter,
    // and a bogus value must not be raw-cast into Firestore as a SignalType.
    const allowedSignalTypes: readonly SignalType[] = [
      'patent',
      'paper',
      'news',
      'funding',
      'github',
      'trend',
      'hackernews',
      'filing',
    ];
    if (!(allowedSignalTypes as readonly string[]).includes(args.type as string)) {
      return {
        success: false,
        error: `type must be one of: ${allowedSignalTypes.join(', ')}`,
        noMutation: noMutationProof('validation'),
      };
    }

    const description = cleanMarkdownFromText((args.description as string) || '');
    const title = cleanMarkdownFromText(args.title as string);
    const url = args.url as string | undefined;
    const summary =
      typeof args.summary === 'string' && args.summary.trim().length > 0
        ? cleanMarkdownFromText(args.summary)
        : undefined;

    const signalUrl = url || `https://assistant.radarist.ai/signal/${Date.now()}`;
    const isAiCreated = !url;

    const rawRelevance =
      typeof args.relevanceScore === 'number' && Number.isFinite(args.relevanceScore) ? args.relevanceScore : 50;
    const relevanceScore = Math.max(0, Math.min(100, rawRelevance));

    const date =
      typeof args.publishedAt === 'number' && Number.isFinite(args.publishedAt) ? args.publishedAt : Date.now();

    // AI-040 — linked-entity resolution is fail-visible and write-free. A name
    // the user explicitly asked to link must never be silently dropped: either
    // every name resolves, or no signal is created and the refusal names exactly
    // which ones did not.
    const linkedEntityOutcome = await resolveSignalLinkedEntities(args.linkedEntityNames);
    if (!linkedEntityOutcome.ok) return linkedEntityOutcome.refusal;
    const { linkedEntities, resolvedLinks } = linkedEntityOutcome;

    const aiSummary = summary ?? (description.length > 200 ? description.slice(0, 200) + '...' : description);

    const signalData: Parameters<typeof adminCreateSignal>[0] = {
      type: args.type as SignalType,
      title,
      description,
      source: (args.source as string) || 'AI Assistant',
      url: signalUrl,
      date,
      relevanceScore,
      alignmentScore: 50,
      alignedStrategies: [],
      linkedEntities,
      status: 'Detected',
      sentiment,
      aiSummary,
      detectedAt: Date.now(),
    };

    if (isAiCreated) {
      signalData.metadata = { agentId: 'ai-assistant', createdVia: 'chat' };
    }

    const signal = await latch.mutating(() => adminCreateSignal(signalData));

    log.info('Created signal', { title: signal.title, id: signal.id, linkedEntities: resolvedLinks.length });

    emitDataRefresh('signals', 'ai-assistant');

    return {
      success: true,
      data: { id: signal.id, title: signal.title, linkedEntities: resolvedLinks },
    };
  } catch (error) {
    log.error('Failed to create signal', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create signal',
      // Proof only while the latch is closed; once the create started, the
      // outcome is genuinely unknown and must stay conservative.
      ...thrownFailureProof(latch),
    };
  }
}

/** Normalized exact-name key shared by explicit-write entity resolvers. */
export function normalizeEntityReferenceName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

const ENTITY_NAME_CANDIDATE_LIMIT = 5;

function rankEntityNameCandidates(
  entities: readonly { id: string; name: string }[],
  name: string,
  prioritizeNormalizedExact: boolean
): { id: string; name: string }[] {
  if (!prioritizeNormalizedExact) {
    const searchName = name.toLowerCase();
    return entities
      .filter((entity) => entity.name.toLowerCase().includes(searchName))
      .slice(0, ENTITY_NAME_CANDIDATE_LIMIT);
  }

  const searchName = normalizeEntityReferenceName(name);
  if (!searchName) return [];

  const matches = entities.filter((entity) => normalizeEntityReferenceName(entity.name).includes(searchName));
  const exactMatches = matches.filter((entity) => normalizeEntityReferenceName(entity.name) === searchName);
  const partialMatches = matches.filter((entity) => normalizeEntityReferenceName(entity.name) !== searchName);

  // Exact matches must be considered before the bounded display list. In
  // particular, two duplicate exact names must never be hidden behind five
  // earlier partial matches and reduced to an apparently unique target.
  return [...exactMatches, ...partialMatches].slice(0, ENTITY_NAME_CANDIDATE_LIMIT);
}

/**
 * Resolve up-to-5 entity candidates on the type's display field (name/title).
 * Returns null for unknown types.
 *
 * The default preserves `deleteEntity`'s established substring/fuzzy policy.
 * Explicit link tools opt into normalized exact-first ordering so they can
 * require one unique exact endpoint and use partial candidates only as hints.
 */
export async function searchEntityCandidatesByName(
  entityType: string,
  name: string,
  options: { prioritizeNormalizedExact?: boolean } = {}
): Promise<{ id: string; name: string }[] | null> {
  const prioritizeNormalizedExact = options.prioritizeNormalizedExact === true;
  switch (entityType) {
    case 'company': {
      const companies = await adminGetCompanies();
      return rankEntityNameCandidates(
        companies.map((company) => ({ id: company.id, name: company.name })),
        name,
        prioritizeNormalizedExact
      );
    }
    case 'useCase': {
      const useCases = await adminGetUseCases();
      return rankEntityNameCandidates(
        useCases.map((useCase) => ({ id: useCase.id, name: useCase.title })),
        name,
        prioritizeNormalizedExact
      );
    }
    case 'prototype': {
      const prototypes = await adminGetPrototypes();
      return rankEntityNameCandidates(
        prototypes.map((prototype) => ({ id: prototype.id, name: prototype.name })),
        name,
        prioritizeNormalizedExact
      );
    }
    case 'strategy': {
      const strategies = await adminGetStrategies();
      return rankEntityNameCandidates(
        strategies.map((strategy) => ({ id: strategy.id, name: strategy.name })),
        name,
        prioritizeNormalizedExact
      );
    }
    case 'signal': {
      const signals = await adminGetSignals();
      return rankEntityNameCandidates(
        signals.map((signal) => ({ id: signal.id, name: signal.title })),
        name,
        prioritizeNormalizedExact
      );
    }
    case 'technology': {
      // Preserve deleteEntity's established fuzzy-search behavior by default.
      // Explicit link resolution reads the complete collection so fuzzy
      // scoring/limit order cannot hide a duplicate exact technology name.
      const technologies = await getDecoupledTechnologies(prioritizeNormalizedExact ? {} : { search: name });
      if (!prioritizeNormalizedExact) {
        const searchName = name.toLowerCase();
        const candidates = technologies.map((technology) => ({ id: technology.id, name: technology.name }));
        const exactMatches = candidates.filter((technology) => technology.name.toLowerCase() === searchName);
        const fuzzyMatches = candidates.filter((technology) => technology.name.toLowerCase() !== searchName);
        return [...exactMatches, ...fuzzyMatches].slice(0, ENTITY_NAME_CANDIDATE_LIMIT);
      }
      return rankEntityNameCandidates(
        technologies.map((technology) => ({ id: technology.id, name: technology.name })),
        name,
        prioritizeNormalizedExact
      );
    }
    case 'orgUnit': {
      const orgUnits = await adminGetOrgUnits();
      return rankEntityNameCandidates(
        orgUnits.map((orgUnit) => ({ id: orgUnit.id, name: orgUnit.name })),
        name,
        prioritizeNormalizedExact
      );
    }
    case 'initiative': {
      const initiatives = await adminGetInitiatives();
      return rankEntityNameCandidates(
        initiatives.map((initiative) => ({ id: initiative.id, name: initiative.name })),
        name,
        prioritizeNormalizedExact
      );
    }
    case 'painPoint': {
      const painPoints = await adminGetPainPoints();
      return rankEntityNameCandidates(
        painPoints.map((painPoint) => ({ id: painPoint.id, name: painPoint.title })),
        name,
        prioritizeNormalizedExact
      );
    }
    default:
      return null;
  }
}

/**
 * Delete an entity (requires confirmation).
 * Supports name-based lookup: if `name` is provided instead of `id`, searches
 * for the entity using the established bounded fuzzy behavior.
 */
export async function executeDeleteEntity(
  args: Record<string, unknown>,
  context?: DeleteGateContext
): Promise<{
  success: boolean;
  data?:
    | {
        message: string;
        matchingEntities?: { id: string; name: string }[];
        placementsDeleted?: number;
        relationsDeleted?: number;
        neo4jDeleted?: boolean;
        mutatedEntityTypes?: readonly MutationEntityType[];
      }
    | {
        message: string;
        deletionBlocker: EntityDeletionBlockedDetails;
        mutatedEntityTypes?: readonly MutationEntityType[];
      }
    | DestructiveGateRefusal;
  error?: string;
}> {
  const entityType = typeof args.entityType === 'string' ? args.entityType.trim() : '';
  if (!DELETABLE_ENTITY_TYPES.has(entityType)) {
    return { success: false, error: `Unknown entity type: ${entityType || '(missing)'}` };
  }

  const rawId = args.id;
  const rawName = args.name;
  const normalizedId = rawId === undefined ? undefined : normalizeDestructiveIdentifier(rawId);
  const normalizedName = rawName === undefined ? undefined : normalizeDestructiveIdentifier(rawName);
  if (rawId !== undefined && !normalizedId) {
    return { success: false, error: 'A non-empty entity ID is required for deletion.' };
  }
  if (rawName !== undefined && !normalizedName) {
    return { success: false, error: 'A non-empty entity name is required for deletion.' };
  }

  let id = normalizedId ?? '';
  const name = normalizedName ?? '';
  let resolvedName = name;
  if (id && name) {
    return { success: false, error: "Provide either 'id' or 'name' for deletion, not both." };
  }

  // If name is provided but not id, resolve the entity ID by name
  if (!id && name) {
    const searchName = name.toLowerCase();
    let matches: { id: string; name: string }[] = [];

    try {
      const candidates = await searchEntityCandidatesByName(entityType, name);
      if (candidates === null) {
        return { success: false, error: `Unknown entity type: ${entityType}` };
      }
      matches = candidates;
    } catch (searchError) {
      log.error('Failed to search entity by name', searchError instanceof Error ? searchError : undefined, {
        entityType,
      });
      return {
        success: false,
        error: `Failed to search for ${entityType} by name: ${searchError instanceof Error ? searchError.message : 'Unknown error'}`,
      };
    }

    if (matches.length === 0) {
      return {
        success: false,
        error: `No ${entityType} found with name "${name}". Please check the name and try again.`,
      };
    }

    // Find exact match first
    const exactMatch = matches.find((m) => m.name.toLowerCase() === searchName);

    if (exactMatch) {
      id = exactMatch.id;
      resolvedName = exactMatch.name;
    } else if (matches.length === 1) {
      id = matches[0].id;
      resolvedName = matches[0].name;
    } else {
      // Multiple matches, ask user to clarify
      return {
        success: false,
        error: `Multiple ${entityType}s found matching "${name}". Please specify which one: ${matches.map((m) => `"${m.name}" (id: ${m.id})`).join(', ')}`,
        data: {
          message: `Found ${matches.length} matching ${entityType}s`,
          matchingEntities: matches,
        },
      };
    }
  }

  if (!id) {
    return {
      success: false,
      error: "Either 'id' or 'name' must be provided to identify the entity to delete.",
    };
  }

  const gate = confirmDestructiveAction({
    fingerprint: destructiveActionFingerprint('deleteEntity', entityType, id),
    summary: `delete the ${entityType} "${resolvedName || id}"`,
    confirmed: args.confirmed as boolean | undefined,
    principal: context?.principal,
    userId: context?.userId,
    requestId: context?.requestId,
    confirmationText: context?.confirmationText,
  });
  if (!gate.ok) {
    return { success: false, error: gate.error, data: gate.data };
  }

  const cascadeMutatedEntityTypes = DELETION_MUTATED_ENTITY_TYPES[entityType as DeletionMutationSource];

  try {
    let technologyCleanup: { placementsDeleted: number; relationsDeleted: number; neo4jDeleted: boolean } | undefined;
    let signalCleanup: { relationsDeleted: number } | undefined;

    // Library entities use Admin SDK services because this executor runs in Node.
    switch (entityType) {
      case 'company': {
        await adminDeleteCompany(id);
        break;
      }
      case 'useCase': {
        await adminDeleteUseCase(id);
        break;
      }
      case 'prototype': {
        await adminDeletePrototype(id);
        break;
      }
      case 'strategy': {
        await adminDeleteStrategy(id);
        break;
      }
      case 'signal': {
        const deletion = await adminDeleteSignals([id]);
        signalCleanup = { relationsDeleted: deletion.relationsDeleted };
        if (deletion.deleted !== 1 || deletion.failed.length !== 0) {
          const errorMessage = `Failed to delete signal ${id} with its server-side cascade`;
          return {
            success: false,
            error: errorMessage,
            data: {
              message: errorMessage,
              ...signalCleanup,
              mutatedEntityTypes: DELETION_MUTATED_ENTITY_TYPES.signal,
            },
          };
        }
        break;
      }
      case 'technology': {
        const deletion = await adminDeleteTechnologyCompletely(id);
        technologyCleanup = {
          placementsDeleted: deletion.placementsDeleted,
          relationsDeleted: deletion.relationsDeleted,
          neo4jDeleted: deletion.neo4jDeleted,
        };
        if (!deletion.success) {
          return {
            success: false,
            error: deletion.error ?? `Failed to completely delete technology ${id}`,
            data: {
              message: `Technology ${id} was not completely deleted`,
              ...technologyCleanup,
              mutatedEntityTypes: DELETION_MUTATED_ENTITY_TYPES.technology,
            },
          };
        }
        break;
      }
      case 'orgUnit': {
        await adminDeleteOrgUnit(id);
        break;
      }
      case 'initiative': {
        await adminDeleteInitiative(id);
        break;
      }
      case 'painPoint': {
        await adminDeletePainPoint(id);
        break;
      }
      default:
        return { success: false, error: `Unknown entity type: ${entityType}` };
    }

    log.info('Deleted entity', { entityType, id });

    // Emit refresh event for the deleted entity type
    const entityTypeToRefreshType: Record<
      string,
      | 'companies'
      | 'technologies'
      | 'useCases'
      | 'prototypes'
      | 'strategies'
      | 'signals'
      | 'orgUnits'
      | 'initiatives'
      | 'painPoints'
    > = {
      company: 'companies',
      technology: 'technologies',
      useCase: 'useCases',
      prototype: 'prototypes',
      strategy: 'strategies',
      signal: 'signals',
      orgUnit: 'orgUnits',
      initiative: 'initiatives',
      painPoint: 'painPoints',
    };
    const refreshType = entityTypeToRefreshType[entityType];
    if (refreshType) {
      emitDataRefresh(refreshType, 'ai-assistant');
    }

    return {
      success: true,
      data: {
        message: `Successfully deleted ${entityType} with ID "${id}"`,
        ...technologyCleanup,
        ...signalCleanup,
        ...(cascadeMutatedEntityTypes ? { mutatedEntityTypes: cascadeMutatedEntityTypes } : {}),
      },
    };
  } catch (error) {
    log.error('Failed to delete entity', error instanceof Error ? error : undefined, { entityType });
    const blocker = getEntityDeletionBlockedDetails(error);
    const errorMessage = error instanceof Error ? error.message : `Failed to delete ${entityType}`;
    if (blocker) {
      return {
        success: false,
        error: errorMessage,
        data: {
          message: errorMessage,
          deletionBlocker: blocker,
          ...(cascadeMutatedEntityTypes ? { mutatedEntityTypes: cascadeMutatedEntityTypes } : {}),
        },
      };
    }
    return {
      success: false,
      error: errorMessage,
      ...(cascadeMutatedEntityTypes
        ? { data: { message: errorMessage, mutatedEntityTypes: cascadeMutatedEntityTypes } }
        : {}),
    };
  }
}

/**
 * Create a company from structured research without promoting unsourced
 * adjuncts. Contacts, SWOT, and competitor relationships remain draft-only.
 */
export async function executeCreateCompanyWithResearch(researchData: ComprehensiveCompanyResearchResult): Promise<{
  success: boolean;
  data?: {
    id: string;
    name: string;
    contactsCreated: 0;
    competitorsAdded: 0;
    swotPopulated: false;
    researchStatus: 'draft';
    sourceReviewRequired: true;
    citationsVerified: false;
  };
  error?: string;
}> {
  try {
    log.info('Creating company with comprehensive research', { companyName: researchData.name });

    // Build initial document links from available URLs
    // Avoid duplicates: don't add URLs that are already in the description
    const documents: Array<{ id: string; name: string; type: 'link'; url: string; uploadedAt: number }> = [];
    const now = Date.now();
    const description = researchData.description?.toLowerCase() || '';

    // Helper to check if a URL is already present in description
    const isUrlInDescription = (url: string): boolean => {
      if (!url) return true; // Treat missing URL as "already present" to skip
      const urlLower = url.toLowerCase();
      // Check full URL or domain
      if (description.includes(urlLower)) return true;
      // Extract domain and check
      const domainMatch = url.match(/(?:https?:\/\/)?(?:www\.)?([^\/\s]+)/i);
      if (domainMatch && description.includes(domainMatch[1].toLowerCase())) return true;
      return false;
    };

    const hasValidWebsiteReceipt = researchData.receipts.website?.some(
      (receipt) => canonicalHttpUrl(receipt.url) !== null
    );
    const canonicalWebsite = researchData.website ? canonicalHttpUrl(researchData.website) : null;

    // The website is the only link whose claim-level receipt survives this flow.
    if (canonicalWebsite && hasValidWebsiteReceipt && !isUrlInDescription(canonicalWebsite.displayUrl)) {
      documents.push({
        id: `doc-${now}-website`,
        name: 'Company Website',
        type: 'link',
        url: canonicalWebsite.displayUrl,
        uploadedAt: now,
      });
    }

    log.info('Adding document links', { count: documents.length });

    // AI-028 — route every sourced fact and the provenance block through
    // the single persistence boundary. An abstained field (e.g. size/stage the
    // research could not source) is omitted from `facts`, so it is never written
    // as a finding and never reaches Firestore as `undefined`.
    const facts: PersistableCompanyFacts = {};
    if (researchData.description) facts.description = cleanMarkdownFromText(researchData.description);
    if (researchData.website) facts.website = researchData.website;
    if (researchData.size !== undefined) facts.size = researchData.size;
    if (researchData.stage !== undefined) facts.stage = researchData.stage;
    if (researchData.industry.length > 0) facts.industries = researchData.industry;
    if (researchData.technologyStack.length > 0) facts.technologyStack = researchData.technologyStack;
    if (researchData.location && (researchData.location.city || researchData.location.country)) {
      facts.location = { city: researchData.location.city, country: researchData.location.country };
    }
    // Competitor display names remain inside the reviewable provenance record;
    // this flow does not create side entities or relationship proposals.
    const competitorNames = (researchData.competitors ?? [])
      .map((competitor) => cleanMarkdownFromText(competitor.name))
      .filter((name) => name.length >= 2);

    const company = await persistSourcedCompanyResearch(
      {
        kind: 'create',
        seed: {
          name: cleanMarkdownFromText(researchData.name),
          description: '',
          type: ['sme'], // Default, can be updated
          website: '',
          industry: [],
          location: { city: '', country: '' },
          tags: [],
          socialLinks: {},
          technologyStack: [],
          documents,
          status: 'Watching',
        },
      },
      {
        research: {
          facts,
          receipts: researchData.receipts,
          unknowns: researchData.unknowns,
          contradictions: researchData.contradictions,
          // The web-research result already dropped per-capability sources; keep
          // the provenance shape consistent by carrying an empty source list.
          vendorCapabilities: researchData.vendorCapabilities.map((capability) => ({ ...capability, sources: [] })),
          missingEvidence: researchData.missingEvidence,
          sourcingComplete: researchData.sourcingComplete,
          citationsVerified: researchData.citationsVerified,
        },
        competitors: competitorNames,
      }
    );

    log.info('Created company with reviewable research draft', { companyName: company.name, companyId: company.id });

    const contactsCreated = 0 as const;
    const competitorsAdded = 0 as const;
    const swotPopulated = false as const;

    // The provenance block (receipts / unknowns / contradictions / vendor
    // capabilities / missing-evidence / sourcingComplete) was already persisted
    // atomically with the company by persistSourcedCompanyResearch above.

    emitDataRefresh(['companies'], 'ai-assistant');

    return {
      success: true,
      data: {
        id: company.id,
        name: company.name,
        contactsCreated,
        competitorsAdded,
        swotPopulated,
        researchStatus: 'draft',
        sourceReviewRequired: true,
        citationsVerified: false,
      },
    };
  } catch (error) {
    log.error('Failed to create company with research', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create company with research',
    };
  }
}
