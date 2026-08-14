/**
 * @file mcp/servers/gemini-servers.ts
 * @description Gemini MCP Server factories (Phase 1)
 *
 * Wraps Gemini capabilities (image, embeddings, research, grounding)
 * as DomainMcpServer instances for the MCP HTTP route.
 *
 * Each server:
 * - Exposes tool definitions via getTools()
 * - Executes tool calls via callTool()
 * - Delegates to existing Gemini client code
 */

import type { McpTool, McpToolCallResult } from '../types';
import type { DomainMcpServer, McpCallContext } from './entities-server';
import { createLogger } from '@/lib/logger';
import { EXTERNAL_TOOL_FAILURE_MESSAGE, frameExternalText } from '@/lib/ai/untrusted-tool-result';

const log = createLogger('mcp/gemini-servers');

/**
 * Task 1.8: Tools blocked from chat mode — destructive operations.
 * These tools are available in missions/sweep but excluded from interactive chat.
 * Export for use by the chat orchestrator (Phase 2) when building allowedTools list.
 */
export const CHAT_BLOCKED_TOOLS = [
  'deleteEntity',
  'deleteOrgUnit',
  'deleteInitiative',
  'deletePainPoint',
  'deleteRadar',
  'deleteDecoupledTechnology',
  'deleteReport',
  'executeCypher',
  'bulkDeleteEntities',
  'bulkApproveSignals',
  'bulkRejectSignals',
] as const;

function makeTextResult(data: unknown): McpToolCallResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
  };
}

function makeErrorResult(error: string): McpToolCallResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ success: false, error }) }],
    isError: true,
  };
}

/** Grounded-web failures may contain upstream prose and must stay quoted. */
function makeExternalErrorResult(error: string, label: string): McpToolCallResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: false,
          error: EXTERNAL_TOOL_FAILURE_MESSAGE,
          data: {
            _external: true,
            _untrustedContent: frameExternalText(error, label),
          },
        }),
      },
    ],
    isError: true,
  };
}

// ============================================================================
// GEMINI IMAGE SERVER
// ============================================================================

export function createGeminiImageServer(): DomainMcpServer {
  log.info('Gemini Image MCP server created');

  return {
    name: 'gemini-image',
    version: '1.0.0',

    getTools(): McpTool[] {
      return [
        {
          name: 'generate_image',
          description: 'Generate an infographic or visualization using Gemini Nano Banana. Returns base64 image data.',
          inputSchema: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'Detailed prompt describing the image' },
              style: { type: 'string', enum: ['professional', 'minimal', 'colorful', 'dark'] },
              aspectRatio: { type: 'string', enum: ['1:1', '16:9', '4:3', '9:16'] },
              model: { type: 'string', enum: ['fast', 'quality'] },
            },
            required: ['prompt'],
          },
        },
      ];
    },

    async callTool(name: string, args: Record<string, unknown>, context?: McpCallContext): Promise<McpToolCallResult> {
      if (name !== 'generate_image') return makeErrorResult(`Unknown tool: ${name}`);

      try {
        const { generateInfographic } = await import('@/lib/ai/image-client');

        // US-1: read the like/dislike loop back into generation. Fail-open — a
        // broken lookup must never block the MCP image tool.
        let learnedStyleFragment: string | undefined;
        try {
          const { buildLearnedStyleFragment } = await import('@/lib/visualizations');
          learnedStyleFragment = await buildLearnedStyleFragment();
        } catch (error) {
          log.warn('learned-style fragment lookup failed — generating without it', {
            error: error instanceof Error ? error.message : String(error),
          });
        }

        // Brand palette from the mission DesignBrief wins; the learned fragment appends.
        const brandStyle =
          [context?.designBrief?.infographicStyle, learnedStyleFragment].filter(Boolean).join('\n') || undefined;

        const result = await generateInfographic({
          prompt: args.prompt as string,
          style: ((args.style as string) ?? 'professional') as 'professional' | 'minimal' | 'colorful' | 'dark',
          aspectRatio: ((args.aspectRatio as string) ?? '16:9') as '1:1' | '16:9' | '4:3' | '9:16',
          model: (args.model as string) === 'quality' ? 'quality' : 'fast',
          userId: context?.userId ?? 'anonymous',
          brandStyle,
        });
        // REPORT-012 T2.6: mint an imageId for composed reports — the agent
        // references it in an `image-ref` block and the composer inlines the
        // image as a bounded data: URI (remote <img> URLs are rejected at
        // publication). Fail-open: a cache failure never blocks generation.
        let imageId: string | null = null;
        // InfographicResult's field is `url` (image-client.ts:51); accept the
        // legacy `imageUrl` shape defensively.
        const resultShape = result as { url?: string | null; imageUrl?: string | null } | null;
        const imageUrl = resultShape?.url ?? resultShape?.imageUrl ?? null;
        if (context?.missionId && typeof imageUrl === 'string' && imageUrl.length > 0) {
          try {
            const { mintChartId, putImageUrl } = await import('@/lib/super-graph/chart-cache');
            imageId = mintChartId('img', (args.prompt as string | undefined)?.slice(0, 32));
            await putImageUrl(context.missionId, imageId, imageUrl);
          } catch (cacheErr) {
            log.warn('image-ref cache write failed (image-ref unavailable for this render)', {
              missionId: context.missionId,
              error: String(cacheErr),
            });
            imageId = null;
          }
        }
        return makeTextResult({ ...(result as object), imageId });
      } catch (error) {
        return makeErrorResult(error instanceof Error ? error.message : 'Image generation failed');
      }
    },
  };
}

