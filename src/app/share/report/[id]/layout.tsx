/**
 * @file app/share/report/[id]/layout.tsx
 * @description Layout for the public report share page
 *
 * This layout renders report content without the application shell
 * (no sidebar, no navigation, no auth requirements).
 *
 * SECURITY: the Content-Security-Policy for this route is a real RESPONSE
 * HEADER set in next.config.ts (`headers()` → `/share/report/:id*`). It used to
 * be declared here via Next `metadata.other`, which emits an inert
 * `<meta name="Content-Security-Policy">` (NOT `http-equiv=`) that browsers
 * ignore — so it enforced nothing. The report body is additionally isolated in
 * a sandboxed iframe (see page.tsx / share-iframe.ts).
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

/**
 * Minimal layout for shared reports.
 * No sidebar, no auth providers, no application chrome.
 * The root layout's <html>/<body> tags still wrap this content.
 */
export default function ShareReportLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
