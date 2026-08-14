'use client';

import { Radar, Building2, AlertTriangle, Lightbulb, Target, Layers, TrendingUp, Activity } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { ENTITY_COLORS } from '@/lib/entity-colors';
import type { PortfolioMetrics } from '@/lib/types';

interface PortfolioMetricsCardsProps {
  metrics: PortfolioMetrics;
}

/**
 * Portfolio Metrics Cards Component
 *
 * Displays key performance indicators across the innovation platform in a compact grid.
 * Uses the same compact KPI card style as other landing pages for consistency.
 *
 * @param props.metrics - Complete portfolio metrics data
 */
export function PortfolioMetricsCards({ metrics }: PortfolioMetricsCardsProps) {
  const statCards = [
    {
      title: 'Technologies',
      value: metrics.totalTechnologies,
      icon: Radar,
      iconColor: ENTITY_COLORS.technology.text,
    },
    {
      title: 'Companies',
      value: metrics.totalCompanies,
      icon: Building2,
      iconColor: ENTITY_COLORS.company.text,
    },
    {
      title: 'Pain Points',
      value: metrics.totalPainPoints,
      icon: AlertTriangle,
      iconColor: ENTITY_COLORS.painPoint.text,
    },
    {
      title: 'Use Cases',
      value: metrics.totalUseCases,
      icon: Lightbulb,
      iconColor: ENTITY_COLORS.useCase.text,
    },
    {
      title: 'Strategies',
      value: metrics.totalStrategies,
      icon: Target,
      iconColor: ENTITY_COLORS.strategy.text,
    },
    {
      title: 'Prototypes',
      value: metrics.prototypeMetrics.activeCount,
      icon: Layers,
      iconColor: ENTITY_COLORS.prototype.text,
    },
    {
      title: 'Signals',
      value: metrics.signalMetrics.totalDetected,
      icon: TrendingUp,
      iconColor: ENTITY_COLORS.signal.text,
    },
    {
      title: 'Pending',
      value: metrics.signalMetrics.pendingReview + metrics.agentMetrics.pendingReview,
      icon: Activity,
      // Slate/neutral — was amber, which read too close to Signals' orange
      // at this compact size; Pending isn't an entity type so it stays
      // off the ENTITY_COLORS canon rather than borrowing a taken hue.
      iconColor: 'text-slate-500 dark:text-slate-400',
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
      {statCards.map((card, index) => (
        <Card key={index} className="hover:shadow-md transition-shadow">
          <CardContent className="p-3 flex flex-col items-center justify-center text-center">
            <card.icon className={`h-6 w-6 mb-1 ${card.iconColor}`} />
            <div className="text-xl font-bold">{card.value.toLocaleString()}</div>
            <div className="text-xs text-muted-foreground truncate w-full">{card.title}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
