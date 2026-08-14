/**
 * @file ai/tools/company-tools.ts
 * @description Company-specific AI tools for enhanced company management.
 *
 * Provides capabilities for:
 * - Comprehensive AI research on companies
 * - AI-powered relation discovery
 * - Adding notes to companies
 * - Updating company research sections
 *
 * @author Radarist Team
 * @created 2026-01-19
 */

import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';
import { adminGetCompanyById, adminUpdateCompany, adminGetCompanies } from '@/lib/companies-admin';
import { adminCreateNote } from '@/lib/company-notes-admin';
import { adminGetTechnologies } from '@/lib/technology-admin';
import { adminGetUseCases } from '@/lib/use-cases-admin';
import { emitDataRefresh } from '@/lib/events/data-refresh';
import { researchCompanyComprehensive, refreshCompanyResearchSection } from '@/ai/flows/research-company-comprehensive';
import { discoverRelations, type RelationSuggestion } from '@/ai/flows/discover-relations';
import type { NoteType, EntityType, CompanyResearch } from '@/lib/types';
import { createLogger } from '@/lib/logger';

const log = createLogger('ai/company-tools');

// ============================================================================
// Tool Definitions for Company Management
// ============================================================================

export const COMPANY_TOOLS: FunctionDeclaration[] = [
  {
    name: 'researchCompany',
    description: `Perform comprehensive AI-powered research on a company using real-time web search. Saves an unverified AI draft; source review required. Canonical company profile fields are not auto-populated.

WHEN TO USE THIS TOOL:
- "Research [company name]" or "Get intelligence on [company]"
- "What do we know about [company]?" - if research is missing or outdated
- "Draft research for [company]" or "Research missing company details"
- "Update our information on [company]"
- After creating a new company with createCompany to prepare a reviewable draft
- When company data appears stale (check lastResearched timestamp)

RESEARCH SECTIONS (can request specific ones or all):
- executiveSummary: Overview, key highlights, strategic recommendations
- productsAndSolutions: Product portfolio, deployment model, integrations
- financialsAndTraction: Funding rounds, revenue estimates, SWOT analysis
- teamAndLeadership: Founders, executives, team size, key hires
- innovationIndicators: Patents, product velocity, open source contributions
- partnershipsAndEcosystem: Strategic, technology, and channel partners
- riskAssessment: Vendor risk score, financial health, red flags

EXAMPLE:
{
  "companyId": "abc123",
  "sections": ["financialsAndTraction", "teamAndLeadership"],
  "saveToCompany": true
}

TIP: For newly created companies, call this without sections param to run full research. For periodic updates, specify only sections that need refreshing.

RELATED TOOLS: createCompany → researchCompany → discoverCompanyRelations (typical workflow)`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        companyId: {
          type: SchemaType.STRING,
          description:
            'The ID of the company to research. Get this from searchEntities, listEntities, or createCompany results.',
        },
        sections: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description:
            "Optional: Specific sections to research. If not provided, researches ALL sections. Values: 'executiveSummary', 'productsAndSolutions', 'financialsAndTraction', 'teamAndLeadership', 'innovationIndicators', 'partnershipsAndEcosystem', 'riskAssessment'",
        },
        saveToCompany: {
          type: SchemaType.BOOLEAN,
          description:
            'Whether to save the research results to the company record. Defaults to true. Set false to preview without saving.',
        },
      },
      required: ['companyId'],
    },
  },
  {
    name: 'discoverCompanyRelations',
    description: `AI-powered discovery of relationships between a company and other entities in the knowledge graph. Analyzes company attributes to suggest connections.

WHEN TO USE THIS TOOL:
- "Find connections for [company]" or "What relates to [company]?"
- "Who are [company]'s competitors?" (use targetTypes: ['company'])
- "What technologies does [company] use?" (use targetTypes: ['technology'])
- "What use cases does [company] solve?" (use targetTypes: ['useCase'])
- After researching a company to build out its relationship network
- When user wants to understand a company's ecosystem

RELATIONSHIP TYPES DISCOVERED:
- Company → Company: competitors, partners, vendors, acquirers, investors
- Company → Technology: uses, provides, integrates_with
- Company → UseCase: solves, enables, specializes_in

EXAMPLE - Find all relations:
{
  "companyId": "abc123",
  "maxSuggestions": 15
}

EXAMPLE - Find competitors only:
{
  "companyId": "abc123",
  "targetTypes": ["company"],
  "maxSuggestions": 10
}

RETURNS: Array of suggestions, each with:
- targetEntity: The related entity (id, name, type)
- relationType: Suggested relationship type
- confidence: 0-1 score (higher = more confident)
- reasoning: AI explanation for why this connection exists

NOTE: This tool suggests relations but does NOT create them. In interactive Assistant research, record each evidence-backed finding with proposeVerifiedRelation so it appears in relation triage. Use createRelation only when the user's current message explicitly directs one exact pair; never turn autonomous findings into human-curated edges.

TYPICAL WORKFLOW: researchCompany → discoverCompanyRelations → proposeVerifiedRelation (→ human review in Assistant or relation triage)`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        companyId: {
          type: SchemaType.STRING,
          description: 'The ID of the company to find relations for. Get from searchEntities or listEntities.',
        },
        targetTypes: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description:
            "Optional: Entity types to search for connections. Values: 'company' (competitors/partners), 'technology' (tech stack), 'useCase' (problems solved). If omitted, searches all types.",
        },
        maxSuggestions: {
          type: SchemaType.NUMBER,
          description:
            'Maximum suggestions to return (default: 10). Use higher values (15-20) for comprehensive mapping, lower (5) for quick overview.',
        },
      },
      required: ['companyId'],
    },
  },
  {
    name: 'addCompanyNote',
    description: `Add a note to a company's activity timeline. Notes track interactions, observations, and key information over time.

WHEN TO USE THIS TOOL:
- "Add a note to [company] about..." or "Log that we met with [company]"
- "Record that [company] showed us a demo"
- "Note that [company] sent pricing info"
- "Mark [company] as evaluated" or "Save our assessment of [company]"
- User shares meeting notes, email summaries, or observations about a company

NOTE TYPES (choose the most appropriate):
- Meeting: Meeting notes, call summaries, in-person discussions
- Email: Email correspondence, written communications
- Demo: Product demos, presentations, proof-of-concepts
- Evaluation: Assessments, reviews, scoring, comparisons
- General: Observations, news, updates, miscellaneous info

EXAMPLE - Log a meeting:
{
  "companyId": "abc123",
  "content": "## Meeting with CEO\\n\\n- Discussed Q2 roadmap\\n- Interested in partnership\\n- Follow up next week",
  "type": "Meeting"
}

EXAMPLE - Record evaluation:
{
  "companyId": "abc123",
  "content": "**Evaluation Score: 8/10**\\n\\nStrong product, good support. Pricing is competitive. Recommend for trial.",
  "type": "Evaluation"
}

FORMATTING: Content supports full Markdown - use headers, lists, bold, links for structured notes.

TIP: Notes appear in the company's timeline chronologically. Use clear, descriptive content so future readers understand the context.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        companyId: {
          type: SchemaType.STRING,
          description: 'The ID of the company to add the note to. Get from searchEntities or listEntities.',
        },
        content: {
          type: SchemaType.STRING,
          description:
            'The note content. Supports Markdown formatting: **bold**, *italic*, ## headers, - lists, [links](url).',
        },
        type: {
          type: SchemaType.STRING,
          description:
            "Note type - must be one of: 'Meeting', 'Email', 'Demo', 'Evaluation', 'General'. Choose based on the nature of the interaction.",
        },
      },
      required: ['companyId', 'content', 'type'],
    },
  },
  {
    name: 'updateCompanyResearch',
    description: `Refresh specific sections of a company's unverified AI research draft. Lighter-weight alternative to full researchCompany; source review remains required.

WHEN TO USE THIS TOOL:
- "Update the financials for [company]" or "Refresh [company]'s funding info"
- "Get latest leadership info for [company]"
- "Check for new risk factors on [company]"
- "Update the executive summary for [company]"
- When you know specific sections are stale but don't need full re-research

USE researchCompany INSTEAD when:
- Company has no research data yet (use full research)
- You need productsAndSolutions or partnershipsAndEcosystem sections
- You want to refresh everything at once

AVAILABLE SECTIONS:
- executiveSummary: Overview, highlights, recommendations
- financialsAndTraction: Funding, revenue, SWOT (use for funding updates)
- teamAndLeadership: Executives, founders, team size (use after leadership changes)
- innovationIndicators: Patents, R&D, open source activity
- riskAssessment: Vendor risk score, red flags, financial health

EXAMPLE - Update funding info after news:
{
  "companyId": "abc123",
  "sections": ["financialsAndTraction", "executiveSummary"]
}

EXAMPLE - Check for leadership changes:
{
  "companyId": "abc123",
  "sections": ["teamAndLeadership"]
}

NOTE: Updated sections are MERGED with existing data. Other sections remain unchanged.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        companyId: {
          type: SchemaType.STRING,
          description: 'The ID of the company to update. Get from searchEntities or listEntities.',
        },
        sections: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description:
            "Sections to refresh - REQUIRED, must specify at least one. Values: 'executiveSummary', 'financialsAndTraction', 'teamAndLeadership', 'innovationIndicators', 'riskAssessment'.",
        },
      },
      required: ['companyId', 'sections'],
    },
  },
];

