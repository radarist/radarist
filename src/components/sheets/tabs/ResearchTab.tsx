'use client';

import * as React from 'react';
import {
  Clock,
  Sparkles,
  Package,
  DollarSign,
  Users,
  Lightbulb,
  Handshake,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Shield,
  FileText,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { canonicalHttpUrl } from '@/lib/signals/source-identity';
import { ResearchTabSkeleton } from '../EntitySheetSkeleton';
import { CompanyReviewPanel } from '@/components/scouting/CompanyReviewPanel';
import type { CompanyResearchPresentation, CompanyResearchDraftProvenance } from '@/lib/company-research-presentation';

// ============================================================================
// TYPES
// ============================================================================

export interface ResearchTabProps {
  /**
   * AI-028 — the ONE derived presentation state (see
   * `deriveCompanyResearchPresentation`). The caller derives it so the company
   * list and this tab can never disagree about whether research exists.
   */
  presentation: CompanyResearchPresentation;
  /**
   * AI-043 — the company id, so the inline human source-review panel can load and
   * record decisions. When absent, the review panel is not rendered.
   */
  companyId?: string;
  /** Whether research is currently loading */
  isLoading?: boolean;
  /** Additional class names */
  className?: string;
}

interface ResearchSectionProps {
  title: string;
  icon: React.ElementType;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

// ============================================================================
// HELPER COMPONENTS
// ============================================================================

/**
 * Collapsible section wrapper for research data
 */
function ResearchSection({ title, icon: Icon, children, defaultOpen = true }: ResearchSectionProps) {
  const [isOpen, setIsOpen] = React.useState(defaultOpen);

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
  );
}

/**
 * Format a timestamp to relative time
 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  if (days < 7) return `${days} day${days > 1 ? 's' : ''} ago`;
  return new Date(timestamp).toLocaleDateString();
}

/**
 * Health indicator badge
 */
function HealthBadge({ health }: { health: 'strong' | 'stable' | 'concerning' | 'critical' }) {
  const config = {
    strong: { label: 'Strong', className: 'bg-green-500/10 text-green-600 border-green-500/20' },
    stable: { label: 'Stable', className: 'bg-blue-500/10 text-blue-600 border-blue-500/20' },
    concerning: { label: 'Concerning', className: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20' },
    critical: { label: 'Critical', className: 'bg-red-500/10 text-red-600 border-red-500/20' },
  };
  const { label, className } = config[health];
  return (
    <Badge variant="outline" className={className}>
      {label}
    </Badge>
  );
}

/**
 * Risk level badge
 */
function RiskBadge({ level }: { level: 'low' | 'medium' | 'high' }) {
  const config = {
    low: { label: 'Low Risk', className: 'bg-green-500/10 text-green-600 border-green-500/20' },
    medium: { label: 'Medium Risk', className: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20' },
    high: { label: 'High Risk', className: 'bg-red-500/10 text-red-600 border-red-500/20' },
  };
  const { label, className } = config[level];
  return (
    <Badge variant="outline" className={className}>
      {label}
    </Badge>
  );
}

/**
 * Maturity badge
 */
function MaturityBadge({ maturity }: { maturity: 'emerging' | 'growing' | 'mature' | 'declining' }) {
  const config = {
    emerging: { label: 'Emerging', className: 'bg-purple-500/10 text-purple-600 border-purple-500/20' },
    growing: { label: 'Growing', className: 'bg-green-500/10 text-green-600 border-green-500/20' },
    mature: { label: 'Mature', className: 'bg-blue-500/10 text-blue-600 border-blue-500/20' },
    declining: { label: 'Declining', className: 'bg-orange-500/10 text-orange-600 border-orange-500/20' },
  };
  const { label, className } = config[maturity];
  return (
    <Badge variant="outline" className={className}>
      {label}
    </Badge>
  );
}

// ============================================================================
// AI-028 DRAFT NOTICE
// ============================================================================

/**
 * AI-028 — one restrained, honest notice that reframes ALL generated research as
 * an unverified AI draft. It covers the narrative, recommendations, SWOT,
 * contacts, and every other section, surfaces ONLY provenance counts that are
 * actually persisted (never a fabricated zero), and never claims verification —
 * `sourcingComplete` is deliberately NOT rendered as "verified"/"decision ready".
 */
function ResearchDraftNotice({
  provenance,
  hasSections,
}: {
  provenance: CompanyResearchDraftProvenance;
  hasSections: boolean;
}) {
  const { citationsUnverified, offeredSourceCount, sourceReferences, missingEvidenceCount } = provenance;
  const hasCounts = offeredSourceCount !== undefined || missingEvidenceCount !== undefined;

  return (
    <Card className="border-amber-500/30 bg-amber-500/5">
      <CardContent className="flex items-start gap-2 py-3">
        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-amber-700 dark:text-amber-300">AI draft — source review required</p>
          <p className="text-xs text-muted-foreground">
            {hasSections
              ? 'This research was generated by AI. Review the summary, recommendations, SWOT, contacts, and other sections — and confirm their sources — before relying on it.'
              : 'This company has an AI research record with no detailed sections to display. Review its sources before relying on it.'}
          </p>
          {citationsUnverified && (
            <p className="text-xs text-muted-foreground">
              Cited sources were AI-suggested and have not been independently checked.
            </p>
          )}
          {hasCounts && (
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              {offeredSourceCount !== undefined && (
                <span>
                  {offeredSourceCount} source reference{offeredSourceCount === 1 ? '' : 's'} offered
                </span>
              )}
              {missingEvidenceCount !== undefined && (
                <span>
                  {missingEvidenceCount} evidence area{missingEvidenceCount === 1 ? '' : 's'} without a cited source
                </span>
              )}
            </div>
          )}
          {sourceReferences && sourceReferences.length > 0 && (
            <div className="pt-1 text-xs">
              <p className="font-medium text-foreground">Source references</p>
              <ul aria-label="Research source references" className="mt-1 space-y-1 text-muted-foreground">
                {sourceReferences.map((reference, index) => {
                  const safeUrl = canonicalHttpUrl(reference.url)?.displayUrl;
                  return (
                    <li key={`${reference.label}-${index}`} className="break-words">
                      {safeUrl ? (
                        <a
                          href={safeUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                        >
                          {reference.label}
                          <ExternalLink aria-hidden="true" className="h-3 w-3 shrink-0" />
                        </a>
                      ) : (
                        <span>{reference.label}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
              {offeredSourceCount !== undefined && offeredSourceCount > sourceReferences.length && (
                <p className="mt-1 text-muted-foreground">
                  Showing {sourceReferences.length} of {offeredSourceCount} references.
                </p>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

/**
 * ResearchTab
 *
 * Displays comprehensive company research data with collapsible sections.
 * Only renders sections that have data available.
 */
export function ResearchTab({ presentation, companyId, isLoading = false, className }: ResearchTabProps) {
  // AI-028 — the ONE derived state decides what to render; `research` is present
  // only for a draft that carries renderable narrative content.
  const research = presentation.kind === 'draft' ? presentation.research : undefined;
  const provenance = presentation.kind === 'none' ? undefined : presentation.provenance;
  const lastResearchedAt = provenance?.lastResearchedAt;

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Company Research</h3>
          {lastResearchedAt !== undefined && (
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Last updated {formatRelativeTime(lastResearchedAt)}
            </p>
          )}
        </div>
      </div>

      {/* Loading State */}
      {isLoading && <ResearchTabSkeleton />}

      {/* Empty State — only when there is genuinely no research to disclose. */}
      {!isLoading && presentation.kind === 'none' && (
        <Card className="border-dashed">
          <CardContent className="py-8 text-center">
            <Sparkles className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm font-medium mb-1">No research data available</p>
            <p className="text-xs text-muted-foreground">
              Use the &quot;Start Research&quot; button in the footer to gather comprehensive information about this
              company.
            </p>
          </CardContent>
        </Card>
      )}

      {/* AI-028 — one restrained draft/source-review notice over ALL generated
          content (draft), or the honest metadata-only state (legacy record). */}
      {!isLoading && presentation.kind !== 'none' && (
        <ResearchDraftNotice provenance={presentation.provenance} hasSections={presentation.kind === 'draft'} />
      )}

      {/* AI-043 — the inline human source-review panel (renders only when there is
          a reviewable draft for this company). */}
      {!isLoading && companyId && <CompanyReviewPanel companyId={companyId} />}

      {/* Research Sections — the AI draft's generated content stays fully visible
          beneath the notice. */}
      {!isLoading && research && (
        <div className="space-y-3">
          {/* Executive Summary */}
          {research.executiveSummary && (
            <ResearchSection title="Executive Summary" icon={Sparkles}>
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">{research.executiveSummary.overview}</p>
                {research.executiveSummary.keyHighlights && research.executiveSummary.keyHighlights.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Key Highlights</p>
                    <ul className="list-disc list-inside space-y-1">
                      {research.executiveSummary.keyHighlights.map((highlight, i) => (
                        <li key={i} className="text-sm">
                          {highlight}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {research.executiveSummary.recommendation && (
                  <div className="p-3 rounded-lg bg-primary/5 border border-primary/10">
                    <p className="text-xs font-medium text-primary mb-1">Recommendation</p>
                    <p className="text-sm">{research.executiveSummary.recommendation}</p>
                  </div>
                )}
              </div>
            </ResearchSection>
          )}

          {/* Products & Solutions */}
          {research.productsAndSolutions && (
            <ResearchSection title="Products & Solutions" icon={Package}>
              <div className="space-y-3">
                {research.productsAndSolutions.coreProducts &&
                  research.productsAndSolutions.coreProducts.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-2">Core Products</p>
                      <div className="grid gap-2">
                        {research.productsAndSolutions.coreProducts.map((product, i) => (
                          <div key={i} className="p-2 rounded-lg bg-muted/50 border">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm">{product.name}</span>
                              {product.category && (
                                <Badge variant="secondary" className="text-xs">
                                  {product.category}
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground mt-1">{product.description}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                <div className="flex flex-wrap gap-2">
                  {research.productsAndSolutions.deploymentModel && (
                    <div className="text-xs">
                      <span className="text-muted-foreground">Deployment:</span>{' '}
                      <Badge variant="outline">{research.productsAndSolutions.deploymentModel.toUpperCase()}</Badge>
                    </div>
                  )}
                  {research.productsAndSolutions.productMaturity && (
                    <div className="text-xs">
                      <span className="text-muted-foreground">Maturity:</span>{' '}
                      <MaturityBadge maturity={research.productsAndSolutions.productMaturity} />
                    </div>
                  )}
                </div>
                {research.productsAndSolutions.integrationCapabilities &&
                  research.productsAndSolutions.integrationCapabilities.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1">Integration Capabilities</p>
                      <div className="flex flex-wrap gap-1">
                        {research.productsAndSolutions.integrationCapabilities.map((cap, i) => (
                          <Badge key={i} variant="secondary" className="text-xs">
                            {cap}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
              </div>
            </ResearchSection>
          )}

          {/* Financials & Traction */}
          {research.financialsAndTraction && (
            <ResearchSection title="Financials & Traction" icon={DollarSign}>
              <div className="space-y-3">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {research.financialsAndTraction.totalRaised && (
                    <div className="p-2 rounded-lg bg-muted/50">
                      <p className="text-xs text-muted-foreground">Total Raised</p>
                      <p className="font-semibold">{research.financialsAndTraction.totalRaised}</p>
                    </div>
                  )}
                  {research.financialsAndTraction.revenueRange && (
                    <div className="p-2 rounded-lg bg-muted/50">
                      <p className="text-xs text-muted-foreground">Revenue</p>
                      <p className="font-semibold">{research.financialsAndTraction.revenueRange}</p>
                    </div>
                  )}
                  {research.financialsAndTraction.customerCount && (
                    <div className="p-2 rounded-lg bg-muted/50">
                      <p className="text-xs text-muted-foreground">Customers</p>
                      <p className="font-semibold">{research.financialsAndTraction.customerCount}</p>
                    </div>
                  )}
                </div>
                {research.financialsAndTraction.fundingHistory &&
                  research.financialsAndTraction.fundingHistory.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-2">Funding History</p>
                      <div className="space-y-1">
                        {research.financialsAndTraction.fundingHistory.map((round, i) => (
                          <div
                            key={i}
                            className="flex items-center justify-between text-sm py-1 border-b border-dashed last:border-0"
                          >
                            <span className="font-medium">{round.round}</span>
                            <div className="flex items-center gap-2">
                              {round.amount && <span>{round.amount}</span>}
                              {round.date && <span className="text-xs text-muted-foreground">{round.date}</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                {research.financialsAndTraction.keyInvestors &&
                  research.financialsAndTraction.keyInvestors.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1">Key Investors</p>
                      <div className="flex flex-wrap gap-1">
                        {research.financialsAndTraction.keyInvestors.map((investor, i) => (
                          <Badge key={i} variant="outline" className="text-xs">
                            {investor}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                {/* SWOT within Financials */}
                {research.financialsAndTraction.swot && (
                  <div className="mt-4 pt-3 border-t">
                    <p className="text-xs font-medium text-muted-foreground mb-2">SWOT Analysis</p>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      {research.financialsAndTraction.swot.strengths?.length > 0 && (
                        <div className="p-2 rounded-lg bg-green-500/5 border border-green-500/10">
                          <p className="font-medium text-green-600 mb-1">Strengths</p>
                          <ul className="list-disc list-inside text-muted-foreground">
                            {research.financialsAndTraction.swot.strengths.map((s, i) => (
                              <li key={i}>{s}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {research.financialsAndTraction.swot.weaknesses?.length > 0 && (
                        <div className="p-2 rounded-lg bg-red-500/5 border border-red-500/10">
                          <p className="font-medium text-red-600 mb-1">Weaknesses</p>
                          <ul className="list-disc list-inside text-muted-foreground">
                            {research.financialsAndTraction.swot.weaknesses.map((w, i) => (
                              <li key={i}>{w}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {research.financialsAndTraction.swot.opportunities?.length > 0 && (
                        <div className="p-2 rounded-lg bg-blue-500/5 border border-blue-500/10">
                          <p className="font-medium text-blue-600 mb-1">Opportunities</p>
                          <ul className="list-disc list-inside text-muted-foreground">
                            {research.financialsAndTraction.swot.opportunities.map((o, i) => (
                              <li key={i}>{o}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {research.financialsAndTraction.swot.threats?.length > 0 && (
                        <div className="p-2 rounded-lg bg-orange-500/5 border border-orange-500/10">
                          <p className="font-medium text-orange-600 mb-1">Threats</p>
                          <ul className="list-disc list-inside text-muted-foreground">
                            {research.financialsAndTraction.swot.threats.map((t, i) => (
                              <li key={i}>{t}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </ResearchSection>
          )}

          {/* Team & Leadership */}
          {research.teamAndLeadership && (
            <ResearchSection title="Team & Leadership" icon={Users}>
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  {research.teamAndLeadership.teamSize && (
                    <div className="text-xs">
                      <span className="text-muted-foreground">Team Size:</span>{' '}
                      <Badge variant="outline">{research.teamAndLeadership.teamSize}</Badge>
                    </div>
                  )}
                  {research.teamAndLeadership.engineeringRatio && (
                    <div className="text-xs">
                      <span className="text-muted-foreground">Engineering:</span>{' '}
                      <Badge variant="outline">{research.teamAndLeadership.engineeringRatio}</Badge>
                    </div>
                  )}
                </div>
                {research.teamAndLeadership.founders && research.teamAndLeadership.founders.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">Founders</p>
                    <div className="space-y-2">
                      {research.teamAndLeadership.founders.map((founder, i) => {
                        const linkedInUrl = canonicalHttpUrl(founder.linkedIn)?.displayUrl;
                        return (
                          <div key={i} className="flex items-start justify-between p-2 rounded-lg bg-muted/50">
                            <div>
                              <p className="font-medium text-sm">{founder.name}</p>
                              <p className="text-xs text-muted-foreground">{founder.role}</p>
                              {founder.background && (
                                <p className="text-xs text-muted-foreground mt-1">{founder.background}</p>
                              )}
                            </div>
                            {linkedInUrl && (
                              <a
                                aria-label={`Open LinkedIn profile for ${founder.name}`}
                                href={linkedInUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-500 hover:text-blue-600"
                              >
                                <ExternalLink aria-hidden="true" className="h-4 w-4" />
                              </a>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {research.teamAndLeadership.keyExecutives && research.teamAndLeadership.keyExecutives.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">Key Executives</p>
                    <div className="space-y-1">
                      {research.teamAndLeadership.keyExecutives.map((exec, i) => (
                        <div
                          key={i}
                          className="flex items-center justify-between text-sm py-1 border-b border-dashed last:border-0"
                        >
                          <span className="font-medium">{exec.name}</span>
                          <span className="text-muted-foreground">{exec.role}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </ResearchSection>
          )}

          {/* Innovation Indicators */}
          {research.innovationIndicators && (
            <ResearchSection title="Innovation Indicators" icon={Lightbulb}>
              <div className="space-y-3">
                <div className="flex flex-wrap gap-3">
                  {research.innovationIndicators.patentCount !== undefined && (
                    <div className="text-xs">
                      <span className="text-muted-foreground">Patents:</span>{' '}
                      <Badge variant="outline">{research.innovationIndicators.patentCount}</Badge>
                    </div>
                  )}
                  {research.innovationIndicators.productVelocity && (
                    <div className="text-xs">
                      <span className="text-muted-foreground">Product Velocity:</span>{' '}
                      <Badge
                        variant="outline"
                        className={cn(
                          research.innovationIndicators.productVelocity === 'high' && 'bg-green-500/10 text-green-600',
                          research.innovationIndicators.productVelocity === 'medium' &&
                            'bg-yellow-500/10 text-yellow-600',
                          research.innovationIndicators.productVelocity === 'low' && 'bg-red-500/10 text-red-600'
                        )}
                      >
                        {research.innovationIndicators.productVelocity.charAt(0).toUpperCase() +
                          research.innovationIndicators.productVelocity.slice(1)}
                      </Badge>
                    </div>
                  )}
                </div>
                {research.innovationIndicators.openSourceActivity && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">Open Source Activity</p>
                    <div className="flex gap-4">
                      {research.innovationIndicators.openSourceActivity.repos !== undefined && (
                        <div className="text-center">
                          <p className="font-semibold">{research.innovationIndicators.openSourceActivity.repos}</p>
                          <p className="text-xs text-muted-foreground">Repos</p>
                        </div>
                      )}
                      {research.innovationIndicators.openSourceActivity.stars !== undefined && (
                        <div className="text-center">
                          <p className="font-semibold">
                            {research.innovationIndicators.openSourceActivity.stars.toLocaleString()}
                          </p>
                          <p className="text-xs text-muted-foreground">Stars</p>
                        </div>
                      )}
                      {research.innovationIndicators.openSourceActivity.contributors !== undefined && (
                        <div className="text-center">
                          <p className="font-semibold">
                            {research.innovationIndicators.openSourceActivity.contributors}
                          </p>
                          <p className="text-xs text-muted-foreground">Contributors</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </ResearchSection>
          )}

          {/* Partnerships & Ecosystem */}
          {research.partnershipsAndEcosystem && (
            <ResearchSection title="Partnerships & Ecosystem" icon={Handshake}>
              <div className="space-y-3">
                {research.partnershipsAndEcosystem.ecosystemPosition && (
                  <div className="text-xs">
                    <span className="text-muted-foreground">Ecosystem Position:</span>{' '}
                    <Badge
                      variant="outline"
                      className={cn(
                        research.partnershipsAndEcosystem.ecosystemPosition === 'leader' &&
                          'bg-green-500/10 text-green-600',
                        research.partnershipsAndEcosystem.ecosystemPosition === 'challenger' &&
                          'bg-blue-500/10 text-blue-600',
                        research.partnershipsAndEcosystem.ecosystemPosition === 'follower' &&
                          'bg-yellow-500/10 text-yellow-600',
                        research.partnershipsAndEcosystem.ecosystemPosition === 'niche' &&
                          'bg-purple-500/10 text-purple-600'
                      )}
                    >
                      {research.partnershipsAndEcosystem.ecosystemPosition.charAt(0).toUpperCase() +
                        research.partnershipsAndEcosystem.ecosystemPosition.slice(1)}
                    </Badge>
                  </div>
                )}
                {research.partnershipsAndEcosystem.strategicPartners &&
                  research.partnershipsAndEcosystem.strategicPartners.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1">Strategic Partners</p>
                      <div className="flex flex-wrap gap-1">
                        {research.partnershipsAndEcosystem.strategicPartners.map((partner, i) => (
                          <Badge key={i} variant="outline" className="text-xs">
                            {partner}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                {research.partnershipsAndEcosystem.technologyPartners &&
                  research.partnershipsAndEcosystem.technologyPartners.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1">Technology Partners</p>
                      <div className="flex flex-wrap gap-1">
                        {research.partnershipsAndEcosystem.technologyPartners.map((partner, i) => (
                          <Badge key={i} variant="secondary" className="text-xs">
                            {partner}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
              </div>
            </ResearchSection>
          )}

          {/* Risk Assessment */}
          {research.riskAssessment && (
            <ResearchSection title="Risk Assessment" icon={Shield}>
              <div className="space-y-3">
                <div className="flex flex-wrap gap-3">
                  {research.riskAssessment.vendorRiskScore !== undefined && (
                    <div className="flex-1 min-w-[140px]">
                      <p className="text-xs text-muted-foreground mb-1">Vendor Risk Score</p>
                      <div className="flex items-center gap-2">
                        <Progress value={100 - research.riskAssessment.vendorRiskScore} className="h-2" />
                        <span className="text-sm font-medium">{research.riskAssessment.vendorRiskScore}/100</span>
                      </div>
                    </div>
                  )}
                  {research.riskAssessment.financialHealth && (
                    <div className="text-xs">
                      <span className="text-muted-foreground">Financial Health:</span>{' '}
                      <HealthBadge health={research.riskAssessment.financialHealth} />
                    </div>
                  )}
                  {research.riskAssessment.regulatoryExposure && (
                    <div className="text-xs">
                      <span className="text-muted-foreground">Regulatory:</span>{' '}
                      <RiskBadge level={research.riskAssessment.regulatoryExposure} />
                    </div>
                  )}
                </div>
                {research.riskAssessment.dependencyRisks && research.riskAssessment.dependencyRisks.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Dependency Risks</p>
                    <ul className="list-disc list-inside text-sm text-muted-foreground">
                      {research.riskAssessment.dependencyRisks.map((risk, i) => (
                        <li key={i}>{risk}</li>
                      ))}
                    </ul>
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
                  <span>AI-estimated confidence: {research.metadata.confidenceScore}%</span>
                )}
                {research.metadata.model && <span>Model: {research.metadata.model}</span>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
