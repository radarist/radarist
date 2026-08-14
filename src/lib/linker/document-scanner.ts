/**
 * @file linker/document-scanner.ts
 * @description Scans document chunks for entity mentions to create link candidates
 *
 * Implements the document mention discovery method for the Linker Agent.
 * Scans document content for mentions of:
 * - Technologies
 * - Companies
 * - Signals (with Approved status)
 * - Use Cases
 * - Strategies
 * - Prototypes
 * - Pain Points
 * - Org Units
 * - Initiatives
 * - Documents (other documents for document-to-document relations)
 *
 * @author Radarist Team
 * @created 2026-01-21
 */

import { createLogger } from '@/lib/logger';
import { db } from '@/lib/firebase-admin';

const log = createLogger('linker/document-scanner');
import { adminGetChunksForDocument } from '@/lib/document-chunk-admin';
import { normalizeAlias } from '@/lib/text-normalize';
import { ENTITY_COLLECTIONS } from '@/lib/entity-collections';
import type { LinkerCandidate, EntityContext } from './types';
import type { DocumentChunk, EntityType, RelationType } from '@/lib/types';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Entity name lookup entry with rich context
 */
interface EntityNameEntry {
  id: string;
  name: string;
  aliases?: string[];
  /** Rich context for AI verification */
  context: EntityContext;
}

/**
 * Mention found in document content
 */
interface DocumentMention {
  /** Entity ID that was mentioned */
  entityId: string;
  /** Entity type */
  entityType: EntityType;
  /** Entity name as it appears in our system */
  entityName: string;
  /** The text that matched */
  matchedText: string;
  /** Chunk ID where the mention was found */
  chunkId: string;
  /** Snippet of content around the mention */
  snippet: string;
  /** Rich context for the mentioned entity */
  entityContext: EntityContext;
}

// ============================================================================
// ENTITY NAME FETCHING
// ============================================================================

/**
 * Cache for entity names to avoid repeated Firestore queries
 */
const entityNameCache = new Map<EntityType, Map<string, EntityNameEntry>>();
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetches all entity names for a given type.
 * Results are cached for performance.
 *
 * @param entityType - The type of entities to fetch
 * @returns Map of entity ID to name entry
 */
async function getEntityNames(entityType: EntityType): Promise<Map<string, EntityNameEntry>> {
  // Check cache freshness
  if (Date.now() - cacheTimestamp > CACHE_TTL) {
    entityNameCache.clear();
    cacheTimestamp = Date.now();
  }

  // Return cached if available
  if (entityNameCache.has(entityType)) {
    return entityNameCache.get(entityType)!;
  }

  const nameMap = new Map<string, EntityNameEntry>();

  try {
    // Canonical EntityType→collection map — the linker scans the SAME
    // collections the app writes to. A local copy here used `useCases`/
    // `orgUnits`, so the auto-linker never found use-case/org-unit entities by
    // name and silently never proposed links to them (see entity-collections.ts).
    const collectionMap = ENTITY_COLLECTIONS;

    // Fields used for entity names vary by type
    const nameFieldMap: Record<string, string> = {
      technology: 'name',
      company: 'name',
      signal: 'title',
      useCase: 'title',
      strategy: 'name',
      prototype: 'name',
      painPoint: 'title',
      orgUnit: 'name',
      initiative: 'name',
      document: 'title',
    };

    const collectionName = collectionMap[entityType];
    if (!collectionName) {
      log.warn('No collection for entity type', { entityType });
      return nameMap;
    }

    // For signals, only fetch Approved ones
    // For documents, only fetch processed ones
    let q = db.collection(collectionName).limit(500);
    if (entityType === 'signal') {
      q = db.collection(collectionName).where('status', '==', 'Approved').limit(500);
    } else if (entityType === 'document') {
      q = db.collection(collectionName).where('status', '==', 'processed').limit(500);
    }

    const snapshot = await q.get();

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const nameField = nameFieldMap[entityType] || 'name';
      const name = data[nameField];

      if (name) {
        // Build rich context for AI verification
        const context: EntityContext = {
          name,
        };

        // Add description if available
        if (data.description || data.summary) {
          context.description = (data.description || data.summary || '').slice(0, 500);
        }

        // Add industry for companies
        if (data.industry || data.sector) {
          context.industry = data.industry || data.sector;
        }

        // Add category (quadrant for technologies)
        if (data.category || data.quadrant) {
          context.category = data.category || data.quadrant;
        }

        // Add tags (up to 10)
        if (Array.isArray(data.tags) && data.tags.length > 0) {
          context.tags = data.tags.slice(0, 10);
        }

        // Add content snippet for signals
        if (entityType === 'signal' && data.content) {
          context.contentSnippet = data.content.slice(0, 300);
        }

        // Add source for signals
        if (entityType === 'signal' && data.source) {
          context.source = data.source;
        }

        nameMap.set(doc.id, {
          id: doc.id,
          name,
          aliases: data.aliases || [],
          context,
        });
      }
    }

    // Cache the result
    entityNameCache.set(entityType, nameMap);

    log.info(`Loaded ${nameMap.size} ${entityType} names`);
  } catch (error) {
    log.error(`Error fetching ${entityType} names`, error instanceof Error ? error : undefined);
  }

  return nameMap;
}