// ============================================================================
// Tool Execution Functions
// ============================================================================

/**
 * Research company result type
 */
export interface ResearchCompanyResult {
  success: boolean;
  data?: {
    companyId: string;
    companyName: string;
    research: CompanyResearch;
    savedToCompany: boolean;
    researchStatus: 'draft';
    sourceReviewRequired: true;
    citationsVerified: false;
  };
  error?: string;
}

/**
 * Perform comprehensive AI research on a company
 */
export async function executeResearchCompany(args: Record<string, unknown>): Promise<ResearchCompanyResult> {
  try {
    const companyId = args.companyId as string;
    const sections = args.sections as string[] | undefined;
    const saveToCompany = args.saveToCompany !== false; // Default true

    // Get company details
    const company = await adminGetCompanyById(companyId);
    if (!company) {
      return {
        success: false,
        error: `Company not found with ID: ${companyId}`,
      };
    }

    log.info('Researching company', { companyName: company.name, companyId });

    let research: CompanyResearch;

    // If specific sections requested, use the section refresh
    if (sections && sections.length > 0) {
      const validSections = sections.filter((s) =>
        [
          'executiveSummary',
          'financialsAndTraction',
          'teamAndLeadership',
          'innovationIndicators',
          'riskAssessment',
        ].includes(s)
      ) as Array<
        'executiveSummary' | 'financialsAndTraction' | 'teamAndLeadership' | 'innovationIndicators' | 'riskAssessment'
      >;

      const partialResearch = await refreshCompanyResearchSection(
        {
          name: company.name,
          website: company.website,
          description: company.description,
          existingResearch: company.research,
        },
        validSections
      );

      // Merge with existing research
      research = {
        ...(company.research || {}),
        ...partialResearch,
        lastResearched: Date.now(),
      } as CompanyResearch;
    } else {
      // Full comprehensive research
      research = await researchCompanyComprehensive({
        name: company.name,
        website: company.website,
        description: company.description,
      });
    }

    // Save to company if requested
    if (saveToCompany) {
      await adminUpdateCompany(companyId, { research });
      log.info('Saved research to company', { companyName: company.name });
      emitDataRefresh('companies', 'ai-assistant');
    }

    return {
      success: true,
      data: {
        companyId,
        companyName: company.name,
        research,
        savedToCompany: saveToCompany,
        researchStatus: 'draft',
        sourceReviewRequired: true,
        citationsVerified: false,
      },
    };
  } catch (error) {
    log.error('Failed to research company', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to research company',
    };
  }
}

