/**
 * @file proposal-scope.test.ts
 * @description UX-037 — the Linker triage scope algebra.
 *
 * The page must have exactly ONE derivation of "the proposals the operator is
 * acting on". Everything visible (list rows, triage queue, the Approve High
 * count) and everything mutable (bulk approve/reject/delete) is computed from
 * the same function here, so a hidden proposal cannot be written.
 */

import {
  DEFAULT_PROPOSAL_SCOPE_FILTERS,
  describeProposalScope,
  filterProposals,
  intersectSelection,
  selectHighConfidence,
  type ProposalScopeFilters,
} from '../proposal-scope';
import type { ProposedRelation } from '@/lib/types';

function proposal(overrides: Partial<ProposedRelation> & { id: string }): ProposedRelation {
  return {
    sourceType: 'company',
    sourceId: `src-${overrides.id}`,
    sourceSnapshot: { id: `src-${overrides.id}`, type: 'company', name: 'Acme Robotics' },
    targetType: 'technology',
    targetId: `tgt-${overrides.id}`,
    targetSnapshot: { id: `tgt-${overrides.id}`, type: 'technology', name: 'Quantum Mesh' },
    relationType: 'uses',
    confidence: 50,
    reasoning: 'because',
    evidence: [],
    status: 'pending',
    discoveredBy: 'linker-agent',
    createdAt: 1,
    ...overrides,
  } as ProposedRelation;
}

const noFilters: ProposalScopeFilters = { ...DEFAULT_PROPOSAL_SCOPE_FILTERS, status: 'all' };

describe('filterProposals', () => {
  it('keeps every proposal when no filter and no search are active', () => {
    const proposals = [proposal({ id: 'a' }), proposal({ id: 'b' })];

    expect(filterProposals(proposals, { searchQuery: '', filters: noFilters }).map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('matches search against source name, target name, and relation type', () => {
    const proposals = [
      proposal({ id: 'source-hit', sourceSnapshot: { id: 's', type: 'company', name: 'Northwind', snapshotAt: 1 } }),
      proposal({ id: 'target-hit', targetSnapshot: { id: 't', type: 'technology', name: 'Northwind Mesh', snapshotAt: 1 } }),
      proposal({ id: 'relation-hit', relationType: 'competes_with' }),
      proposal({ id: 'miss' }),
    ];

    expect(filterProposals(proposals, { searchQuery: 'northwind', filters: noFilters }).map((p) => p.id)).toEqual([
      'source-hit',
      'target-hit',
    ]);
    expect(filterProposals(proposals, { searchQuery: 'competes', filters: noFilters }).map((p) => p.id)).toEqual([
      'relation-hit',
    ]);
  });

  it('applies each facet and the confidence floor', () => {
    const proposals = [
      proposal({ id: 'keep', confidence: 90, status: 'pending', discoveredBy: 'auto-linker', targetType: 'signal' }),
      proposal({ id: 'wrong-status', confidence: 90, status: 'approved', discoveredBy: 'auto-linker' }),
      proposal({ id: 'wrong-source', confidence: 90, sourceType: 'signal' }),
      proposal({ id: 'low-confidence', confidence: 10, discoveredBy: 'auto-linker' }),
    ];

    const scoped = filterProposals(proposals, {
      searchQuery: '',
      filters: {
        ...DEFAULT_PROPOSAL_SCOPE_FILTERS,
        status: 'pending',
        sourceType: 'company',
        targetType: 'signal',
        discoveredBy: 'auto-linker',
        minConfidence: 20,
      },
    });

    expect(scoped.map((p) => p.id)).toEqual(['keep']);
  });

  it('never mutates the input array', () => {
    const proposals = [proposal({ id: 'b' }), proposal({ id: 'a' })];
    filterProposals(proposals, { searchQuery: '', filters: noFilters });
    expect(proposals.map((p) => p.id)).toEqual(['b', 'a']);
  });
});

describe('selectHighConfidence', () => {
  it('takes only pending proposals at or above the threshold', () => {
    const visible = [
      proposal({ id: 'at-threshold', confidence: 75 }),
      proposal({ id: 'above', confidence: 99 }),
      proposal({ id: 'below', confidence: 74 }),
      proposal({ id: 'already-approved', confidence: 99, status: 'approved' }),
    ];

    expect(selectHighConfidence(visible, 75).map((p) => p.id)).toEqual(['at-threshold', 'above']);
  });

  it('is a subset of the visible scope it was given', () => {
    const all = [proposal({ id: 'visible', confidence: 90 }), proposal({ id: 'hidden', confidence: 90 })];
    const visible = filterProposals(all, {
      searchQuery: '',
      filters: { ...DEFAULT_PROPOSAL_SCOPE_FILTERS, minConfidence: 0 },
    }).filter((p) => p.id === 'visible');

    const high = selectHighConfidence(visible, 75);

    expect(high.map((p) => p.id)).toEqual(['visible']);
    expect(high.every((p) => visible.includes(p))).toBe(true);
  });
});

describe('intersectSelection', () => {
  it('drops selected ids that are no longer visible', () => {
    const visible = [proposal({ id: 'a' }), proposal({ id: 'b' })];

    expect(intersectSelection(['a', 'hidden', 'b'], visible)).toEqual(['a', 'b']);
  });

  it('preserves the caller ordering of the surviving ids', () => {
    const visible = [proposal({ id: 'a' }), proposal({ id: 'b' })];

    expect(intersectSelection(['b', 'a'], visible)).toEqual(['b', 'a']);
  });

  it('returns the same array reference when nothing was dropped', () => {
    const visible = [proposal({ id: 'a' }), proposal({ id: 'b' })];
    const selected = ['a', 'b'];

    expect(intersectSelection(selected, visible)).toBe(selected);
  });
});

describe('describeProposalScope', () => {
  it('reports an unfiltered scope as all proposals', () => {
    expect(describeProposalScope('', noFilters)).toBe('all proposals');
  });

  it('names each active narrowing so the confirmation cannot overstate its reach', () => {
    const description = describeProposalScope('mesh', {
      ...DEFAULT_PROPOSAL_SCOPE_FILTERS,
      status: 'pending',
      sourceType: 'company',
      minConfidence: 40,
    });

    expect(description).toContain('matching "mesh"');
    expect(description).toContain('pending');
    expect(description).toContain('company');
    expect(description).toContain('40');
  });
});