// ============================================================================
// MENTION DETECTION
// ============================================================================

/**
 * Extracts a snippet of content around a mention.
 *
 * @param content - Full chunk content
 * @param matchStart - Start index of the match
 * @param matchEnd - End index of the match
 * @param snippetLength - Total length of snippet (default 200)
 * @returns Snippet with context
 */
function extractSnippet(content: string, matchStart: number, matchEnd: number, snippetLength: number = 200): string {
  const contextBefore = Math.floor((snippetLength - (matchEnd - matchStart)) / 2);
  const start = Math.max(0, matchStart - contextBefore);
  const end = Math.min(content.length, start + snippetLength);

  let snippet = content.slice(start, end);

  // Add ellipsis if truncated
  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';

  return snippet;
}

/**
 * Scans a chunk's content for mentions of entities.
 *
 * @param chunk - Document chunk to scan
 * @param entities - Map of entity ID to name entry
 * @param entityType - Type of entities being scanned
 * @returns Array of mentions found
 */
function scanChunkForMentions(
  chunk: DocumentChunk,
  entities: Map<string, EntityNameEntry>,
  entityType: EntityType
): DocumentMention[] {
  const mentions: DocumentMention[] = [];
  const contentLower = chunk.content.toLowerCase();

  // Track already matched entities to avoid duplicates in same chunk
  const matchedEntities = new Set<string>();

  for (const [entityId, entry] of entities) {
    if (matchedEntities.has(entityId)) continue;

    // Build search terms (name + aliases)
    const searchTerms = [entry.name, ...(entry.aliases || [])];

    for (const term of searchTerms) {
      if (!term || term.length < 3) continue; // Skip very short terms

      const termLower = normalizeAlias(term);
      const index = contentLower.indexOf(termLower);

      if (index !== -1) {
        matchedEntities.add(entityId);

        mentions.push({
          entityId,
          entityType,
          entityName: entry.name,
          matchedText: term,
          chunkId: chunk.id,
          snippet: extractSnippet(chunk.content, index, index + term.length),
          entityContext: entry.context,
        });

        break; // Found this entity, move to next
      }
    }
  }

  return mentions;
}

// ============================================================================
// MAIN SCANNER
// ============================================================================

/**
 * Scans a document's chunks for entity mentions and generates link candidates.
 *
 * @param documentId - ID of the document to scan
 * @returns Array of linker candidates for document mentions
 *
 * @example
 * ```typescript
 * const candidates = await scanDocumentForEntities('doc-123');
 * console.log(`Found ${candidates.length} entity mentions`);
 * ```
 */