/**
 * Discover company relations result type
 */
export interface DiscoverCompanyRelationsResult {
  success: boolean;
  data?: {
    companyId: string;
    companyName: string;
    suggestions: RelationSuggestion[];
    candidateCount: number;
  };
  error?: string;
}

/**
 * Discover potential relations for a company using AI
 */
export async function executeDiscoverCompanyRelations(
  args: Record<string, unknown>
): Promise<DiscoverCompanyRelationsResult> {
  try {
    const companyId = args.companyId as string;
    const targetTypes = args.targetTypes as EntityType[] | undefined;
    const maxSuggestions = (args.maxSuggestions as number) || 10;

    // Get company details
    const company = await adminGetCompanyById(companyId);
    if (!company) {
      return {
        success: false,
        error: `Company not found with ID: ${companyId}`,
      };
    }

    log.info('Discovering relations', { companyName: company.name, companyId });

    // Build candidate entities based on target types
    const candidates: Array<{
      id: string;
      name: string;
      type: EntityType;
      description?: string;
    }> = [];

    // Determine which entity types to fetch
    const typesToFetch =
      targetTypes && targetTypes.length > 0 ? targetTypes : (['company', 'technology', 'useCase'] as EntityType[]);

    // Fetch candidates in parallel
    const fetchPromises: Promise<void>[] = [];

    if (typesToFetch.includes('company')) {
      fetchPromises.push(
        adminGetCompanies().then((companies) => {
          companies
            .filter((c) => c.id !== companyId) // Exclude the source company
            .forEach((c) => {
              candidates.push({
                id: c.id,
                name: c.name,
                type: 'company',
                description: c.description,
              });
            });
        })
      );
    }

    if (typesToFetch.includes('technology')) {
      fetchPromises.push(
        adminGetTechnologies({ limit: 100 }).then((techs) => {
          techs.forEach((t) => {
            candidates.push({
              id: t.id,
              name: t.name,
              type: 'technology',
              description: t.description,
            });
          });
        })
      );
    }

    if (typesToFetch.includes('useCase')) {
      fetchPromises.push(
        adminGetUseCases().then((useCases) => {
          useCases.forEach((u) => {
            candidates.push({
              id: u.id,
              name: u.title,
              type: 'useCase',
              description: u.description,
            });
          });
        })
      );
    }

    await Promise.all(fetchPromises);

    log.debug('Found candidate entities', { count: candidates.length });

    if (candidates.length === 0) {
      return {
        success: true,
        data: {
          companyId,
          companyName: company.name,
          suggestions: [],
          candidateCount: 0,
        },
      };
    }

    // Run AI discovery
    const result = await discoverRelations({
      entityType: 'company',
      entityId: companyId,
      entityName: company.name,
      entityDescription: company.description,
      candidateEntities: candidates,
      targetTypes: typesToFetch,
      maxSuggestions,
    });

    log.info('Found relation suggestions', { count: result.suggestions.length, companyName: company.name });

    return {
      success: true,
      data: {
        companyId,
        companyName: company.name,
        suggestions: result.suggestions,
        candidateCount: candidates.length,
      },
    };
  } catch (error) {
    log.error('Failed to discover company relations', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to discover company relations',
    };
  }
}

