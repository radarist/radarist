/**
 * @file ai/tools/new-entities-tools.ts
 * @description AI tools for Phase 3 new entities: OrgUnit, Initiative, PainPoint
 *
 * Provides capabilities for:
 * - Creating, searching, and managing OrgUnits
 * - Creating, searching, and managing Initiatives
 * - Creating, searching, and managing PainPoints
 *
 * @author Radarist Team
 * @created 2025-01-09
 * @phase Phase 3: New Entities
 */

import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';
import {
  adminGetOrgUnits,
  adminGetOrgUnitById,
  adminCreateOrgUnit,
  adminUpdateOrgUnit,
  adminDeleteOrgUnit,
} from '@/lib/org-units-admin';
import {
  adminGetInitiatives,
  adminGetInitiativeById,
  adminCreateInitiative,
  adminUpdateInitiative,
  adminDeleteInitiative,
} from '@/lib/initiatives-admin';
import {
  adminGetPainPoints,
  adminGetPainPointById,
  adminCreatePainPoint,
  adminUpdatePainPoint,
  adminDeletePainPoint,
} from '@/lib/pain-points-admin';
import { emitDataRefresh } from '@/lib/events/data-refresh';
import { DuplicateEntityError } from '@/lib/entity-factory-shared';
import type {
  OrgUnit,
  OrgUnitType,
  OrgUnitLevel,
  Initiative,
  InitiativeStatus,
  InitiativePriority,
  PainPoint,
  PainPointSeverity,
  PainPointStatus,
  PainPointCategory,
} from '@/lib/types';
import { createLogger } from '@/lib/logger';
import { getEntityDeletionBlockedDetails } from '@/lib/entity-deletion-reference-policy';
import {
  confirmDestructiveAction,
  destructiveActionFingerprint,
  normalizeDestructiveIdentifier,
} from '@/lib/ai/destructive-confirmation';
import { DELETION_MUTATED_ENTITY_TYPES, type EntityType as MutationEntityType } from '@/lib/ai/mutation-tracking';

const log = createLogger('ai/new-entities');

/** Request-scoped trust data needed by the shared destructive-action gate. */
type DeleteGateContext = {
  principal?: 'human' | 'machine';
  userId?: string;
  requestId?: string;
  confirmationText?: string;
};

// ============================================================================
// Tool Definitions
// ============================================================================

