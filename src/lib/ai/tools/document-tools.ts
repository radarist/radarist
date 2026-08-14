/**
 * @file ai/tools/document-tools.ts
 * @description Document and Evidence Layer tools for AI Assistant
 *
 * Provides capabilities for:
 * - Searching document chunks (semantic search)
 * - Listing and filtering documents
 * - Getting document details with chunks
 * - Capturing evidence (linking chunks to entities)
 *
 * @phase Phase 2: Evidence Layer
 * @author Radarist Team
 * @created 2026-01-09
 */

import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';
import { adminGetDocuments, adminGetDocumentById, adminCreateDocument } from '@/lib/document-admin';
import { adminUploadDocument } from '@/lib/document-storage-admin';
import { processDocumentFromContent } from '@/lib/document-processing-service';
import { adminGetChunksForDocument, adminGetChunkById, adminSearchChunksSimple } from '@/lib/document-chunk-admin';
import { adminCreateRelation, buildEntitySnapshot } from '@/lib/relations-admin';
import { adminFindExistingLink, adminCreateEntityDocumentLink } from '@/lib/entity-document-link-admin';
import type { EntityDocumentLinkGraphHandoffOutcome } from '@/lib/entity-document-link-handoff';
import { toEntityDocumentLinkType } from '@/lib/entity-document-link-cascade';
import { authorizeExplicitRelationWrite, type RelationWriteAuthorityContext } from '@/lib/ai/relation-write-authority';
import { normalizeEntityReferenceName, searchEntityCandidatesByName } from './entity-creation';
import { inngest } from '@/lib/inngest/client';
import type {
  CreateDocumentInput,
  Document,
  DocumentChunk,
  DocumentStatus,
  DocumentType,
  EntityType,
} from '@/lib/types';
import { createLogger } from '@/lib/logger';

const log = createLogger('ai/document-tools');

// ============================================================================
// Tool Definitions for Document & Evidence Layer
// ============================================================================

