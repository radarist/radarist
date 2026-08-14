import { redirect } from 'next/navigation';

/**
 * Legacy route. Signals are canonical under Triage (`/triage/signals`) — the
 * sidebar, breadcrumbs, and all in-app links file Signals under Triage. This
 * stub preserves any historical `/agents/signals` link by redirecting.
 */
export default function AgentsSignalsRedirect() {
  redirect('/triage/signals');
}
