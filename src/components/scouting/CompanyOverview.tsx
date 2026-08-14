/**
 * @file CompanyOverview.tsx
 * @description Overview tab content for company editing.
 *
 * This component provides a form for editing company basic information including:
 * - Name, description, website
 * - Company type, industry, size, stage
 * - Location, status, tags
 * - Social links and technology stack
 * - Logo management
 *
 * @author Radarist Team
 * @created 2025-11-25
 */

'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Save, Trash2, Plus, X, Sparkles } from 'lucide-react';
import type { Company, CompanyType, CompanyIndustry, EntitySnapshot } from '@/lib/types';
import { useAutoLinker } from '@/hooks/useAutoLinker';
import { AutoLinkerSuggestions } from '@/components/scouting/AutoLinkerSuggestions';
import { createRelation } from '@/lib/relations';
import { normalizeIndustries } from '@/lib/normalize-industries';
import { createSnapshotFromSuggestion, type SuggestedRelation } from '@/lib/auto-linker-utils';
import { useToast } from '@/hooks/use-toast';
import { createLogger } from '@/lib/logger';

const log = createLogger('ui/CompanyOverview');
import { COMPANY_TYPES, COMPANY_SIZES, COMPANY_STAGES, COMPANY_STATUSES, INDUSTRIES } from '@/lib/scouting-constants';
import { fetchCompanyLogo, getCompanyInitials, normalizeWebsite } from '@/lib/company-utils';

interface CompanyOverviewProps {
  /** Company data being edited (can be partial for new companies). */
  company: Partial<Company> | null;
  /** Whether this is a new company. */
  isNew: boolean;
  /** Callback when save button is clicked. */
  onSave: (company: Partial<Company>) => void;
  /** Callback when delete button is clicked. */
  onDelete: () => void;
  /** Whether a save operation is in progress. */
  isSaving: boolean;
  /** Whether a delete operation is in progress. */
  isDeleting: boolean;
}

/**
 * CompanyOverview component.
 * Renders the form for editing company basic information.
 *
 * @param props - Component props
 * @returns The rendered company overview form
 */
