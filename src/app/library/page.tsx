/**
 * @file app/library/page.tsx
 * @description Library landing page - Overview of all entity types
 *
 * The Library is the central repository for all innovation entities:
 * - Companies (partners, vendors, competitors)
 * - Technologies (decoupled technologies collection)
 * - Use Cases (applications and scenarios)
 * - Prototypes (POCs and pilots)
 * - Strategies (innovation goals)
 * - Org Units (organizational structure)
 * - Initiatives (strategic initiatives)
 * - Pain Points (user/business pain points)
 *
 * Note: Signals live under Triage at /triage/signals
 *
 * This landing page provides quick access and statistics for each entity type.
 *
 * @author Radarist Team
 * @created 2025-11-27
 * @updated 2025-11-30 - Removed PageHeader, Signals card, Quick Actions
 * @updated 2025-12-09 - Added Org Units, Initiatives, Pain Points (Phase 3)
 */

'use client';

import { useState, useEffect } from 'react';
import { SmartLayout } from '@/components/layout/AppLayoutV2';
import {
  Building2,
  Cpu,
  Lightbulb,
  FlaskConical,
  Target,
  Network,
  Rocket,
  AlertTriangle,
  FileText,
} from 'lucide-react';
import { getCompanies } from '@/lib/companies';
import { getTechnologies } from '@/lib/technology-service';
import { getUseCases } from '@/lib/use-cases';
import { getPrototypes } from '@/lib/prototypes';
import { getStrategies } from '@/lib/strategies';
import { getOrgUnits } from '@/lib/org-units';
import { getInitiatives } from '@/lib/initiatives';
import { getPainPoints } from '@/lib/pain-points';
import { getDocuments } from '@/lib/document-service';
import { KPICard } from '@/components/ui/kpi-card';
import { EmptyState } from '@/components/feedback/EmptyState';
import { SectionCard } from '@/components/ui/section-card';
import { createLogger } from '@/lib/logger';

const log = createLogger('library-page');

interface LibraryStats {
  companies: number;
  technologies: number;
  useCases: number;
  prototypes: number;
  strategies: number;
  orgUnits: number;
  initiatives: number;
  painPoints: number;
  documents: number;
}

/**
 * Library landing page component
 */
