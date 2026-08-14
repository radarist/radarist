/**
 * @file components/sheets/CompanySheet/OverviewTab.tsx
 * @description Overview tab form for the CompanySheet
 *
 * Contains all form fields for basic info, classification,
 * location, social links, tags, and technology stack.
 *
 * Extracted from CompanySheet.tsx during decomposition.
 */

'use client';

import * as React from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { FileText, Globe, MapPin, Plus, X, Linkedin, Twitter, Github } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';

import type { CompanyType, CompanyIndustry } from '@/lib/types';

import {
  COMPANY_TYPES,
  COMPANY_SIZES,
  COMPANY_STAGES,
  COMPANY_INDUSTRIES,
  COMPANY_STATUSES,
  type CompanyFormValues,
} from './constants';

// ============================================================================
// OVERVIEW TAB
// ============================================================================

interface OverviewTabProps {
  form: UseFormReturn<CompanyFormValues>;
  isLoading?: boolean;
  hasResearchDraft?: boolean;
}

function OverviewTab({ form, isLoading: _isLoading, hasResearchDraft = false }: OverviewTabProps) {
  const [newTag, setNewTag] = React.useState('');
  const [newTech, setNewTech] = React.useState('');

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

  const handleAddTech = () => {
    if (!newTech.trim()) return;
    const current = form.getValues('technologyStack');
    if (!current.includes(newTech.trim())) {
      form.setValue('technologyStack', [...current, newTech.trim()], { shouldDirty: true });
    }
    setNewTech('');
  };

  const handleRemoveTech = (tech: string) => {
    const current = form.getValues('technologyStack');
    form.setValue(
      'technologyStack',
      current.filter((t) => t !== tech),
      { shouldDirty: true }
    );
  };

  const handleToggleType = (type: CompanyType) => {
    const current = form.getValues('type');
    if (current.includes(type)) {
      form.setValue(
        'type',
        current.filter((t) => t !== type),
        { shouldDirty: true, shouldValidate: true }
      );
    } else {
      form.setValue('type', [...current, type], { shouldDirty: true, shouldValidate: true });
    }
  };

  const handleToggleIndustry = (industry: CompanyIndustry) => {
    const current = form.getValues('industry');
    if (current.includes(industry)) {
      form.setValue(
        'industry',
        current.filter((i) => i !== industry),
        { shouldDirty: true }
      );
    } else {
      form.setValue('industry', [...current, industry], { shouldDirty: true });
    }
  };

  return (
    <Form {...form}>
      <form className="space-y-6 pt-2">
        {hasResearchDraft && (
          <div className="flex items-start gap-2 border-l-2 border-amber-500 bg-amber-500/5 px-3 py-2 text-sm">
            <FileText className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p>
              <span className="font-medium">This company has an AI research draft.</span>{' '}
              <span className="text-muted-foreground">Review the Research tab and source references before use.</span>
            </p>
          </div>
        )}
        {/* Basic Info */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">Basic Information</h3>

          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Company Name *</FormLabel>
                <FormControl>
                  <Input placeholder="Enter company name" {...field} />
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
                <FormLabel>Description</FormLabel>
                <FormControl>
                  <Textarea placeholder="Brief description of the company..." rows={3} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="website"
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
        </div>

        {/* Classification */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">Classification</h3>

          {/* Company Types (multi-select) */}
          <FormField
            control={form.control}
            name="type"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Company Type *</FormLabel>
                <div className="flex flex-wrap gap-2">
                  {COMPANY_TYPES.map((option) => (
                    <Badge
                      key={option.value}
                      variant={field.value.includes(option.value) ? 'default' : 'outline'}
                      className="cursor-pointer"
                      onClick={() => handleToggleType(option.value)}
                    >
                      {option.label}
                    </Badge>
                  ))}
                </div>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Industries (multi-select) */}
          <FormField
            control={form.control}
            name="industry"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Industries</FormLabel>
                <div className="flex flex-wrap gap-2">
                  {COMPANY_INDUSTRIES.map((option) => (
                    <Badge
                      key={option.value}
                      variant={field.value.includes(option.value) ? 'default' : 'outline'}
                      className="cursor-pointer"
                      onClick={() => handleToggleIndustry(option.value)}
                    >
                      {option.label}
                    </Badge>
                  ))}
                </div>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="size"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Size</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select size" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {COMPANY_SIZES.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="stage"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Stage</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select stage" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {COMPANY_STAGES.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="status"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Status</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select status" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {COMPANY_STATUSES.map((status) => (
                      <SelectItem key={status} value={status}>
                        {status}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Location */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">Location</h3>

          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="location.city"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>City</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <MapPin className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input placeholder="City" className="pl-9" {...field} />
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="location.country"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Country</FormLabel>
                  <FormControl>
                    <Input placeholder="Country" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        {/* Social Links */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">Social Links</h3>

          <div className="space-y-3">
            <FormField
              control={form.control}
              name="socialLinks.linkedin"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <div className="relative">
                      <Linkedin className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input placeholder="LinkedIn URL" className="pl-9" {...field} />
                    </div>
                  </FormControl>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="socialLinks.twitter"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <div className="relative">
                      <Twitter className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input placeholder="Twitter URL" className="pl-9" {...field} />
                    </div>
                  </FormControl>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="socialLinks.github"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <div className="relative">
                      <Github className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input placeholder="GitHub URL" className="pl-9" {...field} />
                    </div>
                  </FormControl>
                </FormItem>
              )}
            />
          </div>
        </div>

        {/* Tags */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">Tags</h3>

          <div className="flex flex-wrap gap-2">
            {form.watch('tags').map((tag) => (
              <Badge key={tag} variant="secondary" className="gap-1">
                {tag}
                <X className="h-3 w-3 cursor-pointer hover:text-destructive" onClick={() => handleRemoveTag(tag)} />
              </Badge>
            ))}
          </div>

          <div className="flex gap-2">
            <Input
              placeholder="Add a tag..."
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

        {/* Technology Stack */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">Technology Stack</h3>

          <div className="flex flex-wrap gap-2">
            {form.watch('technologyStack').map((tech) => (
              <Badge key={tech} variant="secondary" className="gap-1">
                {tech}
                <X className="h-3 w-3 cursor-pointer hover:text-destructive" onClick={() => handleRemoveTech(tech)} />
              </Badge>
            ))}
          </div>

          <div className="flex gap-2">
            <Input
              placeholder="Add a technology..."
              value={newTech}
              onChange={(e) => setNewTech(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddTech();
                }
              }}
            />
            <Button type="button" variant="outline" size="icon" onClick={handleAddTech}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </form>
    </Form>
  );
}

export { OverviewTab };
export type { OverviewTabProps };