export const DOCUMENT_TOOLS: FunctionDeclaration[] = [
  {
    name: 'searchDocuments',
    description: `Search through uploaded document content to find relevant information, evidence, or citations. Searches the Evidence Layer - PDFs, reports, transcripts, and other documents uploaded to the platform.

WHEN TO USE THIS TOOL:
- "Find documents about [topic]" or "Search for [keyword] in documents"
- "What do our documents say about [topic]?"
- "Find evidence for [claim]" or "Find citations about [topic]"
- "Is there any research on [topic] in our files?"
- User wants to cite or reference internal documents
- Building evidence trails for entities

SEARCH SCOPE:
- Searches document CONTENT (chunks), not just titles
- Includes PDFs, Word docs, transcripts, web captures, markdown files
- Returns matched chunks with context (document title, page number, section)

EXAMPLE - Find AI-related content:
{
  "query": "machine learning implementation challenges",
  "limit": 15
}

EXAMPLE - Search within specific document:
{
  "query": "pricing model",
  "documentId": "doc_abc123"
}

RETURNS: Array of chunks with content snippet, document title, page number, section name.

WORKFLOW:
1. searchDocuments → find relevant chunks
2. getChunkContent → get full text of a specific chunk
3. captureEvidence → link chunk to entity as citation

TIP: Use specific phrases or questions for better results. After finding relevant chunks, use captureEvidence to create citations.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description:
            'Search query - can be keywords, phrases, or questions. Searches document content (not just titles).',
        },
        documentId: {
          type: SchemaType.STRING,
          description: 'Optional: Limit search to a specific document. Use when user wants to search within one file.',
        },
        limit: {
          type: SchemaType.NUMBER,
          description:
            'Maximum results (default: 10, max: 50). Use higher for broad searches, lower for focused queries.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'listDocuments',
    description: `List documents in the Evidence Layer with optional filtering. Use this to see what documents are available before searching or citing them.

WHEN TO USE THIS TOOL:
- "What documents do we have?" or "Show me all uploaded files"
- "List all PDFs" or "Show meeting transcripts"
- "What documents are tagged with [tag]?"
- "Which documents are still processing?"
- Before searching - to understand what's in the Evidence Layer

DOCUMENT TYPES:
- pdf: PDF files (reports, whitepapers, etc.)
- docx: Word documents
- url: Captured web pages
- transcript: Meeting transcripts, recordings
- markdown: Markdown documents
- text: Plain text files

DOCUMENT STATUSES:
- uploaded: File uploaded, not yet processed
- processing: Being chunked and indexed
- processed: Ready for search and citation
- failed: Processing failed (may need re-upload)

EXAMPLE - List all documents:
{
  "limit": 30
}

EXAMPLE - Find PDFs tagged with 'competitor':
{
  "type": "pdf",
  "tags": ["competitor"],
  "limit": 20
}

EXAMPLE - Search document titles:
{
  "search": "quarterly report",
  "status": "processed"
}

RETURNS: Document list with id, title, type, status, chunk count, tags.

NOTE: This lists document metadata (titles). To search document CONTENT, use searchDocuments instead.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        type: {
          type: SchemaType.STRING,
          description: "Filter by document type: 'pdf', 'docx', 'url', 'transcript', 'markdown', 'text'",
        },
        status: {
          type: SchemaType.STRING,
          description: "Filter by processing status: 'uploaded' (pending), 'processing', 'processed' (ready), 'failed'",
        },
        search: {
          type: SchemaType.STRING,
          description:
            'Search in document TITLES and descriptions (not content - use searchDocuments for content search)',
        },
        tags: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Filter by tags - returns documents with ANY matching tag',
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Maximum documents to return (default: 20). Increase for larger lists.',
        },
      },
    },
  },
  {
    name: 'getDocumentDetails',
    description: `Get full details about a specific document including metadata and content chunks. Use this to review a document's contents before citing or searching within it.

WHEN TO USE THIS TOOL:
- "Show me document [id]" or "What's in this document?"
- "Tell me about the [document name]"
- "Show the contents of document [id]"
- After listDocuments to get details on a specific document
- Before captureEvidence to understand document structure

RETURNS:
- Document metadata: title, type, status, description, tags, file size
- Content chunks: text content, page numbers, section names
- Processing info: chunk count, created date

EXAMPLE - Get document with content:
{
  "documentId": "doc_abc123",
  "includeChunks": true,
  "chunkLimit": 20
}

EXAMPLE - Get metadata only (faster):
{
  "documentId": "doc_abc123",
  "includeChunks": false
}

WORKFLOW:
1. listDocuments → find document by title/type
2. getDocumentDetails → see structure and content
3. searchDocuments with documentId → find specific info
4. captureEvidence → cite relevant chunks

TIP: Use chunkLimit=0 for quick metadata lookup. Use higher chunkLimit (20-30) to review document structure.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        documentId: {
          type: SchemaType.STRING,
          description: 'ID of the document. Get from listDocuments or searchDocuments results.',
        },
        includeChunks: {
          type: SchemaType.BOOLEAN,
          description: 'Include content chunks in response (default: true). Set false for faster metadata-only lookup.',
        },
        chunkLimit: {
          type: SchemaType.NUMBER,
          description:
            'Max chunks to return (default: 10). Use 0 for metadata only, higher values (20-50) to review full document.',
        },
      },
      required: ['documentId'],
    },
  },
  {
    name: 'captureEvidence',
    description: `Link a document or specific chunk as evidence/citation for an entity. Creates a traceable connection between source material and entities (companies, technologies, use cases, etc.).

WHEN TO USE THIS TOOL:
- "Link this document to [entity]" or "Cite this for [company]"
- "Use this as evidence for [technology]"
- "This supports our claim about [entity]"
- "This document mentions [company]"
- After finding relevant content via searchDocuments
- Building evidence trails for entities

EVIDENCE TYPES:
- supports: Document supports/validates claims about the entity (default)
- contradicts: Document challenges or contradicts entity claims
- mentions: Document references the entity (neutral)
- cites: Entity is a source/citation from the document

EXAMPLE - Link chunk to company:
{
  "documentId": "doc_abc123",
  "chunkId": "chunk_xyz789",
  "targetEntityId": "comp_123",
  "targetEntityType": "company",
  "evidenceType": "supports",
  "notes": "Mentions their market share growth in Q3"
}

EXAMPLE - Link whole document to technology:
{
  "documentId": "doc_abc123",
  "targetEntityId": "tech_456",
  "targetEntityType": "technology",
  "evidenceType": "mentions",
  "notes": "Technical whitepaper comparing implementations"
}

WORKFLOW:
1. searchDocuments → find relevant chunks
2. getChunkContent → verify the content
3. captureEvidence → create the citation link

ENTITY TYPES: 'company', 'technology', 'useCase', 'prototype', 'strategy', 'signal'

TIP: Include chunkId for precise citations (specific paragraphs/pages). Omit chunkId to link entire document as general reference.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        documentId: {
          type: SchemaType.STRING,
          description: 'ID of the document containing the evidence. Get from searchDocuments or listDocuments.',
        },
        chunkId: {
          type: SchemaType.STRING,
          description:
            'Optional: Specific chunk ID for precise citation (e.g., specific paragraph/page). Get from searchDocuments. If omitted, links entire document.',
        },
        targetEntityId: {
          type: SchemaType.STRING,
          description: 'ID of the entity to link evidence to. Get from searchEntities or listEntities.',
        },
        targetEntityType: {
          type: SchemaType.STRING,
          description: "Type of target entity: 'company', 'technology', 'useCase', 'prototype', 'strategy', 'signal'",
        },
        notes: {
          type: SchemaType.STRING,
          description: 'Optional: Explain why this evidence is relevant. Helps future users understand the connection.',
        },
        evidenceType: {
          type: SchemaType.STRING,
          description:
            "Relationship type: 'supports' (validates), 'contradicts' (challenges), 'mentions' (references), 'cites' (source). Default: 'supports'.",
        },
      },
      required: ['documentId', 'targetEntityId', 'targetEntityType'],
    },
  },
  {
    name: 'getChunkContent',
    description: `Get the full text content of a specific document chunk. Use this after searching to read the complete chunk before citing or quoting.

WHEN TO USE THIS TOOL:
- "Show me the full text of this chunk"
- "Read chunk [id]"
- After searchDocuments to see complete content (search shows truncated snippets)
- Before captureEvidence to verify the content is relevant
- When user wants to see the exact text they're citing

RETURNS:
- Full chunk content (not truncated)
- Document title and ID (parent document)
- Page number and section (if available)
- Chunk index (position in document)
- Token count (useful for context limits)

EXAMPLE:
{
  "chunkId": "chunk_abc123"
}

WORKFLOW:
1. searchDocuments → find chunks with snippets
2. getChunkContent → read full text of promising chunks
3. captureEvidence → link the chunk to an entity

TIP: searchDocuments returns truncated snippets (500 chars). Use this tool when you need the full text for accurate quoting or to verify relevance before citation.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        chunkId: {
          type: SchemaType.STRING,
          description: 'ID of the chunk to retrieve. Get from searchDocuments or getDocumentDetails results.',
        },
      },
      required: ['chunkId'],
    },
  },
  {
    name: 'linkDocumentToEntity',
    description: `Create an explicit knowledge link between an uploaded Document and an entity — the same entityDocumentLink the Library UI creates, including graph sync and cache refresh.

WHEN TO USE THIS TOOL:
- ONLY when the authenticated user's current message explicitly names the document and the entity and instructs the Assistant to link them (e.g. 'Link "Q3 Architecture Review" to Acme Corp').
- Address both sides by exact id or exact name. If a name matches several records the tool refuses and lists the candidates — ask the user to pick one; never guess.
- For document/entity connections you discovered or inferred while reading, do NOT use this tool — use proposeVerifiedRelation so the candidate goes through human review.

EFFECT: writes the entityDocumentLink through the canonical admin link service (createdBy = the signed-in user, aiSuggested false), bumps the document's linked-entity count, and queues the Neo4j projection. Re-running the same instruction converges on the existing link instead of duplicating it.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        documentId: {
          type: SchemaType.STRING,
          description: 'Exact document id. Provide either documentId or documentTitle, not both.',
        },
        documentTitle: {
          type: SchemaType.STRING,
          description: 'Exact document title (case-insensitive). The tool refuses on zero or multiple matches.',
        },
        entityType: {
          type: SchemaType.STRING,
          description:
            "One of 'technology' | 'company' | 'useCase' | 'strategy' | 'prototype' | 'signal' | 'orgUnit' | 'initiative' | 'painPoint'.",
        },
        entityId: {
          type: SchemaType.STRING,
          description: 'Exact entity id. Provide either entityId or entityName, not both.',
        },
        entityName: {
          type: SchemaType.STRING,
          description: 'Exact entity name/title (case-insensitive). The tool refuses on zero or multiple matches.',
        },
        relationshipType: {
          type: SchemaType.STRING,
          description:
            "Link category: 'documentation' (default) | 'pitch_deck' | 'technical_spec' | 'case_study' | 'research_paper' | 'competitive_intel' | 'contract' | 'evidence' | 'other'.",
        },
        relevance: {
          type: SchemaType.STRING,
          description: "'high' | 'medium' (default) | 'low'.",
        },
        note: {
          type: SchemaType.STRING,
          description: 'Optional note stored on the link.',
        },
      },
      required: ['entityType'],
    },
  },
];

