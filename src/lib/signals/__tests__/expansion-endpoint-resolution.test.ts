/**
 * @jest-environment node
 *
 * GRAPH-063 — the expansion prompt hands the model an ungrounded `"id"` slot,
 * so it invents endpoint IDs. Each one becomes a graph MATCH that silently
 * writes nothing and PERMANENTLY blocks the signal's source fingerprint. These
 * tests pin what survives that reconciliation and what is dropped.
 */

import {
  isDirectlyProjectableSignalStatus,
  resolveExpansionEndpoints,
  toPersistedRejections,
  MAX_PERSISTED_REJECTIONS,
  type CandidateEntity,
  type CandidateLoader,
  type RelatedItemKind,
} from '../expansion-endpoint-resolution';
import type { ExpandedContent } from '@/lib/schemas/signal';

function expansion(relatedItems: unknown): ExpandedContent {
  return {
    relatedItems,
    expandedAt: 1,
    expansionModel: 'test',
    expansionDuration: 1,
  } as unknown as ExpandedContent;
}

function loaderFor(workspace: Partial<Record<RelatedItemKind, CandidateEntity[]>>): {
  load: CandidateLoader;
  calls: RelatedItemKind[];
} {
  const calls: RelatedItemKind[] = [];
  return {
    calls,
    load: async (kind) => {
      calls.push(kind);
      return workspace[kind] ?? [];
    },
  };
}

