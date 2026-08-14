/**
 * @file /api/mcp/debug
 * @description MCP Debug Endpoint - Shows tool access details for an API key
 *
 * This endpoint helps diagnose MCP tool access issues by showing:
 * 1. API key permissions
 * 2. Total tool counts
 * 3. Accessible vs blocked tools
 * 4. Tools grouped by permission requirement
 *
 * Authentication:
 *   Authorization: Bearer <api_key>
 *
 * @author Radarist Team
 * @created 2026-01-26
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey } from '@/lib/mcp/api-keys';
import { canExecuteTool, getToolPermissions, TOOL_PERMISSIONS } from '@/lib/mcp/permissions';
import { CORE_AI_TOOLS } from '@/lib/ai/tools';
import type { ApiKeyPermission } from '@/lib/mcp/types';

// ============================================================================
// CORS Headers
// ============================================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ============================================================================
// OPTIONS Handler (CORS preflight)
// ============================================================================

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

// ============================================================================
// GET Handler
// ============================================================================

/**
 * GET /api/mcp/debug
 *
 * Returns detailed tool access information for the authenticated API key.
 *
 * Response:
 * ```json
 * {
 *   "apiKey": {
 *     "id": "key-123",
 *     "name": "My Key",
 *     "permissions": ["read", "write", "signals"]
 *   },
 *   "toolCounts": {
 *     "total": 135,
 *     "accessible": 120,
 *     "blocked": 15
 *   },
 *   "accessibleTools": [...],
 *   "blockedTools": [
 *     { "name": "deleteEntity", "requiredPermissions": ["delete"] }
 *   ],
 *   "toolsByPermission": {
 *     "read": [...],
 *     "write": [...],
 *     ...
 *   }
 * }
 * ```
 */
export async function GET(request: NextRequest) {
  // Get API key from header
  const authHeader = request.headers.get('Authorization');
  const apiKeyString = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader;

  if (!apiKeyString) {
    return NextResponse.json(
      {
        error: 'API key required',
        usage: 'Include Authorization: Bearer <your_api_key> header',
      },
      { status: 401, headers: CORS_HEADERS }
    );
  }

  // Validate API key
  const apiKey = await validateApiKey(apiKeyString);

  if (!apiKey) {
    return NextResponse.json(
      { error: 'Invalid or expired API key' },
      { status: 401, headers: CORS_HEADERS }
    );
  }

  // Get all tool names
  // MCP exposes CORE_AI_TOOLS (curated subset) instead of ALL_AI_TOOLS
  const allToolNames = CORE_AI_TOOLS.map((t) => t.name);

  // Categorize tools by accessibility
  const accessibleTools: string[] = [];
  const blockedTools: { name: string; requiredPermissions: ApiKeyPermission[] }[] = [];

  for (const toolName of allToolNames) {
    if (canExecuteTool(apiKey.permissions, toolName)) {
      accessibleTools.push(toolName);
    } else {
      blockedTools.push({
        name: toolName,
        requiredPermissions: getToolPermissions(toolName),
      });
    }
  }

  // Group tools by permission requirement
  const toolsByPermission: Record<ApiKeyPermission, string[]> = {
    read: [],
    write: [],
    delete: [],
    signals: [],
    admin: [],
  };

  for (const [toolName, perms] of Object.entries(TOOL_PERMISSIONS)) {
    for (const perm of perms) {
      toolsByPermission[perm].push(toolName);
    }
  }

  // Tools with default 'read' permission (not explicitly mapped)
  const explicitlyMapped = new Set(Object.keys(TOOL_PERMISSIONS));
  const defaultReadTools = allToolNames.filter((t) => !explicitlyMapped.has(t));

  // Build response
  const response = {
    timestamp: new Date().toISOString(),
    apiKey: {
      id: apiKey.id,
      name: apiKey.name,
      permissions: apiKey.permissions,
      createdAt: new Date(apiKey.createdAt).toISOString(),
      expiresAt: apiKey.expiresAt
        ? new Date(apiKey.expiresAt).toISOString()
        : null,
    },
    toolCounts: {
      total: allToolNames.length,
      accessible: accessibleTools.length,
      blocked: blockedTools.length,
      accessPercentage: Math.round((accessibleTools.length / allToolNames.length) * 100),
    },
    permissionSummary: {
      hasRead: apiKey.permissions.includes('read'),
      hasWrite: apiKey.permissions.includes('write'),
      hasDelete: apiKey.permissions.includes('delete'),
      hasSignals: apiKey.permissions.includes('signals'),
      hasAdmin: apiKey.permissions.includes('admin'),
    },
    toolsByPermissionCount: {
      read: toolsByPermission.read.length + defaultReadTools.length,
      write: toolsByPermission.write.length,
      delete: toolsByPermission.delete.length,
      signals: toolsByPermission.signals.length,
      admin: toolsByPermission.admin.length,
    },
    accessibleTools: accessibleTools.sort(),
    blockedTools: blockedTools.sort((a, b) => a.name.localeCompare(b.name)),
    recommendations: generateRecommendations(apiKey.permissions, blockedTools),
  };

  return NextResponse.json(response, {
    status: 200,
    headers: CORS_HEADERS,
  });
}

/**
 * Generate recommendations based on blocked tools
 */
function generateRecommendations(
  currentPermissions: ApiKeyPermission[],
  blockedTools: { name: string; requiredPermissions: ApiKeyPermission[] }[]
): string[] {
  const recommendations: string[] = [];

  if (blockedTools.length === 0) {
    recommendations.push('Your API key has access to all available tools.');
    return recommendations;
  }

  // Find which permissions would unblock tools
  const missingPermissions = new Set<ApiKeyPermission>();

  for (const tool of blockedTools) {
    for (const perm of tool.requiredPermissions) {
      if (!currentPermissions.includes(perm)) {
        missingPermissions.add(perm);
      }
    }
  }

  if (missingPermissions.has('delete')) {
    const deleteTools = blockedTools.filter((t) =>
      t.requiredPermissions.includes('delete')
    );
    recommendations.push(
      `Add 'delete' permission to access ${deleteTools.length} delete tools (e.g., ${deleteTools.slice(0, 3).map((t) => t.name).join(', ')})`
    );
  }

  if (missingPermissions.has('admin')) {
    const adminTools = blockedTools.filter((t) =>
      t.requiredPermissions.includes('admin')
    );
    recommendations.push(
      `'admin' permission required for ${adminTools.length} tools (e.g., triggerPipeline). Note: admin cannot be self-assigned.`
    );
  }

  if (missingPermissions.has('signals')) {
    const signalTools = blockedTools.filter((t) =>
      t.requiredPermissions.includes('signals')
    );
    recommendations.push(
      `Add 'signals' permission to access ${signalTools.length} signal management tools`
    );
  }

  if (missingPermissions.has('write')) {
    const writeTools = blockedTools.filter((t) =>
      t.requiredPermissions.includes('write')
    );
    recommendations.push(
      `Add 'write' permission to access ${writeTools.length} create/update tools`
    );
  }

  if (recommendations.length === 0) {
    recommendations.push(
      'Some tools require multiple permissions. Check blockedTools for details.'
    );
  }

  return recommendations;
}