export const NEW_ENTITIES_TOOLS: FunctionDeclaration[] = [
  // ========== OrgUnit Tools ==========
  {
    name: 'searchOrgUnits',
    description: `Search for organizational units (business units, departments, teams, etc.) by name or description.

WHEN TO USE THIS TOOL:
- "Find the [department/team/unit] for..."
- "Which team handles [topic]?"
- "Search for org units related to [area]"
- "List all departments" (use empty or broad query)
- Mapping organizational structure

ORG UNIT TYPES:
- business_unit: Major business segment
- division: Large sub-unit of company
- department: Functional area (HR, IT, Finance)
- team: Working group within department
- squad: Agile/cross-functional team
- other: Custom organization type

LEVELS:
- L1: Top-level (C-suite direct reports)
- L2: Second level (VP/Director)
- L3: Third level (Manager/Lead)
- L4: Fourth level (Individual teams)

EXAMPLE:
{
  "query": "innovation",
  "type": "department",
  "limit": 10
}`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description: 'Search query - matches against org unit names and descriptions',
        },
        type: {
          type: SchemaType.STRING,
          description: "Filter by type: 'business_unit', 'division', 'department', 'team', 'squad', 'other'",
        },
        level: {
          type: SchemaType.STRING,
          description: "Filter by level: 'L1' (top), 'L2', 'L3', 'L4'",
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
    name: 'getOrgUnitDetails',
    description: `Get detailed information about a specific organizational unit including its hierarchy, head, and linked entities.

WHEN TO USE THIS TOOL:
- "Tell me about the [org unit name]"
- "Show details for org unit [id]"
- After searchOrgUnits to get full details on a match
- Need to see org unit hierarchy (parent/children)

RETURNS: Full org unit data including name, description, type, level, parent, head name, employee count, location, tags.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        id: {
          type: SchemaType.STRING,
          description: 'Org unit ID. Get from searchOrgUnits results.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'createOrgUnit',
    description: `Create a new organizational unit to represent business structure. Use for departments, teams, divisions, etc.

WHEN TO USE THIS TOOL:
- "Add [org unit name] to the organization"
- "Create a new team called [name]"
- "Set up a department for [purpose]"
- Building organizational hierarchy

EXAMPLE - Create a team:
{
  "name": "AI Innovation Lab",
  "description": "Cross-functional team exploring AI applications",
  "type": "squad",
  "level": "L3",
  "parentId": "dept_rd_123",
  "headName": "Jane Smith",
  "employeeCount": 8,
  "location": "New York",
  "tags": ["ai", "innovation", "r&d"]
}

TIP: Set parentId to build hierarchy. Use listInitiativesByOrgUnit and listPainPointsByOrgUnit to see related entities after creation.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        name: {
          type: SchemaType.STRING,
          description: "Org unit name (e.g., 'Digital Transformation Office')",
        },
        description: {
          type: SchemaType.STRING,
          description: 'Purpose and scope of the org unit',
        },
        type: {
          type: SchemaType.STRING,
          description: "Type: 'business_unit', 'division', 'department', 'team', 'squad', 'other'",
        },
        level: {
          type: SchemaType.STRING,
          description: "Hierarchical level: 'L1' (top), 'L2', 'L3', 'L4'",
        },
        parentId: {
          type: SchemaType.STRING,
          description: 'Parent org unit ID - creates hierarchy',
        },
        headName: {
          type: SchemaType.STRING,
          description: 'Name of the org unit leader',
        },
        employeeCount: {
          type: SchemaType.NUMBER,
          description: 'Approximate headcount',
        },
        location: {
          type: SchemaType.STRING,
          description: 'Primary location or region',
        },
        tags: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Categorization tags',
        },
      },
      required: ['name', 'type', 'level'],
    },
  },
  {
    name: 'updateOrgUnit',
    description: `Update an existing organizational unit. Requires user confirmation before executing.

WHEN TO USE THIS TOOL:
- "Update [org unit] with new head [name]"
- "Change the description of [org unit]"
- "Update employee count for [org unit]"

WORKFLOW:
1. First describe the changes to the user
2. Ask for confirmation
3. Call with confirmed=true

EXAMPLE:
{
  "id": "org_abc123",
  "updates": { "headName": "John Doe", "employeeCount": 25 },
  "confirmed": true
}`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        id: {
          type: SchemaType.STRING,
          description: 'Org unit ID to update',
        },
        updates: {
          type: SchemaType.OBJECT,
          properties: {},
          description: 'Fields to update: name, description, headName, employeeCount, location, tags, etc.',
        },
        confirmed: {
          type: SchemaType.BOOLEAN,
          description: 'Must be true to execute. ALWAYS ask user for confirmation first.',
        },
      },
      required: ['id', 'updates'],
    },
  },
  {
    name: 'deleteOrgUnit',
    description: `Delete an organizational unit. DESTRUCTIVE - permanently removes the org unit and breaks linked relationships.

WHEN TO USE THIS TOOL:
- "Delete org unit [name]" - only after explicit user request
- Cleaning up test data
- Removing obsolete organizational structure

WARNING: This is permanent. Always confirm with user first.

CONFIRMATION REQUIRED (server-verified — you cannot self-confirm):
- First call returns an exact action-bound "CONFIRM DELETE ..." phrase and does
  not delete. Relay it verbatim and stop for the turn.
- Re-issue the same call only when the next raw user message exactly matches it.

EXAMPLE:
{
  "id": "org_abc123"
}`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        id: {
          type: SchemaType.STRING,
          description: 'Org unit ID to delete',
        },
        confirmed: {
          type: SchemaType.BOOLEAN,
          description:
            'Legacy explicit-confirm flag for automated callers only. Interactive chat must relay the exact action-bound phrase returned by the first call and retry only when the next raw user message exactly matches it.',
        },
      },
      required: ['id'],
    },
  },

  // ========== Initiative Tools ==========
  {
    name: 'searchInitiatives',
    description: `Search for strategic initiatives (programs, projects, transformation efforts) by name or description.

WHEN TO USE THIS TOOL:
- "What initiatives are we running?"
- "Find initiatives about [topic]"
- "Show active high-priority initiatives"
- "List all initiatives owned by [org unit]"
- Tracking strategic programs and projects

INITIATIVE STATUSES:
- proposed: Under consideration, not yet approved
- approved: Approved but not started
- active: Currently in progress
- on_hold: Temporarily paused
- completed: Successfully finished
- cancelled: Stopped/abandoned

PRIORITIES: critical, high, medium, low

EXAMPLE - Find AI initiatives:
{
  "query": "artificial intelligence",
  "status": "active",
  "priority": "high",
  "limit": 15
}

EXAMPLE - Find by owner:
{
  "query": "digital",
  "ownerOrgUnitId": "org_it_123"
}`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description: 'Search query - matches against names and descriptions',
        },
        status: {
          type: SchemaType.STRING,
          description: "Filter: 'proposed', 'approved', 'active', 'on_hold', 'completed', 'cancelled'",
        },
        priority: {
          type: SchemaType.STRING,
          description: "Filter: 'critical', 'high', 'medium', 'low'",
        },
        ownerOrgUnitId: {
          type: SchemaType.STRING,
          description: 'Filter by owning org unit ID',
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Max results (default: 10, max: 50)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'getInitiativeDetails',
    description: `Get full details about a specific strategic initiative including budget, timeline, linked entities.

WHEN TO USE THIS TOOL:
- "Tell me about the [initiative name]"
- "Show initiative details for [id]"
- After searchInitiatives to get complete information
- Reviewing initiative status, budget, progress

RETURNS: Full initiative data - name, description, owner, sponsor, status, priority, dates, budget, spend, linked strategies/prototypes/pain points.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        id: {
          type: SchemaType.STRING,
          description: 'Initiative ID. Get from searchInitiatives.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'createInitiative',
    description: `Create a new strategic initiative to track programs, projects, or transformation efforts.

WHEN TO USE THIS TOOL:
- "Create an initiative for [purpose]"
- "Add a new program called [name]"
- "Start tracking the [project name] initiative"
- Recording strategic investments and transformation programs

EXAMPLE - Full initiative:
{
  "name": "Cloud Migration Program",
  "description": "Migrate legacy systems to cloud infrastructure",
  "ownerOrgUnitId": "org_it_123",
  "sponsorName": "Jane Smith (CTO)",
  "status": "approved",
  "priority": "high",
  "budget": 2500000,
  "linkedStrategyIds": ["strat_digital_123"],
  "linkedPainPointIds": ["pp_legacy_456"],
  "tags": ["cloud", "infrastructure", "modernization"]
}

LINKING ENTITIES:
- linkedStrategyIds: Strategies this initiative supports
- linkedPrototypeIds: PoCs/prototypes under this initiative
- linkedPainPointIds: Problems this initiative solves

TIP: Use searchOrgUnits first to find the correct ownerOrgUnitId.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        name: {
          type: SchemaType.STRING,
          description: 'Initiative name',
        },
        description: {
          type: SchemaType.STRING,
          description: 'Detailed description of goals, scope, expected outcomes',
        },
        ownerOrgUnitId: {
          type: SchemaType.STRING,
          description: 'REQUIRED: ID of the owning org unit. Use searchOrgUnits to find.',
        },
        sponsorName: {
          type: SchemaType.STRING,
          description: 'Executive sponsor name',
        },
        status: {
          type: SchemaType.STRING,
          description: "Status: 'proposed', 'approved', 'active', 'on_hold', 'completed', 'cancelled'",
        },
        priority: {
          type: SchemaType.STRING,
          description: "Priority: 'critical', 'high', 'medium', 'low'",
        },
        startDate: {
          type: SchemaType.NUMBER,
          description: 'Start date (milliseconds since epoch)',
        },
        targetEndDate: {
          type: SchemaType.NUMBER,
          description: 'Target completion date (milliseconds since epoch)',
        },
        budget: {
          type: SchemaType.NUMBER,
          description: 'Budget allocation in USD',
        },
        linkedStrategyIds: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Strategy IDs this initiative supports',
        },
        linkedPrototypeIds: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Prototype IDs linked to this initiative',
        },
        linkedPainPointIds: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Pain point IDs this initiative addresses',
        },
        tags: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Categorization tags',
        },
      },
      required: ['name', 'description', 'ownerOrgUnitId'],
    },
  },
  {
    name: 'updateInitiative',
    description: `Update an existing initiative. Requires user confirmation before executing.

WHEN TO USE THIS TOOL:
- "Update initiative status to [status]"
- "Change budget for [initiative]"
- "Mark [initiative] as completed"
- Tracking progress, spend, status changes

WORKFLOW:
1. Describe the changes to the user
2. Ask for confirmation
3. Call with confirmed=true

EXAMPLE - Update status and spend:
{
  "id": "init_abc123",
  "updates": { "status": "active", "actualSpend": 500000 },
  "confirmed": true
}`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        id: {
          type: SchemaType.STRING,
          description: 'Initiative ID to update',
        },
        updates: {
          type: SchemaType.OBJECT,
          properties: {},
          description: 'Fields: status, priority, budget, actualSpend, targetEndDate, etc.',
        },
        confirmed: {
          type: SchemaType.BOOLEAN,
          description: 'Must be true. ALWAYS ask user for confirmation first.',
        },
      },
      required: ['id', 'updates'],
    },
  },
  {
    name: 'deleteInitiative',
    description: `Delete an initiative. DESTRUCTIVE - permanently removes the initiative and its linked relationships.

WARNING: This is permanent. Always confirm with user first.

CONFIRMATION REQUIRED (server-verified — you cannot self-confirm):
- First call returns an exact action-bound "CONFIRM DELETE ..." phrase and does
  not delete. Relay it verbatim and stop for the turn.
- Re-issue the same call only when the next raw user message exactly matches it.

EXAMPLE:
{
  "id": "init_abc123"
}`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        id: {
          type: SchemaType.STRING,
          description: 'Initiative ID to delete',
        },
        confirmed: {
          type: SchemaType.BOOLEAN,
          description:
            'Legacy explicit-confirm flag for automated callers only. Interactive chat must relay the exact action-bound phrase returned by the first call and retry only when the next raw user message exactly matches it.',
        },
      },
      required: ['id'],
    },
  },

  // ========== PainPoint Tools ==========
  {
    name: 'searchPainPoints',
    description: `Search for business pain points (problems, challenges, blockers) by title or description.

WHEN TO USE THIS TOOL:
- "What problems are we facing?"
- "Find pain points related to [topic]"
- "Show critical issues" or "List high-severity problems"
- "What challenges does [org unit] have?"
- Understanding business problems before proposing solutions

PAIN POINT SEVERITIES:
- critical: Urgent, business-stopping issue
- high: Major impact, needs attention soon
- medium: Moderate impact, should be addressed
- low: Minor inconvenience

STATUSES:
- identified: Newly discovered, needs validation
- validated: Confirmed as real problem
- being_addressed: Solution in progress (linked to initiative/prototype)
- resolved: Problem solved

CATEGORIES:
- operational: Process/workflow inefficiencies
- customer: Customer experience issues
- regulatory: Compliance/legal challenges
- technical: Technology/system problems
- market: Competitive/market pressures
- financial: Cost/revenue concerns
- talent: Hiring/retention/skills gaps
- other: Miscellaneous

EXAMPLE - Find critical technical issues:
{
  "query": "system",
  "severity": "critical",
  "category": "technical",
  "limit": 10
}`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description: 'Search query - matches against pain point titles and descriptions',
        },
        severity: {
          type: SchemaType.STRING,
          description: "Filter by severity: 'critical', 'high', 'medium', 'low'",
        },
        status: {
          type: SchemaType.STRING,
          description: "Filter by status: 'identified', 'validated', 'being_addressed', 'resolved'",
        },
        category: {
          type: SchemaType.STRING,
          description:
            "Filter by category: 'operational', 'customer', 'regulatory', 'technical', 'market', 'financial', 'talent', 'other'",
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
    name: 'getPainPointDetails',
    description: `Get detailed information about a specific pain point including impact, root causes, and linked solutions.

WHEN TO USE THIS TOOL:
- "Tell me about pain point [name or id]"
- "Show details for the [problem name]"
- After searchPainPoints to get full information
- Understanding impact and root causes of a problem

RETURNS: Full pain point data including:
- title, description, severity, status, category
- estimatedImpact (USD), impactDescription
- rootCauses (array)
- affectedOrgUnitIds (which teams are affected)
- linkedPrototypeIds (solutions being tested)
- linkedTechnologyIds, linkedInitiativeIds

TYPICAL WORKFLOW:
1. searchPainPoints → find relevant problems
2. getPainPointDetails → deep dive on specific issue
3. Optionally link to prototype/initiative as solution`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        id: {
          type: SchemaType.STRING,
          description: 'Pain point ID. Get from searchPainPoints results.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'createPainPoint',
    description: `Create a new business pain point to document problems that need solutions. Pain points drive innovation by capturing challenges that technologies, prototypes, or initiatives can address.

WHEN TO USE THIS TOOL:
- "Add a pain point for [problem]"
- "Document the challenge with [issue]"
- "Record this problem: [description]"
- Capturing business problems discovered during research or conversations

EXAMPLE - Full pain point:
{
  "title": "Legacy System Integration Bottleneck",
  "description": "Manual data transfer between CRM and ERP systems causes delays and errors. Sales team spends 2 hours daily on manual data entry.",
  "severity": "high",
  "category": "technical",
  "status": "validated",
  "affectedOrgUnitIds": ["org_sales_123", "org_it_456"],
  "estimatedImpact": 250000,
  "impactDescription": "Lost productivity and data quality issues",
  "rootCauses": ["No API integration", "Legacy ERP lacks modern connectors"],
  "linkedPrototypeIds": ["proto_integration_789"],
  "tags": ["integration", "automation", "crm", "erp"]
}

LINKING ENTITIES:
- affectedOrgUnitIds: Teams/departments impacted by this problem
- linkedPrototypeIds: PoCs testing solutions to this problem
- After creation, can link to initiatives via updatePainPoint

TIP: Use searchOrgUnits first to find correct affectedOrgUnitIds.
TIP: Set estimatedImpact to quantify business case for solutions.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        title: {
          type: SchemaType.STRING,
          description: "Short, descriptive title (e.g., 'Manual Report Generation Process')",
        },
        description: {
          type: SchemaType.STRING,
          description: 'Detailed description: what is the problem, who is affected, what are the symptoms',
        },
        severity: {
          type: SchemaType.STRING,
          description: "Severity: 'critical' (business-stopping), 'high' (major), 'medium' (moderate), 'low' (minor)",
        },
        category: {
          type: SchemaType.STRING,
          description:
            "Category: 'operational', 'customer', 'regulatory', 'technical', 'market', 'financial', 'talent', 'other'",
        },
        status: {
          type: SchemaType.STRING,
          description:
            "Status: 'identified' (new), 'validated' (confirmed), 'being_addressed' (solution in progress), 'resolved'",
        },
        affectedOrgUnitIds: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'IDs of org units affected. Use searchOrgUnits to find IDs.',
        },
        estimatedImpact: {
          type: SchemaType.NUMBER,
          description: 'Estimated annual financial impact in USD (helps prioritization)',
        },
        impactDescription: {
          type: SchemaType.STRING,
          description: "Human-readable impact description (e.g., '20 hours/week lost to manual work')",
        },
        rootCauses: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Root causes of the problem (supports solution design)',
        },
        linkedPrototypeIds: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Prototype IDs testing solutions to this pain point',
        },
        tags: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Categorization tags for filtering',
        },
      },
      required: ['title', 'description', 'severity', 'category'],
    },
  },
  {
    name: 'updatePainPoint',
    description: `Update an existing pain point. Requires user confirmation before executing.

WHEN TO USE THIS TOOL:
- "Update pain point status to [status]"
- "Mark [pain point] as resolved"
- "Change severity of [pain point]"
- "Link [prototype] to this pain point"
- Tracking progress on problem resolution

COMMON UPDATES:
- status: Track lifecycle (identified → validated → being_addressed → resolved)
- severity: Upgrade/downgrade based on new information
- linkedPrototypeIds: Connect solutions being tested
- linkedInitiativeIds: Connect initiatives addressing the problem
- estimatedImpact: Refine business case numbers

WORKFLOW:
1. Describe the changes to the user
2. Ask for confirmation
3. Call with confirmed=true

EXAMPLE - Mark as being addressed:
{
  "id": "pp_abc123",
  "updates": {
    "status": "being_addressed",
    "linkedInitiativeIds": ["init_xyz789"]
  },
  "confirmed": true
}

EXAMPLE - Update severity:
{
  "id": "pp_abc123",
  "updates": { "severity": "critical" },
  "confirmed": true
}`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        id: {
          type: SchemaType.STRING,
          description: 'Pain point ID to update',
        },
        updates: {
          type: SchemaType.OBJECT,
          properties: {},
          description:
            'Fields: status, severity, estimatedImpact, linkedPrototypeIds, linkedInitiativeIds, rootCauses, etc.',
        },
        confirmed: {
          type: SchemaType.BOOLEAN,
          description: 'Must be true to execute. ALWAYS ask user for confirmation first.',
        },
      },
      required: ['id', 'updates'],
    },
  },
  {
    name: 'deletePainPoint',
    description: `Delete a pain point. DESTRUCTIVE - permanently removes the pain point and breaks linked relationships.

WHEN TO USE THIS TOOL:
- "Delete pain point [name or id]" - only after explicit user request
- Cleaning up duplicate or invalid entries
- Removing test data

ALTERNATIVE TO DELETION:
Consider marking as 'resolved' instead of deleting:
- updatePainPoint with status: 'resolved' preserves history
- Deletion loses all linked context

WARNING: This is permanent. Always confirm with user first.

CONFIRMATION REQUIRED (server-verified — you cannot self-confirm):
- First call returns an exact action-bound "CONFIRM DELETE ..." phrase and does
  not delete. Relay it verbatim and stop for the turn.
- Re-issue the same call only when the next raw user message exactly matches it.

EXAMPLE:
{
  "id": "pp_abc123"
}`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        id: {
          type: SchemaType.STRING,
          description: 'Pain point ID to delete',
        },
        confirmed: {
          type: SchemaType.BOOLEAN,
          description:
            'Legacy explicit-confirm flag for automated callers only. Interactive chat must relay the exact action-bound phrase returned by the first call and retry only when the next raw user message exactly matches it.',
        },
      },
      required: ['id'],
    },
  },

  // ========== Cross-Entity Tools ==========
  {
    name: 'listInitiativesByOrgUnit',
    description: `List all initiatives owned by a specific organizational unit. Use this to see what programs/projects a team is running.

WHEN TO USE THIS TOOL:
- "What initiatives does [team/department] own?"
- "Show projects run by [org unit]"
- "List active programs for [business unit]"
- Reviewing an org unit's portfolio of work

EXAMPLE - All initiatives for IT department:
{
  "orgUnitId": "org_it_123"
}

EXAMPLE - Only active initiatives:
{
  "orgUnitId": "org_it_123",
  "status": "active"
}

WORKFLOW:
1. searchOrgUnits → find the org unit ID
2. listInitiativesByOrgUnit → see owned initiatives
3. getInitiativeDetails → deep dive on specific initiative

RETURNS: Array of initiatives with id, name, status, priority, budget.

RELATED TOOLS:
- searchInitiatives: Search across all initiatives (not limited to one org unit)
- listPainPointsByOrgUnit: See problems affecting the same org unit`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        orgUnitId: {
          type: SchemaType.STRING,
          description: 'Org unit ID. Get from searchOrgUnits or getOrgUnitDetails.',
        },
        status: {
          type: SchemaType.STRING,
          description: "Filter by status: 'proposed', 'approved', 'active', 'on_hold', 'completed', 'cancelled'",
        },
      },
      required: ['orgUnitId'],
    },
  },
  {
    name: 'listPainPointsByOrgUnit',
    description: `List all pain points affecting a specific organizational unit. Use this to understand what problems a team faces.

WHEN TO USE THIS TOOL:
- "What problems does [team/department] have?"
- "Show pain points for [org unit]"
- "List challenges affecting [business unit]"
- Understanding a team's problem landscape before proposing solutions

EXAMPLE - All pain points for a department:
{
  "orgUnitId": "org_sales_123"
}

EXAMPLE - Only critical issues:
{
  "orgUnitId": "org_sales_123",
  "severity": "critical"
}

WORKFLOW:
1. searchOrgUnits → find the org unit ID
2. listPainPointsByOrgUnit → see problems affecting them
3. getPainPointDetails → deep dive on specific problem
4. Optionally create initiative or prototype to address

RETURNS: Array of pain points with id, title, severity, status, category.

RELATED TOOLS:
- searchPainPoints: Search across all pain points (not limited to one org unit)
- listInitiativesByOrgUnit: See initiatives that might address these problems`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        orgUnitId: {
          type: SchemaType.STRING,
          description: 'Org unit ID. Get from searchOrgUnits or getOrgUnitDetails.',
        },
        severity: {
          type: SchemaType.STRING,
          description: "Filter by severity: 'critical', 'high', 'medium', 'low'",
        },
      },
      required: ['orgUnitId'],
    },
  },
];

// ============================================================================
// Tool Execution Functions
// ============================================================================

interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

function deletionToolFailure(
  error: unknown,
  fallback: string,
  mutatedEntityTypes: readonly MutationEntityType[]
): ToolResult {
  const blocker = getEntityDeletionBlockedDetails(error);
  return {
    success: false,
    error: error instanceof Error ? error.message : fallback,
    data: {
      ...(blocker ? { deletionBlocker: blocker } : {}),
      mutatedEntityTypes,
    },
  };
}

// ========== OrgUnit Execution Functions ==========

export async function executeSearchOrgUnits(args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const query = (args.query as string).toLowerCase();
    const filterType = args.type as OrgUnitType | undefined;
    const filterLevel = args.level as OrgUnitLevel | undefined;
    const limit = Math.min((args.limit as number) || 10, 50);

    const orgUnits = await adminGetOrgUnits();
    const filtered = orgUnits
      .filter((ou: OrgUnit) => {
        const matchesQuery = ou.name.toLowerCase().includes(query) || ou.description?.toLowerCase().includes(query);
        const matchesType = !filterType || ou.type === filterType;
        const matchesLevel = !filterLevel || ou.level === filterLevel;
        return matchesQuery && matchesType && matchesLevel;
      })
      .slice(0, limit);

    const results = filtered.map((ou: OrgUnit) => ({
      id: ou.id,
      name: ou.name,
      description: ou.description,
      // Navigable entity type — makes the chat entity chips deep-linkable.
      // The domain value (department/team/squad/…) moves to `orgUnitType`.
      type: 'orgUnit' as const,
      orgUnitType: ou.type,
      level: ou.level,
      headName: ou.headName,
      employeeCount: ou.employeeCount,
      location: ou.location,
    }));

    return {
      success: true,
      data: {
        query,
        count: results.length,
        results,
      },
    };
  } catch (error) {
    log.error('Error searching org units', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to search org units',
    };
  }
}

export async function executeGetOrgUnitDetails(args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const id = args.id as string;
    const orgUnit = await adminGetOrgUnitById(id);

    if (!orgUnit) {
      return {
        success: false,
        error: `Org unit with ID '${id}' not found`,
      };
    }

    return {
      success: true,
      data: { ...orgUnit, _type: 'orgUnit' },
    };
  } catch (error) {
    log.error('Error getting org unit details', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get org unit details',
    };
  }
}

export async function executeCreateOrgUnit(args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const orgUnit = await adminCreateOrgUnit({
      name: args.name as string,
      description: (args.description as string) || '',
      type: (args.type as OrgUnitType) || 'team',
      level: (args.level as OrgUnitLevel) || 'L3',
      parentId: args.parentId as string | undefined,
      headName: args.headName as string | undefined,
      employeeCount: args.employeeCount as number | undefined,
      location: args.location as string | undefined,
      tags: (args.tags as string[]) || [],
    });

    log.info('Created org unit', { name: orgUnit.name, id: orgUnit.id });

    emitDataRefresh('orgUnits', 'ai-assistant');

    return {
      success: true,
      data: { id: orgUnit.id, name: orgUnit.name },
    };
  } catch (error) {
    if (error instanceof DuplicateEntityError) {
      return {
        success: true,
        data: {
          alreadyExists: true,
          existingId: error.existingId,
          message: `Already exists (ID: ${error.existingId}). Use update to modify.`,
        },
      };
    }
    log.error('Error creating org unit', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create org unit',
    };
  }
}

export async function executeUpdateOrgUnit(args: Record<string, unknown>): Promise<ToolResult> {
  const id = args.id as string;
  const updates = args.updates as Record<string, unknown>;
  const confirmed = args.confirmed as boolean;

  if (!confirmed) {
    return {
      success: false,
      error: 'Update requires user confirmation. Please describe the changes and ask the user to confirm.',
      data: { pendingUpdate: { id, updates } },
    };
  }

  try {
    await adminUpdateOrgUnit(id, updates);
    log.info('Updated org unit', { id });

    emitDataRefresh('orgUnits', 'ai-assistant');

    return {
      success: true,
      data: { id, updates, message: 'Org unit updated successfully' },
    };
  } catch (error) {
    log.error('Error updating org unit', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update org unit',
    };
  }
}

export async function executeDeleteOrgUnit(
  args: Record<string, unknown>,
  context?: DeleteGateContext
): Promise<ToolResult> {
  const id = normalizeDestructiveIdentifier(args.id) ?? '';
  if (!id) {
    return { success: false, error: 'A non-empty org unit ID is required for deletion.' };
  }

  const gate = confirmDestructiveAction({
    fingerprint: destructiveActionFingerprint('deleteOrgUnit', id),
    summary: `delete the org unit with ID "${id}"`,
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
    await adminDeleteOrgUnit(id);
    log.info('Deleted org unit', { id });

    emitDataRefresh('orgUnits', 'ai-assistant');

    return {
      success: true,
      data: {
        message: `Successfully deleted org unit with ID "${id}"`,
        mutatedEntityTypes: DELETION_MUTATED_ENTITY_TYPES.orgUnit,
      },
    };
  } catch (error) {
    log.error('Error deleting org unit', error instanceof Error ? error : undefined);
    return deletionToolFailure(error, 'Failed to delete org unit', DELETION_MUTATED_ENTITY_TYPES.orgUnit);
  }
}

// ========== Initiative Execution Functions ==========

export async function executeSearchInitiatives(args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const query = (args.query as string).toLowerCase();
    const filterStatus = args.status as InitiativeStatus | undefined;
    const filterPriority = args.priority as InitiativePriority | undefined;
    const filterOrgUnit = args.ownerOrgUnitId as string | undefined;
    const limit = Math.min((args.limit as number) || 10, 50);

    const initiatives = await adminGetInitiatives();
    const filtered = initiatives
      .filter((init: Initiative) => {
        const matchesQuery = init.name.toLowerCase().includes(query) || init.description?.toLowerCase().includes(query);
        const matchesStatus = !filterStatus || init.status === filterStatus;
        const matchesPriority = !filterPriority || init.priority === filterPriority;
        const matchesOrgUnit = !filterOrgUnit || init.ownerOrgUnitId === filterOrgUnit;
        return matchesQuery && matchesStatus && matchesPriority && matchesOrgUnit;
      })
      .slice(0, limit);

    const results = filtered.map((init: Initiative) => ({
      id: init.id,
      name: init.name,
      description: init.description,
      status: init.status,
      priority: init.priority,
      ownerOrgUnitName: init.ownerOrgUnitName,
      budget: init.budget,
      actualSpend: init.actualSpend,
      startDate: init.startDate,
      targetEndDate: init.targetEndDate,
    }));

    return {
      success: true,
      data: {
        query,
        count: results.length,
        results,
      },
    };
  } catch (error) {
    log.error('Error searching initiatives', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to search initiatives',
    };
  }
}

export async function executeGetInitiativeDetails(args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const id = args.id as string;
    const initiative = await adminGetInitiativeById(id);

    if (!initiative) {
      return {
        success: false,
        error: `Initiative with ID '${id}' not found`,
      };
    }

    return {
      success: true,
      data: { ...initiative, _type: 'initiative' },
    };
  } catch (error) {
    log.error('Error getting initiative details', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get initiative details',
    };
  }
}

export async function executeCreateInitiative(args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const initiative = await adminCreateInitiative({
      name: args.name as string,
      description: (args.description as string) || '',
      ownerOrgUnitId: args.ownerOrgUnitId as string,
      ownerOrgUnitName: args.ownerOrgUnitName as string | undefined,
      sponsorName: args.sponsorName as string | undefined,
      status: (args.status as InitiativeStatus) || 'proposed',
      priority: (args.priority as InitiativePriority) || 'medium',
      startDate: args.startDate as number | undefined,
      targetEndDate: args.targetEndDate as number | undefined,
      budget: args.budget as number | undefined,
      linkedStrategyIds: (args.linkedStrategyIds as string[]) || [],
      linkedPrototypeIds: (args.linkedPrototypeIds as string[]) || [],
      linkedPainPointIds: (args.linkedPainPointIds as string[]) || [],
      tags: (args.tags as string[]) || [],
    });

    log.info('Created initiative', { name: initiative.name, id: initiative.id });

    emitDataRefresh('initiatives', 'ai-assistant');

    return {
      success: true,
      data: { id: initiative.id, name: initiative.name },
    };
  } catch (error) {
    if (error instanceof DuplicateEntityError) {
      return {
        success: true,
        data: {
          alreadyExists: true,
          existingId: error.existingId,
          message: `Already exists (ID: ${error.existingId}). Use update to modify.`,
        },
      };
    }
    log.error('Error creating initiative', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create initiative',
    };
  }
}

export async function executeUpdateInitiative(args: Record<string, unknown>): Promise<ToolResult> {
  const id = args.id as string;
  const updates = args.updates as Record<string, unknown>;
  const confirmed = args.confirmed as boolean;

  if (!confirmed) {
    return {
      success: false,
      error: 'Update requires user confirmation. Please describe the changes and ask the user to confirm.',
      data: { pendingUpdate: { id, updates } },
    };
  }

  try {
    await adminUpdateInitiative(id, updates);
    log.info('Updated initiative', { id });

    emitDataRefresh('initiatives', 'ai-assistant');

    return {
      success: true,
      data: { id, updates, message: 'Initiative updated successfully' },
    };
  } catch (error) {
    log.error('Error updating initiative', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update initiative',
    };
  }
}

export async function executeDeleteInitiative(
  args: Record<string, unknown>,
  context?: DeleteGateContext
): Promise<ToolResult> {
  const id = normalizeDestructiveIdentifier(args.id) ?? '';
  if (!id) {
    return { success: false, error: 'A non-empty initiative ID is required for deletion.' };
  }

  const gate = confirmDestructiveAction({
    fingerprint: destructiveActionFingerprint('deleteInitiative', id),
    summary: `delete the initiative with ID "${id}"`,
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
    await adminDeleteInitiative(id);
    log.info('Deleted initiative', { id });

    emitDataRefresh('initiatives', 'ai-assistant');

    return {
      success: true,
      data: {
        message: `Successfully deleted initiative with ID "${id}"`,
        mutatedEntityTypes: DELETION_MUTATED_ENTITY_TYPES.initiative,
      },
    };
  } catch (error) {
    log.error('Error deleting initiative', error instanceof Error ? error : undefined);
    return deletionToolFailure(error, 'Failed to delete initiative', DELETION_MUTATED_ENTITY_TYPES.initiative);
  }
}

// ========== PainPoint Execution Functions ==========

export async function executeSearchPainPoints(args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const query = (args.query as string).toLowerCase();
    const filterSeverity = args.severity as PainPointSeverity | undefined;
    const filterStatus = args.status as PainPointStatus | undefined;
    const filterCategory = args.category as PainPointCategory | undefined;
    const limit = Math.min((args.limit as number) || 10, 50);

    const painPoints = await adminGetPainPoints();
    const filtered = painPoints
      .filter((pp: PainPoint) => {
        const matchesQuery = pp.title.toLowerCase().includes(query) || pp.description?.toLowerCase().includes(query);
        const matchesSeverity = !filterSeverity || pp.severity === filterSeverity;
        const matchesStatus = !filterStatus || pp.status === filterStatus;
        const matchesCategory = !filterCategory || pp.category === filterCategory;
        return matchesQuery && matchesSeverity && matchesStatus && matchesCategory;
      })
      .slice(0, limit);

    const results = filtered.map((pp: PainPoint) => ({
      id: pp.id,
      title: pp.title,
      description: pp.description,
      severity: pp.severity,
      status: pp.status,
      category: pp.category,
      estimatedImpact: pp.estimatedImpact,
      affectedOrgUnitIds: pp.affectedOrgUnitIds,
    }));

    return {
      success: true,
      data: {
        query,
        count: results.length,
        results,
      },
    };
  } catch (error) {
    log.error('Error searching pain points', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to search pain points',
    };
  }
}

export async function executeGetPainPointDetails(args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const id = args.id as string;
    const painPoint = await adminGetPainPointById(id);

    if (!painPoint) {
      return {
        success: false,
        error: `Pain point with ID '${id}' not found`,
      };
    }

    return {
      success: true,
      data: { ...painPoint, _type: 'painPoint' },
    };
  } catch (error) {
    log.error('Error getting pain point details', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get pain point details',
    };
  }
}

export async function executeCreatePainPoint(args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const painPoint = await adminCreatePainPoint({
      title: args.title as string,
      description: (args.description as string) || '',
      severity: (args.severity as PainPointSeverity) || 'medium',
      category: (args.category as PainPointCategory) || 'other',
      status: (args.status as PainPointStatus) || 'identified',
      affectedOrgUnitIds: (args.affectedOrgUnitIds as string[]) || [],
      estimatedImpact: args.estimatedImpact as number | undefined,
      impactDescription: args.impactDescription as string | undefined,
      rootCauses: (args.rootCauses as string[]) || [],
      linkedPrototypeIds: (args.linkedPrototypeIds as string[]) || [],
      linkedTechnologyIds: [],
      linkedInitiativeIds: [],
      tags: (args.tags as string[]) || [],
    });

    log.info('Created pain point', { title: painPoint.title, id: painPoint.id });

    emitDataRefresh('painPoints', 'ai-assistant');

    return {
      success: true,
      data: { id: painPoint.id, title: painPoint.title },
    };
  } catch (error) {
    if (error instanceof DuplicateEntityError) {
      return {
        success: true,
        data: {
          alreadyExists: true,
          existingId: error.existingId,
          message: `Already exists (ID: ${error.existingId}). Use update to modify.`,
        },
      };
    }
    log.error('Error creating pain point', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create pain point',
    };
  }
}

export async function executeUpdatePainPoint(args: Record<string, unknown>): Promise<ToolResult> {
  const id = args.id as string;
  const updates = args.updates as Record<string, unknown>;
  const confirmed = args.confirmed as boolean;

  if (!confirmed) {
    return {
      success: false,
      error: 'Update requires user confirmation. Please describe the changes and ask the user to confirm.',
      data: { pendingUpdate: { id, updates } },
    };
  }

  try {
    await adminUpdatePainPoint(id, updates);
    log.info('Updated pain point', { id });

    emitDataRefresh('painPoints', 'ai-assistant');

    return {
      success: true,
      data: { id, updates, message: 'Pain point updated successfully' },
    };
  } catch (error) {
    log.error('Error updating pain point', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update pain point',
    };
  }
}

export async function executeDeletePainPoint(
  args: Record<string, unknown>,
  context?: DeleteGateContext
): Promise<ToolResult> {
  const id = normalizeDestructiveIdentifier(args.id) ?? '';
  if (!id) {
    return { success: false, error: 'A non-empty pain point ID is required for deletion.' };
  }

  const gate = confirmDestructiveAction({
    fingerprint: destructiveActionFingerprint('deletePainPoint', id),
    summary: `delete the pain point with ID "${id}"`,
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
    await adminDeletePainPoint(id);
    log.info('Deleted pain point', { id });

    emitDataRefresh('painPoints', 'ai-assistant');

    return {
      success: true,
      data: {
        message: `Successfully deleted pain point with ID "${id}"`,
        mutatedEntityTypes: DELETION_MUTATED_ENTITY_TYPES.painPoint,
      },
    };
  } catch (error) {
    log.error('Error deleting pain point', error instanceof Error ? error : undefined);
    return deletionToolFailure(error, 'Failed to delete pain point', DELETION_MUTATED_ENTITY_TYPES.painPoint);
  }
}

// ========== Cross-Entity Execution Functions ==========

export async function executeListInitiativesByOrgUnit(args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const orgUnitId = args.orgUnitId as string;
    const filterStatus = args.status as InitiativeStatus | undefined;

    const initiatives = await adminGetInitiatives();
    const filtered = initiatives.filter((init: Initiative) => {
      const matchesOrgUnit = init.ownerOrgUnitId === orgUnitId;
      const matchesStatus = !filterStatus || init.status === filterStatus;
      return matchesOrgUnit && matchesStatus;
    });

    return {
      success: true,
      data: {
        orgUnitId,
        count: filtered.length,
        initiatives: filtered.map((init: Initiative) => ({
          id: init.id,
          name: init.name,
          status: init.status,
          priority: init.priority,
          budget: init.budget,
        })),
      },
    };
  } catch (error) {
    log.error('Error listing initiatives by org unit', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list initiatives',
    };
  }
}

export async function executeListPainPointsByOrgUnit(args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const orgUnitId = args.orgUnitId as string;
    const filterSeverity = args.severity as PainPointSeverity | undefined;

    const painPoints = await adminGetPainPoints();
    const filtered = painPoints.filter((pp: PainPoint) => {
      const matchesOrgUnit = pp.affectedOrgUnitIds.includes(orgUnitId);
      const matchesSeverity = !filterSeverity || pp.severity === filterSeverity;
      return matchesOrgUnit && matchesSeverity;
    });

    return {
      success: true,
      data: {
        orgUnitId,
        count: filtered.length,
        painPoints: filtered.map((pp: PainPoint) => ({
          id: pp.id,
          title: pp.title,
          severity: pp.severity,
          status: pp.status,
          category: pp.category,
        })),
      },
    };
  } catch (error) {
    log.error('Error listing pain points by org unit', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list pain points',
    };
  }
}
