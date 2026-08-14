/**
 * @file GraphDetailPanel.tsx
 * @description Detail panel for showing selected node or relationship properties
 *
 * Features:
 * - Key-value property display
 * - Labels and type display
 * - Link to entity page (for entities)
 * - Copy ID button
 * - Expand neighbors button
 *
 * @author Radarist Team
 * @created 2026-01-18
 */

'use client';

import { Copy, ExternalLink, Circle, ArrowRight, Loader2, Network, X, Focus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { getEntityTypeFromGraphLabels, getEntityUrl, resolveGraphNodeEntityId } from '@/lib/entity-links';
import { entityColorHex, relationColorHex } from '@/lib/entity-colors';

// ============================================================================
// TYPES
// ============================================================================

interface SelectedNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
  caption?: string;
}

interface SelectedRelationship {
  id: string;
  from: string;
  to: string;
  type: string;
  properties: Record<string, unknown>;
}

export type GraphExpansionState = 'idle' | 'loading' | 'complete' | 'global-limit' | 'stalled';

interface GraphDetailPanelProps {
  /** Selected node (if any) */
  selectedNode?: SelectedNode | null;
  /** Selected relationship (if any) */
  selectedRelationship?: SelectedRelationship | null;
  /** Callback to expand neighbors for a node */
  onExpandNeighbors?: (nodeId: string) => void;
  /** GRAPH-067 — isolate the selected node's one-hop neighborhood on the canvas */
  onIsolateNode?: (nodeId: string) => void;
  /** GRAPH-067 — whether this selected node's neighborhood is currently isolated */
  isIsolated?: boolean;
  /** Current progressive-expansion state for the selected node. */
  expansionState?: GraphExpansionState;
  /** Callback to close the panel */
  onClose?: () => void;
  /** Custom class name */
  className?: string;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Build the "View Entity" deep link for a graph node, or null when the node
 * is not an entity / carries no usable Firestore id. The renderer node `id` is the
 * Neo4j elementId — NOT the Firestore id, which lives in `properties.id`
 * (see resolveGraphNodeEntityId). Callers hide the button on null instead of
 * linking to a sheet that can never resolve.
 */
function getNodeEntityUrl(node: SelectedNode): string | null {
  const entityType = getEntityTypeFromGraphLabels(node.labels);
  const entityId = resolveGraphNodeEntityId(node);
  if (!entityType || !entityId) {
    return null;
  }
  return getEntityUrl(entityType, entityId);
}

/**
 * Format a property value for display
 */
function formatPropertyValue(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return String(value);
}

/**
 * Check if a property should be displayed
 */
function shouldDisplayProperty(key: string): boolean {
  // Skip internal properties
  const internalProps = ['_labels', 'elementId', 'identity'];
  return !internalProps.includes(key);
}

// ============================================================================
// PROPERTY ROW COMPONENT
// ============================================================================

function PropertyRow({ propKey, value }: { propKey: string; value: unknown }) {
  const formattedValue = formatPropertyValue(value);
  const isLongValue = formattedValue.length > 50;

  return (
    <div className="py-1.5 px-1 rounded hover:bg-muted/50">
      <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{propKey}</div>
      <div className={cn('text-xs font-mono break-all', isLongValue && 'whitespace-pre-wrap')}>{formattedValue}</div>
    </div>
  );
}

// ============================================================================
// COMPONENT
// ============================================================================

export function GraphDetailPanel({
  selectedNode,
  selectedRelationship,
  onExpandNeighbors,
  onIsolateNode,
  isIsolated = false,
  expansionState = 'idle',
  onClose,
  className,
}: GraphDetailPanelProps) {
  const { toast } = useToast();

  // Handle copy ID
  const handleCopyId = (id: string) => {
    navigator.clipboard.writeText(id);
    toast({
      title: 'Copied',
      description: 'ID copied to clipboard',
    });
  };

  // No selection
  if (!selectedNode && !selectedRelationship) {
    return (
      <div className={cn('flex flex-col h-full bg-background border-l', className)}>
        <div className="p-3 border-b">
          <h3 className="font-semibold text-sm">Details</h3>
        </div>
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-xs text-muted-foreground text-center">Click a node or relationship to view its details</p>
        </div>
      </div>
    );
  }

  // Node selected
  if (selectedNode) {
    const entityUrl = getNodeEntityUrl(selectedNode);
    const primaryLabel = selectedNode.labels.find((l) => l !== 'Entity') || selectedNode.labels[0];
    const color = entityColorHex(primaryLabel || '');

    // Get sorted properties
    const propertyEntries = Object.entries(selectedNode.properties)
      .filter(([key]) => shouldDisplayProperty(key))
      .sort(([a], [b]) => a.localeCompare(b));

    return (
      <div className={cn('flex flex-col h-full bg-background border-l', className)}>
        {/* Header */}
        <div className="p-3 border-b">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-sm flex items-center gap-2">
              <Circle className="h-3 w-3" style={{ fill: color, color: color }} />
              Node
            </h3>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={onClose}
              aria-label="Close node details"
              title="Close node details"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex flex-wrap gap-1 mt-2">
            {selectedNode.labels.map((label) => (
              <Badge
                key={label}
                variant="secondary"
                className="text-[10px]"
                style={{
                  backgroundColor: `${entityColorHex(label)}20`,
                  color: entityColorHex(label),
                }}
              >
                {label}
              </Badge>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-1 border-b p-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs flex-1"
            onClick={() => handleCopyId(selectedNode.id)}
          >
            <Copy className="h-3 w-3 mr-1" />
            Copy ID
          </Button>
          {entityUrl && (
            <Button variant="outline" size="sm" className="h-7 text-xs flex-1" asChild>
              <a href={entityUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3 w-3 mr-1" />
                View Entity
              </a>
            </Button>
          )}
          {onExpandNeighbors && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 min-w-[6.75rem] flex-1 text-xs"
              onClick={() => onExpandNeighbors(selectedNode.id)}
              disabled={expansionState !== 'idle'}
              title={
                expansionState === 'complete'
                  ? 'All current neighbors are visible'
                  : expansionState === 'global-limit'
                    ? 'Narrow the query to expand beyond the display limit'
                    : expansionState === 'stalled'
                      ? 'Rerun the base query before expanding again'
                      : undefined
              }
            >
              {expansionState === 'loading' ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Network className="mr-1 h-3 w-3" />
              )}
              {expansionState === 'loading'
                ? 'Expanding'
                : expansionState === 'complete'
                  ? 'Complete'
                  : expansionState === 'global-limit'
                    ? 'Limit reached'
                    : expansionState === 'stalled'
                      ? 'Unavailable'
                      : 'Expand'}
            </Button>
          )}
          {onIsolateNode && (
            <Button
              variant={isIsolated ? 'default' : 'outline'}
              size="sm"
              className="h-7 min-w-[6.75rem] flex-1 text-xs"
              onClick={() => onIsolateNode(selectedNode.id)}
              aria-pressed={isIsolated}
              title={
                isIsolated
                  ? 'Clear isolate — restore the full graph and the prior viewport'
                  : 'Isolate this node and its one-hop neighborhood on the canvas'
              }
            >
              <Focus className="mr-1 h-3 w-3" />
              {isIsolated ? 'Clear isolate' : 'Isolate'}
            </Button>
          )}
        </div>

        {/* Properties */}
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-1">
            <div className="text-xs font-medium text-muted-foreground mb-2">Properties ({propertyEntries.length})</div>
            {propertyEntries.length === 0 ? (
              <p className="text-xs text-muted-foreground">No properties</p>
            ) : (
              propertyEntries.map(([key, value]) => <PropertyRow key={key} propKey={key} value={value} />)
            )}
          </div>
        </ScrollArea>
      </div>
    );
  }

  // Relationship selected
  if (selectedRelationship) {
    const color = relationColorHex(selectedRelationship.type);

    // Get sorted properties
    const propertyEntries = Object.entries(selectedRelationship.properties)
      .filter(([key]) => shouldDisplayProperty(key))
      .sort(([a], [b]) => a.localeCompare(b));

    return (
      <div className={cn('flex flex-col h-full bg-background border-l', className)}>
        {/* Header */}
        <div className="p-3 border-b">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-sm flex items-center gap-2">
              <ArrowRight className="h-3 w-3" style={{ color: color }} />
              Relationship
            </h3>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={onClose}
              aria-label="Close relationship details"
              title="Close relationship details"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <Badge
            variant="secondary"
            className="mt-2 text-[10px] font-mono"
            style={{
              backgroundColor: `${color}20`,
              color: color,
            }}
          >
            {selectedRelationship.type}
          </Badge>
        </div>

        {/* Connection Info */}
        <div className="p-2 border-b">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Connection</div>
          <div className="text-xs font-mono">
            <span className="text-muted-foreground">From:</span> {selectedRelationship.from}
          </div>
          <div className="text-xs font-mono">
            <span className="text-muted-foreground">To:</span> {selectedRelationship.to}
          </div>
        </div>

        {/* Actions */}
        <div className="p-2 border-b flex gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs flex-1"
            onClick={() => handleCopyId(selectedRelationship.id)}
          >
            <Copy className="h-3 w-3 mr-1" />
            Copy ID
          </Button>
        </div>

        {/* Properties */}
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-1">
            <div className="text-xs font-medium text-muted-foreground mb-2">Properties ({propertyEntries.length})</div>
            {propertyEntries.length === 0 ? (
              <p className="text-xs text-muted-foreground">No properties</p>
            ) : (
              propertyEntries.map(([key, value]) => <PropertyRow key={key} propKey={key} value={value} />)
            )}
          </div>
        </ScrollArea>
      </div>
    );
  }

  return null;
}
