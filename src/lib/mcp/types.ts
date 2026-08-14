/**
 * @file mcp/types.ts
 * @description Type definitions for the MCP (Model Context Protocol) server
 *
 * @author Radarist Team
 * @created 2026-01-22
 */

// ============================================================================
// JSON-RPC Types
// ============================================================================

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ============================================================================
// JSON-RPC Error Codes
// ============================================================================

export const JSON_RPC_ERROR_CODES = {
  // Standard JSON-RPC errors
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  // Custom MCP errors
  UNAUTHORIZED: -32001,
  FORBIDDEN: -32003,
  NOT_FOUND: -32004,
  TOOL_EXECUTION_ERROR: -32010,
  RATE_LIMITED: -32020,
} as const;

// ============================================================================
// MCP Protocol Types
// ============================================================================

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpCapabilities {
  tools?: {
    listChanged?: boolean;
  };
  /**
   * Resource capability (L3 Memory-as-resources).
   *
   * NOTE (Wave 0 contract freeze): this is declared but NOT advertised in
   * `SERVER_CAPABILITIES` yet. Flipping it on goes live with P1.5 (G1).
   * `listChanged` is the canonical advertised field; `subscribe` is reserved
   * for a future subscription surface and stays optional.
   */
  resources?: {
    subscribe?: boolean;
    listChanged?: boolean;
  };
  prompts?: {
    listChanged?: boolean;
  };
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: McpCapabilities;
  serverInfo: McpServerInfo;
}

// ============================================================================
// MCP Resource Types (L3 Memory-as-resources)
// ============================================================================

/**
 * A resource descriptor returned by `resources/list`.
 *
 * `uri` is a `radarist://` URI per the grammar in `resource-uris.ts`.
 */
export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/**
 * The contents of a single resource returned by `resources/read`.
 *
 * Wave 0 contract: only text resources are modeled; binary blobs are out of
 * scope for the ambient substrate sprint.
 */
export interface McpResourceContents {
  uri: string;
  mimeType?: string;
  text: string;
}

// ============================================================================
// Skill-as-Prompt Types (L2 Skills-as-prompts)
// ============================================================================

/**
 * A skill exposed through the MCP `prompts/*` surface.
 *
 * `body` is the verbatim SKILL.md content; `contentHash` is a tamper-evident
 * digest of `body` computed at build time (see Lane B's
 * `scripts/build-skill-prompts.ts`). The generated manifest lives at
 * `src/lib/mcp/generated/skill-prompts.ts`.
 */
export interface SkillPrompt {
  name: string;
  description: string;
  body: string;
  contentHash: string;
}

// ============================================================================
// MCP Tool Types
// ============================================================================

export interface McpTool {
  name: string;
  description: string;
  inputSchema: McpJsonSchema;
}

export interface McpJsonSchema {
  type: string;
  description?: string;
  properties?: Record<string, McpJsonSchema>;
  required?: string[];
  items?: McpJsonSchema;
  enum?: string[];
  format?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
}

export interface McpToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface McpToolCallResult {
  content: McpContent[];
  isError?: boolean;
}

export interface McpContent {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
}

// ============================================================================
// API Key Types
// ============================================================================

export type ApiKeyPermission =
  | 'read' // List/get entities
  | 'write' // Create/update entities
  | 'delete' // Delete entities
  | 'signals' // Manage signals
  | 'admin'; // Full access

export interface ApiKey {
  id: string;
  hashedKey: string;
  userId: string;
  name: string;
  permissions: ApiKeyPermission[];
  createdAt: number;
  lastUsedAt?: number;
  expiresAt?: number | null;
  revokedAt?: number | null;
}

export interface ApiKeyPublic {
  id: string;
  name: string;
  permissions: ApiKeyPermission[];
  createdAt: number;
  lastUsedAt?: number;
  expiresAt?: number | null;
  prefix: string;
}

export interface CreateApiKeyInput {
  userId: string;
  name: string;
  permissions?: ApiKeyPermission[];
  expiresInDays?: number;
}

export interface CreateApiKeyResult {
  key: string;
  apiKey: ApiKeyPublic;
}

// ============================================================================
// MCP Context
// ============================================================================

export interface McpContext {
  apiKey: ApiKey;
}

// ============================================================================
// MCP Methods
// ============================================================================

export type McpMethod =
  | 'initialize'
  | 'initialized'
  | 'ping'
  | 'tools/list'
  | 'tools/call'
  | 'resources/list'
  | 'resources/read'
  | 'prompts/list'
  | 'prompts/get';
