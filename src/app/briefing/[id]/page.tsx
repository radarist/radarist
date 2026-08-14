/**
 * @file app/briefing/[id]/page.tsx
 * @description Back-compat redirect from `/briefing/[id]` to
 * `/triage/insights/[id]`.
 *
 * Moved on 2026-05-13 along with the parent list route. Keeps shared
 * detail-page links from older messages / emails functional.
 */

import { redirect } from 'next/navigation';

interface RedirectProps {
  params: Promise<{ id: string }>;
}

export default async function BriefingDetailRedirect({ params }: RedirectProps) {
  const { id } = await params;
  redirect(`/triage/insights/${id}`);
}
