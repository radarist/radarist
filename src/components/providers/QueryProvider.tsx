'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { getQueryClient } from '@/lib/query-client';

interface QueryProviderProps {
  children: React.ReactNode;
}

/**
 * QueryProvider wraps the app with TanStack Query's QueryClientProvider.
 *
 * Features:
 * - Provides the QueryClient to all components
 * - React Query DevTools are OPT-IN via NEXT_PUBLIC_QUERY_DEVTOOLS=1
 * - Uses singleton pattern for browser-side QueryClient
 */
export function QueryProvider({ children }: QueryProviderProps) {
  // Get or create the QueryClient (singleton on browser, new on server)
  const queryClient = getQueryClient();

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {/*
       * DevTools floating trigger is OPT-IN (default OFF): all four viewport
       * corners of this app carry real UI (bottom-right: drawer Save CTA /
       * chat input; bottom-left: sidebar user chip; top-right: header
       * controls; top-left: logo), so the library's fixed z-index-100000
       * toggle covers something interactive wherever it's anchored — it
       * can cover the drawer Save button or the user-avatar chip. Set
       * NEXT_PUBLIC_QUERY_DEVTOOLS=1
       * to mount it when actively debugging query state; bottom-left is the
       * least-critical collision while enabled.
       */}
      {process.env.NEXT_PUBLIC_QUERY_DEVTOOLS === '1' && (
        <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
      )}
    </QueryClientProvider>
  );
}
