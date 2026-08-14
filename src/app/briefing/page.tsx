/**
 * @file app/briefing/page.tsx
 * @description Back-compat redirect from `/briefing` to `/triage/insights`.
 *
 * The list page moved on 2026-05-13 as part of the "Insights" rename +
 * Triage nav grouping. This shim preserves deep links from bookmarks,
 * emails, or prior conversations. `next/navigation`'s `redirect()`
 * produces a 307 (preserves method) by default — fine for the GET-only
 * briefing route.
 */

import { redirect } from 'next/navigation';

export default function BriefingRedirect() {
  redirect('/triage/insights');
}
