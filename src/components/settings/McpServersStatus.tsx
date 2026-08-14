/**
 * @file McpServersStatus.tsx
 * @description MCP server connection status dashboard.
 *
 * Shows all MCP servers (internal + external) with live connection
 * status and expandable tool lists. Internal servers are live-pinged
 * via /api/mcp/tools-status. External servers show config-only status.
 *
 * @created 2026-02-23
 * @updated 2026-02-26
 */

'use client';

import { useState, useCallback, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Server, RefreshCw, CheckCircle2, XCircle, Clock, ChevronRight, Terminal, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { auth } from '@/lib/firebase';
import { fetchWithAuth } from '@/lib/fetch-with-auth';

// ============================================================================
// TYPES
// ============================================================================

interface InternalServer {
  name: string;
  slug: string;
  status: 'connected' | 'disconnected';
  tools: string[];
  version?: string;
}

interface ExternalServer {
  name: string;
  transport: string;
  command: string;
  args?: string[];
  status: 'configured';
}

interface ToolsStatusResponse {
  internal: InternalServer[];
  external: ExternalServer[];
}

// ============================================================================
// HELPERS
// ============================================================================

function StatusIcon({ status }: { status: 'connected' | 'disconnected' | 'configured' | 'checking' }) {
  switch (status) {
    case 'connected':
      return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
    case 'disconnected':
      return <XCircle className="h-4 w-4 text-destructive" />;
    case 'configured':
      return <CheckCircle2 className="h-4 w-4 text-blue-500" />;
    case 'checking':
      return <Clock className="h-4 w-4 text-muted-foreground animate-pulse" />;
  }
}

function statusBadgeVariant(status: string): 'default' | 'secondary' | 'destructive' {
  switch (status) {
    case 'connected':
      return 'secondary';
    case 'disconnected':
      return 'destructive';
    default:
      return 'default';
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'connected':
      return 'Connected';
    case 'disconnected':
      return 'Disconnected';
    case 'configured':
      return 'Configured';
    case 'checking':
      return 'Checking...';
    default:
      return status;
  }
}

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * MCP server status dashboard.
 *
 * Sections (counts come from /api/mcp/tools-status — currently 11 logical
 * internal servers: 6 platform domains + 4 gemini-* + super-graph):
 * - Internal Servers: live-pinged with expandable tool lists ("Connected"/"Disconnected")
 * - External Servers: config-only from impulse.config.yaml ("Configured")
 */
export function McpServersStatus() {
  const [data, setData] = useState<ToolsStatusResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());

  const fetchStatus = useCallback(async () => {
    try {
      const user = auth.currentUser;
      if (!user) return;
      const res = await fetchWithAuth('/api/mcp/tools-status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result: ToolsStatusResponse = await res.json();
      setData(result);
      return result;
    } catch {
      toast.error('Failed to fetch MCP server status');
      return null;
    }
  }, []);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    const result = await fetchStatus();
    setIsRefreshing(false);
    if (result) {
      const connected = result.internal.filter((s) => s.status === 'connected').length;
      const total = result.internal.length;
      if (connected === total) {
        toast.success('All internal servers connected');
      } else {
        toast.warning(`${connected} of ${total} internal servers connected`);
      }
    }
  }, [fetchStatus]);

  const toggleServer = useCallback((name: string) => {
    setExpandedServers((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    fetchStatus().finally(() => setIsLoading(false));
  }, [fetchStatus]);

  const internalServers = data?.internal ?? [];
  const externalServers = data?.external ?? [];
  const connectedCount = internalServers.filter((s) => s.status === 'connected').length;
  const totalTools = internalServers.reduce((sum, s) => sum + s.tools.length, 0);
  const totalServers = internalServers.length + externalServers.length;

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            {totalServers} servers total{' \u2022 '}
            {connectedCount} internal connected{' \u2022 '}
            {totalTools} tools available
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing || isLoading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${isRefreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardHeader className="py-4">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-9 w-9 rounded-lg" />
                  <div className="space-y-2 flex-1">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-64" />
                  </div>
                  <Skeleton className="h-6 w-24" />
                </div>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}

      {/* Internal Servers */}
      {!isLoading && internalServers.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-muted-foreground">Internal Servers ({internalServers.length})</h3>
          {internalServers.map((server) => {
            const isExpanded = expandedServers.has(server.name);
            return (
              <Collapsible key={server.name} open={isExpanded} onOpenChange={() => toggleServer(server.name)}>
                <Card>
                  <CollapsibleTrigger asChild>
                    <CardHeader className="py-4 cursor-pointer hover:bg-muted/50 transition-colors">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="h-9 w-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
                            <Server className="h-4 w-4 text-muted-foreground" />
                          </div>
                          <div className="min-w-0">
                            <CardTitle className="text-sm font-mono">{server.name}</CardTitle>
                            <CardDescription className="text-xs">
                              /api/mcp/{server.slug}
                              {server.version && ` \u2022 v${server.version}`}
                            </CardDescription>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 shrink-0 ml-4">
                          {server.status === 'connected' && (
                            <Badge variant="secondary" className="text-xs">
                              {server.tools.length} tools
                            </Badge>
                          )}
                          <Badge variant={statusBadgeVariant(server.status)} className="gap-1.5">
                            <StatusIcon status={server.status} />
                            {statusLabel(server.status)}
                          </Badge>
                          <ChevronRight
                            className={`h-4 w-4 text-muted-foreground transition-transform ${
                              isExpanded ? 'rotate-90' : ''
                            }`}
                          />
                        </div>
                      </div>
                    </CardHeader>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    {server.tools.length > 0 ? (
                      <CardContent className="pt-0 pb-4">
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5">
                          {server.tools.map((tool) => (
                            <div
                              key={tool}
                              className="flex items-center gap-1.5 text-xs text-muted-foreground px-2 py-1 rounded bg-muted/50"
                            >
                              <Wrench className="h-3 w-3 shrink-0" />
                              <span className="truncate font-mono">{tool}</span>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    ) : (
                      <CardContent className="pt-0 pb-4">
                        <p className="text-xs text-muted-foreground">
                          {server.status === 'disconnected'
                            ? 'Server is disconnected — cannot retrieve tools'
                            : 'No tools reported'}
                        </p>
                      </CardContent>
                    )}
                  </CollapsibleContent>
                </Card>
              </Collapsible>
            );
          })}
        </div>
      )}

      {/* External Servers */}
      {!isLoading && externalServers.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-muted-foreground">External Servers ({externalServers.length})</h3>
          {externalServers.map((server) => (
            <Card key={server.name}>
              <CardHeader className="py-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="h-9 w-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
                      <Terminal className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0">
                      <CardTitle className="text-sm font-mono">{server.name}</CardTitle>
                      <CardDescription className="text-xs truncate">
                        {server.command} {server.args?.join(' ') ?? ''}
                      </CardDescription>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 ml-4">
                    <Badge variant="secondary" className="text-xs">
                      {server.transport}
                    </Badge>
                    <Badge variant="default" className="gap-1.5">
                      <StatusIcon status="configured" />
                      Configured
                    </Badge>
                  </div>
                </div>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}

      {/* No servers */}
      {!isLoading && internalServers.length === 0 && externalServers.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No Servers Found</CardTitle>
            <CardDescription>Check impulse.config.yaml and ensure MCP servers are configured.</CardDescription>
          </CardHeader>
        </Card>
      )}
    </div>
  );
}
