'use client';

import * as React from 'react';
import { Activity, Lightbulb, ClipboardCheck, Eye, FileText, Hammer, Library, Settings } from 'lucide-react';
import Link from 'next/link';
import { useTheme } from 'next-themes';

import { NavMain } from '@/components/nav-main';
import { NavSecondary } from '@/components/nav-secondary';
import { NavUser } from '@/components/nav-user';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import { OctopusLogo } from '@/components/branding/OctopusLogo';
import { getBrandingConfig } from '@/lib/branding';
import { LinkerNavBadge } from '@/components/linker/LinkerNavBadge';
import { AssessmentNavBadge } from '@/components/assessment/AssessmentNavBadge';

// Get branding configuration
const brandingConfig = getBrandingConfig();

const userData = {
  name: brandingConfig.user.name,
  email: brandingConfig.user.email,
  avatar: brandingConfig.user.avatar,
};

const navSecondary = [
  {
    title: 'Settings',
    url: '/settings',
    icon: Settings,
  },
];

// Navigation items (called inside component to include React components).
// Exported so navigation regressions can assert against the real nav shape
// instead of a fixture that could drift away from it.
export function getNavMain() {
  return [
    {
      title: 'Dashboard',
      url: '/dashboard',
      icon: Lightbulb,
    },
    {
      title: 'Visualizations',
      url: '/visualizations/radar',
      icon: Eye,
      isActive: true,
      items: [
        { title: 'Radar', url: '/visualizations/radar' },
        { title: 'Graph', url: '/visualizations/graph' },
        // 2026-05-13: Infographics moved here from the top-level nav
        // so it groups visually with the other visualization surfaces.
        { title: 'Infographics', url: '/infographics' },
      ],
    },
    {
      title: 'Library',
      url: '/library',
      icon: Library,
      isActive: true,
      items: [
        // AUDIT-012: parents render as non-link collapse triggers, so the
        // hub page needs its own child entry to be reachable at all.
        { title: 'Overview', url: '/library' },
        { title: 'Companies', url: '/library/companies' },
        { title: 'Technologies', url: '/library/technologies' },
        { title: 'Strategies', url: '/library/strategies' },
        { title: 'Use Cases', url: '/library/use-cases' },
        { title: 'Prototypes', url: '/library/prototypes' },
        { title: 'Org Units', url: '/library/org-units' },
        { title: 'Initiatives', url: '/library/initiatives' },
        { title: 'Pain Points', url: '/library/pain-points' },
        { title: 'Documents', url: '/library/documents' },
      ],
    },
    {
      title: 'Triage',
      url: '/triage/signals',
      icon: ClipboardCheck,
      items: [
        { title: 'Signals', url: '/triage/signals' },
        { title: 'Relations', url: '/triage/relations', badge: <LinkerNavBadge /> },
        { title: 'Assessments', url: '/triage/assessment', badge: <AssessmentNavBadge /> },
        // 2026-05-13: "Briefing" was renamed to "Insights" and moved
        // under Triage. The old top-level entry redirects via
        // `app/briefing/page.tsx` for back-compat with shared links.
        { title: 'Insights', url: '/triage/insights' },
      ],
    },
    {
      title: 'Activity',
      url: '/agents/runs',
      icon: Activity,
      // UX-068: Background verification jobs moved off the Agent Runs page onto
      // their own `Jobs` child, so each Activity surface is one table.
      items: [
        { title: 'Agent Runs', url: '/agents/runs' },
        { title: 'Jobs', url: '/agents/jobs' },
      ],
    },
    {
      title: 'Artifacts',
      url: '/artifacts',
      icon: Hammer,
    },
    {
      title: 'Reports',
      url: '/reports',
      icon: FileText,
    },
  ];
}

function SidebarLogo() {
  const { theme, resolvedTheme } = useTheme();
  const { state } = useSidebar();
  const [mounted, setMounted] = React.useState(false);
  const isCollapsed = state === 'collapsed';

  React.useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <div className="h-8" />;
  }

  const isDark = theme === 'dark' || resolvedTheme === 'dark';

  // When collapsed, show just the octopus (smaller size to fit)
  if (isCollapsed) {
    return (
      <div className="flex items-center justify-center w-8 h-8">
        <OctopusLogo size="sm" />
      </div>
    );
  }

  // When expanded, show octopus + a clean, premium sans wordmark (matches login).
  // Mark sized down to balance the wordmark; the wordmark is nudged up ~1px so it
  // optically aligns with the octopus HEAD (the tentacles make the mark bottom-heavy).
  return (
    <div className="flex items-center gap-2.5">
      <OctopusLogo size="sm" className="-mt-px" />
      <span className={`text-lg font-bold tracking-tight leading-none ${isDark ? 'text-white' : 'text-foreground'}`}>
        {brandingConfig.fullName}
      </span>
    </div>
  );
}

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  // Get nav items inside component to include React components (badges)
  const navMain = React.useMemo(() => getNavMain(), []);

  return (
    <Sidebar collapsible="icon" {...props}>
      {/* Header / logo — plain header block, not a menu button (no hover/active pill) */}
      <SidebarHeader className="px-4 py-3">
        <Link href="/dashboard" className="flex items-center">
          <SidebarLogo />
        </Link>
      </SidebarHeader>

      {/* Main navigation */}
      <SidebarContent>
        <NavMain items={navMain} />
        <NavSecondary items={navSecondary} className="mt-auto" />
      </SidebarContent>

      {/* User at the very bottom */}
      <SidebarFooter>
        <NavUser user={userData} />
      </SidebarFooter>

      {/* Rail for hover-to-expand when collapsed */}
      <SidebarRail />
    </Sidebar>
  );
}
