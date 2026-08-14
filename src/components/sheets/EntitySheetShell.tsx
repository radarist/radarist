'use client';

import React from 'react';
import { X } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { ENTITY_COLORS } from '@/lib/entity-colors';
import { ErrorBoundary } from '@/components/feedback/ErrorBoundary';
import { VerificationBadge } from '@/components/impulse/VerificationBadge';
import { useTrackEntityView } from '@/hooks/useTrackEntityView';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Entity types supported by the shell
 */
export type EntityType =
  | 'company'
  | 'technology'
  | 'useCase'
  | 'prototype'
  | 'strategy'
  | 'signal'
  | 'document'
  | 'orgUnit'
  | 'initiative'
  | 'painPoint';

/**
 * AI Context for auto-linker suggestions (Phase 5)
 */
interface AIContext {
  /** Description text to analyze */
  description?: string;
  /** Existing relation IDs to exclude from suggestions */
  existingRelations?: string[];
  /** Additional context fields */
  [key: string]: string | string[] | undefined;
}

/**
 * EntitySheetShell Props
 */
interface EntitySheetShellProps {
  /** Sheet title */
  title: string;
  /** Entity type for badge styling */
  entityType: EntityType;
  /** Controlled open state */
  open: boolean;
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void;
  /** Main content (form or detail view) */
  children: React.ReactNode;
  /** Optional subtitle/description */
  subtitle?: React.ReactNode;
  /** Header actions (buttons next to title, before close button) */
  headerActions?: React.ReactNode;
  /** Footer content (typically save/cancel buttons) */
  footer?: React.ReactNode;
  /** Width of the sheet */
  width?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  /** Additional class names */
  className?: string;
  /** Entity ID for verification badge */
  entityId?: string;
  /** AI context for auto-linker (Phase 5 - currently unused) */
  aiContext?: AIContext;
}

// ============================================================================
// ENTITY TYPE CONFIG
// ============================================================================

// Badge tint + AA-tuned text, sourced from the canonical entity palette.
const badgeColor = (t: EntityType) => `${ENTITY_COLORS[t].bg} ${ENTITY_COLORS[t].text}`;

const entityTypeConfig: Record<EntityType, { label: string; color: string }> = {
  company: { label: 'Company', color: badgeColor('company') },
  technology: { label: 'Technology', color: badgeColor('technology') },
  useCase: { label: 'Use Case', color: badgeColor('useCase') },
  prototype: { label: 'Prototype', color: badgeColor('prototype') },
  strategy: { label: 'Strategy', color: badgeColor('strategy') },
  signal: { label: 'Signal', color: badgeColor('signal') },
  document: { label: 'Document', color: badgeColor('document') },
  orgUnit: { label: 'Org Unit', color: badgeColor('orgUnit') },
  initiative: { label: 'Initiative', color: badgeColor('initiative') },
  painPoint: { label: 'Pain Point', color: badgeColor('painPoint') },
};

const widthClasses = {
  sm: 'sm:max-w-[504px]',
  md: 'sm:max-w-[680px]',
  lg: 'sm:max-w-[907px]',
  xl: 'sm:max-w-[1134px]',
  full: 'sm:max-w-[calc(100vw-100px)]',
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

/**
 * EntitySheetShell
 *
 * A standardized shell/wrapper for entity detail sheets.
 * Handles the UI chrome (header, footer) while accepting
 * independent form components as children.
 *
 * @example
 * ```tsx
 * <EntitySheetShell
 *   title="Create Company"
 *   entityType="company"
 *   open={isOpen}
 *   onOpenChange={setIsOpen}
 *   footer={
 *     <div className="flex gap-2">
 *       <Button variant="outline" onClick={() => setIsOpen(false)}>
 *         Cancel
 *       </Button>
 *       <Button onClick={handleSave}>Save</Button>
 *     </div>
 *   }
 * >
 *   <CreateCompanyForm />
 * </EntitySheetShell>
 * ```
 */
export function EntitySheetShell({
  title,
  entityType,
  open,
  onOpenChange,
  children,
  subtitle,
  headerActions,
  footer,
  entityId,
  width = 'lg',
  className,
  aiContext: _aiContext, // Reserved for Phase 5 AI auto-linker
}: EntitySheetShellProps) {
  const showVerification = !!entityId;
  const config = entityTypeConfig[entityType];

  // Track the user's entity view in Neo4j so the proactive-intelligence
  // pipeline (dot-connector, insight detection) has Session + EXPLORED
  // edges to reason against. Fires only when the sheet is open AND has
  // a concrete entityId.
  useTrackEntityView(open && entityId ? entityId : undefined, open && entityId ? entityType : undefined);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        hideClose
        data-testid="entity-sheet"
        // P-C6: don't let Radix auto-focus the header close button on open —
        // it renders a visible focus ring on a button the user didn't
        // interact with. Escape-to-close and the tab focus-trap are separate
        // Radix lifecycle hooks and are unaffected by this. With no other
        // focusable element to fall back to, Radix's FocusScope focuses the
        // Content container itself (tabIndex=-1) — `outline-none` stops the
        // browser from drawing its own default ring around the whole panel.
        onOpenAutoFocus={(e) => e.preventDefault()}
        className={cn('flex w-full flex-col p-0 outline-none', widthClasses[width], className)}
      >
        {/* Header */}
        <SheetHeader className="shrink-0 border-b px-6 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <SheetTitle className="text-xl">{title}</SheetTitle>
              <Badge variant="outline" className={cn('text-xs', config.color)}>
                {config.label}
              </Badge>
              {showVerification && <VerificationBadge entityId={entityId} />}
            </div>
            <div className="flex items-center gap-2">
              {headerActions}
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onOpenChange(false)}>
                <X className="h-4 w-4" />
                <span className="sr-only">Close</span>
              </Button>
            </div>
          </div>
          <SheetDescription className={cn('mt-1', !subtitle && 'sr-only')}>
            {subtitle ?? `View and manage ${config.label.toLowerCase()} details.`}
          </SheetDescription>
        </SheetHeader>

        {/* Scrollable Content */}
        <div className="flex-1 min-h-0 overflow-auto">
          <ErrorBoundary>
            <div className="p-6">{children}</div>
          </ErrorBoundary>
        </div>

        {/* Footer */}
        {footer && (
          <div className="shrink-0 border-t px-6 py-4">
            {/* Full width container for proper flex-spacer alignment */}
            <div className="flex items-center w-full">{footer}</div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
