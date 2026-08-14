import type { Metadata } from 'next';
import './globals.css';
import { Toaster } from '@/components/ui/toaster';
import { Toaster as SonnerToaster } from '@/components/ui/sonner';
import { ThemeProvider } from '@/components/ThemeProvider';
import { QueryProvider } from '@/components/providers/QueryProvider';
import { AuthProvider } from '@/components/providers/AuthProvider';
import { AccountCacheBoundary } from '@/components/providers/AccountCacheBoundary';

export const metadata: Metadata = {
  title: 'Radarist',
  description: 'Open-source agentic technology radar',
};

/**
 * Root Layout component.
 * - Sets up the HTML structure.
 * - Uses the local/system font stack so the local-first app works offline.
 * - Wraps the app in ThemeProvider (Next-Themes).
 * - Includes the global Toaster for notifications.
 * - Note: SidebarProvider is now inside AppLayoutV2 (shadcn pattern)
 *
 * @param props - Props containing children.
 * @returns The root layout structure.
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-body antialiased">
        {/* Skip to main content link for keyboard users */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:top-4 focus:left-4 focus:px-4 focus:py-2 focus:bg-primary focus:text-primary-foreground focus:rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
        >
          Skip to main content
        </a>
        <QueryProvider>
          <AuthProvider>
            <AccountCacheBoundary>
              <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
                {children}
                <Toaster />
                <SonnerToaster position="bottom-right" />
              </ThemeProvider>
            </AccountCacheBoundary>
          </AuthProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
