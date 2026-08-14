'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  LayoutDashboard,
  Radar,
  Network,
  Library,
  Building2,
  Cpu,
  Lightbulb,
  FlaskConical,
  Target,
  Radio,
  Bot,
  Settings,
  Search,
  FileText,
  Clock,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';
import { useRecentItems } from '@/hooks/useRecentItems';
import { getCompanies } from '@/lib/companies';
import { getPrototypes } from '@/lib/prototypes';
import { getUseCases } from '@/lib/use-cases';
import { getStrategies } from '@/lib/strategies';
import type { EntityType } from '@/lib/types';
import { createLogger } from '@/lib/logger';
import { getEntityUrl } from '@/lib/entity-links';

const log = createLogger('ui/CommandPalette');

// ============================================================================
// TYPES
// ============================================================================

interface CommandItem {
  id: string;
  title: string;
  description?: string;
  icon: React.ElementType;
  shortcut?: string;
  action: () => void;
  keywords?: string[];
}

interface CommandGroup {
  heading: string;
  items: CommandItem[];
}

interface SearchResult {
  id: string;
  name: string;
  type: EntityType;
  description?: string;
}

const ENTITY_TYPE_CONFIG: Record<EntityType, { icon: React.ElementType; path: string }> = {
  company: { icon: Building2, path: '/library/companies' },
  technology: { icon: Cpu, path: '/library/technologies' },
  useCase: { icon: Lightbulb, path: '/library/use-cases' },
  prototype: { icon: FlaskConical, path: '/library/prototypes' },
  strategy: { icon: Target, path: '/library/strategies' },
  signal: { icon: Radio, path: '/triage/signals' },
  document: { icon: FileText, path: '/library/documents' },
  orgUnit: { icon: Building2, path: '/library/org-units' },
  initiative: { icon: Target, path: '/library/initiatives' },
  painPoint: { icon: Radio, path: '/library/pain-points' },
  radarPlacement: { icon: Radar, path: '/radar' },
};

// ============================================================================
// COMMAND PALETTE COMPONENT
// ============================================================================

interface CommandPaletteProps {
  /** Controlled open state */
  open?: boolean;
  /** Callback when open state changes */
  onOpenChange?: (open: boolean) => void;
}

/**
 * CommandPalette
 *
 * Global command palette accessible via Cmd+K (Mac) or Ctrl+K (Windows/Linux).
 * Provides quick navigation, search, and actions.
 *
 * Features:
 * - Navigation to any page
 * - Quick create actions
 * - AI Assistant access
 * - Keyboard-first interaction
 */
