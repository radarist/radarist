/**
 * Unit Tests for MCP Schema Converter
 *
 * Tests the conversion of Gemini FunctionDeclaration schemas to MCP JSON Schema format.
 *
 * @jest-environment node
 */

import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';
import {
  convertGeminiSchemaToJsonSchema,
  convertGeminiToolToMcpTool,
  convertGeminiToolsToMcpTools,
  isValidToolName,
  sanitizeToolName,
  getSchemaDebugInfo,
} from '../schema-converter';

describe('MCP Schema Converter', () => {
  describe('convertGeminiSchemaToJsonSchema', () => {
    it('should convert basic types correctly', () => {
      // String
      expect(convertGeminiSchemaToJsonSchema({ type: SchemaType.STRING })).toEqual({
        type: 'string',
      });

      // Number
      expect(convertGeminiSchemaToJsonSchema({ type: SchemaType.NUMBER })).toEqual({
        type: 'number',
      });

      // Integer
      expect(convertGeminiSchemaToJsonSchema({ type: SchemaType.INTEGER })).toEqual({
        type: 'integer',
      });

      // Boolean
      expect(convertGeminiSchemaToJsonSchema({ type: SchemaType.BOOLEAN })).toEqual({
        type: 'boolean',
      });

      // Array
      expect(convertGeminiSchemaToJsonSchema({ type: SchemaType.ARRAY })).toEqual({
        type: 'array',
      });

      // Object
      expect(convertGeminiSchemaToJsonSchema({ type: SchemaType.OBJECT })).toEqual({
        type: 'object',
      });
    });

    it('should handle string type values', () => {
      expect(convertGeminiSchemaToJsonSchema({ type: 'STRING' })).toEqual({
        type: 'string',
      });
      expect(convertGeminiSchemaToJsonSchema({ type: 'NUMBER' })).toEqual({
        type: 'number',
      });
    });

    it('should handle undefined schema', () => {
      expect(convertGeminiSchemaToJsonSchema(undefined)).toEqual({
        type: 'object',
        properties: {},
      });
    });

    it('should convert description', () => {
      const result = convertGeminiSchemaToJsonSchema({
        type: SchemaType.STRING,
        description: 'A test description',
      });
      expect(result).toEqual({
        type: 'string',
        description: 'A test description',
      });
    });

    it('should convert enum values', () => {
      const result = convertGeminiSchemaToJsonSchema({
        type: SchemaType.STRING,
        enum: ['option1', 'option2', 'option3'],
      });
      expect(result).toEqual({
        type: 'string',
        enum: ['option1', 'option2', 'option3'],
      });
    });

    it('should convert format', () => {
      const result = convertGeminiSchemaToJsonSchema({
        type: SchemaType.STRING,
        format: 'date-time',
      });
      expect(result).toEqual({
        type: 'string',
        format: 'date-time',
      });
    });

    it('should convert default values', () => {
      const result = convertGeminiSchemaToJsonSchema({
        type: SchemaType.NUMBER,
        default: 10,
      });
      expect(result).toEqual({
        type: 'number',
        default: 10,
      });
    });

    it('should convert numeric constraints', () => {
      const result = convertGeminiSchemaToJsonSchema({
        type: SchemaType.INTEGER,
        minimum: 1,
        maximum: 100,
      });
      expect(result).toEqual({
        type: 'integer',
        minimum: 1,
        maximum: 100,
      });
    });

    it('should convert nested properties', () => {
      const result = convertGeminiSchemaToJsonSchema({
        type: SchemaType.OBJECT,
        properties: {
          name: { type: SchemaType.STRING },
          age: { type: SchemaType.INTEGER },
        },
        required: ['name'],
      });
      expect(result).toEqual({
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'integer' },
        },
        required: ['name'],
      });
    });

    it('should convert array items', () => {
      const result = convertGeminiSchemaToJsonSchema({
        type: SchemaType.ARRAY,
        items: { type: SchemaType.STRING },
      });
      expect(result).toEqual({
        type: 'array',
        items: { type: 'string' },
      });
    });

    it('should handle deeply nested schemas', () => {
      const result = convertGeminiSchemaToJsonSchema({
        type: SchemaType.OBJECT,
        properties: {
          user: {
            type: SchemaType.OBJECT,
            properties: {
              name: { type: SchemaType.STRING },
              contacts: {
                type: SchemaType.ARRAY,
                items: {
                  type: SchemaType.OBJECT,
                  properties: {
                    email: { type: SchemaType.STRING },
                  },
                },
              },
            },
          },
        },
      });

      expect(result.properties?.user?.properties?.contacts?.items?.properties?.email).toEqual({
        type: 'string',
      });
    });
  });

  describe('convertGeminiToolToMcpTool', () => {
    it('should convert a basic tool', () => {
      const geminiTool: FunctionDeclaration = {
        name: 'searchEntities',
        description: 'Search for entities',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            query: {
              type: SchemaType.STRING,
              description: 'Search query',
            },
          },
          required: ['query'],
        },
      };

      const result = convertGeminiToolToMcpTool(geminiTool);

      expect(result).toEqual({
        name: 'searchEntities',
        description: 'Search for entities',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query',
            },
          },
          required: ['query'],
        },
      });
    });

    it('should provide default description if missing', () => {
      const geminiTool: FunctionDeclaration = {
        name: 'myTool',
      };

      const result = convertGeminiToolToMcpTool(geminiTool);

      expect(result.description).toBe('Execute the myTool tool');
    });

    it('should handle tool without parameters', () => {
      const geminiTool: FunctionDeclaration = {
        name: 'ping',
        description: 'Ping the server',
      };

      const result = convertGeminiToolToMcpTool(geminiTool);

      expect(result.inputSchema).toEqual({
        type: 'object',
        properties: {},
      });
    });
  });

  describe('convertGeminiToolsToMcpTools', () => {
    it('should convert multiple tools', () => {
      const geminiTools: FunctionDeclaration[] = [
        { name: 'tool1', description: 'First tool' },
        { name: 'tool2', description: 'Second tool' },
        { name: 'tool3', description: 'Third tool' },
      ];

      const result = convertGeminiToolsToMcpTools(geminiTools);

      expect(result).toHaveLength(3);
      expect(result.map((t) => t.name)).toEqual(['tool1', 'tool2', 'tool3']);
    });

    it('should handle empty array', () => {
      const result = convertGeminiToolsToMcpTools([]);
      expect(result).toEqual([]);
    });
  });

  describe('isValidToolName', () => {
    it('should accept valid tool names', () => {
      expect(isValidToolName('searchEntities')).toBe(true);
      expect(isValidToolName('create_company')).toBe(true);
      expect(isValidToolName('tool123')).toBe(true);
      expect(isValidToolName('A')).toBe(true);
    });

    it('should reject invalid tool names', () => {
      expect(isValidToolName('123tool')).toBe(false); // Starts with number
      expect(isValidToolName('tool-name')).toBe(false); // Contains hyphen
      expect(isValidToolName('tool.name')).toBe(false); // Contains dot
      expect(isValidToolName('tool name')).toBe(false); // Contains space
      expect(isValidToolName('')).toBe(false); // Empty
    });
  });

  describe('sanitizeToolName', () => {
    it('should keep valid names unchanged', () => {
      expect(sanitizeToolName('searchEntities')).toBe('searchEntities');
      expect(sanitizeToolName('tool_123')).toBe('tool_123');
    });

    it('should replace invalid characters with underscores', () => {
      expect(sanitizeToolName('tool-name')).toBe('tool_name');
      expect(sanitizeToolName('tool.name')).toBe('tool_name');
      expect(sanitizeToolName('tool name')).toBe('tool_name');
    });

    it('should prefix with tool_ if starts with number', () => {
      expect(sanitizeToolName('123tool')).toBe('tool_123tool');
    });
  });

  describe('getSchemaDebugInfo', () => {
    it('should return debug info for schema', () => {
      const info = getSchemaDebugInfo({
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'integer' },
        },
        required: ['name'],
      });

      expect(info).toBe('type=object, properties=2, required=1');
    });

    it('should handle schema without properties', () => {
      const info = getSchemaDebugInfo({ type: 'string' });
      expect(info).toBe('type=string, properties=0, required=0');
    });
  });
});
