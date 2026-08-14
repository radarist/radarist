/**
 * @file McpApiKeysPanel.tsx
 * @description MCP API Keys management panel for the Settings page (MCP Servers tab).
 *
 * Allows users to create, list and revoke `tp_live_` API keys that external
 * AI assistants (Claude Desktop, Cursor, …) use to access Radarist via the
 * MCP protocol (`/api/mcp/[server]`). Backed by /api/mcp/keys (Firebase
 * ID-token gated).
 *
 * Restored 2026-06-10 from pre-2c8a82c4 history and modernized:
 * - sonner toasts (settings-page convention) instead of useToast
 * - fetchWithAuth handles token injection — no manual getIdToken plumbing
 * - `expiresInDays` omitted (not null) for "never expires" — the keys route
 *   rejects non-number values
 * - shadcn Select for expiry instead of a native <select>
 * - Skeleton loading state instead of a spinner
 *
 * @author Radarist Team
 * @created 2026-01-22
 * @updated 2026-06-10
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Key, Plus, Copy, Check, Trash2, Loader2, Clock, Shield, AlertTriangle, Terminal } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/components/providers/AuthProvider';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { createLogger } from '@/lib/logger';
import type { ApiKeyPublic, ApiKeyPermission } from '@/lib/mcp/types';

const log = createLogger('ui/McpApiKeysPanel');

// ============================================================================
// Types
// ============================================================================

interface CreateKeyFormData {
  name: string;
  permissions: ApiKeyPermission[];
  expiresInDays: number | null;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_FORM: CreateKeyFormData = {
  name: '',
  permissions: ['read', 'write', 'signals'],
  expiresInDays: null,
};

const PERMISSION_OPTIONS: {
  value: ApiKeyPermission;
  label: string;
  description: string;
}[] = [
  { value: 'read', label: 'Read', description: 'View entities and data' },
  { value: 'write', label: 'Write', description: 'Create and update entities' },
  { value: 'delete', label: 'Delete', description: 'Remove entities' },
  { value: 'signals', label: 'Signals', description: 'Approve/reject signals' },
];

/** Select stores strings — 'never' maps to expiresInDays: null. */
const EXPIRY_OPTIONS: { value: string; label: string }[] = [
  { value: 'never', label: 'Never expires' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '180', label: '180 days' },
  { value: '365', label: '1 year' },
];

// ============================================================================
// Component
// ============================================================================

/**
 * MCP API Keys Panel
 *
 * Create / list / revoke / copy UI for `tp_live_` keys, mounted in the
 * Settings → MCP Servers tab below the server status list.
 */
