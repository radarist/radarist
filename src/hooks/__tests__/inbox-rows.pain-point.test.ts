/**
 * @jest-environment node
 */

import { entityToRow } from '@/hooks/inbox-rows';
import type { ProposedEntity } from '@/lib/schemas/proposed-entity';

function painPointProposal(data: Record<string, unknown>): ProposedEntity {
  return {
    id: 'proposal-pain-1',
    entityType: 'painPoint',
    name: 'Slow onboarding',
    description: 'Customers cannot complete onboarding reliably.',
    data,
    confidence: 80,
    evidence: { metrics: [], findings: [] },
    status: 'pending',
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('entityToRow pain-point approval truth', () => {
  it('shows the exact classifications that sparse approval will default before approval', () => {
    const row = entityToRow(painPointProposal({ tags: ['onboarding'] }));

    expect(row.effect).toBe(
      'Add painPoint to the catalog as Medium severity · Operational category (defaults shown for review)',
    );
  });

  it('shows explicit classifications without describing them as defaults', () => {
    const row = entityToRow(
      painPointProposal({ severity: 'critical', category: 'customer', status: 'validated' }),
    );

    expect(row.effect).toBe(
      'Add painPoint to the catalog as Critical severity · Customer category',
    );
  });

  it('shows the same fallback classifications the writer uses for malformed values', () => {
    const row = entityToRow(
      painPointProposal({ severity: 'urgent', category: 42, status: 'unknown' }),
    );

    expect(row.effect).toBe(
      'Add painPoint to the catalog as Medium severity · Operational category (defaults shown for review)',
    );
  });
});
