/**
 * @file CompanyCompetitors.tsx
 * @description Component for managing competitor relationships between companies
 *
 * Features:
 * - Display linked competitor companies
 * - Add new competitors from existing companies
 * - Remove competitor links
 * - Show competitor details (size, stage, location)
 *
 * @author Radarist Team
 * @created 2025-11-28
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Plus, Trash2, Building2, Search, ExternalLink, MapPin, Users, Loader2, Swords } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { getCompanies, getCompanyById } from '@/lib/companies';
import { createRelation, getRelationsForEntity, deleteRelation } from '@/lib/relations';
import { normalizeIndustries } from '@/lib/normalize-industries';
import type { Company, Relation, EntitySnapshot } from '@/lib/types';
import { createLogger } from '@/lib/logger';

const log = createLogger('ui/CompanyCompetitors');

interface CompanyCompetitorsProps {
  /** Company ID to show competitors for */
  companyId: string;
  /** Company name for display */
  companyName: string;
}

/**
 * CompanyCompetitors component.
 * Displays and manages competitor relationships for a company.
 */
export function CompanyCompetitors({ companyId, companyName }: CompanyCompetitorsProps) {
  const [competitors, setCompetitors] = useState<{ relation: Relation; company: Company | null }[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [availableCompanies, setAvailableCompanies] = useState<Company[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isAdding, setIsAdding] = useState<string | null>(null);
  const [isRemoving, setIsRemoving] = useState<string | null>(null);
  const { toast } = useToast();

  /**
   * Load competitors from relations
   */
  const loadCompetitors = useCallback(async () => {
    setIsLoading(true);
    try {
      const relations = await getRelationsForEntity(companyId);

      // Filter for competitor relations
      const competitorRelations = relations.filter((rel) => rel.relationType === 'competes_with');

      // Fetch full company details for each competitor
      const competitorsWithDetails = await Promise.all(
        competitorRelations.map(async (rel) => {
          const isSource = rel.sourceSnapshot.id === companyId;
          const competitorId = isSource ? rel.targetSnapshot.id : rel.sourceSnapshot.id;

          try {
            const company = await getCompanyById(competitorId);
            return { relation: rel, company };
          } catch {
            return { relation: rel, company: null };
          }
        })
      );

      setCompetitors(competitorsWithDetails);
    } catch (error) {
      log.error('Failed to load competitors', error instanceof Error ? error : undefined);
      toast({
        title: 'Error',
        description: 'Failed to load competitors',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  }, [companyId, toast]);

  /**
   * Load available companies for adding
   */
  const loadAvailableCompanies = useCallback(async () => {
    try {
      const companies = await getCompanies();
      // Filter out current company and existing competitors
      const competitorIds = new Set(
        competitors.map((c) => {
          const isSource = c.relation.sourceSnapshot.id === companyId;
          return isSource ? c.relation.targetSnapshot.id : c.relation.sourceSnapshot.id;
        })
      );

      const available = companies.filter((c) => c.id !== companyId && !competitorIds.has(c.id));
      setAvailableCompanies(available);
    } catch (error) {
      log.error('Failed to load companies', error instanceof Error ? error : undefined);
    }
  }, [companyId, competitors]);

  useEffect(() => {
    loadCompetitors();
  }, [loadCompetitors]);

  useEffect(() => {
    if (isAddDialogOpen) {
      loadAvailableCompanies();
    }
  }, [isAddDialogOpen, loadAvailableCompanies]);

  /**
   * Add a competitor relationship
   */
  const handleAddCompetitor = async (competitor: Company) => {
    setIsAdding(competitor.id);
    try {
      const sourceSnapshot: EntitySnapshot = {
        type: 'company',
        id: companyId,
        name: companyName,
        snapshotAt: Date.now(),
      };

      const targetSnapshot: EntitySnapshot = {
        type: 'company',
        id: competitor.id,
        name: competitor.name,
        description: competitor.description,
        snapshotAt: Date.now(),
      };

      await createRelation({
        relationType: 'competes_with',
        sourceSnapshot,
        targetSnapshot,
        confidence: 100,
        aiSuggested: false,
        claimStatus: 'curated',
      });

      toast({
        title: 'Competitor added',
        description: `${competitor.name} is now linked as a competitor`,
      });

      setIsAddDialogOpen(false);
      loadCompetitors();
    } catch (error) {
      log.error('Failed to add competitor', error instanceof Error ? error : undefined);
      toast({
        title: 'Error',
        description: 'Failed to add competitor',
        variant: 'destructive',
      });
    } finally {
      setIsAdding(null);
    }
  };

  /**
   * Remove a competitor relationship
   */
  const handleRemoveCompetitor = async (relationId: string, competitorName: string) => {
    setIsRemoving(relationId);
    try {
      await deleteRelation(relationId);

      toast({
        title: 'Competitor removed',
        description: `${competitorName} is no longer linked as a competitor`,
      });

      loadCompetitors();
    } catch (error) {
      log.error('Failed to remove competitor', error instanceof Error ? error : undefined);
      toast({
        title: 'Error',
        description: 'Failed to remove competitor',
        variant: 'destructive',
      });
    } finally {
      setIsRemoving(null);
    }
  };

  // Filter available companies by search.
  // industry is normalized — legacy/AI-imported docs store a plain string.
  const filteredCompanies = availableCompanies.filter(
    (c) =>
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      normalizeIndustries(c.industry).some((i) => i.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium flex items-center gap-2">
            <Swords className="h-5 w-5 text-red-500" />
            Competitors
          </h3>
          <p className="text-sm text-muted-foreground">Track companies competing in the same market</p>
        </div>
        <Button onClick={() => setIsAddDialogOpen(true)} variant="outline" className="gap-2">
          <Plus className="h-4 w-4" />
          Add Competitor
        </Button>
      </div>

      {/* Competitors List */}
      {competitors.length === 0 ? (
        <EmptyState
          icon={Swords}
          title="No competitors linked"
          description="Add competitor companies to track market dynamics"
          action={{
            label: 'Add First Competitor',
            onClick: () => setIsAddDialogOpen(true),
            icon: Plus,
            variant: 'outline',
          }}
        />
      ) : (
        <div className="grid gap-3">
          {competitors.map(({ relation, company }) => {
            const isSource = relation.sourceSnapshot.id === companyId;
            const competitorSnapshot = isSource ? relation.targetSnapshot : relation.sourceSnapshot;
            const competitorName = company?.name || competitorSnapshot.name;

            return (
              <Card key={relation.id} className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <div className="p-2 rounded-lg bg-red-50 dark:bg-red-950">
                      <Building2 className="h-5 w-5 text-red-500" />
                    </div>
                    <div>
                      <h4 className="font-medium">{competitorName}</h4>
                      {company && (
                        <div className="flex flex-wrap items-center gap-2 mt-1">
                          {normalizeIndustries(company.industry)
                            .slice(0, 2)
                            .map((ind, idx) => (
                              <Badge key={`${ind}-${idx}`} variant="secondary" className="text-xs">
                                {ind}
                              </Badge>
                            ))}
                          {company.location?.city && (
                            <span className="text-xs text-muted-foreground flex items-center gap-1">
                              <MapPin className="h-3 w-3" />
                              {company.location.city}
                              {company.location.country && `, ${company.location.country}`}
                            </span>
                          )}
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Users className="h-3 w-3" />
                            {company.size}
                          </span>
                        </div>
                      )}
                      {company?.description && (
                        <p className="text-sm text-muted-foreground mt-2 line-clamp-2">{company.description}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {company?.website && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => window.open(company.website, '_blank')}
                        aria-label={`Open ${competitorName} website`}
                      >
                        <ExternalLink className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleRemoveCompetitor(relation.id, competitorName)}
                      disabled={isRemoving === relation.id}
                      aria-label={`Remove competitor ${competitorName}`}
                    >
                      {isRemoving === relation.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4 text-destructive" />
                      )}
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Add Competitor Dialog */}
      <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Competitor</DialogTitle>
            <DialogDescription>Select a company to link as a competitor to {companyName}</DialogDescription>
          </DialogHeader>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search companies..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>

          <ScrollArea className="h-[300px] -mx-6 px-6">
            {filteredCompanies.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground">
                {availableCompanies.length === 0 ? 'No other companies available' : 'No companies match your search'}
              </div>
            ) : (
              <div className="space-y-2">
                {filteredCompanies.map((company) => (
                  <Card
                    key={company.id}
                    className="p-3 cursor-pointer hover:bg-muted/50 transition-colors"
                    onClick={() => handleAddCompetitor(company)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Building2 className="h-5 w-5 text-muted-foreground" />
                        <div>
                          <p className="font-medium">{company.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {normalizeIndustries(company.industry).slice(0, 2).join(', ')}
                            {company.location?.city && ` • ${company.location.city}`}
                          </p>
                        </div>
                      </div>
                      {isAdding === company.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Plus className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}
