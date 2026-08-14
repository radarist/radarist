/**
 * @file ai/tools/deep-research-tools.ts
 * @description AI tool for creating standalone research documents via Gemini Deep Research.
 *
 * Semantically distinct from existing research tools:
 * - webSearch → returns inline text summary (seconds)
 * - researchCompanyByName/researchTechnology → enriches a specific ENTITY (seconds)
 * - createResearchDocument → creates a STANDALONE DOCUMENT in the library (1-5 minutes)
 *
 * @author Radarist Team
 * @created 2026-02-27
 */

import type { FunctionDeclaration } from '@google/generative-ai';
import { SchemaType } from '@google/generative-ai';
import { dispatchDeepResearchDocument } from '@/lib/deep-research-document-admin';
import { createLogger } from '@/lib/logger';

const log = createLogger('ai/deep-research-tools');

// ============================================================================
// Tool Declarations
// ============================================================================

export const DEEP_RESEARCH_TOOLS: FunctionDeclaration[] = [
  {
    name: 'createResearchDocument',
    description: `Generate a comprehensive research document on ANY topic and save it to the Document Library as markdown.

DIFFERENT FROM OTHER TOOLS:
- webSearch → returns inline text summary (seconds)
- researchCompanyByName/researchTechnology → enriches a specific ENTITY (seconds)
- createResearchDocument → creates a STANDALONE DOCUMENT in the library (1-5 minutes)
- startMission with agent="creator" → produces a saved HTML report in Reports after the user approves the brief and confirms spend

WHEN TO USE THIS TOOL:
- "Do a deep research on [broad topic]"
- "Research [topic] and save it to the library"
- "I need a comprehensive analysis saved as a document"
- User explicitly asks for a "research document" or "deep research"
- User wants a referenceable library document, not a styled report

WHEN NOT TO USE:
- User asks for a saved HTML report → present a structured brief, get approval, then use the confirmed Creator mission path
- User asks about a specific company → use researchCompanyByName
- User asks about a specific technology → use researchTechnology
- User wants a quick answer → use webSearch
- User wants to enrich an existing entity → use enrichment tools

WHAT HAPPENS:
1. A background research job starts (Gemini Deep Research agent)
2. The agent autonomously searches the web for 1-5 minutes
3. Result is saved as a markdown document in the Document Library
4. Document is chunked for search and citations
5. User can find it in Library → Documents (NOT in Reports)

RETURNS: Confirmation with document ID. The research runs in the background.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description:
            'Research topic or question (e.g., "Post-Quantum Cryptography adoption in financial services", "AI regulation landscape in Europe 2026")',
        },
        tags: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Optional tags for the document (e.g., ["quantum", "cryptography", "security"])',
        },
      },
      required: ['query'],
    },
  },
];

// ============================================================================
// Tool Executors
// ============================================================================

export interface CreateResearchDocumentResult {
  documentId: string;
  message: string;
}

/**
 * Create a deep research document.
 *
 * Creates a placeholder document (status: 'processing') and fires an Inngest
 * event to start the Gemini Deep Research background job.
 *
 * @param args - Tool arguments (query, optional tags)
 * @param userId - The authenticated user's ID
 * @returns Confirmation with document ID
 */
export async function executeCreateResearchDocument(
  args: { query: string; tags?: string[] },
  userId: string
): Promise<CreateResearchDocumentResult> {
  if (!userId) {
    throw new Error('createResearchDocument requires an authenticated user');
  }

  // Validate BEFORE creating the placeholder document and dispatching the
  // Inngest deep-research job — an empty query must cost zero tokens.
  const query = args.query?.trim();
  if (!query) {
    throw new Error('createResearchDocument requires a non-empty query');
  }

  // AI-021: one supported generated-document contract — truthful `processing`
  // state, verified job dispatch. A rejected dispatch marks the document
  // failed and THROWS; the tool dispatcher surfaces it as an honest tool
  // error instead of a fabricated "I've started..." success.
  const document = await dispatchDeepResearchDocument({
    query,
    userId,
    tags: args.tags,
  });

  log.info('Deep research document created from AI Assistant', {
    documentId: document.id,
    query: query.substring(0, 100),
  });

  return {
    documentId: document.id,
    message: `I've started a deep research task on "${query.substring(0, 80)}${query.length > 80 ? '...' : ''}". The Gemini Deep Research agent will autonomously browse the web for 1-5 minutes and create a comprehensive document. You'll find it in Library → Documents once it's done.`,
  };
}
