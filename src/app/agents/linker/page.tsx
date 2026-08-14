import { redirect } from 'next/navigation';

/**
 * Legacy route. The Linker Triage implementation is canonical under Triage
 * (`/triage/relations`) — the sidebar, breadcrumbs, and all in-app links file
 * it under Triage. This stub preserves any historical `/agents/linker` link
 * by redirecting.
 */
export default function AgentsLinkerRedirect() {
  redirect('/triage/relations');
}