/**
 * Add company note result type
 */
export interface AddCompanyNoteResult {
  success: boolean;
  data?: {
    noteId: string;
    companyId: string;
    type: NoteType;
    createdAt: number;
  };
  error?: string;
}

/**
 * Add a note to a company
 */
export async function executeAddCompanyNote(args: Record<string, unknown>): Promise<AddCompanyNoteResult> {
  try {
    const companyId = args.companyId as string;
    const content = args.content as string;
    const type = args.type as NoteType;

    // Validate note type
    const validTypes: NoteType[] = ['Meeting', 'Email', 'Demo', 'Evaluation', 'General'];
    if (!validTypes.includes(type)) {
      return {
        success: false,
        error: `Invalid note type: ${type}. Valid types are: ${validTypes.join(', ')}`,
      };
    }

    // Verify company exists
    const company = await adminGetCompanyById(companyId);
    if (!company) {
      return {
        success: false,
        error: `Company not found with ID: ${companyId}`,
      };
    }

    // Create the note
    const note = await adminCreateNote(companyId, {
      content,
      type,
    });

    log.info('Added note to company', { type, companyName: company.name, noteId: note.id });

    // Emit refresh event
    emitDataRefresh('companies', 'ai-assistant');

    return {
      success: true,
      data: {
        noteId: note.id,
        companyId,
        type: note.type,
        createdAt: note.createdAt,
      },
    };
  } catch (error) {
    log.error('Failed to add company note', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to add company note',
    };
  }
}

