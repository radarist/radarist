/**
 * @file AICompanyResearch.tsx
 * @description Component for AI-powered company research.
 *
 * This component allows users to trigger an AI research process for a company.
 * It displays the research results and allows applying them to the company profile.
 *
 * @author Radarist Team
 * @created 2025-11-25
 */

'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Sparkles, Loader2, Check, MapPin, Building2, Tag, Layers, Share2 } from 'lucide-react';
import { researchCompanyAction } from '@/app/actions';
import type { Company } from '@/lib/types';
import { useToast } from '@/hooks/use-toast';
import type { ResearchCompanyOutput } from '@/ai/flows/research-company';
import { createLogger } from '@/lib/logger';

const log = createLogger('ui/AICompanyResearch');

function safeExternalUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

interface AICompanyResearchProps {
  /** The company to research. */
  company: Partial<Company>;
  /** Callback to apply research results to the company. */
  onApply: (data: Partial<Company>) => void;
}

/**
 * AICompanyResearch component.
 *
 * @param props - Component props
 * @returns The rendered component
 */
export function AICompanyResearch({ company, onApply }: AICompanyResearchProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<ResearchCompanyOutput | null>(null);
  const { toast } = useToast();
  const safeSocialLinks = result
    ? {
        linkedin: safeExternalUrl(result.socialLinks?.linkedin),
        twitter: safeExternalUrl(result.socialLinks?.twitter),
        github: safeExternalUrl(result.socialLinks?.github),
      }
    : {};

  const handleResearch = async () => {
    if (!company.name) {
      toast({
        title: 'Missing Information',
        description: 'Please enter a company name first.',
        variant: 'destructive',
      });
      return;
    }

    setIsLoading(true);
    try {
      const data = await researchCompanyAction({
        name: company.name,
        website: company.website,
      });

      if (data) {
        setResult(data);
        toast({
          title: 'Research draft ready',
          description: 'This quick draft has no source receipts. Independently verify it before staging fields.',
        });
      } else {
        toast({
          title: 'Research Failed',
          description: 'Could not retrieve company information.',
          variant: 'destructive',
        });
      }
    } catch (error) {
      log.error('Research error', error instanceof Error ? error : undefined);
      toast({
        title: 'Error',
        description: 'An error occurred during research.',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleApply = () => {
    if (!result) return;

    // Map research result to Company interface
    // Phase 4: Cast AI research results to proper enum types
    const updates: Partial<Company> = {
      description: result.description,
      // AI-028 — do NOT apply size/stage/type/industry from this unbounded
      // result. They are free-text model strings (e.g. "SME", "Series A")
      // and casting them onto the domain enums fabricates type-valid but
      // wrong facts. They are left unchanged rather than guessed.
      location: result.location,
      tags: [...(company.tags || []), ...result.tags].filter((v, i, a) => a.indexOf(v) === i), // Merge unique
      technologyStack: result.technologyStack,
      socialLinks: {
        linkedin: safeSocialLinks.linkedin || company.socialLinks?.linkedin || undefined,
        twitter: safeSocialLinks.twitter || company.socialLinks?.twitter || undefined,
        github: safeSocialLinks.github || company.socialLinks?.github || undefined,
      },
    };

    onApply(updates);
    toast({
      title: 'Draft staged for review',
      description: 'Review and independently verify the generated fields, then save to persist them.',
    });
  };

  return (
    <div className="space-y-6">
      {!result && !isLoading && (
        <div className="text-center py-12 space-y-4">
          <div className="bg-primary/10 w-16 h-16 rounded-full flex items-center justify-center mx-auto">
            <Sparkles className="w-8 h-8 text-primary" />
          </div>
          <div className="max-w-md mx-auto space-y-2">
            <h3 className="text-lg font-semibold">AI Company Research</h3>
            <p className="text-muted-foreground">
              Use AI to automatically gather information about <strong>{company.name || 'this company'}</strong>. We'll
              find their description, tech stack, size, stage, and more.
            </p>
          </div>
          <Button onClick={handleResearch} size="lg" className="gap-2">
            <Sparkles className="w-4 h-4" />
            Start Research
          </Button>
        </div>
      )}

      {isLoading && (
        <div className="text-center py-12 space-y-4">
          <Loader2 className="w-12 h-12 text-primary animate-spin mx-auto" />
          <p className="text-muted-foreground animate-pulse">Analyzing company data...</p>
        </div>
      )}

      {result && (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-primary" />
              Research draft
            </h3>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setResult(null)}>
                Discard
              </Button>
              <Button onClick={handleApply} className="gap-2">
                <Check className="w-4 h-4" />
                Stage draft fields
              </Button>
            </div>
          </div>

          <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-300">
            This quick AI draft does not include source receipts. Independently verify each field before staging it.
            Nothing is saved until you review and save.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="p-4 space-y-3">
              <div className="flex items-center gap-2 text-primary font-medium">
                <Building2 className="w-4 h-4" />
                <span>Overview</span>
              </div>
              <p className="text-sm text-muted-foreground">{result.description}</p>

              <div className="grid grid-cols-2 gap-2 text-sm mt-4">
                <div>
                  <span className="text-muted-foreground block text-xs">Size</span>
                  <span className="font-medium">{result.size}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block text-xs">Stage</span>
                  <span className="font-medium">{result.stage}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block text-xs">Location</span>
                  <span className="font-medium flex items-center gap-1">
                    <MapPin className="w-3 h-3" />
                    {result.location.city}, {result.location.country}
                  </span>
                </div>
              </div>
            </Card>

            <Card className="p-4 space-y-3">
              <div className="flex items-center gap-2 text-primary font-medium">
                <Layers className="w-4 h-4" />
                <span>Classification</span>
              </div>

              <div className="space-y-3">
                <div>
                  <span className="text-xs text-muted-foreground block mb-1">Industries</span>
                  <div className="flex flex-wrap gap-1">
                    {result.industry.map((ind) => (
                      <Badge key={ind} variant="secondary" className="text-xs">
                        {ind}
                      </Badge>
                    ))}
                  </div>
                </div>

                <div>
                  <span className="text-xs text-muted-foreground block mb-1">Types</span>
                  <div className="flex flex-wrap gap-1">
                    {result.type.map((t) => (
                      <Badge key={t} variant="outline" className="text-xs">
                        {t}
                      </Badge>
                    ))}
                  </div>
                </div>

                <div>
                  <span className="text-xs text-muted-foreground block mb-1">Tech Stack</span>
                  <div className="flex flex-wrap gap-1">
                    {result.technologyStack.map((tech) => (
                      <Badge
                        key={tech}
                        className="bg-slate-100 text-slate-800 hover:bg-slate-200 border-slate-200 text-xs"
                      >
                        {tech}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>
            </Card>

            <Card className="p-4 space-y-3 md:col-span-2">
              <div className="flex items-center gap-2 text-primary font-medium">
                <Tag className="w-4 h-4" />
                <span>Tags & Socials</span>
              </div>

              <div className="flex flex-wrap gap-1 mb-4">
                {result.tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="text-xs">
                    #{tag}
                  </Badge>
                ))}
              </div>

              <div className="flex gap-4 text-sm">
                {safeSocialLinks.linkedin && (
                  <a
                    href={safeSocialLinks.linkedin}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-blue-600 hover:underline"
                  >
                    <Share2 className="w-3 h-3" /> LinkedIn
                  </a>
                )}
                {safeSocialLinks.twitter && (
                  <a
                    href={safeSocialLinks.twitter}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-sky-500 hover:underline"
                  >
                    <Share2 className="w-3 h-3" /> Twitter
                  </a>
                )}
                {safeSocialLinks.github && (
                  <a
                    href={safeSocialLinks.github}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-slate-800 hover:underline"
                  >
                    <Share2 className="w-3 h-3" /> GitHub
                  </a>
                )}
              </div>
            </Card>
          </div>

          <p className="text-xs text-muted-foreground">
            Size, stage, type, and industry are unverified AI guesses and are not applied to your profile.{' '}
            Staging does not save; saving the company is your explicit acceptance of the staged fields.
          </p>
        </div>
      )}
    </div>
  );
}