export function McpApiKeysPanel() {
  const { user, loading: authLoading } = useAuth();

  // State
  const [keys, setKeys] = useState<ApiKeyPublic[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [isDeleting, setIsDeleting] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Form state
  const [formData, setFormData] = useState<CreateKeyFormData>(DEFAULT_FORM);

  /**
   * Fetch the user's API keys. fetchWithAuth injects the Firebase ID token.
   */
  const fetchKeys = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await fetchWithAuth('/api/mcp/keys');

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const data = (await response.json()) as { data?: ApiKeyPublic[] };
      setKeys(data.data ?? []);
    } catch (error) {
      log.error('Failed to fetch API keys', error instanceof Error ? error : undefined);
      toast.error('Failed to load API keys', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Load keys once auth is ready.
   */
  useEffect(() => {
    if (authLoading) return;
    if (user) {
      void fetchKeys();
    } else {
      setIsLoading(false);
    }
  }, [authLoading, user, fetchKeys]);

  /**
   * Create a new API key.
   */
  const handleCreate = async () => {
    if (!formData.name.trim()) {
      toast.error('Name required', { description: 'Please enter a name for the API key' });
      return;
    }
    if (formData.permissions.length === 0) {
      toast.error('Permissions required', { description: 'Please select at least one permission' });
      return;
    }

    try {
      setIsCreating(true);
      const response = await fetchWithAuth('/api/mcp/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name.trim(),
          permissions: formData.permissions,
          // The route rejects non-number values — omit for "never expires".
          ...(formData.expiresInDays !== null ? { expiresInDays: formData.expiresInDays } : {}),
        }),
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(errorData.error || 'Failed to create API key');
      }

      const data = (await response.json()) as { data?: { key?: string } };
      if (!data.data?.key) {
        throw new Error('Key creation response was missing the key value');
      }
      setNewKeyValue(data.data.key);
      setShowCreateDialog(false);
      setFormData(DEFAULT_FORM);

      await fetchKeys();
    } catch (error) {
      log.error('Failed to create API key', error instanceof Error ? error : undefined);
      toast.error('Creation failed', {
        description: error instanceof Error ? error.message : 'Failed to create API key',
      });
    } finally {
      setIsCreating(false);
    }
  };

  /**
   * Revoke an API key.
   */
  const handleRevoke = async (keyId: string) => {
    try {
      setIsDeleting(keyId);
      const response = await fetchWithAuth(`/api/mcp/keys?id=${encodeURIComponent(keyId)}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(errorData.error || 'Failed to revoke API key');
      }

      toast.success('Key revoked', {
        description: 'The API key has been revoked and can no longer be used',
      });
      await fetchKeys();
    } catch (error) {
      log.error('Failed to revoke API key', error instanceof Error ? error : undefined);
      toast.error('Revoke failed', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setIsDeleting(null);
    }
  };

  /**
   * Copy the freshly created key to the clipboard.
   */
  const handleCopy = async () => {
    if (!newKeyValue) return;
    try {
      await navigator.clipboard.writeText(newKeyValue);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success('Copied', { description: 'API key copied to clipboard' });
    } catch (error) {
      log.error('Clipboard write failed', error instanceof Error ? error : undefined);
      toast.error('Copy failed', { description: 'Failed to copy to clipboard' });
    }
  };

  const formatDate = (timestamp: number) =>
    new Date(timestamp).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });

  const togglePermission = (perm: ApiKeyPermission) => {
    setFormData((prev) => ({
      ...prev,
      permissions: prev.permissions.includes(perm)
        ? prev.permissions.filter((p) => p !== perm)
        : [...prev.permissions, perm],
    }));
  };

  return (
    <div className="space-y-4">
      {/* Header Card */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Key className="h-5 w-5" />
                MCP API Keys
              </CardTitle>
              <CardDescription className="mt-1">
                Create API keys to let external AI assistants (Claude Desktop, Cursor, etc.) access Radarist via the
                Model Context Protocol.
              </CardDescription>
            </div>
            <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
              <DialogTrigger asChild>
                <Button size="sm" disabled={!user}>
                  <Plus className="h-4 w-4 mr-2" />
                  Create Key
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create API Key</DialogTitle>
                  <DialogDescription>Create a new API key for external AI assistant access.</DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-4">
                  {/* Name */}
                  <div className="space-y-2">
                    <Label htmlFor="key-name">Name</Label>
                    <Input
                      id="key-name"
                      placeholder="e.g., Claude Desktop"
                      value={formData.name}
                      onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                    />
                    <p className="text-xs text-muted-foreground">A descriptive name to identify this key</p>
                  </div>

                  {/* Permissions */}
                  <div className="space-y-2">
                    <Label>Permissions</Label>
                    <div className="space-y-2">
                      {PERMISSION_OPTIONS.map((option) => (
                        <div key={option.value} className="flex items-center space-x-2">
                          <Checkbox
                            id={`perm-${option.value}`}
                            checked={formData.permissions.includes(option.value)}
                            onCheckedChange={() => togglePermission(option.value)}
                          />
                          <div className="grid gap-0.5 leading-none">
                            <label htmlFor={`perm-${option.value}`} className="text-sm font-medium cursor-pointer">
                              {option.label}
                            </label>
                            <p className="text-xs text-muted-foreground">{option.description}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Expiry */}
                  <div className="space-y-2">
                    <Label htmlFor="key-expiry">Expiration</Label>
                    <Select
                      value={formData.expiresInDays === null ? 'never' : String(formData.expiresInDays)}
                      onValueChange={(value) =>
                        setFormData((prev) => ({
                          ...prev,
                          expiresInDays: value === 'never' ? null : Number(value),
                        }))
                      }
                    >
                      <SelectTrigger id="key-expiry">
                        <SelectValue placeholder="Never expires" />
                      </SelectTrigger>
                      <SelectContent>
                        {EXPIRY_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <DialogFooter>
                  <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
                    Cancel
                  </Button>
                  <Button onClick={handleCreate} disabled={isCreating}>
                    {isCreating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    Create Key
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>
      </Card>

      {/* New Key Display Dialog */}
      <Dialog open={!!newKeyValue} onOpenChange={(open) => !open && setNewKeyValue(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Check className="h-5 w-5 text-emerald-500" />
              API Key Created
            </DialogTitle>
            <DialogDescription>Copy your API key now. You won&apos;t be able to see it again.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="flex items-center gap-2">
              <code className="flex-1 text-sm bg-muted px-3 py-2 rounded font-mono break-all">{newKeyValue}</code>
              <Button size="icon" variant="outline" onClick={handleCopy} aria-label="Copy API key">
                {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>

            <div className="flex items-start gap-2 p-3 bg-yellow-500/10 border border-yellow-500/20 rounded text-sm">
              <AlertTriangle className="h-4 w-4 text-yellow-500 mt-0.5 flex-shrink-0" />
              <p className="text-yellow-700 dark:text-yellow-300">
                Store this key securely. It cannot be retrieved after closing this dialog.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button onClick={() => setNewKeyValue(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Keys List */}
      {isLoading ? (
        <Card>
          <CardContent className="py-4 space-y-3">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-72" />
            <Skeleton className="h-4 w-56" />
          </CardContent>
        </Card>
      ) : keys.length === 0 ? (
        <Card>
          <CardContent className="py-8">
            <div className="text-center text-muted-foreground">
              <Key className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>No API keys created yet</p>
              <p className="text-sm mt-1">Create a key to allow external AI assistants to access Radarist</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {keys.map((key) => (
            <Card key={key.id}>
              <CardContent className="py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h4 className="font-medium truncate">{key.name}</h4>
                      {key.expiresAt != null && key.expiresAt < Date.now() && (
                        <Badge variant="destructive" className="text-xs">
                          Expired
                        </Badge>
                      )}
                    </div>
                    <code className="text-xs text-muted-foreground font-mono">{key.prefix}</code>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {key.permissions.map((perm) => (
                        <Badge key={perm} variant="secondary" className="text-xs">
                          {perm}
                        </Badge>
                      ))}
                    </div>
                    <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        Created {formatDate(key.createdAt)}
                      </span>
                      {key.lastUsedAt != null && <span>Last used {formatDate(key.lastUsedAt)}</span>}
                      {key.expiresAt != null && (
                        <span className="flex items-center gap-1">
                          <Shield className="h-3 w-3" />
                          Expires {formatDate(key.expiresAt)}
                        </span>
                      )}
                    </div>
                  </div>

                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive"
                        disabled={isDeleting === key.id}
                        aria-label={`Revoke API key ${key.name}`}
                      >
                        {isDeleting === key.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Revoke API Key?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will immediately revoke the API key &quot;{key.name}&quot;. Any applications using this
                          key will lose access. This action cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => handleRevoke(key.id)}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          Revoke Key
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Connection hint */}
      <Card className="bg-muted/30">
        <CardContent className="py-4">
          <div className="flex items-start gap-3">
            <Terminal className="h-5 w-5 text-muted-foreground mt-0.5" />
            <div className="min-w-0">
              <p className="text-sm font-medium">Connecting a client</p>
              <p className="text-xs text-muted-foreground mt-1">
                Point your MCP client at{' '}
                <code className="font-mono bg-muted px-1 py-0.5 rounded">/api/mcp/&#123;server&#125;</code> (servers:
                entities, graph, signals, research, radar, reports) and send the key via the{' '}
                <code className="font-mono bg-muted px-1 py-0.5 rounded">x-api-key</code> header or{' '}
                <code className="font-mono bg-muted px-1 py-0.5 rounded">Authorization: Bearer</code>.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