export async function scanDocumentForEntities(documentId: string): Promise<LinkerCandidate[]> {
  log.info('Scanning document', { documentId });

  const candidates: LinkerCandidate[] = [];

  try {
    // Fetch document chunks
    const chunks = await adminGetChunksForDocument(documentId);

    if (chunks.length === 0) {
      log.info('No chunks found for document', { documentId });
      return candidates;
    }

    log.info('Processing chunks', { count: chunks.length });

    // Fetch document metadata for source name and context
    const { adminGetDocumentById } = await import('@/lib/document-admin');
    const document = await adminGetDocumentById(documentId);
    const documentTitle = document?.title || documentId;

    // Build source context for the document
    const sourceContext: EntityContext = {
      name: documentTitle,
    };
    if (document?.description) {
      sourceContext.description = document.description.slice(0, 500);
    }
    if (document?.aiSummary) {
      sourceContext.summary = document.aiSummary.slice(0, 500);
    }
    const sourceLabel = document?.domain || document?.originalUrl || document?.type;
    if (sourceLabel) {
      sourceContext.source = sourceLabel;
    }
    if (Array.isArray(document?.tags) && document.tags.length > 0) {
      sourceContext.tags = document.tags.slice(0, 10);
    }

    // Entity types to scan for and their corresponding relation type
    const entityTypesWithRelations: Array<{ type: EntityType; relation: RelationType }> = [
      { type: 'technology', relation: 'about' },
      { type: 'company', relation: 'about' },
      { type: 'signal', relation: 'source' },
      { type: 'useCase', relation: 'about' },
      { type: 'strategy', relation: 'about' },
      { type: 'prototype', relation: 'about' },
      { type: 'painPoint', relation: 'about' },
      { type: 'orgUnit', relation: 'owned_by' },
      { type: 'initiative', relation: 'about' },
      { type: 'document', relation: 'references' },
    ];

    // Fetch entity names for all types in parallel
    const entityNameResults = await Promise.all(
      entityTypesWithRelations.map(async ({ type }) => ({
        type,
        names: await getEntityNames(type),
      }))
    );

    // Build lookup map
    const entityNamesByType = new Map<EntityType, Map<string, EntityNameEntry>>();
    for (const { type, names } of entityNameResults) {
      entityNamesByType.set(type, names);
    }

    const totalEntities = entityNameResults.reduce((sum, { names }) => sum + names.size, 0);
    log.info('Loaded entity names', { totalEntities, types: entityTypesWithRelations.length });

    // Collect all mentions from all chunks
    const allMentions: Array<DocumentMention & { relation: RelationType }> = [];

    for (const chunk of chunks) {
      // Scan for each entity type
      for (const { type, relation } of entityTypesWithRelations) {
        const names = entityNamesByType.get(type);
        if (!names || names.size === 0) continue;

        const mentions = scanChunkForMentions(chunk, names, type);
        // Add relation type to each mention
        for (const mention of mentions) {
          allMentions.push({ ...mention, relation });
        }
      }
    }

    // Deduplicate mentions (same document → same entity, keep first)
    // Also filter out self-references (document referencing itself)
    const uniqueMentions = new Map<string, DocumentMention & { relation: RelationType }>();
    for (const mention of allMentions) {
      // Skip self-references for document-to-document relations
      if (mention.entityType === 'document' && mention.entityId === documentId) {
        continue;
      }
      const key = `${mention.entityType}:${mention.entityId}`;
      if (!uniqueMentions.has(key)) {
        uniqueMentions.set(key, mention);
      }
    }

    log.info('Found unique entity mentions', { count: uniqueMentions.size });

    // Convert mentions to candidates with appropriate relation types
    for (const mention of uniqueMentions.values()) {
      candidates.push({
        sourceId: documentId,
        sourceType: 'document',
        sourceName: documentTitle,
        sourceContext,
        targetId: mention.entityId,
        targetType: mention.entityType,
        targetName: mention.entityName,
        targetContext: mention.entityContext,
        relationType: mention.relation,
        confidence: 70, // Base confidence for document mentions
        discoveryMethod: 'document_mention' as const,
        evidenceSnippets: [mention.snippet],
      });
    }
  } catch (error) {
    log.error(`Error scanning document ${documentId}`, error instanceof Error ? error : undefined);
  }

  return candidates;
}

/**
 * Scans multiple documents for entity mentions.
 *
 * @param documentIds - Array of document IDs to scan
 * @returns Array of all candidates from all documents
 */
export async function batchScanDocuments(documentIds: string[]): Promise<LinkerCandidate[]> {
  const allCandidates: LinkerCandidate[] = [];

  // Process documents in parallel (with limit)
  const BATCH_SIZE = 5;
  for (let i = 0; i < documentIds.length; i += BATCH_SIZE) {
    const batch = documentIds.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map((docId) => scanDocumentForEntities(docId)));

    for (const candidates of results) {
      allCandidates.push(...candidates);
    }
  }

  return allCandidates;
}

/**
 * Gets all document IDs that haven't been scanned recently.
 *
 * @param maxDocuments - Maximum number of documents to return
 * @returns Array of document IDs to scan
 */
export async function getDocumentsToScan(maxDocuments: number = 50): Promise<string[]> {
  try {
    // Only get documents with processed status
    const snapshot = await db.collection('documents').where('status', '==', 'processed').limit(maxDocuments).get();

    return snapshot.docs.map((doc) => doc.id);
  } catch (error) {
    log.error('Error getting documents to scan', error instanceof Error ? error : undefined);
    return [];
  }
}
