'use client'

import * as React from 'react'
import {
  Clock,
  Sparkles,
  TrendingUp,
  BarChart3,
  Building2,
  Briefcase,
  Cpu,
  DollarSign,
  Scale,
  GraduationCap,
  Telescope,
  ChevronDown,
  ChevronRight,
  Target,
  AlertTriangle,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { ResearchTabSkeleton } from '../EntitySheetSkeleton'
import type { TechnologyResearch } from '@/lib/types'

// ============================================================================
// TYPES
// ============================================================================

export interface TechnologyResearchTabProps {
  /** Technology research data */
  research?: TechnologyResearch | null
  /** Whether research is currently loading */
  isLoading?: boolean
  /** Research status for showing "Researching..." state */
  researchStatus?: 'idle' | 'pending' | 'completed' | 'failed' | null
  /** Additional class names */
  className?: string
}

interface ResearchSectionProps {
  title: string
  icon: React.ElementType
  children: React.ReactNode
  defaultOpen?: boolean
}

// ============================================================================
// HELPER COMPONENTS
// ============================================================================

/**
 * Collapsible section wrapper for research data
 */
function ResearchSection({ title, icon: Icon, children, defaultOpen = true }: ResearchSectionProps) {
  const [isOpen, setIsOpen] = React.useState(defaultOpen)

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <Card>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors py-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Icon className="h-4 w-4 text-muted-foreground" />
              {title}
              <span className="ml-auto">
                {isOpen ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
              </span>
            </CardTitle>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0 pb-4">{children}</CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}

/**
 * Format a timestamp to relative time
 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`
  if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`
  if (days < 7) return `${days} day${days > 1 ? 's' : ''} ago`
  return new Date(timestamp).toLocaleDateString()
}

function formatResearchCost(costUsd: number | undefined): string {
  if (typeof costUsd !== 'number' || !Number.isFinite(costUsd)) return 'Cost unavailable'
  return costUsd.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })
}

/**
 * Risk level badge
 */
function RiskBadge({ level }: { level: 'low' | 'medium' | 'high' }) {
  const config = {
    low: { label: 'Low', className: 'bg-green-500/10 text-green-600 border-green-500/20' },
    medium: { label: 'Medium', className: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20' },
    high: { label: 'High', className: 'bg-red-500/10 text-red-600 border-red-500/20' },
  }
  const { label, className } = config[level]
  return <Badge variant="outline" className={className}>{label}</Badge>
}

/**
 * Hype Cycle Position Badge
 */
function HypeCycleBadge({ position }: { position: string }) {
  const config: Record<string, { label: string; className: string }> = {
    'innovation-trigger': { label: 'Innovation Trigger', className: 'bg-purple-500/10 text-purple-600' },
    'peak-of-inflated-expectations': { label: 'Peak of Expectations', className: 'bg-red-500/10 text-red-600' },
    'trough-of-disillusionment': { label: 'Trough', className: 'bg-orange-500/10 text-orange-600' },
    'slope-of-enlightenment': { label: 'Slope of Enlightenment', className: 'bg-blue-500/10 text-blue-600' },
    'plateau-of-productivity': { label: 'Plateau', className: 'bg-green-500/10 text-green-600' },
  }
  const { label, className } = config[position] || { label: position, className: '' }
  return <Badge variant="outline" className={className}>{label}</Badge>
}

/**
 * Trajectory Badge
 */
function TrajectoryBadge({ trajectory }: { trajectory: string }) {
  const config: Record<string, { label: string; className: string }> = {
    accelerating: { label: 'Accelerating', className: 'bg-green-500/10 text-green-600' },
    steady: { label: 'Steady', className: 'bg-blue-500/10 text-blue-600' },
    slowing: { label: 'Slowing', className: 'bg-yellow-500/10 text-yellow-600' },
    declining: { label: 'Declining', className: 'bg-red-500/10 text-red-600' },
  }
  const { label, className } = config[trajectory] || { label: trajectory, className: '' }
  return <Badge variant="outline" className={className}>{label}</Badge>
}

/**
 * Strategic Value Badge
 */
function StrategicValueBadge({ value }: { value: string }) {
  const config: Record<string, { label: string; className: string }> = {
    transformational: { label: 'Transformational', className: 'bg-purple-500/10 text-purple-600' },
    significant: { label: 'Significant', className: 'bg-green-500/10 text-green-600' },
    incremental: { label: 'Incremental', className: 'bg-blue-500/10 text-blue-600' },
    marginal: { label: 'Marginal', className: 'bg-muted text-muted-foreground' },
  }
  const { label, className } = config[value] || { label: value, className: '' }
  return <Badge variant="outline" className={className}>{label}</Badge>
}

/**
 * Availability Badge
 */
function AvailabilityBadge({ availability }: { availability: string }) {
  const config: Record<string, { label: string; className: string }> = {
    abundant: { label: 'Abundant', className: 'bg-green-500/10 text-green-600' },
    adequate: { label: 'Adequate', className: 'bg-blue-500/10 text-blue-600' },
    limited: { label: 'Limited', className: 'bg-yellow-500/10 text-yellow-600' },
    scarce: { label: 'Scarce', className: 'bg-red-500/10 text-red-600' },
  }
  const { label, className } = config[availability] || { label: availability, className: '' }
  return <Badge variant="outline" className={className}>{label}</Badge>
}

/**
 * Trend Indicator
 */
function TrendIndicator({ trend }: { trend: 'up' | 'down' | 'stable' }) {
  if (trend === 'up') return <span className="text-green-600">+</span>
  if (trend === 'down') return <span className="text-red-600">-</span>
  return <span className="text-muted-foreground">=</span>
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

/**
 * TechnologyResearchTab
 *
 * Displays comprehensive technology research data with collapsible sections.
 * Only renders sections that have data available.
 */
export function TechnologyResearchTab({
  research,
  isLoading = false,
  researchStatus,
  className,
}: TechnologyResearchTabProps) {
  // Check if research is in progress
  const isResearchPending = researchStatus === 'pending'

  // TEST-022: the last attempt failed and left nothing behind.
  const hasResearchFailed = researchStatus === 'failed'

  // Check if any research data exists
  const hasData = research && (
    research.executiveSummary ||
    research.maturityAssessment ||
    research.technologyMetrics ||
    research.keyPlayers ||
    research.useCasesAndApplications ||
    research.technicalDeepDive ||
    research.valueAssessment ||
    research.risksAndBarriers ||
    research.investmentLandscape ||
    research.regulatoryAndCompliance ||
    research.talentAndSkills ||
    research.futureOutlook
  )
  const usage = research?.metadata?.usage
  const tokenCount =
    typeof usage?.inputTokens === 'number' && typeof usage.outputTokens === 'number'
      ? usage.inputTokens + usage.outputTokens
      : undefined

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Technology Research</h3>
          {research?.lastResearched && (
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Last updated {formatRelativeTime(research.lastResearched)}
            </p>
          )}
        </div>
      </div>

      {/* Loading State */}
      {isLoading && <ResearchTabSkeleton />}

      {/* Researching State - shown when research is in progress */}
      {!isLoading && isResearchPending && (
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="py-8 text-center">
            <div className="flex flex-col items-center gap-3">
              <div className="relative">
                <Sparkles className="mx-auto h-8 w-8 text-primary animate-pulse" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium">Researching...</p>
                <p className="text-xs text-muted-foreground">
                  Comprehensive research is running in the background.
                </p>
                <p className="text-xs text-muted-foreground/70">
                  You can navigate away - results will appear when complete.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Failed State (TEST-022) — a failed attempt is a different fact from
          "never researched"; collapsing them told the operator nothing had
          been tried when something had been tried and lost. */}
      {!isLoading && !isResearchPending && !hasData && hasResearchFailed && (
        <Card className="border-dashed border-amber-500/40" data-testid="research-failed-panel">
          <CardContent className="py-8 text-center">
            <AlertTriangle className="mx-auto mb-2 h-8 w-8 text-amber-500/70" />
            <p className="text-sm font-medium mb-1">Research did not complete</p>
            <p className="text-xs text-muted-foreground">
              The last attempt failed and no results were saved. Use the &quot;Research&quot; button to try again.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Empty State */}
      {!isLoading && !isResearchPending && !hasData && !hasResearchFailed && (
        <Card className="border-dashed">
          <CardContent className="py-8 text-center">
            <Sparkles className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm font-medium mb-1">No research data available</p>
            <p className="text-xs text-muted-foreground">
              Use the &quot;Research&quot; button to gather comprehensive information about this technology.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Research Sections */}
      {!isLoading && hasData && (
        <div className="space-y-3">
          {usage && (
            <div
              role="region"
              aria-label="Research run telemetry"
              className="flex flex-wrap items-center gap-x-4 gap-y-1 border-y py-2 text-xs text-muted-foreground"
            >
              <span>
                Model: <span className="font-medium text-foreground">{usage.model || 'Unavailable'}</span>
              </span>
              <span>1 model request</span>
              <span>{tokenCount === undefined ? 'Tokens unavailable' : `${tokenCount.toLocaleString()} tokens`}</span>
              <span title={usage.costUnavailableReason}>{formatResearchCost(usage.costUsd)}</span>
              {usage.requestId && <span className="break-all">Request: {usage.requestId}</span>}
            </div>
          )}

          {/* Section 1: Executive Summary */}
          {research.executiveSummary && (
            <ResearchSection title="Executive Summary" icon={Sparkles}>
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">{research.executiveSummary.summary}</p>
                {research.executiveSummary.keyInsights && research.executiveSummary.keyInsights.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Key Insights</p>
                    <ul className="list-disc list-inside space-y-1">
                      {research.executiveSummary.keyInsights.map((insight, i) => (
                        <li key={i} className="text-sm">{insight}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </ResearchSection>
          )}

          {/* Section 2: Maturity Assessment */}
          {research.maturityAssessment && (
            <ResearchSection title="Maturity Assessment" icon={TrendingUp}>
              <div className="space-y-3">
                <div className="flex flex-wrap gap-3">
                  {research.maturityAssessment.hypeCyclePosition && (
                    <div className="text-xs">
                      <span className="text-muted-foreground">Hype Cycle:</span>{' '}
                      <HypeCycleBadge position={research.maturityAssessment.hypeCyclePosition} />
                    </div>
                  )}
                  {research.maturityAssessment.maturityTrajectory && (
                    <div className="text-xs">
                      <span className="text-muted-foreground">Trajectory:</span>{' '}
                      <TrajectoryBadge trajectory={research.maturityAssessment.maturityTrajectory} />
                    </div>
                  )}
                </div>
                {research.maturityAssessment.timeToMainstream && (
                  <div className="text-sm flex items-center gap-2">
                    <span className="text-muted-foreground">Time to Mainstream:</span>
                    <span>{research.maturityAssessment.timeToMainstream}</span>
                  </div>
                )}
              </div>
            </ResearchSection>
          )}

          {/* Section 3: Technology Metrics */}
          {research.technologyMetrics && (
            <ResearchSection title="Technology Metrics" icon={BarChart3}>
              <div className="space-y-3">
                {research.technologyMetrics.category && (
                  <div className="text-sm flex items-center gap-2">
                    <span className="text-muted-foreground">Category:</span>
                    <Badge variant="secondary">{research.technologyMetrics.category}</Badge>
                  </div>
                )}
                {research.technologyMetrics.keyMetrics && research.technologyMetrics.keyMetrics.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">Key Metrics</p>
                    <div className="grid grid-cols-2 gap-2">
                      {research.technologyMetrics.keyMetrics.map((metric, i) => (
                        <div key={i} className="p-2 rounded-lg bg-muted/50">
                          <p className="text-xs text-muted-foreground">{metric.name}</p>
                          <p className="font-semibold text-sm flex items-center gap-1">
                            {metric.value}
                            {metric.trend && <TrendIndicator trend={metric.trend} />}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {research.technologyMetrics.milestones && research.technologyMetrics.milestones.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">Milestones</p>
                    <div className="space-y-1">
                      {research.technologyMetrics.milestones.map((milestone, i) => (
                        <div key={i} className="flex items-center justify-between text-sm py-1 border-b border-dashed last:border-0">
                          <span className="text-muted-foreground">{milestone.date}</span>
                          <span>{milestone.description}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </ResearchSection>
          )}

          {/* Section 4: Key Players */}
          {research.keyPlayers && (
            <ResearchSection title="Key Players" icon={Building2}>
              <div className="space-y-3">
                {research.keyPlayers.marketLeaders && research.keyPlayers.marketLeaders.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">Market Leaders</p>
                    <div className="grid gap-2">
                      {research.keyPlayers.marketLeaders.map((leader, i) => (
                        <div key={i} className="p-2 rounded-lg bg-muted/50 border">
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-sm">{leader.name}</span>
                            {leader.marketShare && <Badge variant="outline" className="text-xs">{leader.marketShare}</Badge>}
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">{leader.role}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {research.keyPlayers.emergingStartups && research.keyPlayers.emergingStartups.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">Emerging Startups</p>
                    <div className="flex flex-wrap gap-2">
                      {research.keyPlayers.emergingStartups.map((startup, i) => (
                        <Badge key={i} variant="secondary" className="text-xs">
                          {startup.name} {startup.funding && `(${startup.funding})`}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                {research.keyPlayers.openSourceProjects && research.keyPlayers.openSourceProjects.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">Open Source Projects</p>
                    <div className="space-y-1">
                      {research.keyPlayers.openSourceProjects.map((project, i) => (
                        <div key={i} className="flex items-center justify-between text-sm py-1 border-b border-dashed last:border-0">
                          <span className="font-medium">{project.name}</span>
                          <span className="text-xs text-muted-foreground">
                            {project.stars?.toLocaleString()} stars
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </ResearchSection>
          )}

          {/* Section 5: Use Cases & Applications */}
          {research.useCasesAndApplications && (
            <ResearchSection title="Use Cases & Applications" icon={Briefcase}>
              <div className="space-y-3">
                {research.useCasesAndApplications.byMaturity && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">By Maturity</p>
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      {(research.useCasesAndApplications.byMaturity.production?.length ?? 0) > 0 && (
                        <div className="p-2 rounded-lg bg-green-500/5 border border-green-500/10">
                          <p className="font-medium text-green-600 mb-1">Production</p>
                          <ul className="list-disc list-inside text-muted-foreground">
                            {(research.useCasesAndApplications.byMaturity.production ?? []).map((uc, i) => <li key={i}>{uc}</li>)}
                          </ul>
                        </div>
                      )}
                      {(research.useCasesAndApplications.byMaturity.piloting?.length ?? 0) > 0 && (
                        <div className="p-2 rounded-lg bg-blue-500/5 border border-blue-500/10">
                          <p className="font-medium text-blue-600 mb-1">Piloting</p>
                          <ul className="list-disc list-inside text-muted-foreground">
                            {(research.useCasesAndApplications.byMaturity.piloting ?? []).map((uc, i) => <li key={i}>{uc}</li>)}
                          </ul>
                        </div>
                      )}
                      {(research.useCasesAndApplications.byMaturity.experimental?.length ?? 0) > 0 && (
                        <div className="p-2 rounded-lg bg-purple-500/5 border border-purple-500/10">
                          <p className="font-medium text-purple-600 mb-1">Experimental</p>
                          <ul className="list-disc list-inside text-muted-foreground">
                            {(research.useCasesAndApplications.byMaturity.experimental ?? []).map((uc, i) => <li key={i}>{uc}</li>)}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {research.useCasesAndApplications.flagshipExamples && research.useCasesAndApplications.flagshipExamples.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">Flagship Examples</p>
                    <div className="space-y-2">
                      {research.useCasesAndApplications.flagshipExamples.map((example, i) => (
                        <div key={i} className="p-2 rounded-lg bg-muted/50 border">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm">{example.company}</span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">{example.useCase}</p>
                          {example.outcome && (
                            <p className="text-xs text-green-600 mt-1">Outcome: {example.outcome}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </ResearchSection>
          )}

          {/* Section 6: Technical Deep-Dive */}
          {research.technicalDeepDive && (
            <ResearchSection title="Technical Deep-Dive" icon={Cpu} defaultOpen={false}>
              <div className="space-y-3">
                {research.technicalDeepDive.architectureOverview && (
                  <p className="text-sm text-muted-foreground">{research.technicalDeepDive.architectureOverview}</p>
                )}
                {research.technicalDeepDive.coreComponents && research.technicalDeepDive.coreComponents.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">Core Components</p>
                    <div className="grid gap-2">
                      {research.technicalDeepDive.coreComponents.map((component, i) => (
                        <div key={i} className="p-2 rounded-lg bg-muted/50 border">
                          <span className="font-medium text-sm">{component.name}</span>
                          <p className="text-xs text-muted-foreground mt-1">{component.purpose}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {research.technicalDeepDive.interoperability && (
                  <div className="text-xs">
                    <span className="text-muted-foreground">Interoperability:</span>{' '}
                    <RiskBadge level={research.technicalDeepDive.interoperability.level ?? 'medium'} />
                    <p className="text-muted-foreground mt-1">{research.technicalDeepDive.interoperability.details}</p>
                  </div>
                )}
                {research.technicalDeepDive.standards && research.technicalDeepDive.standards.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Standards</p>
                    <div className="flex flex-wrap gap-1">
                      {research.technicalDeepDive.standards.map((std, i) => (
                        <Badge key={i} variant="outline" className="text-xs">{std}</Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </ResearchSection>
          )}

          {/* Section 7: Value Assessment */}
          {research.valueAssessment && (
            <ResearchSection title="Value Assessment" icon={Target}>
              <div className="space-y-3">
                <div className="flex flex-wrap gap-3">
                  {research.valueAssessment.maturityLevel && (
                    <div className="text-xs">
                      <span className="text-muted-foreground">Maturity Level:</span>{' '}
                      <Badge variant="outline">{research.valueAssessment.maturityLevel}/5</Badge>
                    </div>
                  )}
                  {research.valueAssessment.strategicValue && (
                    <div className="text-xs">
                      <span className="text-muted-foreground">Strategic Value:</span>{' '}
                      <StrategicValueBadge value={research.valueAssessment.strategicValue} />
                    </div>
                  )}
                  {research.valueAssessment.evidenceLevel && (
                    <div className="text-xs">
                      <span className="text-muted-foreground">Evidence:</span>{' '}
                      <Badge variant="outline">{research.valueAssessment.evidenceLevel}</Badge>
                    </div>
                  )}
                </div>
                {research.valueAssessment.primaryValueDrivers && research.valueAssessment.primaryValueDrivers.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Value Drivers</p>
                    <div className="flex flex-wrap gap-1">
                      {research.valueAssessment.primaryValueDrivers.map((driver, i) => (
                        <Badge key={i} variant="secondary" className="text-xs">{driver}</Badge>
                      ))}
                    </div>
                  </div>
                )}
                {(research.valueAssessment.typicalROI || research.valueAssessment.timeToValue || research.valueAssessment.paybackPeriod) && (
                  <div className="grid grid-cols-3 gap-2">
                    {research.valueAssessment.typicalROI && (
                      <div className="p-2 rounded-lg bg-muted/50">
                        <p className="text-xs text-muted-foreground">Typical ROI</p>
                        <p className="font-semibold text-sm">{research.valueAssessment.typicalROI}</p>
                      </div>
                    )}
                    {research.valueAssessment.timeToValue && (
                      <div className="p-2 rounded-lg bg-muted/50">
                        <p className="text-xs text-muted-foreground">Time to Value</p>
                        <p className="font-semibold text-sm">{research.valueAssessment.timeToValue}</p>
                      </div>
                    )}
                    {research.valueAssessment.paybackPeriod && (
                      <div className="p-2 rounded-lg bg-muted/50">
                        <p className="text-xs text-muted-foreground">Payback Period</p>
                        <p className="font-semibold text-sm">{research.valueAssessment.paybackPeriod}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </ResearchSection>
          )}

          {/* Section 8: Risks & Barriers */}
          {research.risksAndBarriers && (
            <ResearchSection title="Risks & Barriers" icon={AlertTriangle}>
              <div className="space-y-3">
                <div className="flex flex-wrap gap-3">
                  {research.risksAndBarriers.vendorLockInRisk && (
                    <div className="text-xs">
                      <span className="text-muted-foreground">Vendor Lock-in:</span>{' '}
                      <RiskBadge level={research.risksAndBarriers.vendorLockInRisk ?? 'medium'} />
                    </div>
                  )}
                  {research.risksAndBarriers.obsolescenceRisk && (
                    <div className="text-xs">
                      <span className="text-muted-foreground">Obsolescence:</span>{' '}
                      <RiskBadge level={research.risksAndBarriers.obsolescenceRisk ?? 'medium'} />
                    </div>
                  )}
                </div>
                {research.risksAndBarriers.technicalBarriers && research.risksAndBarriers.technicalBarriers.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Technical Barriers</p>
                    <ul className="list-disc list-inside text-sm text-muted-foreground">
                      {research.risksAndBarriers.technicalBarriers.map((barrier, i) => (
                        <li key={i}>{barrier}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {research.risksAndBarriers.adoptionBarriers && research.risksAndBarriers.adoptionBarriers.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Adoption Barriers</p>
                    <ul className="list-disc list-inside text-sm text-muted-foreground">
                      {research.risksAndBarriers.adoptionBarriers.map((barrier, i) => (
                        <li key={i}>{barrier}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {research.risksAndBarriers.securityConsiderations && research.risksAndBarriers.securityConsiderations.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Security Considerations</p>
                    <div className="flex flex-wrap gap-1">
                      {research.risksAndBarriers.securityConsiderations.map((sec, i) => (
                        <Badge key={i} variant="outline" className="text-xs bg-red-500/5">{sec}</Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </ResearchSection>
          )}

          {/* Section 9: Investment Landscape */}
          {research.investmentLandscape && (
            <ResearchSection title="Investment Landscape" icon={DollarSign} defaultOpen={false}>
              <div className="space-y-3">
                <div className="flex flex-wrap gap-3">
                  {research.investmentLandscape.vcActivityLevel && (
                    <div className="text-xs">
                      <span className="text-muted-foreground">VC Activity:</span>{' '}
                      <Badge variant="outline">{research.investmentLandscape.vcActivityLevel}</Badge>
                    </div>
                  )}
                  {research.investmentLandscape.investmentTrend && (
                    <div className="text-xs">
                      <span className="text-muted-foreground">Trend:</span>{' '}
                      <TrajectoryBadge trajectory={research.investmentLandscape.investmentTrend} />
                    </div>
                  )}
                </div>
                {research.investmentLandscape.totalFundingLast12Months && (
                  <div className="p-2 rounded-lg bg-muted/50">
                    <p className="text-xs text-muted-foreground">Funding (Last 12 Months)</p>
                    <p className="font-semibold">{research.investmentLandscape.totalFundingLast12Months}</p>
                  </div>
                )}
                {research.investmentLandscape.notableFundingRounds && research.investmentLandscape.notableFundingRounds.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">Notable Rounds</p>
                    <div className="space-y-1">
                      {research.investmentLandscape.notableFundingRounds.map((round, i) => (
                        <div key={i} className="flex items-center justify-between text-sm py-1 border-b border-dashed last:border-0">
                          <span className="font-medium">{round.company}</span>
                          <div className="flex items-center gap-2">
                            <span>{round.amount}</span>
                            {round.date && <span className="text-xs text-muted-foreground">{round.date}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </ResearchSection>
          )}

          {/* Section 10: Regulatory & Compliance */}
          {research.regulatoryAndCompliance && (
            <ResearchSection title="Regulatory & Compliance" icon={Scale} defaultOpen={false}>
              <div className="space-y-3">
                {research.regulatoryAndCompliance.regulatoryTrajectory && (
                  <div className="text-xs">
                    <span className="text-muted-foreground">Regulatory Trajectory:</span>{' '}
                    <Badge variant="outline">{research.regulatoryAndCompliance.regulatoryTrajectory}</Badge>
                  </div>
                )}
                {research.regulatoryAndCompliance.relevantRegulations && research.regulatoryAndCompliance.relevantRegulations.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Relevant Regulations</p>
                    <div className="flex flex-wrap gap-1">
                      {research.regulatoryAndCompliance.relevantRegulations.map((reg, i) => (
                        <Badge key={i} variant="outline" className="text-xs">{reg}</Badge>
                      ))}
                    </div>
                  </div>
                )}
                {research.regulatoryAndCompliance.upcomingRegulations && research.regulatoryAndCompliance.upcomingRegulations.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">Upcoming Regulations</p>
                    <div className="space-y-2">
                      {research.regulatoryAndCompliance.upcomingRegulations.map((reg, i) => (
                        <div key={i} className="p-2 rounded-lg bg-yellow-500/5 border border-yellow-500/10">
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-sm">{reg.name}</span>
                            {reg.expectedDate && <span className="text-xs text-muted-foreground">{reg.expectedDate}</span>}
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">{reg.impact}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </ResearchSection>
          )}

          {/* Section 11: Talent & Skills */}
          {research.talentAndSkills && (
            <ResearchSection title="Talent & Skills" icon={GraduationCap} defaultOpen={false}>
              <div className="space-y-3">
                <div className="flex flex-wrap gap-3">
                  {research.talentAndSkills.talentAvailability && (
                    <div className="text-xs">
                      <span className="text-muted-foreground">Talent Availability:</span>{' '}
                      <AvailabilityBadge availability={research.talentAndSkills.talentAvailability} />
                    </div>
                  )}
                  {research.talentAndSkills.talentCostIndicator && (
                    <div className="text-xs">
                      <span className="text-muted-foreground">Cost:</span>{' '}
                      <Badge variant="outline">{research.talentAndSkills.talentCostIndicator}</Badge>
                    </div>
                  )}
                </div>
                {research.talentAndSkills.requiredCompetencies && research.talentAndSkills.requiredCompetencies.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Required Competencies</p>
                    <div className="flex flex-wrap gap-1">
                      {research.talentAndSkills.requiredCompetencies.map((skill, i) => (
                        <Badge key={i} variant="secondary" className="text-xs">{skill}</Badge>
                      ))}
                    </div>
                  </div>
                )}
                {research.talentAndSkills.trainingRequirements && (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="p-2 rounded-lg bg-muted/50">
                      <p className="text-xs text-muted-foreground">Time to Competency</p>
                      <p className="font-semibold text-sm">{research.talentAndSkills.trainingRequirements.timeToCompetency}</p>
                    </div>
                    <div className="p-2 rounded-lg bg-muted/50">
                      <p className="text-xs text-muted-foreground">Complexity</p>
                      <p className="font-semibold text-sm capitalize">{research.talentAndSkills.trainingRequirements.complexity}</p>
                    </div>
                  </div>
                )}
                {research.talentAndSkills.buildVsBuy && (
                  <div className="p-3 rounded-lg bg-primary/5 border border-primary/10">
                    <p className="text-xs font-medium text-primary mb-1">
                      Recommendation: {(research.talentAndSkills.buildVsBuy.recommendation ?? 'unknown').toUpperCase()}
                    </p>
                    <p className="text-sm">{research.talentAndSkills.buildVsBuy.rationale}</p>
                  </div>
                )}
              </div>
            </ResearchSection>
          )}

          {/* Section 12: Future Outlook */}
          {research.futureOutlook && (
            <ResearchSection title="Future Outlook" icon={Telescope}>
              <div className="space-y-3">
                {research.futureOutlook.disruptionPotential && (
                  <div className="text-xs">
                    <span className="text-muted-foreground">Disruption Potential:</span>{' '}
                    <RiskBadge level={research.futureOutlook.disruptionPotential ?? 'medium'} />
                  </div>
                )}
                {research.futureOutlook.emergingTrends && research.futureOutlook.emergingTrends.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Emerging Trends</p>
                    <ul className="list-disc list-inside text-sm space-y-1">
                      {research.futureOutlook.emergingTrends.map((trend, i) => (
                        <li key={i}>{trend}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {research.futureOutlook.predictedDevelopments && research.futureOutlook.predictedDevelopments.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">Predicted Developments</p>
                    <div className="space-y-1">
                      {research.futureOutlook.predictedDevelopments.map((dev, i) => (
                        <div key={i} className="flex items-center justify-between text-sm py-1 border-b border-dashed last:border-0">
                          <span className="text-muted-foreground">{dev.timeframe}</span>
                          <span>{dev.prediction}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {research.futureOutlook.watchSignals && research.futureOutlook.watchSignals.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Watch Signals</p>
                    <div className="flex flex-wrap gap-1">
                      {research.futureOutlook.watchSignals.map((signal, i) => (
                        <Badge key={i} variant="outline" className="text-xs">{signal}</Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </ResearchSection>
          )}

          {/* Metadata */}
          {research.metadata && (
            <div className="flex items-center justify-between text-xs text-muted-foreground pt-2 border-t">
              <div className="flex items-center gap-2">
                {research.metadata.confidenceScore !== undefined && (
                  <span>Confidence: {research.metadata.confidenceScore}%</span>
                )}
                {research.metadata.model && (
                  <span>Model: {research.metadata.model}</span>
                )}
              </div>
              {research.metadata.sources && research.metadata.sources.length > 0 && (
                <span>{research.metadata.sources.length} sources</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
