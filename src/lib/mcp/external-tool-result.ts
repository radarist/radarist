/**
 * Convert an external ToolResult into one bounded MCP text result.
 *
 * MCP has several transports (aggregate and per-domain). Keeping this adapter
 * shared prevents one transport from serializing an upstream error/message
 * directly while another correctly quotes it as untrusted data.
 */

import 'server-only';

import {
  frameExternalToolResult,
  isExternalContentTool,
} from '@/lib/ai/untrusted-tool-result';
import type { ToolResult } from '@/lib/ai/tools/tool-result';

import type { McpToolCallResult } from './types';

/**
 * Return an MCP result when `toolName` is external, otherwise `null` so the
 * caller can preserve its existing first-party formatting byte-for-byte.
 */
export function externalToolResultToMcp(
  toolName: string,
  result: ToolResult
): McpToolCallResult | null {
  if (!isExternalContentTool(toolName)) return null;

  const framed = frameExternalToolResult(toolName, result);
  return {
    content: [{ type: 'text', text: JSON.stringify(framed) }],
    ...(framed.success ? {} : { isError: true }),
  };
}

/**
 * Turn a thrown external-provider failure into the same framed MCP contract.
 * The raw exception is quoted inside `_untrustedContent`; only the fixed safe
 * error emitted by `frameExternalToolResult` remains at the top level.
 */
export function externalToolFailureToMcp(
  toolName: string,
  error: unknown
): McpToolCallResult | null {
  const message = error instanceof Error ? error.message : String(error);
  return externalToolResultToMcp(toolName, { success: false, error: message });
}
