'use client'

import * as React from 'react'
import {
  Sparkles,
  Loader2,
  Check,
  Globe,
  MapPin,
  Building2,
  Tag,
  Layers,
  AlertCircle,
  RefreshCw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import type { EntityType } from '@/lib/types'

// ============================================================================
// TYPES
// ============================================================================

export interface AIResearchResult {
  // Core fields
  summary?: string
  description?: string
  industry?: string[]
  location?: { city?: string; country?: string }
  tags?: string[]
  technologies?: string[]
  technologyStack?: string[] // Alias for technologies
  competitors?: string[]
  insights?: string[]
  confidence?: number

  // Extended company fields (from research-company.ts)
  type?: string[]
  size?: string
  stage?: string
  socialLinks?: {
    linkedin?: string | null
    twitter?: string | null
    github?: string | null
  }
  contacts?: Array<{
    name: string
    role: string
    linkedin?: string | null
  }>
  documents?: Array<{
    name: string
    url: string
    type?: 'link' | 'upload'
  }>
  swot?: {
    strengths: string[]
    weaknesses: string[]
    opportunities: string[]
    threats: string[]
  }
  fundingInfo?: {
    totalRaised?: string
    lastRound?: string
    investors?: string[]
  }
}

interface AIResearchTabProps {
  /** Entity type being researched */
  entityType: EntityType
  /** Entity name for research */
  entityName: string
  /** Additional context for research (e.g., website URL) */
  context?: Record<string, string>
  /** Callback when research is triggered */
  onResearch: (entityName: string, context?: Record<string, string>) => Promise<AIResearchResult | null>
  /** Callback to apply research results */
  onApply?: (result: AIResearchResult) => void
  /** Whether in read-only mode */
  readOnly?: boolean
  /** Additional class names */
  className?: string
}

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * AIResearchTab
 *
 * Tab component for AI-powered entity research.
 * Triggers AI analysis and displays results with apply option.
 */
export function AIResearchTab({
  entityType,
  entityName,
  context,
  onResearch,
  onApply,
  readOnly = false,
  className,
}: AIResearchTabProps) {
  const [isLoading, setIsLoading] = React.useState(false)
  const [result, setResult] = React.useState<AIResearchResult | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [hasApplied, setHasApplied] = React.useState(false)

  const handleResearch = async () => {
    if (!entityName.trim()) {
      setError('Please provide an entity name first.')
      return
    }

    setIsLoading(true)
    setError(null)
    setHasApplied(false)

    try {
      const data = await onResearch(entityName, context)
      if (data) {
        setResult(data)
      } else {
        setError('Could not retrieve research data. Please try again.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Research failed. Please try again.')
    } finally {
      setIsLoading(false)
    }
  }

  const handleApply = () => {
    if (result && onApply) {
      onApply(result)
      setHasApplied(true)
    }
  }

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {/* Header with Research Button */}
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">AI Research</h3>
          <p className="text-xs text-muted-foreground">
            Use AI to gather information about this {entityType}.
          </p>
        </div>
        <Button
          onClick={handleResearch}
          disabled={isLoading || !entityName.trim() || readOnly}
          size="sm"
        >
          {isLoading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Researching...
            </>
          ) : result ? (
            <>
              <RefreshCw className="mr-2 h-4 w-4" />
              Re-research
            </>
          ) : (
            <>
              <Sparkles className="mr-2 h-4 w-4" />
              Start Research
            </>
          )}
        </Button>
      </div>

      {/* Error State */}
      {error && (
        <Card className="border-destructive/50 bg-destructive/10">
          <CardContent className="flex items-center gap-2 py-3">
            <AlertCircle className="h-4 w-4 text-destructive" />
            <span className="text-sm text-destructive">{error}</span>
          </CardContent>
        </Card>
      )}

      {/* Empty State */}
      {!result && !isLoading && !error && (
        <Card className="border-dashed">
          <CardContent className="py-8 text-center">
            <Sparkles className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              Click "Start Research" to analyze this {entityType} with AI.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Loading State */}
      {isLoading && (
        <Card>
          <CardContent className="py-8 text-center">
            <Loader2 className="mx-auto mb-2 h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">
              AI is researching {entityName}...
            </p>
          </CardContent>
        </Card>
      )}

      {/* Results */}
      {result && !isLoading && (
        <ScrollArea className="flex-1">
          <div className="space-y-4">
            {/* Summary */}
            {result.summary && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Summary</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm">{result.summary}</p>
                </CardContent>
              </Card>
            )}

            {/* Description */}
            {result.description && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Description</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">{result.description}</p>
                </CardContent>
              </Card>
            )}

            {/* Industries */}
            {result.industry && result.industry.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Building2 className="h-4 w-4" />
                    Industries
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-1">
                    {result.industry.map((ind, i) => (
                      <Badge key={i} variant="secondary">{ind}</Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Location */}
            {result.location && (result.location.city || result.location.country) && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <MapPin className="h-4 w-4" />
                    Location
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm">
                    {[result.location.city, result.location.country].filter(Boolean).join(', ')}
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Technologies */}
            {result.technologies && result.technologies.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Layers className="h-4 w-4" />
                    Technologies
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-1">
                    {result.technologies.map((tech, i) => (
                      <Badge key={i} variant="outline">{tech}</Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Tags */}
            {result.tags && result.tags.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Tag className="h-4 w-4" />
                    Tags
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-1">
                    {result.tags.map((tag, i) => (
                      <Badge key={i} variant="secondary">{tag}</Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Insights */}
            {result.insights && result.insights.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Sparkles className="h-4 w-4" />
                    Key Insights
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="list-disc list-inside space-y-1">
                    {result.insights.map((insight, i) => (
                      <li key={i} className="text-sm text-muted-foreground">{insight}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            {/* Competitors */}
            {result.competitors && result.competitors.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Building2 className="h-4 w-4" />
                    Competitors
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-1">
                    {result.competitors.map((comp, i) => (
                      <Badge key={i} variant="outline">{comp}</Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* SWOT Analysis */}
            {result.swot && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Sparkles className="h-4 w-4" />
                    SWOT Analysis
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    {result.swot.strengths && result.swot.strengths.length > 0 && (
                      <div className="space-y-1">
                        <p className="font-medium text-green-600">Strengths</p>
                        <ul className="list-disc list-inside text-muted-foreground">
                          {result.swot.strengths.map((s, i) => <li key={i}>{s}</li>)}
                        </ul>
                      </div>
                    )}
                    {result.swot.weaknesses && result.swot.weaknesses.length > 0 && (
                      <div className="space-y-1">
                        <p className="font-medium text-red-600">Weaknesses</p>
                        <ul className="list-disc list-inside text-muted-foreground">
                          {result.swot.weaknesses.map((w, i) => <li key={i}>{w}</li>)}
                        </ul>
                      </div>
                    )}
                    {result.swot.opportunities && result.swot.opportunities.length > 0 && (
                      <div className="space-y-1">
                        <p className="font-medium text-blue-600">Opportunities</p>
                        <ul className="list-disc list-inside text-muted-foreground">
                          {result.swot.opportunities.map((o, i) => <li key={i}>{o}</li>)}
                        </ul>
                      </div>
                    )}
                    {result.swot.threats && result.swot.threats.length > 0 && (
                      <div className="space-y-1">
                        <p className="font-medium text-orange-600">Threats</p>
                        <ul className="list-disc list-inside text-muted-foreground">
                          {result.swot.threats.map((t, i) => <li key={i}>{t}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Contacts */}
            {result.contacts && result.contacts.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Globe className="h-4 w-4" />
                    Key Contacts
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2">
                    {result.contacts.map((contact, i) => (
                      <li key={i} className="text-sm">
                        <span className="font-medium">{contact.name}</span>
                        <span className="text-muted-foreground"> - {contact.role}</span>
                        {contact.linkedin && (
                          <a
                            href={contact.linkedin}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ml-2 text-blue-600 hover:underline"
                          >
                            LinkedIn
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            {/* Confidence */}
            {result.confidence !== undefined && (
              <div className="text-xs text-muted-foreground text-right">
                Confidence: {Math.round(result.confidence * 100)}%
              </div>
            )}

            {/* Apply Button */}
            {onApply && !readOnly && (
              <>
                <Separator />
                <div className="flex justify-end">
                  <Button
                    onClick={handleApply}
                    disabled={hasApplied}
                    variant={hasApplied ? 'outline' : 'default'}
                  >
                    {hasApplied ? (
                      <>
                        <Check className="mr-2 h-4 w-4" />
                        Applied
                      </>
                    ) : (
                      <>
                        <Check className="mr-2 h-4 w-4" />
                        Apply to Entity
                      </>
                    )}
                  </Button>
                </div>
              </>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}

// ============================================================================
// EXPORTS
// ============================================================================

export type { AIResearchTabProps }