describe('resolveExpansionEndpoints', () => {
  it('keeps an endpoint whose id names a real projectable entity', async () => {
    const { load } = loaderFor({
      technologies: [{ id: 'tech-real', label: 'Quantum Simulation', projectable: true }],
    });

    const result = await resolveExpansionEndpoints(
      expansion({
        technologies: [{ id: 'tech-real', name: 'Quantum Simulation', relevance: 'core' }],
        companies: [],
        signals: [],
      }),
      'signal-1',
      load
    );

    expect(result.relatedItems?.technologies).toEqual([
      { id: 'tech-real', name: 'Quantum Simulation', relevance: 'core' },
    ]);
    expect(result).toMatchObject({ keptCount: 1, resolvedCount: 0, rejectedCount: 0 });
  });

  // The exact shape the finding reported: five plausible-looking IDs for
  // entities that do not exist.
  it('rejects an endpoint whose id and name name nothing in the workspace', async () => {
    const { load } = loaderFor({ technologies: [] });

    const result = await resolveExpansionEndpoints(
      expansion({
        technologies: [
          { id: 'tech-id', name: 'Invented Tech', relevance: 'related' },
          { id: 'tech-phasecraft-simulator', name: 'Phasecraft Simulator', relevance: 'related' },
        ],
        companies: [],
        signals: [],
      }),
      'signal-1',
      load
    );

    expect(result.relatedItems?.technologies).toEqual([]);
    expect(result.rejectedCount).toBe(2);
    expect(result.decisions.map((d) => d.reason)).toEqual(['unknown-id-and-name', 'unknown-id-and-name']);
  });

  it('resolves a wrong id onto the canonical entity when the name matches exactly one', async () => {
    const { load } = loaderFor({
      companies: [{ id: 'company-canonical', label: 'Phasecraft', projectable: true }],
    });

    const result = await resolveExpansionEndpoints(
      expansion({
        technologies: [],
        companies: [{ id: 'company-hallucinated', name: 'phasecraft', relevance: 'subject' }],
        signals: [],
      }),
      'signal-1',
      load
    );

    expect(result.relatedItems?.companies).toEqual([
      { id: 'company-canonical', name: 'phasecraft', relevance: 'subject' },
    ]);
    expect(result).toMatchObject({ resolvedCount: 1, rejectedCount: 0 });
  });

  it('refuses to guess when two entities answer to the same name', async () => {
    const { load } = loaderFor({
      companies: [
        { id: 'company-a', label: 'Acme', projectable: true },
        { id: 'company-b', label: 'acme', projectable: true },
      ],
    });

    const result = await resolveExpansionEndpoints(
      expansion({
        technologies: [],
        companies: [{ id: 'company-unknown', name: 'Acme', relevance: 'related' }],
        signals: [],
      }),
      'signal-1',
      load
    );

    expect(result.relatedItems?.companies).toEqual([]);
    expect(result.decisions[0]).toMatchObject({ outcome: 'rejected', reason: 'ambiguous-name' });
  });

  // A Detected signal is inbox-only: it is never projected on its own, and a
  // RELATED_SIGNAL edge is not a reference kind that grants eligibility. The
  // MATCH would therefore never succeed.
  it('rejects a related signal that the graph can never project', async () => {
    const { load } = loaderFor({
      signals: [{ id: 'signal-detected', label: 'Detected only', projectable: false }],
    });

    const result = await resolveExpansionEndpoints(
      expansion({
        technologies: [],
        companies: [],
        signals: [{ id: 'signal-detected', title: 'Detected only', relevance: 'related' }],
      }),
      'signal-1',
      load
    );

    expect(result.relatedItems?.signals).toEqual([]);
    expect(result.decisions[0]).toMatchObject({ outcome: 'rejected', reason: 'not-projectable' });
  });

  it('drops a self-reference', async () => {
    const { load } = loaderFor({
      signals: [{ id: 'signal-1', label: 'The signal itself', projectable: true }],
    });

    const result = await resolveExpansionEndpoints(
      expansion({
        technologies: [],
        companies: [],
        signals: [{ id: 'signal-1', title: 'The signal itself', relevance: 'self' }],
      }),
      'signal-1',
      load
    );

    expect(result.relatedItems?.signals).toEqual([]);
    expect(result.decisions[0]).toMatchObject({ outcome: 'rejected', reason: 'self-reference' });
  });

  it('rejects an entry carrying neither an id nor a label', async () => {
    const { load } = loaderFor({ technologies: [] });

    const result = await resolveExpansionEndpoints(
      expansion({ technologies: [{ id: '  ', name: '', relevance: 'x' }], companies: [], signals: [] }),
      'signal-1',
      load
    );

    expect(result.decisions[0]).toMatchObject({ outcome: 'rejected', reason: 'no-identifier' });
  });

  it('collapses two model entries that canonicalize onto one entity', async () => {
    const { load } = loaderFor({
      technologies: [{ id: 'tech-real', label: 'Quantum Simulation', projectable: true }],
    });

    const result = await resolveExpansionEndpoints(
      expansion({
        technologies: [
          { id: 'tech-real', name: 'Quantum Simulation', relevance: 'core' },
          { id: 'tech-wrong-handle', name: 'Quantum Simulation', relevance: 'duplicate' },
        ],
        companies: [],
        signals: [],
      }),
      'signal-1',
      load
    );

    expect(result.relatedItems?.technologies).toHaveLength(1);
  });

  it('does not read a collection the expansion never referenced', async () => {
    const { load, calls } = loaderFor({
      technologies: [{ id: 'tech-real', label: 'Real', projectable: true }],
    });

    await resolveExpansionEndpoints(
      expansion({
        technologies: [{ id: 'tech-real', name: 'Real', relevance: 'core' }],
        companies: [],
        signals: [],
      }),
      'signal-1',
      load
    );

    expect(calls).toEqual(['technologies']);
  });

  it('passes through an expansion with no relatedItems at all', async () => {
    const { load, calls } = loaderFor({});

    const result = await resolveExpansionEndpoints(expansion(undefined), 'signal-1', load);

    expect(result.relatedItems).toBeUndefined();
    expect(result.decisions).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('isDirectlyProjectableSignalStatus', () => {
  it('accepts only the statuses the graph projects on their own', () => {
    expect(isDirectlyProjectableSignalStatus('Approved')).toBe(true);
    expect(isDirectlyProjectableSignalStatus('Imported')).toBe(true);
    expect(isDirectlyProjectableSignalStatus('Detected')).toBe(false);
    expect(isDirectlyProjectableSignalStatus('Validated')).toBe(false);
    expect(isDirectlyProjectableSignalStatus(undefined)).toBe(false);
  });
});

describe('toPersistedRejections', () => {
  it('records only rejections and bounds the stored list', () => {
    const decisions = Array.from({ length: MAX_PERSISTED_REJECTIONS + 10 }, (_, index) => ({
      kind: 'technologies' as const,
      proposedId: `tech-${index}`,
      proposedLabel: `Tech ${index}`,
      outcome: 'rejected' as const,
      reason: 'unknown-id-and-name' as const,
    }));
    decisions.push({
      kind: 'technologies',
      proposedId: 'tech-real',
      proposedLabel: 'Real',
      outcome: 'kept',
      reason: undefined,
    } as never);

    const persisted = toPersistedRejections(decisions);

    expect(persisted).toHaveLength(MAX_PERSISTED_REJECTIONS);
    expect(persisted.every((entry) => entry.reason === 'unknown-id-and-name')).toBe(true);
  });
});
