/**
 * @file app/api/debug/neo4j/route.ts
 * @description Debug API for querying Neo4j directly
 *
 * This endpoint helps diagnose sync issues by querying Neo4j
 * to see what data exists in the graph database.
 *
 * @phase Knowledge Tab Sprint - Phase 2
 * @author Radarist Team
 * @created 2026-01-14
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/debug/neo4j');
import neo4j from 'neo4j-driver';
import {
  runReadTransaction,
  checkHealth,
} from '@/lib/graph';

/**
 * GET /api/debug/neo4j
 *
 * Query parameters:
 * - action: The type of query (health, nodes, relationships, entity-doc-links, check-entity, check-document)
 * - entityType: Entity type to search for
 * - entityId: Entity ID to search for
 * - documentId: Document ID to search for
 * - limit: Max results (default 50)
 */
export async function GET(request: NextRequest) {
  // Require admin authentication + development mode only
  const auth = await requireAdmin(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Debug endpoints are only available in development mode' }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action') || 'health';
    const entityType = searchParams.get('entityType');
    const entityId = searchParams.get('entityId');
    const documentId = searchParams.get('documentId');
    const limitValue = parseInt(searchParams.get('limit') || '50', 10);
    const limit = neo4j.int(limitValue);

    switch (action) {
      case 'health': {
        const health = await checkHealth();
        return NextResponse.json({
          success: true,
          data: health,
        });
      }

      case 'nodes': {
        // Get all nodes with optional label filter
        let cypher = `
          MATCH (n)
          RETURN labels(n) AS labels, n.id AS id, n.name AS name, n.title AS title, n.entityType AS entityType
          LIMIT $limit
        `;

        if (entityType) {
          const label = entityType.charAt(0).toUpperCase() + entityType.slice(1);
          cypher = `
            MATCH (n:${label})
            RETURN labels(n) AS labels, n.id AS id, n.name AS name, n.title AS title, n.entityType AS entityType
            LIMIT $limit
          `;
        }

        const result = await runReadTransaction(cypher, { limit });
        return NextResponse.json({
          success: true,
          data: result.records,
          count: result.records.length,
        });
      }

      case 'technologies': {
        const cypher = `
          MATCH (t:Technology)
          RETURN t.id AS id, t.name AS name, t.entityType AS entityType, labels(t) AS labels
          LIMIT $limit
        `;
        const result = await runReadTransaction(cypher, { limit });
        return NextResponse.json({
          success: true,
          data: result.records,
          count: result.records.length,
        });
      }

      case 'documents': {
        const cypher = `
          MATCH (d:Document)
          RETURN d.id AS id, d.title AS title, d.type AS type, labels(d) AS labels
          LIMIT $limit
        `;
        const result = await runReadTransaction(cypher, { limit });
        return NextResponse.json({
          success: true,
          data: result.records,
          count: result.records.length,
        });
      }

      case 'relationships': {
        // Get all relationships
        const cypher = `
          MATCH (a)-[r]->(b)
          RETURN type(r) AS type, r.linkId AS linkId, a.id AS sourceId, a.name AS sourceName,
                 b.id AS targetId, b.name AS targetName, b.title AS targetTitle
          LIMIT $limit
        `;
        const result = await runReadTransaction(cypher, { limit });
        return NextResponse.json({
          success: true,
          data: result.records,
          count: result.records.length,
        });
      }

      case 'entity-doc-links': {
        // Get all entity-document relationships
        const cypher = `
          MATCH (e)-[r]->(d:Document)
          WHERE r.linkId IS NOT NULL
          RETURN type(r) AS relationType, r.linkId AS linkId, r.relevance AS relevance,
                 e.id AS entityId, e.name AS entityName, labels(e) AS entityLabels,
                 d.id AS documentId, d.title AS documentTitle
          LIMIT $limit
        `;
        const result = await runReadTransaction(cypher, { limit });
        return NextResponse.json({
          success: true,
          data: result.records,
          count: result.records.length,
        });
      }

      case 'check-entity': {
        if (!entityId) {
          return NextResponse.json(
            { error: 'entityId parameter required' },
            { status: 400 }
          );
        }

        // Check if entity exists with any label
        const cypher = `
          MATCH (n {id: $entityId})
          RETURN n.id AS id, n.name AS name, n.entityType AS entityType, labels(n) AS labels,
                 properties(n) AS properties
        `;
        const result = await runReadTransaction(cypher, { entityId });

        if (result.records.length === 0) {
          return NextResponse.json({
            success: true,
            exists: false,
            message: `Entity ${entityId} NOT FOUND in Neo4j`,
          });
        }

        return NextResponse.json({
          success: true,
          exists: true,
          data: result.records[0],
        });
      }

      case 'check-document': {
        if (!documentId) {
          return NextResponse.json(
            { error: 'documentId parameter required' },
            { status: 400 }
          );
        }

        // Check if document exists
        const cypher = `
          MATCH (d:Document {id: $documentId})
          RETURN d.id AS id, d.title AS title, d.type AS type, labels(d) AS labels,
                 properties(d) AS properties
        `;
        const result = await runReadTransaction(cypher, { documentId });

        if (result.records.length === 0) {
          return NextResponse.json({
            success: true,
            exists: false,
            message: `Document ${documentId} NOT FOUND in Neo4j`,
          });
        }

        return NextResponse.json({
          success: true,
          exists: true,
          data: result.records[0],
        });
      }

      case 'chunks': {
        // Get all chunks with embedding status
        const cypher = `
          MATCH (c:Chunk)
          WITH c,
               c.documentId AS documentId,
               CASE WHEN c.embedding IS NOT NULL AND size(c.embedding) > 0 THEN true ELSE false END AS hasEmbedding,
               size(coalesce(c.embedding, [])) AS embeddingSize
          OPTIONAL MATCH (d:Document {id: c.documentId})
          RETURN c.id AS chunkId, documentId, d.title AS documentTitle,
                 c.chunkIndex AS chunkIndex, hasEmbedding, embeddingSize,
                 substring(c.content, 0, 100) AS contentPreview
          ORDER BY documentId, c.chunkIndex
          LIMIT $limit
        `;
        const result = await runReadTransaction(cypher, { limit });

        // Count chunks with and without embeddings
        const stats = {
          total: result.records.length,
          withEmbedding: result.records.filter((r) => r.hasEmbedding).length,
          withoutEmbedding: result.records.filter((r) => !r.hasEmbedding).length,
        };

        return NextResponse.json({
          success: true,
          data: result.records,
          stats,
          vectorIndexHealth: stats.withEmbedding === stats.total ? 'HEALTHY' : 'NEEDS_ATTENTION',
        });
      }

      case 'document-chunks': {
        if (!documentId) {
          return NextResponse.json(
            { error: 'documentId parameter required' },
            { status: 400 }
          );
        }

        // Get all chunks for a specific document
        const cypher = `
          MATCH (c:Chunk {documentId: $documentId})
          WITH c,
               CASE WHEN c.embedding IS NOT NULL AND size(c.embedding) > 0 THEN true ELSE false END AS hasEmbedding,
               size(coalesce(c.embedding, [])) AS embeddingSize
          OPTIONAL MATCH (d:Document {id: c.documentId})
          RETURN c.id AS chunkId, c.documentId AS documentId, d.title AS documentTitle,
                 c.chunkIndex AS chunkIndex, hasEmbedding, embeddingSize,
                 substring(c.content, 0, 200) AS contentPreview
          ORDER BY c.chunkIndex
        `;
        const result = await runReadTransaction(cypher, { documentId });

        // Also check if document node exists
        const docCheck = await runReadTransaction(
          `MATCH (d:Document {id: $documentId}) RETURN d.id AS id, d.title AS title`,
          { documentId }
        );

        return NextResponse.json({
          success: true,
          documentExists: docCheck.records.length > 0,
          document: docCheck.records[0] || null,
          chunks: result.records,
          chunkCount: result.records.length,
          chunksWithEmbedding: result.records.filter((r) => r.hasEmbedding).length,
          readyForVectorSearch: result.records.length > 0 && result.records.every((r) => r.hasEmbedding),
          diagnosis: result.records.length === 0
            ? 'NO_CHUNKS_IN_NEO4J - Document needs to be synced to Neo4j'
            : result.records.some((r) => !r.hasEmbedding)
              ? 'MISSING_EMBEDDINGS - Some chunks need embedding generation'
              : 'READY - All chunks have embeddings',
        });
      }

      case 'vector-index-status': {
        // Check the vector index status
        const cypher = `
          SHOW INDEXES
          WHERE name = 'chunk_embedding'
          RETURN name, state, populationPercent, type
        `;
        const result = await runReadTransaction(cypher);

        if (result.records.length === 0) {
          return NextResponse.json({
            success: true,
            indexExists: false,
            message: 'Vector index chunk_embedding NOT FOUND - run schema.cypher to create it',
          });
        }

        const indexInfo = result.records[0];
        return NextResponse.json({
          success: true,
          indexExists: true,
          indexName: indexInfo.name,
          state: indexInfo.state,
          populationPercent: indexInfo.populationPercent,
          type: indexInfo.type,
          ready: indexInfo.state === 'ONLINE',
        });
      }

      case 'check-link': {
        if (!entityId || !documentId) {
          return NextResponse.json(
            { error: 'entityId and documentId parameters required' },
            { status: 400 }
          );
        }

        // Check both entity and document, plus any relationships between them
        const checkEntityCypher = `
          MATCH (n {id: $entityId})
          RETURN n.id AS id, n.name AS name, labels(n) AS labels
        `;
        const checkDocCypher = `
          MATCH (d:Document {id: $documentId})
          RETURN d.id AS id, d.title AS title
        `;
        const checkRelCypher = `
          MATCH (e {id: $entityId})-[r]->(d:Document {id: $documentId})
          RETURN type(r) AS relationType, r.linkId AS linkId, r.relevance AS relevance
        `;

        const [entityResult, docResult, relResult] = await Promise.all([
          runReadTransaction(checkEntityCypher, { entityId }),
          runReadTransaction(checkDocCypher, { documentId }),
          runReadTransaction(checkRelCypher, { entityId, documentId }),
        ]);

        return NextResponse.json({
          success: true,
          entityExists: entityResult.records.length > 0,
          entity: entityResult.records[0] || null,
          documentExists: docResult.records.length > 0,
          document: docResult.records[0] || null,
          relationshipExists: relResult.records.length > 0,
          relationships: relResult.records,
          diagnosis: {
            canCreateLink: entityResult.records.length > 0 && docResult.records.length > 0,
            missingEntity: entityResult.records.length === 0,
            missingDocument: docResult.records.length === 0,
          },
        });
      }

      default:
        return NextResponse.json(
          {
            error: 'Unknown action',
            availableActions: [
              'health',
              'nodes',
              'technologies',
              'documents',
              'relationships',
              'entity-doc-links',
              'check-entity',
              'check-document',
              'check-link',
              'chunks',
              'document-chunks',
              'vector-index-status',
            ],
            usageExamples: {
              checkDocumentChunks: '/api/debug/neo4j?action=document-chunks&documentId=YOUR_DOC_ID',
              checkAllChunks: '/api/debug/neo4j?action=chunks&limit=100',
              checkVectorIndex: '/api/debug/neo4j?action=vector-index-status',
            }
          },
          { status: 400 }
        );
    }
  } catch (error) {
    log.error('Failed to query Neo4j', error instanceof Error ? error : undefined);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to query Neo4j',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
