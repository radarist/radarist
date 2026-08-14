'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
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
  ClipboardCheck,
  Settings,
  Home,
} from 'lucide-react';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';

// ============================================================================
// TYPES
// ============================================================================

interface BreadcrumbSegment {
  label: string;
  href: string;
  icon?: React.ElementType;
}

// ============================================================================
// ROUTE CONFIGURATION
// ============================================================================

/**
 * Map of path segments to human-readable labels and icons.
 * This handles both static routes and provides defaults for dynamic segments.
 */
const routeConfig: Record<string, { label: string; icon?: React.ElementType }> = {
  // Main sections
  dashboard: { label: 'Dashboard', icon: LayoutDashboard },
  visualizations: { label: 'Visualizations' },
  library: { label: 'Library', icon: Library },
  signals: { label: 'Signals', icon: Radio },
  triage: { label: 'Triage', icon: ClipboardCheck },
  agents: { label: 'Agents', icon: Bot },
  settings: { label: 'Settings', icon: Settings },

  // Visualization subsections
  radar: { label: 'Radar', icon: Radar },
  relations: { label: 'Relations', icon: Network },

  // Library entity types
  companies: { label: 'Companies', icon: Building2 },
  technologies: { label: 'Technologies', icon: Cpu },
  'use-cases': { label: 'Use Cases', icon: Lightbulb },
  prototypes: { label: 'Prototypes', icon: FlaskConical },
  strategies: { label: 'Strategies', icon: Target },

  // Agent subsections
  create: { label: 'Create' },
  monitor: { label: 'Monitor' },

  // Common actions
  new: { label: 'New' },
  edit: { label: 'Edit' },
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Check if a segment looks like a dynamic ID (UUID, numeric, etc.)
 */
function isDynamicSegment(segment: string): boolean {
  // UUID pattern
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) {
    return true;
  }
  // Firestore-like IDs (20+ alphanumeric chars)
  if (/^[a-zA-Z0-9]{20,}$/.test(segment)) {
    return true;
  }
  // Numeric IDs
  if (/^\d+$/.test(segment)) {
    return true;
  }
  // Slug-style IDs that embed a long numeric run, e.g. "signal-1781334600963-tvj62r1"
  // or "company-1700000000000-abc". A 10+ digit sequence in a path segment is a
  // generated id, not a human route word — show the entity name (or "Details") instead.
  if (/\d{10,}/.test(segment)) {
    return true;
  }
  return false;
}

/**
 * Generate breadcrumb segments from a pathname
 */
function generateBreadcrumbs(pathname: string, entityName?: string): BreadcrumbSegment[] {
  const segments = pathname.split('/').filter(Boolean);
  const breadcrumbs: BreadcrumbSegment[] = [];

  let currentPath = '';

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    currentPath += `/${segment}`;

    // Skip if this is a dynamic segment (ID) - we'll use entityName instead
    if (isDynamicSegment(segment)) {
      // Use provided entity name or fall back to "Details"
      breadcrumbs.push({
        label: entityName || 'Details',
        href: currentPath,
      });
      continue;
    }

    // Look up the config for this segment
    const config = routeConfig[segment];

    if (config) {
      breadcrumbs.push({
        label: config.label,
        href: currentPath,
        icon: config.icon,
      });
    } else {
      // Fallback: capitalize the segment
      breadcrumbs.push({
        label: segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, ' '),
        href: currentPath,
      });
    }
  }

  return breadcrumbs;
}

// ============================================================================
// BREADCRUMBS COMPONENT
// ============================================================================

interface BreadcrumbsProps {
  /**
   * Optional entity name to display for dynamic routes (e.g., "Acme Corp")
   */
  entityName?: string;
  /**
   * Optional custom breadcrumbs to override automatic generation
   */
  customBreadcrumbs?: BreadcrumbSegment[];
  /**
   * Whether to show icons in breadcrumbs
   * @default true
   */
  showIcons?: boolean;
  /**
   * Whether to show home link
   * @default true
   */
  showHome?: boolean;
}

/**
 * Breadcrumbs
 *
 * Auto-generates breadcrumbs from the current pathname with support for:
 * - Static route labels from configuration
 * - Dynamic segment detection (IDs)
 * - Custom entity names for detail pages
 * - Optional icons
 *
 * Usage:
 * ```tsx
 * // Auto-generated from pathname
 * <Breadcrumbs />
 *
 * // With entity name for detail page
 * <Breadcrumbs entityName="Acme Corp" />
 *
 * // Custom breadcrumbs
 * <Breadcrumbs customBreadcrumbs={[
 *   { label: 'Library', href: '/library' },
 *   { label: 'Companies', href: '/library/companies' },
 *   { label: 'Acme Corp', href: '/library/companies/abc123' },
 * ]} />
 * ```
 */
export function Breadcrumbs({ entityName, customBreadcrumbs, showIcons = true, showHome = true }: BreadcrumbsProps) {
  const pathname = usePathname();

  // Use custom breadcrumbs if provided, otherwise generate from pathname
  const breadcrumbs = customBreadcrumbs ?? generateBreadcrumbs(pathname, entityName);

  // On dashboard, show just "Dashboard" as a title (not as navigation)
  if (pathname === '/dashboard' || pathname === '/') {
    return <span className="font-medium">Dashboard</span>;
  }

  // No breadcrumbs to show
  if (breadcrumbs.length === 0) {
    return null;
  }

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {/* Home link */}
        {showHome && (
          <>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href="/dashboard" className="flex items-center gap-1">
                  {showIcons && <Home className="h-3.5 w-3.5" />}
                  <span className="sr-only sm:not-sr-only sm:inline">Home</span>
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
          </>
        )}

        {/* Breadcrumb segments */}
        {breadcrumbs.map((crumb, index) => {
          const isLast = index === breadcrumbs.length - 1;
          const Icon = crumb.icon;

          return (
            <React.Fragment key={crumb.href}>
              <BreadcrumbItem>
                {isLast ? (
                  // Current page (not clickable)
                  <BreadcrumbPage className="flex items-center gap-1">
                    {showIcons && Icon && <Icon className="h-3.5 w-3.5" />}
                    <span className="max-w-[200px] truncate">{crumb.label}</span>
                  </BreadcrumbPage>
                ) : (
                  // Navigable link
                  <BreadcrumbLink asChild>
                    <Link href={crumb.href} className="flex items-center gap-1">
                      {showIcons && Icon && <Icon className="h-3.5 w-3.5" />}
                      <span>{crumb.label}</span>
                    </Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {!isLast && <BreadcrumbSeparator />}
            </React.Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

// ============================================================================
// EXPORTS
// ============================================================================

export type { BreadcrumbSegment, BreadcrumbsProps };
