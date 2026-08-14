'use client';

import * as React from 'react';
import type { UseFormReturn } from 'react-hook-form';
import {
  Globe,
  Github,
  BookOpen,
  Plus,
  X,
  Loader2,
  Sparkles,
  TrendingUp,
  TrendingDown,
  Minus,
  BarChart3,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

import type { Technology, MarketInterest } from '@/lib/types';

import {
  TECHNOLOGY_CATEGORIES,
  TRL_OPTIONS,
  TIME_TO_IMPACT_OPTIONS,
  COMMON_TAGS,
  type TechnologyFormValues,
} from './constants';

// ============================================================================
// OVERVIEW TAB
// ============================================================================

interface OverviewTabProps {
  form: UseFormReturn<TechnologyFormValues>;
  isLoading?: boolean;
  /** Technology data for displaying read-only metadata like marketInterest */
  technology?: Technology;
}

function OverviewTab({ form, isLoading: _isLoading, technology }: OverviewTabProps) {
  const [newTag, setNewTag] = React.useState('');

  const handleAddTag = () => {
    if (!newTag.trim()) return;
    const current = form.getValues('tags');
    if (!current.includes(newTag.trim())) {
      form.setValue('tags', [...current, newTag.trim()], { shouldDirty: true });
    }
    setNewTag('');
  };

  const handleRemoveTag = (tag: string) => {
    const current = form.getValues('tags');
    form.setValue(
      'tags',
      current.filter((t) => t !== tag),
      { shouldDirty: true }
    );
  };

  const handleToggleTag = (tag: string) => {
    const current = form.getValues('tags');
    if (current.includes(tag)) {
      handleRemoveTag(tag);
    } else {
      form.setValue('tags', [...current, tag], { shouldDirty: true });
    }
  };

  return (
    <Form {...form}>
      <form className="space-y-6">
        {/* Basic Info */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">Basic Information</h3>

          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Technology Name *</FormLabel>
                <FormControl>
                  <Input placeholder="e.g., React, PostgreSQL, Kubernetes" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="description"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Description *</FormLabel>
                <FormControl>
                  <Textarea
                    placeholder="Brief description of the technology, its purpose, and key features..."
                    rows={3}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="category"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Category</FormLabel>
                {/* Key prop forces Select to re-mount when technology changes,
                    fixing sync issue between Radix UI Select and react-hook-form.
                    IMPORTANT: value must be undefined (not '') when no selection */}
                <Select
                  key={`category-${technology?.id || 'new'}-${field.value || 'none'}`}
                  onValueChange={field.onChange}
                  value={field.value}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select category" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {TECHNOLOGY_CATEGORIES.map((cat) => (
                      <SelectItem key={cat.value} value={cat.value}>
                        {cat.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Technology Readiness Level (TRL) */}
          <FormField
            control={form.control}
            name="trl"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Technology Readiness Level (TRL)</FormLabel>
                <Select
                  key={`trl-${technology?.id || 'new'}-${field.value || 'none'}`}
                  onValueChange={(value) => field.onChange(value ? parseInt(value, 10) : undefined)}
                  value={field.value?.toString()}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select TRL (1-9)" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {TRL_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value.toString()}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>Standard 1-9 scale measuring technology maturity</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Time to Impact Horizon */}
          <FormField
            control={form.control}
            name="timeToImpact"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Time to Impact</FormLabel>
                <Select
                  key={`tti-${technology?.id || 'new'}-${field.value || 'none'}`}
                  onValueChange={field.onChange}
                  value={field.value}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select time horizon" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {TIME_TO_IMPACT_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>Expected timeframe for significant adoption or impact</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* URLs */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">Links</h3>

          <FormField
            control={form.control}
            name="websiteUrl"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Website</FormLabel>
                <FormControl>
                  <div className="relative">
                    <Globe className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input placeholder="https://example.com" className="pl-9" {...field} />
                  </div>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="githubUrl"
            render={({ field }) => (
              <FormItem>
                <FormLabel>GitHub Repository</FormLabel>
                <FormControl>
                  <div className="relative">
                    <Github className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input placeholder="https://github.com/org/repo" className="pl-9" {...field} />
                  </div>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="documentationUrl"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Documentation</FormLabel>
                <FormControl>
                  <div className="relative">
                    <BookOpen className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input placeholder="https://docs.example.com" className="pl-9" {...field} />
                  </div>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Tags */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">Tags</h3>

          {/* Common tags */}
          <div className="flex flex-wrap gap-2">
            {COMMON_TAGS.map((tag) => (
              <Badge
                key={tag}
                variant={form.watch('tags').includes(tag) ? 'default' : 'outline'}
                className="cursor-pointer"
                onClick={() => handleToggleTag(tag)}
              >
                {tag}
              </Badge>
            ))}
          </div>

          {/* Custom tags */}
          <div className="flex flex-wrap gap-2">
            {form
              .watch('tags')
              .filter((t) => !COMMON_TAGS.includes(t))
              .map((tag) => (
                <Badge key={tag} variant="secondary" className="gap-1">
                  {tag}
                  <X className="h-3 w-3 cursor-pointer hover:text-destructive" onClick={() => handleRemoveTag(tag)} />
                </Badge>
              ))}
          </div>

          {/* Add custom tag */}
          <div className="flex gap-2">
            <Input
              placeholder="Add a custom tag..."
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddTag();
                }
              }}
            />
            <Button type="button" variant="outline" size="icon" onClick={handleAddTag}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Market Interest (Read-only metadata from AI/system) */}
        {technology?.marketInterest && <MarketInterestDisplay marketInterest={technology.marketInterest} />}
      </form>
    </Form>
  );
}

