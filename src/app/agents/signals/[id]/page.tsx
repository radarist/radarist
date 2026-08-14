import { redirect } from 'next/navigation';

/**
 * Legacy detail route. Signals are canonical under Triage
 * (`/triage/signals/[id]`). This stub preserves any historical
 * `/agents/signals/<id>` link by redirecting to the canonical path.
 */
export default async function AgentsSignalDetailRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/triage/signals/${id}`);
}
