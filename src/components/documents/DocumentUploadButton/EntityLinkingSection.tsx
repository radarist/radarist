'use client';

/**
 * @file DocumentUploadButton/EntityLinkingSection.tsx
 * @description Collapsible entity linking section for linking documents to companies,
 *              technologies, and use cases.
 */

import React from 'react';
import { Link2, Building2, Cpu, Lightbulb } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { EntitySearchCombobox } from '@/components/agents/EntitySearchCombobox';
import type { EntitySelection } from './types';

interface EntityLinkingSectionProps {
  entitySelection: EntitySelection;
  onSelectionChange: (entityType: keyof EntitySelection, selectedIds: string[]) => void;
}

export function EntityLinkingSection({ entitySelection, onSelectionChange }: EntityLinkingSectionProps) {
  const totalLinked =
    entitySelection.companies.length + entitySelection.technologies.length + entitySelection.useCases.length;

  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 h-8 text-muted-foreground hover:text-foreground"
        >
          <Link2 className="h-4 w-4" />
          <span>Link to entities</span>
          {totalLinked > 0 && (
            <Badge variant="secondary" className="ml-auto">
              {totalLinked}
            </Badge>
          )}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 pt-2">
        {/* Companies */}
        <div className="space-y-1">
          <Label className="text-xs flex items-center gap-1.5 text-muted-foreground">
            <Building2 className="h-3 w-3" />
            Companies
          </Label>
          <EntitySearchCombobox
            entityType="companies"
            value={entitySelection.companies}
            onChange={(ids) => onSelectionChange('companies', ids)}
            placeholder="Select companies..."
            multiple
            maxSelections={5}
          />
        </div>

        {/* Technologies */}
        <div className="space-y-1">
          <Label className="text-xs flex items-center gap-1.5 text-muted-foreground">
            <Cpu className="h-3 w-3" />
            Technologies
          </Label>
          <EntitySearchCombobox
            entityType="technologies"
            value={entitySelection.technologies}
            onChange={(ids) => onSelectionChange('technologies', ids)}
            placeholder="Select technologies..."
            multiple
            maxSelections={5}
          />
        </div>

        {/* Use Cases */}
        <div className="space-y-1">
          <Label className="text-xs flex items-center gap-1.5 text-muted-foreground">
            <Lightbulb className="h-3 w-3" />
            Use Cases
          </Label>
          <EntitySearchCombobox
            entityType="useCases"
            value={entitySelection.useCases}
            onChange={(ids) => onSelectionChange('useCases', ids)}
            placeholder="Select use cases..."
            multiple
            maxSelections={5}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
