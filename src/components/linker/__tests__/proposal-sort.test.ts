/**
 * @file components/linker/__tests__/proposal-sort.test.ts
 * @description Unit tests for the pure Linker proposals comparator
 * (sort semantics pinned by the 2026-06-10 library-table alignment):
 *   - source / target — entity display name, localeCompare
 *   - relation — relation type label (underscores read as spaces)
 *   - confidence — numeric (not lexicographic)
 *   - createdAt — timestamp
 *   - ties return 0 (stable sort), unknown keys are a no-op
 */

import {
  PROPOSAL_SORT_FIELDS,
  DEFAULT_PROPOSAL_SORT,
  compareProposals,
  defaultProposalSortDirection,
  isProposalSortField,
} from '../proposal-sort';
import type { ProposedRelation } from '@/lib/types';

function makeProposal(overrides: Partial<ProposedRelation>): ProposedRelation {
  return {
    id: 'prop-0',
    sourceType: 'company',
    sourceId: 'company-1',
    sourceSnapshot: { type: 'company', id: 'company-1', name: 'Acme Corp', snapshotAt: 1717200000000 },
    targetType: 'technology',
    targetId: 'tech-1',
    targetSnapshot: { type: 'technology', id: 'tech-1', name: 'Quantum SDK', snapshotAt: 1717200000000 },
    relationType: 'uses',
    confidence: 80,
    reasoning: 'Detected in docs',
    evidence: [],
    status: 'pending',
    discoveredBy: 'linker-agent',
    createdAt: 1717200000000,
    updatedAt: 1717200000000,
    ...overrides,
  };
}

describe('compareProposals', () => {
  it('sorts by source entity display name with localeCompare', () => {
    const a = makeProposal({ sourceSnapshot: { type: 'company', id: 'c1', name: 'Acme Corp', snapshotAt: 1717200000000 } });
    const b = makeProposal({ sourceSnapshot: { type: 'company', id: 'c2', name: 'Beta Labs', snapshotAt: 1717200000000 } });

    expect(compareProposals(a, b, { key: 'source', direction: 'asc' })).toBeLessThan(0);
    expect(compareProposals(a, b, { key: 'source', direction: 'desc' })).toBeGreaterThan(0);
  });

  it('sorts by target entity display name with localeCompare', () => {
    const a = makeProposal({ targetSnapshot: { type: 'technology', id: 't1', name: 'Agent Framework', snapshotAt: 1717200000000 } });
    const b = makeProposal({ targetSnapshot: { type: 'technology', id: 't2', name: 'Quantum SDK', snapshotAt: 1717200000000 } });

    expect(compareProposals(a, b, { key: 'target', direction: 'asc' })).toBeLessThan(0);
    expect(compareProposals(b, a, { key: 'target', direction: 'asc' })).toBeGreaterThan(0);
  });

  it('sorts relation by its type label, reading underscores as spaces', () => {
    const a = makeProposal({ relationType: 'integrates_with' });
    const b = makeProposal({ relationType: 'uses' });

    // "integrates with" < "uses"
    expect(compareProposals(a, b, { key: 'relation', direction: 'asc' })).toBeLessThan(0);
    expect(compareProposals(a, b, { key: 'relation', direction: 'desc' })).toBeGreaterThan(0);
  });

  it('sorts confidence numerically, not lexicographically', () => {
    const low = makeProposal({ confidence: 9 });
    const high = makeProposal({ confidence: 80 });

    // Lexicographic compare would put "80" before "9" — numeric must not.
    expect(compareProposals(low, high, { key: 'confidence', direction: 'asc' })).toBeLessThan(0);
    expect(compareProposals(low, high, { key: 'confidence', direction: 'desc' })).toBeGreaterThan(0);
  });

  it('sorts createdAt by timestamp', () => {
    const older = makeProposal({ createdAt: 1717200000000 });
    const newer = makeProposal({ createdAt: 1717300000000 });

    expect(compareProposals(older, newer, { key: 'createdAt', direction: 'asc' })).toBeLessThan(0);
    expect(compareProposals(older, newer, { key: 'createdAt', direction: 'desc' })).toBeGreaterThan(0);
  });

  it('returns 0 for ties so Array.prototype.sort stays stable', () => {
    const a = makeProposal({ id: 'p1', confidence: 75 });
    const b = makeProposal({ id: 'p2', confidence: 75 });

    // `direction * 0` yields -0; `===` (and Array.prototype.sort) treat it as 0.
    expect(compareProposals(a, b, { key: 'confidence', direction: 'desc' }) === 0).toBe(true);

    // Stability end-to-end: equal-confidence rows keep their input order.
    const rows = [a, b];
    rows.sort((x, y) => compareProposals(x, y, { key: 'confidence', direction: 'desc' }));
    expect(rows.map((r) => r.id)).toEqual(['p1', 'p2']);
  });

  it('treats missing snapshot names as empty strings instead of throwing', () => {
    const broken = makeProposal({
      sourceSnapshot: undefined as unknown as ProposedRelation['sourceSnapshot'],
    });
    const named = makeProposal({ sourceSnapshot: { type: 'company', id: 'c2', name: 'Beta Labs', snapshotAt: 1717200000000 } });

    expect(compareProposals(broken, named, { key: 'source', direction: 'asc' })).toBeLessThan(0);
  });

  it('is a no-op for unknown sort keys', () => {
    const a = makeProposal({ id: 'p1' });
    const b = makeProposal({ id: 'p2' });

    expect(compareProposals(a, b, { key: 'status', direction: 'asc' })).toBe(0);
  });
});

describe('defaultProposalSortDirection', () => {
  it('starts numeric/date columns descending and text columns ascending', () => {
    expect(defaultProposalSortDirection('confidence')).toBe('desc');
    expect(defaultProposalSortDirection('createdAt')).toBe('desc');
    expect(defaultProposalSortDirection('source')).toBe('asc');
    expect(defaultProposalSortDirection('target')).toBe('asc');
    expect(defaultProposalSortDirection('relation')).toBe('asc');
  });
});

describe('isProposalSortField', () => {
  it('accepts exactly the five sortable columns', () => {
    for (const field of PROPOSAL_SORT_FIELDS) {
      expect(isProposalSortField(field)).toBe(true);
    }
    expect(isProposalSortField('status')).toBe(false);
    expect(isProposalSortField('')).toBe(false);
  });
});

describe('DEFAULT_PROPOSAL_SORT', () => {
  it('defaults to newest first', () => {
    expect(DEFAULT_PROPOSAL_SORT).toEqual({ key: 'createdAt', direction: 'desc' });
  });
});
