/**
 * @file lib/radar-placement-api-client.ts
 * @description Browser client for the authenticated same-origin RadarPlacement
 * handoff (GRAPH-060).
 *
 * The client `radar-placement-service` no longer writes Firestore (or emits the
 * graph-sync event through a client-side Inngest sender that can't see the
 * server-only local endpoint). In a browser it delegates create/update/delete to
 * these helpers, which POST/PATCH/DELETE the RELATIVE same-origin `/api/radar-
 * placements` routes via `fetchWithAuth`. Relative paths mean the handoff works
 * under any shifted port and with no configured public app base URL, and no
 * Inngest key or routing material is ever exposed to the browser.
 */

import type { CreateRadarPlacementInput, RadarPlacement, UpdateRadarPlacementInput } from '@/lib/types';
import { fetchWithAuth } from '@/lib/fetch-with-auth';

/** Same server-owned `graphHandoff` the routes return (mirrored for the client). */
export interface PlacementGraphHandoff {
  committed: true;
  acknowledged: boolean;
  reconciliationRequired: boolean;
}

interface ApiEnvelope<T> {
  success?: boolean;
  data?: T;
  error?: string;
  message?: string;
  graphHandoff?: PlacementGraphHandoff;
}

/** True in a browser context — where direct Firestore writes must be avoided. */
export function isBrowserRadarPlacementClient(): boolean {
  return typeof window !== 'undefined';
}

async function requestJson<T>(
  url: string,
  init: RequestInit
): Promise<{ data: T; graphHandoff?: PlacementGraphHandoff }> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  const response = await fetchWithAuth(url, { ...init, headers });
  const payload = (await response.json().catch(() => ({}))) as ApiEnvelope<T>;
  if (!response.ok || payload.success === false) {
    throw new Error(payload.message || payload.error || `Placement request failed (${response.status})`);
  }
  if (payload.data === undefined) throw new Error('Placement API returned no data');
  return { data: payload.data, graphHandoff: payload.graphHandoff };
}

/**
 * GRAPH-060 #2 — surface a committed-but-unacknowledged handoff to the user. The
 * Firestore change succeeded; the graph projection is pending recovery. We say
 * exactly that — never "rollback", "failed", or "fully converged" — with retry
 * guidance and no keys / internal URLs / ports.
 */
function announceGraphHandoff(handoff: PlacementGraphHandoff | undefined): void {
  if (typeof window === 'undefined' || !handoff?.reconciliationRequired) return;
  void import('sonner')
    .then(({ toast }) => {
      toast.warning('Saved — graph sync is catching up', {
        description: 'Your change is stored. The graph view will reconcile automatically in a moment.',
      });
    })
    .catch(() => {
      /* toast is best-effort UI; never fail a committed mutation on it */
    });
}

/** Create a placement through the authenticated handoff; resolves the committed placement. */
export async function createRadarPlacementViaApi(input: CreateRadarPlacementInput): Promise<RadarPlacement> {
  const { data, graphHandoff } = await requestJson<RadarPlacement>('/api/radar-placements', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  announceGraphHandoff(graphHandoff);
  return data;
}

/** Update (or ring-move) a placement through the authenticated handoff. */
export async function updateRadarPlacementViaApi(
  id: string,
  updates: UpdateRadarPlacementInput
): Promise<RadarPlacement> {
  const { data, graphHandoff } = await requestJson<RadarPlacement>(`/api/radar-placements/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
  announceGraphHandoff(graphHandoff);
  return data;
}

/** Delete a placement through the authenticated handoff. */
export async function deleteRadarPlacementViaApi(id: string): Promise<void> {
  const { graphHandoff } = await requestJson<{ deleted: true }>(`/api/radar-placements/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  announceGraphHandoff(graphHandoff);
}

/** GRAPH-060 #1 — bulk-delete every placement of a technology via the server cascade. */
export async function deleteAllPlacementsForTechnologyViaApi(technologyId: string): Promise<number> {
  const { data } = await requestJson<{ deleted: number }>(
    `/api/radar-placements?technologyId=${encodeURIComponent(technologyId)}`,
    { method: 'DELETE' }
  );
  return data.deleted;
}

/** GRAPH-060 #1 — bulk-delete every placement on a radar via the server cascade. */
export async function deleteAllPlacementsForRadarViaApi(radarId: string): Promise<number> {
  const { data } = await requestJson<{ deleted: number }>(
    `/api/radar-placements?radarId=${encodeURIComponent(radarId)}`,
    { method: 'DELETE' }
  );
  return data.deleted;
}
