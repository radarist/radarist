/**
 * @file app/triage/entities/page.tsx
 * @description Net-new discoveries now live in the unified Assessments inbox, so this
 * legacy path (referenced by the discoverNetNewTechnologies tool message) redirects there.
 */
import { redirect } from 'next/navigation';

export default function ProposedEntitiesRedirect() {
  redirect('/triage/assessment');
}