/**
 * Update company research result type
 */
export interface UpdateCompanyResearchResult {
  success: boolean;
  data?: {
    companyId: string;
    companyName: string;
    updatedSections: string[];
    lastResearched: number;
    researchStatus: 'draft';
    sourceReviewRequired: true;
    citationsVerified: false;
  };
  error?: string;
}

/**
 * Update specific sections of company research
 */
export async function executeUpdateCompanyResearch(
  args: Record<string, unknown>
): Promise<UpdateCompanyResearchResult> {
  try {
    const companyId = args.companyId as string;
    const sections = args.sections as string[];

    if (!sections || sections.length === 0) {
      return {
        success: false,
        error: 'At least one section must be specified for update',
      };
    }

    // Validate sections
    const validSections = [
      'executiveSummary',
      'financialsAndTraction',
      'teamAndLeadership',
      'innovationIndicators',
      'riskAssessment',
    ];
    const invalidSections = sections.filter((s) => !validSections.includes(s));
    if (invalidSections.length > 0) {
      return {
        success: false,
        error: `Invalid sections: ${invalidSections.join(', ')}. Valid sections are: ${validSections.join(', ')}`,
      };
    }

    // Get company details
    const company = await adminGetCompanyById(companyId);
    if (!company) {
      return {
        success: false,
        error: `Company not found with ID: ${companyId}`,
      };
    }

    log.info('Updating research sections', { companyName: company.name, sections });

    // Refresh the specified sections
    const partialResearch = await refreshCompanyResearchSection(
      {
        name: company.name,
        website: company.website,
        description: company.description,
        existingResearch: company.research,
      },
      sections as Array<
        'executiveSummary' | 'financialsAndTraction' | 'teamAndLeadership' | 'innovationIndicators' | 'riskAssessment'
      >
    );

    // Merge with existing research
    const updatedResearch: CompanyResearch = {
      ...(company.research || {}),
      ...partialResearch,
      lastResearched: Date.now(),
    } as CompanyResearch;

    // Save to company
    await adminUpdateCompany(companyId, { research: updatedResearch });

    log.info('Updated research sections', { companyName: company.name });

    // Emit refresh event
    emitDataRefresh('companies', 'ai-assistant');

    return {
      success: true,
      data: {
        companyId,
        companyName: company.name,
        updatedSections: sections,
        lastResearched: updatedResearch.lastResearched,
        researchStatus: 'draft',
        sourceReviewRequired: true,
        citationsVerified: false,
      },
    };
  } catch (error) {
    log.error('Failed to update company research', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update company research',
    };
  }
}