export default function LibraryPage() {
  const [stats, setStats] = useState<LibraryStats>({
    companies: 0,
    technologies: 0,
    useCases: 0,
    prototypes: 0,
    strategies: 0,
    orgUnits: 0,
    initiatives: 0,
    painPoints: 0,
    documents: 0,
  });
  const [isLoading, setIsLoading] = useState(true);
  // AUDIT-008: a failed stats fetch must not render all-zero KPI tiles as if
  // the library were empty — track it and render an honest error note instead.
  const [statsError, setStatsError] = useState<string | null>(null);

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = async () => {
    setIsLoading(true);
    setStatsError(null);
    try {
      // Fetch entity counts in parallel
      const [companies, technologies, useCases, prototypes, strategies, orgUnits, initiatives, painPoints, documents] =
        await Promise.all([
          getCompanies(),
          getTechnologies(),
          getUseCases(),
          getPrototypes(),
          getStrategies(),
          getOrgUnits(),
          getInitiatives(),
          getPainPoints(),
          getDocuments(),
        ]);

      setStats({
        companies: companies.length,
        technologies: technologies.length,
        useCases: useCases.length,
        prototypes: prototypes.length,
        strategies: strategies.length,
        orgUnits: orgUnits.length,
        initiatives: initiatives.length,
        painPoints: painPoints.length,
        documents: documents.length,
      });
    } catch (error) {
      log.error('Error loading stats', error instanceof Error ? error : new Error(String(error)));
      setStatsError(error instanceof Error ? error.message : 'Failed to load library statistics.');
    } finally {
      setIsLoading(false);
    }
  };

  // KPI data for the top row
  const kpis = [
    { icon: Building2, value: stats.companies, label: 'Companies', color: 'text-blue-500' },
    { icon: Cpu, value: stats.technologies, label: 'Technologies', color: 'text-purple-500' },
    { icon: Target, value: stats.strategies, label: 'Strategies', color: 'text-red-500' },
    { icon: Lightbulb, value: stats.useCases, label: 'Use Cases', color: 'text-yellow-500' },
    { icon: FlaskConical, value: stats.prototypes, label: 'Prototypes', color: 'text-green-500' },
    { icon: Network, value: stats.orgUnits, label: 'Org Units', color: 'text-cyan-500' },
    { icon: Rocket, value: stats.initiatives, label: 'Initiatives', color: 'text-orange-500' },
    { icon: AlertTriangle, value: stats.painPoints, label: 'Pain Points', color: 'text-pink-500' },
    { icon: FileText, value: stats.documents, label: 'Documents', color: 'text-slate-500' },
  ];

  // Section cards for entity types
  const entityTypes = [
    {
      title: 'Companies',
      description: 'Partners, vendors, competitors, and startups in your ecosystem',
      icon: Building2,
      count: stats.companies,
      href: '/library/companies',
      color: 'text-blue-500',
    },
    {
      title: 'Technologies',
      description: 'Tools, platforms, and frameworks tracked in your radar',
      icon: Cpu,
      count: stats.technologies,
      href: '/library/technologies',
      color: 'text-purple-500',
    },
    {
      title: 'Strategies',
      description: 'Innovation goals and strategic objectives',
      icon: Target,
      count: stats.strategies,
      href: '/library/strategies',
      color: 'text-red-500',
    },
    {
      title: 'Use Cases',
      description: 'Applications and scenarios for technology adoption',
      icon: Lightbulb,
      count: stats.useCases,
      href: '/library/use-cases',
      color: 'text-yellow-500',
    },
    {
      title: 'Prototypes',
      description: 'POCs, pilots, and innovation experiments',
      icon: FlaskConical,
      count: stats.prototypes,
      href: '/library/prototypes',
      color: 'text-green-500',
    },
    {
      title: 'Org Units',
      description: 'Organizational structure: business units, divisions, and teams',
      icon: Network,
      count: stats.orgUnits,
      href: '/library/org-units',
      color: 'text-cyan-500',
    },
    {
      title: 'Initiatives',
      description: 'Strategic initiatives, projects, and transformation programs',
      icon: Rocket,
      count: stats.initiatives,
      href: '/library/initiatives',
      color: 'text-orange-500',
    },
    {
      title: 'Pain Points',
      description: 'User and business challenges, blockers, and opportunities',
      icon: AlertTriangle,
      count: stats.painPoints,
      href: '/library/pain-points',
      color: 'text-pink-500',
    },
    {
      title: 'Documents',
      description: 'Research documents, reports, and uploaded files',
      icon: FileText,
      count: stats.documents,
      href: '/library/documents',
      color: 'text-slate-500',
    },
  ];

  return (
    <SmartLayout>
      <div className="flex-1 overflow-y-auto p-6">
        {/* KPI Cards Row — replaced by an honest error note when the stats
            fetch failed (all-zero tiles would read as an empty library). */}
        {statsError ? (
          <div className="mb-8">
            <EmptyState
              icon={AlertTriangle}
              title="Could not load library statistics"
              description={statsError}
              action={{ label: 'Retry', onClick: () => void loadStats() }}
            />
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9 gap-4 mb-8">
            {kpis.map((kpi) => (
              <KPICard
                key={kpi.label}
                icon={kpi.icon}
                value={kpi.value}
                label={kpi.label}
                color={kpi.color}
                isLoading={isLoading}
              />
            ))}
          </div>
        )}

        {/* Entity Type Section Cards — on stats error, keep the navigation
            cards but show "-" (the loading placeholder) instead of fake 0s. */}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {entityTypes.map((entity) => (
            <SectionCard
              key={entity.title}
              title={entity.title}
              description={entity.description}
              icon={entity.icon}
              count={entity.count}
              href={entity.href}
              color={entity.color}
              isLoading={isLoading || statsError !== null}
            />
          ))}
        </div>
      </div>
    </SmartLayout>
  );
}