// ============================================================================
// MARKET INTEREST DISPLAY (Phase 0 Task 0.2.1)
// ============================================================================

interface MarketInterestDisplayProps {
  marketInterest: MarketInterest;
  /** Callback to trigger AI TRL assessment */
  onAssessTRL?: () => Promise<void>;
  /** Whether AI assessment is in progress */
  isAssessing?: boolean;
}

/**
 * TRL (Technology Readiness Level) descriptions.
 * Standard 1-9 scale used in NASA, DoD, and innovation management.
 */
const TRL_DESCRIPTIONS: Record<number, string> = {
  1: 'Basic principles observed',
  2: 'Technology concept formulated',
  3: 'Experimental proof of concept',
  4: 'Technology validated in lab',
  5: 'Technology validated in relevant environment',
  6: 'Technology demonstrated in relevant environment',
  7: 'System prototype demonstration',
  8: 'System complete and qualified',
  9: 'Actual system proven in operational environment',
};

/**
 * Get TRL phase label (Research/Development/Deployment).
 */
function getTRLPhase(trl: number): { label: string; color: string } {
  if (trl <= 3) return { label: 'Research', color: 'text-blue-600' };
  if (trl <= 6) return { label: 'Development', color: 'text-amber-600' };
  return { label: 'Deployment', color: 'text-green-600' };
}

/**
 * Read-only display for market interest data.
 * This data is populated by AI research and external signal analysis,
 * not user input.
 *
 * @phase Phase 0 Task 0.2.1
 */
function MarketInterestDisplay({ marketInterest, onAssessTRL, isAssessing }: MarketInterestDisplayProps) {
  const getTrendIcon = () => {
    switch (marketInterest.trend) {
      case 'rising':
        return <TrendingUp className="h-4 w-4 text-green-500" />;
      case 'declining':
        return <TrendingDown className="h-4 w-4 text-red-500" />;
      default:
        return <Minus className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getTrendLabel = () => {
    switch (marketInterest.trend) {
      case 'rising':
        return 'Rising';
      case 'declining':
        return 'Declining';
      default:
        return 'Stable';
    }
  };

  const getTrendColor = () => {
    switch (marketInterest.trend) {
      case 'rising':
        return 'text-green-600';
      case 'declining':
        return 'text-red-600';
      default:
        return 'text-muted-foreground';
    }
  };

  const getScoreColor = () => {
    if (marketInterest.score >= 70) return 'text-green-600';
    if (marketInterest.score >= 40) return 'text-yellow-600';
    return 'text-red-600';
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const trl = marketInterest.trl;
  const trlPhase = trl ? getTRLPhase(trl) : null;

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
        <BarChart3 className="h-4 w-4" />
        Market Interest & Readiness
      </h3>

      <Card>
        <CardContent className="p-4">
          <div className="grid grid-cols-3 gap-4">
            {/* Score */}
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">Interest Score</span>
              <div className="flex items-baseline gap-1">
                <span className={cn('text-2xl font-bold', getScoreColor())}>{marketInterest.score}</span>
                <span className="text-sm text-muted-foreground">/100</span>
              </div>
            </div>

            {/* Trend */}
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">Trend</span>
              <div className="flex items-center gap-2">
                {getTrendIcon()}
                <span className={cn('text-sm font-medium', getTrendColor())}>{getTrendLabel()}</span>
              </div>
            </div>

            {/* TRL */}
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">Technology Readiness</span>
              {trl ? (
                <div className="space-y-0.5">
                  <div className="flex items-baseline gap-1">
                    <span className={cn('text-2xl font-bold', trlPhase?.color)}>TRL {trl}</span>
                  </div>
                  <span className={cn('text-xs', trlPhase?.color)}>{trlPhase?.label}</span>
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  <span className="text-sm text-muted-foreground">Not assessed</span>
                  {onAssessTRL && (
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={onAssessTRL}
                      disabled={isAssessing}
                    >
                      {isAssessing ? (
                        <>
                          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          Assessing...
                        </>
                      ) : (
                        <>
                          <Sparkles className="h-3 w-3 mr-1" />
                          Assess with AI
                        </>
                      )}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* TRL Description */}
          {trl && TRL_DESCRIPTIONS[trl] && (
            <div className="mt-4 pt-4 border-t">
              <span className="text-sm text-muted-foreground">{TRL_DESCRIPTIONS[trl]}</span>
            </div>
          )}

          {/* Sources */}
          {marketInterest.sources && marketInterest.sources.length > 0 && (
            <div className="mt-4 pt-4 border-t space-y-2">
              <span className="text-xs text-muted-foreground">Data Sources</span>
              <div className="flex flex-wrap gap-1">
                {marketInterest.sources.map((source, idx) => (
                  <Badge key={idx} variant="outline" className="text-xs">
                    {source}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Last Updated */}
          <div className="mt-4 pt-4 border-t">
            <span className="text-xs text-muted-foreground">
              Last updated: {formatDate(marketInterest.lastUpdated)}
            </span>
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground italic">
        Market interest and TRL data is automatically populated by AI research and external signal analysis.
      </p>
    </div>
  );
}

export { OverviewTab };
export type { OverviewTabProps };
