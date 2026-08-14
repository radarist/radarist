/**
 * @file mcp/schema-converter.ts
 * @description Convert Gemini FunctionDeclaration schemas to MCP JSON Schema format
 *
 * The existing AI tools use Gemini's FunctionDeclaration format with SchemaType enum.
 * MCP requires standard JSON Schema format. This module handles the conversion.
 *
 * @author Radarist Team
 * @created 2026-01-22
 */

import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';
import type { McpTool, McpJsonSchema } from './types';

// ============================================================================
// Schema Type Mapping
// ============================================================================

/**
 * Map Gemini SchemaType to JSON Schema type string
 */
function mapSchemaType(geminiType: SchemaType | string | undefined): string {
  switch (geminiType) {
    case SchemaType.STRING:
    case 'STRING':
      return 'string';
    case SchemaType.NUMBER:
    case 'NUMBER':
      return 'number';
    case SchemaType.INTEGER:
    case 'INTEGER':
      return 'integer';
    case SchemaType.BOOLEAN:
    case 'BOOLEAN':
      return 'boolean';
    case SchemaType.ARRAY:
    case 'ARRAY':
      return 'array';
    case SchemaType.OBJECT:
    case 'OBJECT':
    default:
      return 'object';
  }
}

// ============================================================================
// Schema Conversion
// ============================================================================

/**
 * Convert a Gemini schema object to JSON Schema format
 *
 * @param geminiSchema - The Gemini schema object
 * @returns The equivalent JSON Schema
 */
export function convertGeminiSchemaToJsonSchema(
  geminiSchema: Record<string, unknown> | undefined
): McpJsonSchema {
  if (!geminiSchema) {
    return { type: 'object', properties: {} };
  }

  // Convert type
  const schemaType = geminiSchema.type as SchemaType | string | undefined;
  const result: McpJsonSchema = {
    type: mapSchemaType(schemaType),
  };

  // Copy description
  if (typeof geminiSchema.description === 'string') {
    result.description = geminiSchema.description;
  }

  // Convert enum
  if (Array.isArray(geminiSchema.enum)) {
    result.enum = geminiSchema.enum as string[];
  }

  // Convert format
  if (typeof geminiSchema.format === 'string') {
    result.format = geminiSchema.format;
  }

  // Convert default
  if (geminiSchema.default !== undefined) {
    result.default = geminiSchema.default;
  }

  // Convert numeric constraints
  if (typeof geminiSchema.minimum === 'number') {
    result.minimum = geminiSchema.minimum;
  }
  if (typeof geminiSchema.maximum === 'number') {
    result.maximum = geminiSchema.maximum;
  }

  // Convert properties recursively
  if (
    geminiSchema.properties &&
    typeof geminiSchema.properties === 'object'
  ) {
    result.properties = {};
    for (const [key, value] of Object.entries(geminiSchema.properties)) {
      if (value && typeof value === 'object') {
        result.properties[key] = convertGeminiSchemaToJsonSchema(
          value as Record<string, unknown>
        );
      }
    }
  }

  // Convert required
  if (Array.isArray(geminiSchema.required)) {
    result.required = geminiSchema.required as string[];
  }

  // Convert array items
  if (geminiSchema.items && typeof geminiSchema.items === 'object') {
    result.items = convertGeminiSchemaToJsonSchema(
      geminiSchema.items as Record<string, unknown>
    );
  }

  return result;
}

/**
 * Convert a Gemini FunctionDeclaration to MCP Tool format
 *
 * @param fn - The Gemini FunctionDeclaration
 * @returns The MCP Tool definition
 */
export function convertGeminiToolToMcpTool(fn: FunctionDeclaration): McpTool {
  return {
    name: fn.name,
    description: fn.description || `Execute the ${fn.name} tool`,
    inputSchema: convertGeminiSchemaToJsonSchema(
      fn.parameters as Record<string, unknown> | undefined
    ),
  };
}

/**
 * Convert an array of Gemini FunctionDeclarations to MCP Tools
 *
 * @param tools - Array of Gemini FunctionDeclarations
 * @returns Array of MCP Tool definitions
 */
export function convertGeminiToolsToMcpTools(
  tools: FunctionDeclaration[]
): McpTool[] {
  return tools.map(convertGeminiToolToMcpTool);
}

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validate that a tool name is valid
 * MCP tool names should be alphanumeric with underscores
 */
export function isValidToolName(name: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_]*$/.test(name);
}

/**
 * Sanitize a tool name to be MCP-compatible
 */
export function sanitizeToolName(name: string): string {
  // Replace invalid characters with underscores
  let sanitized = name.replace(/[^a-zA-Z0-9_]/g, '_');

  // Ensure it starts with a letter
  if (!/^[a-zA-Z]/.test(sanitized)) {
    sanitized = 'tool_' + sanitized;
  }

  return sanitized;
}

/**
 * Get a summary of the schema for debugging
 */
export function getSchemaDebugInfo(schema: McpJsonSchema): string {
  const propCount = schema.properties
    ? Object.keys(schema.properties).length
    : 0;
  const requiredCount = schema.required?.length || 0;

  return `type=${schema.type}, properties=${propCount}, required=${requiredCount}`;
}