// ============================================================================
// Document WRITE tool (mission-scoped)
// ----------------------------------------------------------------------------
// Kept as a SEPARATE export from the read-only DOCUMENT_TOOLS so it is placed
// deliberately (onto the reports/creator MCP surface) rather than swept into
// every consumer of DOCUMENT_TOOLS.
// ============================================================================

export const DOCUMENT_WRITE_TOOLS: FunctionDeclaration[] = [
  {
    name: 'draftDocument',
    description: `Persist a markdown Document to the library (/library/documents). Mission-scoped: only valid inside a running mission (the missionId is bound server-side). Provide a title and the FULL markdown body; the document is uploaded, chunked for search/citations, and linked to the mission. Returns the created document id; the document appears in the library at /library/documents.

WHEN TO USE:
- You researched a topic (e.g. via searchPatents) and want to save the written analysis as a durable Document the user can open in the library.
- Prefer this over draftReport/publishReport when the user asked for a "document" (markdown in /library/documents) rather than a shareable HTML report.

DO NOT fabricate: only write findings supported by the tools you actually called; if research degraded (e.g. a rate-limit), say so in the body rather than inventing content.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        title: {
          type: SchemaType.STRING,
          description: 'Human-readable document title, e.g. "Patent Landscape: Vector Databases".',
        },
        markdownBody: {
          type: SchemaType.STRING,
          description: 'The full document body as markdown. Stored verbatim and chunked for search.',
        },
        summary: {
          type: SchemaType.STRING,
          description: 'Optional one-paragraph summary/description of the document.',
        },
        tags: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Optional tags for categorization (e.g. ["patents", "vector-databases"]).',
        },
      },
      required: ['title', 'markdownBody'],
    },
  },
];

// ============================================================================
// Result Types
// ============================================================================

interface SearchResult {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  content: string;
  page?: number;
  section?: string;
  relevanceScore?: number;
}

interface DocumentListItem {
  id: string;
  title: string;
  type: DocumentType;
  status: DocumentStatus;
  chunkCount?: number;
  description?: string;
  tags?: string[];
  createdAt?: number;
  fileSize?: number;
}

interface DocumentDetails {
  document: Document;
  chunks: Array<{
    id: string;
    content: string;
    page?: number;
    section?: string;
    chunkIndex: number;
  }>;
  totalChunks: number;
}

interface EvidenceCapture {
  relationId: string;
  documentId: string;
  documentTitle: string;
  chunkId?: string;
  targetEntityId: string;
  targetEntityType: string;
  evidenceType: string;
}

// ============================================================================
// Tool Execution Functions
// ============================================================================

/**
 * Search through document chunks for relevant content.
 */
export async function executeSearchDocuments(args: Record<string, unknown>): Promise<{
  success: boolean;
  data?: { results: SearchResult[]; total: number };
  error?: string;
}> {
  try {
    const query = args.query as string;
    const documentId = args.documentId as string | undefined;
    const limit = Math.min((args.limit as number) || 10, 50);

    log.debug('Searching documents', { query, limit });

    // Use simple search (for now - semantic search will come with Neo4j)
    const chunks = await adminSearchChunksSimple(query, documentId, limit);

    // Get document details for each chunk
    const documentCache = new Map<string, Document | null>();
    const results: SearchResult[] = [];

    for (const chunk of chunks) {
      // Cache document lookups
      if (!documentCache.has(chunk.documentId)) {
        documentCache.set(chunk.documentId, await adminGetDocumentById(chunk.documentId));
      }
      const doc = documentCache.get(chunk.documentId);

      results.push({
        chunkId: chunk.id,
        documentId: chunk.documentId,
        documentTitle: doc?.title || 'Unknown Document',
        content: chunk.content.length > 500 ? chunk.content.slice(0, 500) + '...' : chunk.content,
        page: chunk.metadata?.page,
        section: chunk.metadata?.section,
      });
    }

    return {
      success: true,
      data: { results, total: results.length },
    };
  } catch (error) {
    log.error('Search failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Search failed',
    };
  }
}

/**
 * List documents with optional filters.
 */
export async function executeListDocuments(args: Record<string, unknown>): Promise<{
  success: boolean;
  data?: { documents: DocumentListItem[]; total: number };
  error?: string;
}> {
  try {
    const type = args.type as DocumentType | undefined;
    const status = args.status as DocumentStatus | undefined;
    const search = args.search as string | undefined;
    const tags = args.tags as string[] | undefined;
    const limit = (args.limit as number) || 20;

    log.debug('Listing documents', { type, status, limit });

    const documents = await adminGetDocuments({
      type,
      status,
      search,
      tags,
      limit,
    });

    const items: DocumentListItem[] = documents.map((doc) => ({
      id: doc.id,
      title: doc.title,
      type: doc.type,
      status: doc.status,
      chunkCount: doc.chunkCount,
      description: doc.description,
      tags: doc.tags,
      createdAt: doc.createdAt,
      fileSize: doc.fileSize,
    }));

    return {
      success: true,
      data: { documents: items, total: items.length },
    };
  } catch (error) {
    log.error('List failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list documents',
    };
  }
}

/**
 * Get detailed information about a document including chunks.
 */
export async function executeGetDocumentDetails(args: Record<string, unknown>): Promise<{
  success: boolean;
  data?: DocumentDetails;
  error?: string;
}> {
  try {
    const documentId = args.documentId as string;
    const includeChunks = args.includeChunks !== false;
    const chunkLimit = (args.chunkLimit as number) ?? 10;

    log.debug('Getting document details', { documentId });

    const document = await adminGetDocumentById(documentId);
    if (!document) {
      return {
        success: false,
        error: `Document not found: ${documentId}`,
      };
    }

    let chunks: DocumentChunk[] = [];
    if (includeChunks && chunkLimit > 0) {
      chunks = await adminGetChunksForDocument(documentId);
      chunks = chunks.slice(0, chunkLimit);
    }

    return {
      success: true,
      data: {
        document,
        chunks: chunks.map((c) => ({
          id: c.id,
          content: c.content.length > 1000 ? c.content.slice(0, 1000) + '...' : c.content,
          page: c.metadata?.page,
          section: c.metadata?.section,
          chunkIndex: c.chunkIndex,
        })),
        totalChunks: document.chunkCount || 0,
      },
    };
  } catch (error) {
    log.error('Get details failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get document details',
    };
  }
}

/**
 * Capture evidence by linking a document/chunk to an entity.
 */
export async function executeCaptureEvidence(args: Record<string, unknown>): Promise<{
  success: boolean;
  data?: EvidenceCapture;
  error?: string;
}> {
  try {
    const documentId = args.documentId as string;
    const chunkId = args.chunkId as string | undefined;
    const targetEntityId = args.targetEntityId as string;
    const targetEntityType = args.targetEntityType as string;
    const notes = args.notes as string | undefined;
    const evidenceType = (args.evidenceType as string) || 'supports';

    log.info('Capturing evidence', { documentId });

    // Get document to verify it exists and get title
    const document = await adminGetDocumentById(documentId);
    if (!document) {
      return {
        success: false,
        error: `Document not found: ${documentId}`,
      };
    }

    // If chunkId provided, verify it exists
    if (chunkId) {
      const chunk = await adminGetChunkById(chunkId);
      if (!chunk) {
        return {
          success: false,
          error: `Chunk not found: ${chunkId}`,
        };
      }
      if (chunk.documentId !== documentId) {
        return {
          success: false,
          error: `Chunk ${chunkId} does not belong to document ${documentId}`,
        };
      }
    }

    // Map evidence type to relation type
    const relationTypeMap: Record<string, string> = {
      supports: 'supports',
      contradicts: 'contradicts',
      mentions: 'references',
      cites: 'cites',
    };
    const relationType = relationTypeMap[evidenceType] || 'supports';

    // Create the relation linking document to entity
    const now = Date.now();

    // Build notes with chunk reference if applicable
    const relationNotes = notes
      ? `${notes}${chunkId ? ` [Chunk: ${chunkId}]` : ''}`
      : `Evidence captured via AI Assistant (${evidenceType})${chunkId ? `. Chunk: ${chunkId}` : ''}`;

    const relation = await adminCreateRelation({
      relationType: relationType as import('@/lib/types').RelationType,
      sourceSnapshot: {
        id: documentId,
        type: 'document' as import('@/lib/types').EntityType,
        name: document.title,
        snapshotAt: now,
      },
      targetSnapshot: {
        id: targetEntityId,
        type: targetEntityType as import('@/lib/types').EntityType,
        name: '', // Will be populated by the service
        snapshotAt: now,
      },
      notes: relationNotes,
      aiSuggested: true,
      agentName: 'assistant',
      confidence: 85, // High confidence since it's explicit capture
    });

    return {
      success: true,
      data: {
        relationId: relation.id,
        documentId,
        documentTitle: document.title,
        chunkId,
        targetEntityId,
        targetEntityType,
        evidenceType,
      },
    };
  } catch (error) {
    log.error('Capture evidence failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to capture evidence',
    };
  }
}

/**
 * Get the full content of a specific chunk.
 */
export async function executeGetChunkContent(args: Record<string, unknown>): Promise<{
  success: boolean;
  data?: {
    chunkId: string;
    documentId: string;
    documentTitle: string;
    content: string;
    page?: number;
    section?: string;
    chunkIndex: number;
    tokenCount?: number;
  };
  error?: string;
}> {
  try {
    const chunkId = args.chunkId as string;

    log.debug('Getting chunk content', { chunkId });

    const chunk = await adminGetChunkById(chunkId);
    if (!chunk) {
      return {
        success: false,
        error: `Chunk not found: ${chunkId}`,
      };
    }

    // Get parent document for context
    const document = await adminGetDocumentById(chunk.documentId);

    return {
      success: true,
      data: {
        chunkId: chunk.id,
        documentId: chunk.documentId,
        documentTitle: document?.title || 'Unknown Document',
        content: chunk.content,
        page: chunk.metadata?.page,
        section: chunk.metadata?.section,
        chunkIndex: chunk.chunkIndex,
        tokenCount: chunk.tokenCount,
      },
    };
  } catch (error) {
    log.error('Get chunk failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get chunk',
    };
  }
}

// ============================================================================
// draftDocument executor (mission-scoped write)
// ============================================================================

/** Server-side context bound by the MCP route for a mission-bound tool call. */
export interface ExecuteDraftDocumentContext {
  /** Bound from the `x-mission-id` header; absent outside a mission. */
  missionId?: string;
  /** Effective userId resolved by the MCP route (the mission owner). */
  userId?: string;
}

/** Filesystem-safe slug for the Storage object name (the storage path adds its own timestamp + random suffix). */
function slugifyForFile(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-/, '')
    .replace(/-$/, '')
    .slice(0, 60);
  return slug.length > 0 ? slug : 'document';
}

/**
 * Persist a markdown Document (mission-scoped). Mirrors the deep-research write
 * path: upload the body to Firebase Storage, create the Document record
 * (`type: 'markdown'`, real `storageUrl` + `uploadedBy`, `sourceMissionId`
 * provenance), chunk it for search/citations, then fire the best-effort Neo4j
 * sync event. Never throws to the agent — returns a typed error instead. The
 * markdown body lives in Storage; `Document` has no `content` field.
 */
export async function executeDraftDocument(
  args: { title: string; markdownBody: string; summary?: string; tags?: string[] },
  context: ExecuteDraftDocumentContext
): Promise<{ success: boolean; documentId?: string; url?: string; error?: string }> {
  if (!context.missionId || !context.userId) {
    log.warn('draftDocument called without mission context', {
      hasMissionId: Boolean(context.missionId),
      hasUserId: Boolean(context.userId),
    });
    return {
      success: false,
      error: 'missionId not bound — draftDocument is only valid within a mission orchestrator turn',
    };
  }

  const title = args.title?.trim();
  const markdownBody = args.markdownBody ?? '';
  if (!title) {
    return { success: false, error: 'title is required' };
  }
  if (markdownBody.trim().length < 10) {
    return { success: false, error: 'markdownBody is empty or too short to save' };
  }

  try {
    // 1. Upload the markdown body to Firebase Storage. adminUploadDocument
    //    returns a discriminated union and does NOT throw on failure.
    const fileName = `${slugifyForFile(title)}.md`;
    const upload = await adminUploadDocument(
      Buffer.from(markdownBody, 'utf-8'),
      fileName,
      'text/markdown',
      context.userId
    );
    if (!upload.success) {
      log.warn('draftDocument storage upload failed', { title, error: upload.error });
      return { success: false, error: `Storage upload failed: ${upload.error}` };
    }

    // 2. Create the Document record with the real storageUrl + mission provenance.
    const input: CreateDocumentInput = {
      title,
      type: 'markdown',
      storageUrl: upload.storageUrl,
      uploadedBy: context.userId,
      mimeType: 'text/markdown',
      fileSize: Buffer.byteLength(markdownBody, 'utf-8'),
      sourceMissionId: context.missionId,
      ...(args.summary ? { description: args.summary } : {}),
      ...(args.tags && args.tags.length > 0 ? { tags: args.tags } : {}),
    };
    const doc = await adminCreateDocument(input);

    // 3. Chunk for search/citations. Non-fatal — the document exists and is
    //    viewable even if chunking fails (mirrors the deep-research job).
    const processed = await processDocumentFromContent(doc.id, markdownBody);
    if (!processed.success) {
      log.warn('draftDocument chunking failed (non-fatal)', { documentId: doc.id, error: processed.error });
    }

    // 4. Best-effort Neo4j sync (never fatal to the write).
    try {
      await inngest.send({ name: 'app/document.sync.requested', data: { documentId: doc.id, operation: 'create' } });
    } catch (syncError) {
      log.warn('draftDocument graph-sync dispatch failed (non-fatal)', {
        documentId: doc.id,
        error: syncError instanceof Error ? syncError.message : String(syncError),
      });
    }

    log.info('draftDocument created', { documentId: doc.id, missionId: context.missionId, title });
    // The library documents page opens docs via an in-page preview dialog
    // (component state), not a per-id route — so link to the reachable list
    // page rather than a /library/documents/<id> URL that would 404.
    return { success: true, documentId: doc.id, url: '/library/documents' };
  } catch (error) {
    log.error('draftDocument failed', error instanceof Error ? error : new Error(String(error)), { title });
    return { success: false, error: error instanceof Error ? error.message : 'Failed to create document' };
  }
}

// ============================================================================
// linkDocumentToEntity (AI-023)
// ============================================================================

const LINKABLE_ENTITY_TYPES = [
  'technology',
  'company',
  'useCase',
  'strategy',
  'prototype',
  'signal',
  'orgUnit',
  'initiative',
  'painPoint',
] as const;
type LinkableEntityType = (typeof LINKABLE_ENTITY_TYPES)[number];

const LINK_RELATIONSHIP_TYPES = [
  'documentation',
  'pitch_deck',
  'technical_spec',
  'case_study',
  'research_paper',
  'competitive_intel',
  'contract',
  'evidence',
  'other',
] as const;

const LINK_RELEVANCE_LEVELS = ['high', 'medium', 'low'] as const;

interface LinkDocumentToEntityData {
  created: boolean;
  linkId?: string;
  documentId?: string;
  documentTitle?: string;
  entityId?: string;
  entityName?: string;
  /**
   * GRAPH-069 — the honest state of the knowledge-graph projection for a link
   * this call created. Absent when nothing was created. `acknowledged` is the
   * only value that means the graph write is on its way; the others mean the
   * Firestore link is committed and reconciliation still owes it an edge.
   */
  graphSync?: EntityDocumentLinkGraphHandoffOutcome['status'];
  message: string;
  matchingDocuments?: Array<{ id: string; title: string }>;
  matchingEntities?: Array<{ id: string; name: string }>;
}

/**
 * Execute `linkDocumentToEntity` — the explicit, human-directed Document→entity
 * knowledge link. Governance mirrors createRelation: current-user authority via
 * authorizeExplicitRelationWrite (the raw current turn must name both endpoints
 * and instruct the link; machine principals and discovery phrasing refuse), and
 * inferred candidates stay in the proposeVerifiedRelation review lane. Writes go
 * through the canonical admin link service so the linked-entity count bump and
 * the Neo4j handoff ride the same path as the Library UI.
 */
export async function executeLinkDocumentToEntity(
  args: Record<string, unknown>,
  context?: RelationWriteAuthorityContext & { userId?: string }
): Promise<{ success: boolean; data?: LinkDocumentToEntityData; error?: string }> {
  try {
    if (!context?.userId) {
      return { success: false, error: 'linkDocumentToEntity requires an authenticated user.' };
    }

    const entityTypeArg = args.entityType as string;
    if (!(LINKABLE_ENTITY_TYPES as readonly string[]).includes(entityTypeArg)) {
      return {
        success: false,
        error: `entityType must be one of: ${LINKABLE_ENTITY_TYPES.join(', ')}. Got: ${String(entityTypeArg)}`,
      };
    }
    const entityType = entityTypeArg as LinkableEntityType;

    const relationshipType = (args.relationshipType as string | undefined) ?? 'documentation';
    if (!(LINK_RELATIONSHIP_TYPES as readonly string[]).includes(relationshipType)) {
      return { success: false, error: `relationshipType must be one of: ${LINK_RELATIONSHIP_TYPES.join(', ')}.` };
    }
    const relevance = (args.relevance as string | undefined) ?? 'medium';
    if (!(LINK_RELEVANCE_LEVELS as readonly string[]).includes(relevance)) {
      return { success: false, error: `relevance must be one of: ${LINK_RELEVANCE_LEVELS.join(', ')}.` };
    }

    const documentIdArg = typeof args.documentId === 'string' ? args.documentId.trim() : '';
    const documentTitleArg = typeof args.documentTitle === 'string' ? args.documentTitle.trim() : '';
    if (documentIdArg && documentTitleArg) {
      return { success: false, error: "Provide either 'documentId' or 'documentTitle' for the document, not both." };
    }
    if (!documentIdArg && !documentTitleArg) {
      return { success: false, error: "Either 'documentId' or 'documentTitle' is required." };
    }

    const entityIdArg = typeof args.entityId === 'string' ? args.entityId.trim() : '';
    const entityNameArg = typeof args.entityName === 'string' ? args.entityName.trim() : '';
    if (entityIdArg && entityNameArg) {
      return { success: false, error: "Provide either 'entityId' or 'entityName' for the entity, not both." };
    }
    if (!entityIdArg && !entityNameArg) {
      return { success: false, error: "Either 'entityId' or 'entityName' is required." };
    }

    // Resolve the document endpoint (exact id, or one unique normalized exact title).
    let documentId: string;
    let documentTitle: string;
    if (documentIdArg) {
      const document = await adminGetDocumentById(documentIdArg);
      if (!document) {
        return { success: false, error: `No document found with id "${documentIdArg}".` };
      }
      documentId = document.id;
      documentTitle = document.title;
    } else {
      const normalizedTitle = normalizeEntityReferenceName(documentTitleArg);
      const documents = await adminGetDocuments();
      const titleMatches = documents.filter((document) =>
        normalizeEntityReferenceName(document.title).includes(normalizedTitle)
      );
      const exactMatches = titleMatches.filter(
        (document) => normalizeEntityReferenceName(document.title) === normalizedTitle
      );
      const partialMatches = titleMatches.filter(
        (document) => normalizeEntityReferenceName(document.title) !== normalizedTitle
      );
      const candidates = [...exactMatches, ...partialMatches].slice(0, 5);

      if (exactMatches.length > 1) {
        const duplicateCandidates = exactMatches.slice(0, 5);
        return {
          success: false,
          error: `Multiple documents have the exact normalized title "${documentTitleArg}". Please specify the document id: ${duplicateCandidates
            .map((document) => `"${document.title}" (id: ${document.id})`)
            .join(', ')}`,
          data: {
            created: false,
            message: `Found multiple documents with the exact title`,
            matchingDocuments: duplicateCandidates.map((document) => ({ id: document.id, title: document.title })),
          },
        };
      }

      const chosen = exactMatches[0];
      if (!chosen) {
        if (candidates.length === 0) {
          return { success: false, error: `No document found matching "${documentTitleArg}".` };
        }
        if (candidates.length === 1) {
          return {
            success: false,
            error: `No exact document title found for "${documentTitleArg}". Specify the exact title or document id.`,
            data: {
              created: false,
              message: `Found one partial document-title match`,
              matchingDocuments: candidates.map((d) => ({ id: d.id, title: d.title })),
            },
          };
        }
        return {
          success: false,
          error: `Multiple documents found matching "${documentTitleArg}". Please specify which one: ${candidates
            .map((d) => `"${d.title}" (id: ${d.id})`)
            .join(', ')}`,
          data: {
            created: false,
            message: `Found ${candidates.length} matching documents`,
            matchingDocuments: candidates.map((d) => ({ id: d.id, title: d.title })),
          },
        };
      }
      documentId = chosen.id;
      documentTitle = chosen.title;
    }

    // Resolve the entity endpoint (exact id, or one unique normalized exact name).
    let entityId: string;
    let entityName: string;
    if (entityIdArg) {
      const snapshot = await buildEntitySnapshot(entityIdArg, entityType as EntityType);
      entityId = snapshot.id;
      entityName = snapshot.name;
    } else {
      const candidates = await searchEntityCandidatesByName(entityType, entityNameArg, {
        prioritizeNormalizedExact: true,
      });
      if (candidates === null) {
        return { success: false, error: `entityType must be one of: ${LINKABLE_ENTITY_TYPES.join(', ')}.` };
      }
      const normalizedName = normalizeEntityReferenceName(entityNameArg);
      const exactMatches = candidates.filter(
        (candidate) => normalizeEntityReferenceName(candidate.name) === normalizedName
      );
      if (exactMatches.length > 1) {
        return {
          success: false,
          error: `Multiple ${entityType} records have the exact normalized name "${entityNameArg}". Please specify the entity id: ${exactMatches
            .map((candidate) => `"${candidate.name}" (id: ${candidate.id})`)
            .join(', ')}`,
          data: {
            created: false,
            message: `Found multiple ${entityType} records with the exact name`,
            matchingEntities: exactMatches,
          },
        };
      }

      const chosen = exactMatches[0];
      if (!chosen) {
        if (candidates.length === 0) {
          return { success: false, error: `No ${entityType} found with name "${entityNameArg}".` };
        }
        if (candidates.length === 1) {
          return {
            success: false,
            error: `No exact ${entityType} name found for "${entityNameArg}". Specify the exact name or entity id.`,
            data: {
              created: false,
              message: `Found one partial ${entityType} name match`,
              matchingEntities: candidates,
            },
          };
        }
        return {
          success: false,
          error: `Multiple ${entityType} entities found matching "${entityNameArg}". Please specify which one: ${candidates
            .map((c) => `"${c.name}" (id: ${c.id})`)
            .join(', ')}`,
          data: {
            created: false,
            message: `Found ${candidates.length} matching ${entityType} entities`,
            matchingEntities: candidates,
          },
        };
      }
      entityId = chosen.id;
      entityName = chosen.name;
    }

    // Current-user authority: the raw current turn must name both endpoints and
    // explicitly instruct the link — same machinery as createRelation. Machine
    // principals and discovery phrasing refuse here.
    const authorization = authorizeExplicitRelationWrite(
      context,
      { id: documentId, name: documentTitle },
      { id: entityId, name: entityName }
    );
    if (!authorization.authorized) {
      return {
        success: false,
        data: {
          created: false,
          message:
            'Nothing was linked. Explicit document linking requires the current authenticated user message to name the document and the entity and instruct the Assistant to link them ' +
            `(for example: 'Link "${documentTitle}" to ${entityName}'). ` +
            'For discovered or inferred connections use proposeVerifiedRelation so the candidate goes through review.',
        },
        error: `Explicit document link was not authorized: ${authorization.reason}`,
      };
    }

    const linkEntityType = toEntityDocumentLinkType(entityType);

    // Retry convergence: an identical instruction converges on the existing
    // link instead of duplicating or erroring.
    const existing = await adminFindExistingLink(linkEntityType, entityId, documentId);
    if (existing) {
      return {
        success: true,
        data: {
          created: false,
          linkId: existing.id,
          documentId,
          documentTitle,
          entityId,
          entityName,
          message: `"${documentTitle}" is already linked to ${entityName}.`,
        },
      };
    }

    try {
      const { link, graphHandoff } = await adminCreateEntityDocumentLink({
        workspaceId: 'default',
        entityType: linkEntityType,
        entityId,
        documentId,
        relationshipType: relationshipType as (typeof LINK_RELATIONSHIP_TYPES)[number],
        relevance: relevance as (typeof LINK_RELEVANCE_LEVELS)[number],
        tags: [],
        aiSuggested: false,
        createdBy: context.userId,
        ...(typeof args.note === 'string' && args.note.trim() ? { note: args.note.trim() } : {}),
      });
      // GRAPH-069: the link is committed either way, but the Assistant must not
      // claim the knowledge graph has it when the handoff was never
      // acknowledged. Say what is true and name the recovery path.
      const graphPending = graphHandoff.status !== 'acknowledged';
      return {
        success: true,
        data: {
          created: true,
          linkId: link.id,
          documentId,
          documentTitle,
          entityId,
          entityName,
          graphSync: graphHandoff.status,
          message: graphPending
            ? `Linked "${documentTitle}" to ${entityName} (${relationshipType}). ` +
              'The knowledge-graph projection was not acknowledged yet and will be reconciled automatically.'
            : `Linked "${documentTitle}" to ${entityName} (${relationshipType}).`,
        },
      };
    } catch (createError) {
      // A concurrent create lost the race to the service's already-exists
      // guard — converge on the surviving link.
      if (createError instanceof Error && createError.message.includes('Link already exists')) {
        const raced = await adminFindExistingLink(linkEntityType, entityId, documentId);
        if (raced) {
          return {
            success: true,
            data: {
              created: false,
              linkId: raced.id,
              documentId,
              documentTitle,
              entityId,
              entityName,
              message: `"${documentTitle}" is already linked to ${entityName}.`,
            },
          };
        }
      }
      throw createError;
    }
  } catch (error) {
    log.error('linkDocumentToEntity failed', error instanceof Error ? error : new Error(String(error)));
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to link document to entity',
    };
  }
}
