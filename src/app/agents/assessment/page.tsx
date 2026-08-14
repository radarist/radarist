import { redirect } from 'next/navigation';

/**
 * Legacy route. The Assessment inbox implementation is canonical under
 * Triage (`/triage/assessment`) — the sidebar, breadcrumbs, and all in-app
 * links file it under Triage. This stub preserves any historical
 * `/agents/assessment` link by redirecting.
 */
export default function AgentsAssessmentRedirect() {
  redirect('/triage/assessment');
}