export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const router = useRouter();
  const [internalOpen, setInternalOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [searchResults, setSearchResults] = React.useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = React.useState(false);
  const { recentItems, addRecentItem } = useRecentItems();

  // Controlled or uncontrolled open state
  const isOpen = open ?? internalOpen;
  const setIsOpen = onOpenChange ?? setInternalOpen;

  // Keyboard shortcut handler
  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // Cmd+K or Ctrl+K
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setIsOpen(!isOpen);
      }
    };

    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [isOpen, setIsOpen]);

  // Entity search with debounce
  React.useEffect(() => {
    if (!searchQuery.trim() || searchQuery.length < 2) {
      setSearchResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const query = searchQuery.toLowerCase();
        const results: SearchResult[] = [];

        // Search across all entity types in parallel
        const [companies, prototypes, useCases, strategies] = await Promise.all([
          getCompanies().catch(() => []),
          getPrototypes().catch(() => []),
          getUseCases().catch(() => []),
          getStrategies().catch(() => []),
        ]);

        // Filter companies
        companies.forEach((c) => {
          if (c.name.toLowerCase().includes(query) || c.description?.toLowerCase().includes(query)) {
            results.push({ id: c.id, name: c.name, type: 'company', description: c.description });
          }
        });

        // Filter prototypes
        prototypes.forEach((p) => {
          if (p.name.toLowerCase().includes(query) || p.description?.toLowerCase().includes(query)) {
            results.push({ id: p.id, name: p.name, type: 'prototype', description: p.description });
          }
        });

        // Filter use cases
        useCases.forEach((u) => {
          if (u.title.toLowerCase().includes(query) || u.description?.toLowerCase().includes(query)) {
            results.push({ id: u.id, name: u.title, type: 'useCase', description: u.description });
          }
        });

        // Filter strategies
        strategies.forEach((s) => {
          if (s.name.toLowerCase().includes(query) || s.description?.toLowerCase().includes(query)) {
            results.push({ id: s.id, name: s.name, type: 'strategy', description: s.description });
          }
        });

        // Limit to 8 results
        setSearchResults(results.slice(0, 8));
      } catch (error) {
        log.error('Search failed', error instanceof Error ? error : undefined);
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Clear search when closing
  React.useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      setSearchResults([]);
    }
  }, [isOpen]);

  // Navigate and close
  const navigate = (href: string) => {
    router.push(href);
    setIsOpen(false);
  };

  // Navigate to entity and track. URL comes from the canonical entity-links
  // map — each list page's sheet listens to its own param (?company=, …);
  // the previous generic `?open=` was silently ignored by every page.
  const navigateToEntity = (result: SearchResult) => {
    const config = ENTITY_TYPE_CONFIG[result.type];
    const path = getEntityUrl(result.type, result.id) ?? config.path;
    addRecentItem({
      id: result.id,
      name: result.name,
      type: result.type,
      path,
    });
    router.push(path);
    setIsOpen(false);
  };

  // Action and close
  const runAction = (action: () => void) => {
    action();
    setIsOpen(false);
  };

  // Command groups configuration
  const commandGroups: CommandGroup[] = [
    {
      heading: 'Navigation',
      items: [
        {
          id: 'dashboard',
          title: 'Go to Dashboard',
          icon: LayoutDashboard,
          action: () => navigate('/dashboard'),
          keywords: ['home', 'overview'],
        },
        {
          id: 'radar',
          title: 'Go to Radar',
          icon: Radar,
          action: () => navigate('/visualizations/radar'),
          keywords: ['technology', 'visualization'],
        },
        {
          id: 'graph',
          title: 'Go to Relations Graph',
          icon: Network,
          action: () => navigate('/visualizations/graph'),
          keywords: ['network', 'connections'],
        },
        {
          id: 'library',
          title: 'Go to Library',
          icon: Library,
          action: () => navigate('/library'),
          keywords: ['entities', 'all'],
        },
        {
          id: 'signals',
          title: 'Go to Signals',
          icon: Radio,
          action: () => navigate('/triage/signals'),
          keywords: ['triage', 'approval'],
        },
        {
          id: 'agents',
          title: 'Go to Agents',
          icon: Bot,
          action: () => navigate('/agents/runs'),
          keywords: ['automation', 'ai'],
        },
        {
          // UX-068 — background verification jobs are their own Activity
          // surface now, so the palette can reach them without a detour
          // through Agent Runs.
          id: 'jobs',
          title: 'Go to Jobs',
          icon: ShieldCheck,
          action: () => navigate('/agents/jobs'),
          keywords: ['activity', 'verification', 'background', 'defense'],
        },
        {
          id: 'settings',
          title: 'Go to Settings',
          icon: Settings,
          action: () => navigate('/settings'),
          keywords: ['preferences', 'config'],
        },
      ],
    },
    {
      heading: 'Library',
      items: [
        {
          id: 'companies',
          title: 'Browse Companies',
          icon: Building2,
          action: () => navigate('/library/companies'),
          keywords: ['vendors', 'partners', 'startups'],
        },
        {
          id: 'technologies',
          title: 'Browse Technologies',
          icon: Cpu,
          action: () => navigate('/library/technologies'),
          keywords: ['tech', 'stack'],
        },
        {
          id: 'usecases',
          title: 'Browse Use Cases',
          icon: Lightbulb,
          action: () => navigate('/library/use-cases'),
          keywords: ['applications', 'scenarios'],
        },
        {
          id: 'prototypes',
          title: 'Browse Prototypes',
          icon: FlaskConical,
          action: () => navigate('/library/prototypes'),
          keywords: ['experiments', 'poc'],
        },
        {
          id: 'strategies',
          title: 'Browse Strategies',
          icon: Target,
          action: () => navigate('/library/strategies'),
          keywords: ['plans', 'goals'],
        },
      ],
    },
  ];

  return (
    <CommandDialog open={isOpen} onOpenChange={setIsOpen}>
      <CommandInput placeholder="Type a command or search..." value={searchQuery} onValueChange={setSearchQuery} />
      <CommandList>
        <CommandEmpty>
          {isSearching ? (
            <div className="flex items-center justify-center gap-2 py-6">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Searching...</span>
            </div>
          ) : (
            'No results found.'
          )}
        </CommandEmpty>

        {/* Search Results */}
        {searchResults.length > 0 && (
          <>
            <CommandGroup heading="Search Results">
              {searchResults.map((result) => {
                const config = ENTITY_TYPE_CONFIG[result.type];
                const Icon = config.icon;
                return (
                  <CommandItem
                    key={`${result.type}-${result.id}`}
                    value={`search ${result.name} ${result.type}`}
                    onSelect={() => navigateToEntity(result)}
                  >
                    <Icon className="mr-2 h-4 w-4" />
                    <div className="flex flex-col">
                      <span>{result.name}</span>
                      <span className="text-xs text-muted-foreground capitalize">{result.type}</span>
                    </div>
                  </CommandItem>
                );
              })}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {/* Recent Items */}
        {recentItems.length > 0 && !searchQuery && (
          <>
            <CommandGroup heading="Recent">
              {recentItems.slice(0, 5).map((item) => {
                const config = ENTITY_TYPE_CONFIG[item.type];
                const Icon = config.icon;
                return (
                  <CommandItem
                    key={`recent-${item.id}`}
                    value={`recent ${item.name} ${item.type}`}
                    onSelect={() => {
                      // Re-derive the canonical URL — stored paths can be stale
                      // (e.g. legacy `?open=` entries persisted in localStorage
                      // before the entity-links migration). Fall back to the
                      // stored path only for types without a canonical mapping.
                      router.push(getEntityUrl(item.type, item.id) ?? item.path);
                      setIsOpen(false);
                    }}
                  >
                    <Clock className="mr-2 h-4 w-4 text-muted-foreground" />
                    <Icon className="mr-2 h-4 w-4" />
                    <div className="flex flex-col">
                      <span>{item.name}</span>
                      <span className="text-xs text-muted-foreground capitalize">{item.type}</span>
                    </div>
                  </CommandItem>
                );
              })}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {commandGroups.map((group, groupIndex) => (
          <React.Fragment key={group.heading}>
            {groupIndex > 0 && <CommandSeparator />}
            <CommandGroup heading={group.heading}>
              {group.items.map((item) => (
                <CommandItem
                  key={item.id}
                  value={`${item.title} ${item.keywords?.join(' ') ?? ''}`}
                  onSelect={() => runAction(item.action)}
                >
                  <item.icon className="mr-2 h-4 w-4" />
                  <div className="flex flex-col">
                    <span>{item.title}</span>
                    {item.description && <span className="text-xs text-muted-foreground">{item.description}</span>}
                  </div>
                  {item.shortcut && <CommandShortcut>{item.shortcut}</CommandShortcut>}
                </CommandItem>
              ))}
            </CommandGroup>
          </React.Fragment>
        ))}
      </CommandList>
    </CommandDialog>
  );
}

// ============================================================================
// COMMAND PALETTE TRIGGER BUTTON
// ============================================================================

interface CommandPaletteTriggerProps {
  onClick?: () => void;
}

/**
 * A button to trigger the command palette.
 * Can be placed in the header or sidebar.
 */
export function CommandPaletteTrigger({ onClick }: CommandPaletteTriggerProps) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <Search className="h-4 w-4" />
      <span className="hidden sm:inline">Search...</span>
      <kbd className="pointer-events-none ml-2 hidden h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium opacity-100 sm:flex">
        <span className="text-xs">⌘</span>K
      </kbd>
    </button>
  );
}