// ============================================================================
// GEMINI EMBEDDINGS SERVER
// ============================================================================

export function createGeminiEmbeddingsServer(): DomainMcpServer {
  log.info('Gemini Embeddings MCP server created');

  return {
    name: 'gemini-embeddings',
    version: '1.0.0',

    getTools(): McpTool[] {
      return [
        {
          name: 'generate_embedding',
          description: 'Generate a vector embedding for text using Gemini (768 dimensions)',
          inputSchema: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Text to embed' },
              taskType: { type: 'string', enum: ['RETRIEVAL_DOCUMENT', 'RETRIEVAL_QUERY', 'SEMANTIC_SIMILARITY'] },
            },
            required: ['text'],
          },
        },
        {
          name: 'generate_embeddings_batch',
          description: 'Generate vector embeddings for multiple texts (768 dimensions each)',
          inputSchema: {
            type: 'object',
            properties: {
              texts: { type: 'array', items: { type: 'string' } },
              taskType: { type: 'string', enum: ['RETRIEVAL_DOCUMENT', 'RETRIEVAL_QUERY'] },
              concurrency: { type: 'number' },
            },
            required: ['texts'],
          },
        },
      ];
    },

    async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
      try {
        const { generateEmbedding, generateEmbeddings } = await import('@/lib/ai/client');

        if (name === 'generate_embedding') {
          const embedding = await generateEmbedding(args.text as string);
          return makeTextResult({ success: true, embedding, dimension: 768 });
        }

        if (name === 'generate_embeddings_batch') {
          const result = await generateEmbeddings(args.texts as string[]);
          return makeTextResult({ success: true, ...result });
        }

        return makeErrorResult(`Unknown tool: ${name}`);
      } catch (error) {
        return makeErrorResult(error instanceof Error ? error.message : 'Embedding failed');
      }
    },
  };
}

// ============================================================================
// GEMINI RESEARCH SERVER (async — returns immediately)
// ============================================================================

export function createGeminiResearchServer(): DomainMcpServer {
  log.info('Gemini Research MCP server created');

  return {
    name: 'gemini-research',
    version: '1.0.0',

    getTools(): McpTool[] {
      return [
        {
          name: 'start_research',
          description: 'Start an async deep research task. Returns immediately — results appear in document library.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Research topic or question' },
              tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['query'],
          },
        },
      ];
    },

    async callTool(name: string, args: Record<string, unknown>, context?: McpCallContext): Promise<McpToolCallResult> {
      if (name !== 'start_research') return makeErrorResult(`Unknown tool: ${name}`);

      try {
        // Delegate to existing deep research tool (fires Inngest event)
        const { executeCreateResearchDocument } = await import('@/lib/ai/tools/deep-research-tools');
        const result = await executeCreateResearchDocument(
          { query: args.query as string, tags: args.tags as string[] },
          context?.userId ?? 'anonymous'
        );
        return makeTextResult(result);
      } catch (error) {
        return makeErrorResult(error instanceof Error ? error.message : 'Research start failed');
      }
    },
  };
}

// ============================================================================
// GEMINI GROUNDING SERVER
// ============================================================================

export function createGeminiGroundingServer(): DomainMcpServer {
  log.info('Gemini Grounding MCP server created');

  return {
    name: 'gemini-grounding',
    version: '1.0.0',

    getTools(): McpTool[] {
      return [
        {
          name: 'search_with_grounding',
          description: 'Search the web using Google Search grounding via Gemini. Returns text with source citations.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query' },
              model: { type: 'string', description: 'Gemini model (default: gemini-3-flash-preview)' },
            },
            required: ['query'],
          },
        },
      ];
    },

    async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
      if (name !== 'search_with_grounding') return makeErrorResult(`Unknown tool: ${name}`);

      try {
        const { generateContent } = await import('@/lib/ai/client');
        const result = await generateContent(args.query as string, {
          model: ((args.model as string) ?? 'gemini-3-flash-preview') as 'gemini-3-flash-preview',
          useGoogleSearch: true,
          maxOutputTokens: 16384,
        });
        // SEC-010 — Google-Search-grounded prose is external content. This
        // server bypasses `executeTool`, so it frames the text directly.
        return makeTextResult({ success: true, text: frameExternalText(result, 'tool:search_with_grounding') });
      } catch (error) {
        return makeExternalErrorResult(
          error instanceof Error ? error.message : 'Grounding search failed',
          'tool:search_with_grounding:error'
        );
      }
    },
  };
}
