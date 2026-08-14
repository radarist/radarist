/**
 * @file AIContextProvider.tsx
 * @description React context provider for AI Assistant context awareness
 *
 * Automatically tracks:
 * - Current route/page
 * - Entity being viewed
 * - Recent activity
 *
 * @author Radarist Team
 * @created 2025-11-29
 */

'use client';

import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { useAIStore } from '@/stores/ai-store';
import { getPageTypeFromPath } from '@/lib/ai/page-context';
import type { AIContext, AIEntityReference } from '@/types/ai-assistant';

// ============================================================================
// Context Definition
// ============================================================================

interface AIContextValue {
  /** Current AI context */
  context: AIContext;
  /** Update entity context */
  setEntityContext: (entity: AIEntityReference | undefined) => void;
}

const AIContextContext = createContext<AIContextValue | null>(null);

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Pathname → AIPageType classifier. The implementation lives in
 * `src/lib/ai/page-context.ts` (AI-006 — a plain module the capability
 * generator and the route-coverage gate can import without React); re-exported
 * here so existing imports (tests, components) keep working unchanged.
 */
export { getPageTypeFromPath } from '@/lib/ai/page-context';

// ============================================================================
// Provider Component
// ============================================================================

interface AIContextProviderProps {
  children: ReactNode;
}

/**
 * Provides AI context awareness throughout the application.
 * Automatically tracks route changes and updates context.
 *
 * Usage:
 * ```tsx
 * // In root layout
 * <AIContextProvider>
 *   {children}
 * </AIContextProvider>
 *
 * // In components
 * const { context, setEntityContext } = useAIContext();
 * ```
 */
export function AIContextProvider({ children }: AIContextProviderProps) {
  const pathname = usePathname();
  const { context, setContext, setEntityContext } = useAIStore();

  // Update context when route changes
  useEffect(() => {
    const pageType = getPageTypeFromPath(pathname);

    setContext({
      currentRoute: pathname,
      currentPage: pageType,
      // Clear entity context when navigating away from detail pages
      ...(pageType !== 'entity-detail' && { entity: undefined }),
    });
  }, [pathname, setContext]);

  const value: AIContextValue = {
    context,
    setEntityContext,
  };

  return <AIContextContext.Provider value={value}>{children}</AIContextContext.Provider>;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook to access AI context.
 *
 * @throws Error if used outside AIContextProvider
 */
export function useAIContext(): AIContextValue {
  const context = useContext(AIContextContext);

  if (!context) {
    throw new Error('useAIContext must be used within AIContextProvider');
  }

  return context;
}

// ============================================================================
// Entity Context Hook
// ============================================================================

/**
 * Hook to set entity context for the AI Assistant.
 * Call this when viewing a specific entity to provide context.
 *
 * Usage:
 * ```tsx
 * // In entity detail component
 * useSetAIEntityContext({
 *   type: "company",
 *   id: company.id,
 *   name: company.name,
 *   data: company,
 * });
 * ```
 */
export function useSetAIEntityContext(entity: AIEntityReference | undefined) {
  const { setEntityContext } = useAIStore();

  useEffect(() => {
    if (entity) {
      setEntityContext(entity);
    }

    // Clear on unmount
    return () => {
      setEntityContext(undefined);
    };
  }, [entity?.type, entity?.id, entity?.name, setEntityContext]);
}