export function CompanyOverview({ company, isNew, onSave, onDelete, isSaving, isDeleting }: CompanyOverviewProps) {
  const [formData, setFormData] = useState<Partial<Company>>(company || {});
  const [newTag, setNewTag] = useState('');
  const [newTech, setNewTech] = useState('');
  const [isFetchingLogo, setIsFetchingLogo] = useState(false);
  const [imageError, setImageError] = useState(false);
  const { toast } = useToast();

  // Auto-linker for description field
  const { suggestions, isAnalyzing, trackText, dismissSuggestion } = useAutoLinker({
    sourceEntityType: 'company',
    sourceEntityId: company?.id || '',
    enabled: !isNew && !!company?.id, // Only enable for existing companies
  });

  /**
   * Handles linking a suggested entity
   */
  const handleLinkSuggestion = async (suggestion: SuggestedRelation) => {
    if (!company?.id) return;

    try {
      // Create source snapshot (this company)
      const sourceSnapshot: EntitySnapshot = {
        type: 'company',
        id: company.id,
        name: formData.name || company.name || '',
        description: formData.description || company.description,
        snapshotAt: Date.now(),
      };

      // Create target snapshot from suggestion
      const targetSnapshot = createSnapshotFromSuggestion(suggestion);

      // Create the relation
      await createRelation({
        relationType: suggestion.relationType,
        sourceSnapshot,
        targetSnapshot,
        confidence: suggestion.confidence,
        aiSuggested: true,
      });

      toast({
        title: 'Relation created',
        description: `Linked to ${suggestion.entityName}`,
      });

      dismissSuggestion(suggestion.entityId);
    } catch (error) {
      log.error('Failed to create relation', error instanceof Error ? error : undefined);
      toast({
        title: 'Error',
        description: 'Failed to create relation. Please try again.',
        variant: 'destructive',
      });
    }
  };

  // Reset image error when logo changes
  useEffect(() => {
    setImageError(false);
  }, [formData.logo]);

  // Update form data when company prop changes
  useEffect(() => {
    if (company) {
      setFormData(company);
    }
  }, [company, company?.name, company?.website, company?.description]);

  // Auto-fetch logo when website changes (for new companies or when website is updated)
  useEffect(() => {
    const autoFetchLogo = async () => {
      // Only auto-fetch if:
      // 1. Website is set
      // 2. Logo is not already set
      // 3. Not currently fetching
      if (formData.website && !formData.logo && !isFetchingLogo) {
        setIsFetchingLogo(true);
        try {
          const logoUrl = await fetchCompanyLogo(formData.website);
          if (logoUrl) {
            updateField('logo', logoUrl);
          }
        } catch (error) {
          log.error('Failed to auto-fetch logo', error instanceof Error ? error : undefined);
        } finally {
          setIsFetchingLogo(false);
        }
      }
    };

    // Debounce the auto-fetch to avoid too many calls while typing
    const timeoutId = setTimeout(autoFetchLogo, 1000);
    return () => clearTimeout(timeoutId);
  }, [formData.website, formData.logo, isFetchingLogo]);

  /**
   * Updates a field in the form data.
   */
  const updateField = (field: keyof Company, value: Company[keyof Company]) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  /**
   * Toggles a company type in the multi-select.
   */
  const toggleType = (type: CompanyType) => {
    const currentTypes = formData.type || [];
    if (currentTypes.includes(type)) {
      updateField(
        'type',
        currentTypes.filter((t) => t !== type)
      );
    } else {
      updateField('type', [...currentTypes, type]);
    }
  };

  /**
   * Toggles an industry in the multi-select.
   * Normalizes first — legacy/AI-imported docs store `industry` as a plain
   * string, and array ops on that shape crash (or spread into characters).
   */
  const toggleIndustry = (industry: CompanyIndustry) => {
    const currentIndustries = normalizeIndustries(formData.industry);
    if (currentIndustries.includes(industry)) {
      updateField(
        'industry',
        currentIndustries.filter((i) => i !== industry)
      );
    } else {
      updateField('industry', [...currentIndustries, industry]);
    }
  };

  /**
   * Adds a tag to the company.
   */
  const addTag = () => {
    if (newTag.trim() && !(formData.tags || []).includes(newTag.trim())) {
      updateField('tags', [...(formData.tags || []), newTag.trim()]);
      setNewTag('');
    }
  };

  /**
   * Removes a tag from the company.
   */
  const removeTag = (tag: string) => {
    updateField(
      'tags',
      (formData.tags || []).filter((t) => t !== tag)
    );
  };

  /**
   * Adds a technology to the stack.
   */
  const addTech = () => {
    if (newTech.trim() && !(formData.technologyStack || []).includes(newTech.trim())) {
      updateField('technologyStack', [...(formData.technologyStack || []), newTech.trim()]);
      setNewTech('');
    }
  };

  /**
   * Removes a technology from the stack.
   */
  const removeTech = (tech: string) => {
    updateField(
      'technologyStack',
      (formData.technologyStack || []).filter((t) => t !== tech)
    );
  };

  /**
   * Fetches company logo from external API.
   */
  const handleFetchLogo = async () => {
    if (!formData.website) return;

    setIsFetchingLogo(true);
    try {
      const logoUrl = await fetchCompanyLogo(formData.website);
      if (logoUrl) {
        updateField('logo', logoUrl);
      }
    } catch (error) {
      log.error('Failed to fetch logo', error instanceof Error ? error : undefined);
    } finally {
      setIsFetchingLogo(false);
    }
  };

  /**
   * Handles form submission.
   */
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // Normalize website URL
    if (formData.website) {
      formData.website = normalizeWebsite(formData.website);
    }

    onSave(formData);
  };

  const isValid = formData.name && formData.website;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Logo Section */}
      <Card className="p-4">
        <div className="flex items-center gap-4">
          <div className="flex-shrink-0">
            {formData.logo && !imageError ? (
              <img
                src={formData.logo}
                alt="Company logo"
                className="w-20 h-20 rounded-lg object-contain bg-muted p-2"
                onError={() => setImageError(true)}
              />
            ) : (
              <div className="w-20 h-20 rounded-lg bg-primary/10 flex items-center justify-center text-primary font-bold text-xl">
                {formData.name ? getCompanyInitials(formData.name) : '?'}
              </div>
            )}
          </div>
          <div className="flex-1">
            <Label>Company Logo</Label>
            <div className="flex gap-2 mt-1">
              <Input
                type="url"
                placeholder="Logo URL"
                value={formData.logo || ''}
                onChange={(e) => updateField('logo', e.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                onClick={handleFetchLogo}
                disabled={!formData.website || isFetchingLogo}
                className="gap-2"
              >
                <Sparkles className="h-4 w-4" />
                Auto-fetch
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {/* Basic Information */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="md:col-span-2">
          <Label htmlFor="name">Company Name *</Label>
          <Input
            id="name"
            value={formData.name || ''}
            onChange={(e) => updateField('name', e.target.value)}
            placeholder="e.g., Datadog"
            required
          />
        </div>

        <div className="md:col-span-2">
          <Label htmlFor="description">Description</Label>
          <Textarea
            id="description"
            value={formData.description || ''}
            onChange={(e) => {
              updateField('description', e.target.value);
              trackText(e.target.value);
            }}
            placeholder="Brief overview of the company..."
            rows={3}
          />
          {/* Auto-linker suggestions */}
          {!isNew && company?.id && (
            <AutoLinkerSuggestions
              suggestions={suggestions}
              isAnalyzing={isAnalyzing}
              onLink={handleLinkSuggestion}
              onDismiss={dismissSuggestion}
              className="mt-2"
            />
          )}
        </div>

        <div>
          <Label htmlFor="website">Website *</Label>
          <Input
            id="website"
            type="url"
            value={formData.website || ''}
            onChange={(e) => updateField('website', e.target.value)}
            placeholder="https://example.com"
            required
          />
        </div>

        <div>
          <Label htmlFor="status">Status</Label>
          <Select value={formData.status || 'Watching'} onValueChange={(value) => updateField('status', value)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COMPANY_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  <span className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 rounded-full ${
                        status === 'Watching'
                          ? 'bg-blue-500'
                          : status === 'Contacted'
                            ? 'bg-yellow-500'
                            : status === 'Partner'
                              ? 'bg-green-500'
                              : 'bg-red-500'
                      }`}
                    />
                    {status}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="size">Company Size</Label>
          <Select value={formData.size || 'Startup'} onValueChange={(value) => updateField('size', value)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COMPANY_SIZES.map((size) => (
                <SelectItem key={size} value={size}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="stage">Stage</Label>
          <Select value={formData.stage || 'Seed'} onValueChange={(value) => updateField('stage', value)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COMPANY_STAGES.map((stage) => (
                <SelectItem key={stage} value={stage}>
                  {stage}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Company Types (Multi-select) */}
      <div>
        <Label>Company Type</Label>
        <div className="flex flex-wrap gap-2 mt-2">
          {COMPANY_TYPES.map((type) => {
            const isSelected = (formData.type || []).includes(type);
            return (
              <Badge
                key={type}
                variant={isSelected ? 'default' : 'outline'}
                className="cursor-pointer"
                onClick={() => toggleType(type)}
              >
                {type}
              </Badge>
            );
          })}
        </div>
      </div>

      {/* Industries (Multi-select) */}
      <div>
        <Label>Industries</Label>
        <div className="flex flex-wrap gap-2 mt-2 max-h-32 overflow-y-auto">
          {INDUSTRIES.map((industry) => {
            const isSelected = normalizeIndustries(formData.industry).includes(industry);
            return (
              <Badge
                key={industry}
                variant={isSelected ? 'default' : 'outline'}
                className="cursor-pointer"
                onClick={() => toggleIndustry(industry)}
              >
                {industry}
              </Badge>
            );
          })}
        </div>
      </div>

      {/* Location */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="city">City</Label>
          <Input
            id="city"
            value={formData.location?.city || ''}
            onChange={(e) =>
              updateField('location', {
                ...formData.location,
                city: e.target.value,
              })
            }
            placeholder="New York"
          />
        </div>
        <div>
          <Label htmlFor="country">Country</Label>
          <Input
            id="country"
            value={formData.location?.country || ''}
            onChange={(e) =>
              updateField('location', {
                ...formData.location,
                country: e.target.value,
              })
            }
            placeholder="USA"
          />
        </div>
      </div>

      {/* Tags */}
      <div>
        <Label>Tags</Label>
        <div className="flex gap-2 mt-2 mb-2">
          <Input
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            placeholder="Add a tag..."
            onKeyPress={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addTag();
              }
            }}
          />
          <Button type="button" variant="outline" onClick={addTag}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {(formData.tags || []).map((tag) => (
            <Badge key={tag} variant="secondary" className="gap-1">
              {tag}
              <X className="h-3 w-3 cursor-pointer" onClick={() => removeTag(tag)} />
            </Badge>
          ))}
        </div>
      </div>

      {/* Technology Stack */}
      <div>
        <Label>Technology Stack</Label>
        <div className="flex gap-2 mt-2 mb-2">
          <Input
            value={newTech}
            onChange={(e) => setNewTech(e.target.value)}
            placeholder="Add a technology..."
            onKeyPress={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addTech();
              }
            }}
          />
          <Button type="button" variant="outline" onClick={addTech}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {(formData.technologyStack || []).map((tech) => (
            <Badge key={tech} variant="secondary" className="gap-1">
              {tech}
              <X className="h-3 w-3 cursor-pointer" onClick={() => removeTech(tech)} />
            </Badge>
          ))}
        </div>
      </div>

      {/* Social Links */}
      <div>
        <Label>Social Links</Label>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
          <div>
            <Label htmlFor="linkedin" className="text-xs">
              LinkedIn
            </Label>
            <Input
              id="linkedin"
              type="url"
              value={formData.socialLinks?.linkedin || ''}
              onChange={(e) =>
                updateField('socialLinks', {
                  ...formData.socialLinks,
                  linkedin: e.target.value,
                })
              }
              placeholder="https://linkedin.com/company/..."
            />
          </div>
          <div>
            <Label htmlFor="twitter" className="text-xs">
              Twitter/X
            </Label>
            <Input
              id="twitter"
              type="url"
              value={formData.socialLinks?.twitter || ''}
              onChange={(e) =>
                updateField('socialLinks', {
                  ...formData.socialLinks,
                  twitter: e.target.value,
                })
              }
              placeholder="https://twitter.com/..."
            />
          </div>
          <div>
            <Label htmlFor="github" className="text-xs">
              GitHub
            </Label>
            <Input
              id="github"
              type="url"
              value={formData.socialLinks?.github || ''}
              onChange={(e) =>
                updateField('socialLinks', {
                  ...formData.socialLinks,
                  github: e.target.value,
                })
              }
              placeholder="https://github.com/..."
            />
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex justify-between pt-4 border-t">
        <div>
          {!isNew && (
            <Button
              type="button"
              variant="destructive"
              onClick={onDelete}
              disabled={isDeleting || isSaving}
              className="gap-2"
            >
              <Trash2 className="h-4 w-4" />
              {isDeleting ? 'Deleting...' : 'Delete'}
            </Button>
          )}
        </div>
        <Button type="submit" disabled={!isValid || isSaving || isDeleting} className="gap-2">
          <Save className="h-4 w-4" />
          {isSaving ? 'Saving...' : isNew ? 'Create Company' : 'Save Changes'}
        </Button>
      </div>
    </form>
  );
}
