/**
 * @file QueryTemplates.tsx
 * @description Preset query templates in a compact dropdown menu
 *
 * Features:
 * - Dropdown menu for query templates
 * - Categorized by use case
 * - Unique icons per template
 *
 * @author Radarist Team
 * @created 2026-01-18
 */

"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ChevronDown,
  Circle,
  GitFork,
  Building2,
  Cpu,
  Lightbulb,
  Users,
  Route,
  Link2,
  TrendingUp,
  FileText,
  LayoutTemplate,
} from "lucide-react";
import { currentEdgePredicate, currentPathPredicate } from "@/lib/graph-query-current";

// ============================================================================
// TYPES
// ============================================================================

interface QueryTemplate {
  id: string;
  label: string;
  description: string;
  query: string;
  icon: React.ElementType;
  category: "overview" | "entities" | "paths" | "analysis";
}

interface QueryTemplatesProps {
  /** Callback when a template is selected */
  onSelect: (query: string) => void;
  /** Whether templates are disabled */
  disabled?: boolean;
}

// ============================================================================
// TEMPLATES
// ============================================================================

export const TEMPLATES: QueryTemplate[] = [
  // Overview queries
  {
    id: "all-nodes",
    label: "All Nodes",
    description: "Return all nodes in the graph (limited to 500)",
    query: "MATCH (n) RETURN n LIMIT 500",
    icon: Circle,
    category: "overview",
  },
  {
    id: "all-relationships",
    label: "All Relationships",
    description: "Return all nodes and relationships (limited to 500)",
    query: `MATCH (n)-[r]->(m)
WHERE ${currentEdgePredicate("r")}
RETURN n, r, m
LIMIT 500`,
    icon: GitFork,
    category: "overview",
  },

  // Entity-specific queries
  {
    id: "companies-technologies",
    label: "Companies & Tech",
    description: "Show companies and their technology relationships",
    query: `MATCH (c:Company)-[r]-(t:Technology)
WHERE ${currentEdgePredicate("r")}
RETURN c, r, t
LIMIT 200`,
    icon: Building2,
    category: "entities",
  },
  {
    id: "technologies",
    label: "Technologies",
    description: "Return all technology nodes",
    query: "MATCH (t:Technology) RETURN t LIMIT 200",
    icon: Cpu,
    category: "entities",
  },
  {
    id: "use-cases",
    label: "Use Cases",
    description: "Show use cases and their technology connections",
    query: `MATCH (u:UseCase)-[r]-(t)
WHERE ${currentEdgePredicate("r")}
RETURN u, r, t
LIMIT 200`,
    icon: Lightbulb,
    category: "entities",
  },
  {
    id: "org-structure",
    label: "Org Structure",
    description: "Show organizational units and their relationships",
    query: `MATCH (o:OrgUnit)-[r]-(x)
WHERE ${currentEdgePredicate("r")}
RETURN o, r, x
LIMIT 200`,
    icon: Users,
    category: "entities",
  },

  // Path finding queries
  {
    id: "shortest-path",
    label: "Find Path",
    description: "Find shortest path between two nodes (edit names)",
    query: `MATCH path = shortestPath((a)-[*..5]-(b))
	WHERE a.name = 'NodeA' AND b.name = 'NodeB'
	  AND ${currentPathPredicate("path")}
	RETURN path
LIMIT 5`,
    icon: Route,
    category: "paths",
  },
  {
    id: "connected-entities",
    label: "Connected Entities",
    description: "Find all entities connected to a specific node (edit name)",
    query: `MATCH path = (n {name: 'NodeName'})-[*1..2]-(connected)
	WHERE ${currentPathPredicate("path")}
	RETURN path
LIMIT 100`,
    icon: Link2,
    category: "paths",
  },

  // Analysis queries
  {
    id: "most-connected",
    label: "Most Connected",
    description: "Find the most connected nodes in the graph",
    query: `MATCH (n)-[r]-()
	WHERE ${currentEdgePredicate("r")}
	WITH n, count(r) as connections
ORDER BY connections DESC
	LIMIT 20
	MATCH (n)-[r]-(m)
	WHERE ${currentEdgePredicate("r")}
	RETURN n, r, m`,
    icon: TrendingUp,
    category: "analysis",
  },
  {
    id: "documents",
    label: "Documents",
    description: "Show documents and their entity links",
    query: `MATCH (d:Document)-[r]-(e)
WHERE ${currentEdgePredicate("r")}
RETURN d, r, e
LIMIT 200`,
    icon: FileText,
    category: "analysis",
  },
];

const CATEGORIES = [
  { key: "overview", label: "Overview" },
  { key: "entities", label: "Entities" },
  { key: "paths", label: "Paths" },
  { key: "analysis", label: "Analysis" },
] as const;

// ============================================================================
// COMPONENT
// ============================================================================

export function QueryTemplates({ onSelect, disabled = false }: QueryTemplatesProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className="h-9 gap-1.5 px-3"
        >
          <LayoutTemplate className="h-4 w-4" />
          Templates
          <ChevronDown className="h-3.5 w-3.5 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-[min(280px,calc(100vw-1rem))] overflow-y-auto overscroll-contain"
      >
        {CATEGORIES.map((category, idx) => (
          <DropdownMenuGroup key={category.key}>
            {idx > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {category.label}
            </DropdownMenuLabel>
            {TEMPLATES.filter((t) => t.category === category.key).map((template) => {
              const Icon = template.icon;
              return (
                <DropdownMenuItem
                  key={template.id}
                  onClick={() => onSelect(template.query)}
                  className="cursor-pointer"
                >
                  <Icon className="h-4 w-4 mr-2 text-muted-foreground" />
                  <div className="flex flex-col">
                    <span className="text-sm">{template.label}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {template.description}
                    </span>
                  </div>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
