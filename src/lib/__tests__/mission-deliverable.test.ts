/**
 * @file lib/__tests__/mission-deliverable.test.ts
 * @description MISSION-011 — the deliverable contract that keeps Linker missions
 * on their evidence-backed edge-proposal deliverable.
 *
 * Pure module, zero provider spend, zero Firestore: every assertion here is a
 * property of the rule itself, which is exactly what makes the rule survive an
 * unavailable or wrong intent classifier.
 */

import {
  LINKER_PROPOSAL_CONTRACT,
  PROPOSAL_CONTRACT_SENTINEL,
  PROPOSAL_DELIVERABLE_AGENTS,
  isProposalDeliverableAgent,
  missionDeliverableKind,
  promptCarriesProposalContract,
  promptExplicitlyRequestsArtifact,
  resolveMissionDeliverable,
} from '@/lib/mission-deliverable';
import { containsLinkerBundleMarker, parseLinkerBundle } from '@/lib/mission-quality/analyzers/linker-bundle-parser';

const MAIN_SLOT = [{ name: 'main', intent: 'legacy default (no classifier)' }];

describe('proposal-deliverable agents', () => {
  it('classifies linker as a proposal deliverable and everyone else as a report', () => {
    expect(isProposalDeliverableAgent('linker')).toBe(true);
    expect(missionDeliverableKind({ agent: 'linker' })).toBe('proposal');
    for (const agent of ['scout', 'creator', 'strategist', 'curator', 'evaluator', 'defense-minister']) {
      expect(isProposalDeliverableAgent(agent)).toBe(false);
      expect(missionDeliverableKind({ agent })).toBe('report');
    }
  });

  it('tolerates missing/whitespace agents without throwing', () => {
    expect(isProposalDeliverableAgent(undefined)).toBe(false);
    expect(isProposalDeliverableAgent(null)).toBe(false);
    expect(isProposalDeliverableAgent(' linker ')).toBe(true);
    expect(PROPOSAL_DELIVERABLE_AGENTS.has('linker')).toBe(true);
  });
});

describe('the contract and the quality gate cannot drift apart', () => {
  // The whole MISSION-011 root cause was an instruction and a gate that keyed on
  // different things. This is the structural proof that they no longer can: the
  // appended contract itself satisfies the marker the L1 parser looks for.
  it('satisfies containsLinkerBundleMarker by construction', () => {
    expect(containsLinkerBundleMarker(LINKER_PROPOSAL_CONTRACT)).toBe(true);
  });

  it('publishes a bundle example that the real parser accepts', () => {
    // The contract's own example must be a valid bundle — an agent copying it
    // verbatim (with real names substituted) must clear the critical check.
    const example = LINKER_PROPOSAL_CONTRACT.replace(/<exact entity name>/, 'Acme Corp')
      .replace(/<exact entity name>/, 'Widget Platform')
      .replace('<canonical snake_case predicate>', 'uses')
      .replace('<one sentence naming BOTH entity names verbatim>', 'Acme Corp runs on Widget Platform in production.');
    const parsed = parseLinkerBundle(example);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.bundle.edges).toHaveLength(1);
      expect(parsed.bundle.edges[0].sourceEntityName).toBe('Acme Corp');
      expect(parsed.bundle.edges[0].targetEntityName).toBe('Widget Platform');
    }
  });

  it('states the no-artifact rule in the prompt the agent reads', () => {
    expect(LINKER_PROPOSAL_CONTRACT).toMatch(/Do NOT produce a report/i);
    expect(LINKER_PROPOSAL_CONTRACT).toMatch(/do NOT delegate one to another agent/i);
  });
});

describe('promptExplicitlyRequestsArtifact', () => {
  it('is false for sweep and operator prompts that request no artifact', () => {
    expect(promptExplicitlyRequestsArtifact('Research and find relationships for: Phasecraft (company)')).toBe(false);
    expect(promptExplicitlyRequestsArtifact('Find and propose relationships between our quantum technologies')).toBe(
      false
    );
    expect(promptExplicitlyRequestsArtifact('')).toBe(false);
    expect(promptExplicitlyRequestsArtifact(undefined)).toBe(false);
  });

  it('is true when a production verb and an artifact noun share a clause', () => {
    expect(promptExplicitlyRequestsArtifact('Map the relationships and publish a report on what you find')).toBe(true);
    expect(promptExplicitlyRequestsArtifact('Give me a one-pager on the vendor landscape')).toBe(true);
    expect(promptExplicitlyRequestsArtifact('Produce an infographic of the graph clusters')).toBe(true);
    expect(promptExplicitlyRequestsArtifact('I need a briefing on the quantum patent cluster')).toBe(true);
  });

  it('is true when the output format is named directly', () => {
    expect(promptExplicitlyRequestsArtifact('Summarise the edges as a report')).toBe(true);
    expect(promptExplicitlyRequestsArtifact('Put the findings into a deck')).toBe(true);
  });

  it('does not fire on an artifact noun in an unrelated clause', () => {
    expect(
      promptExplicitlyRequestsArtifact('Find relationships for Acme. Afterwards I will write the report myself.')
    ).toBe(false);
    expect(promptExplicitlyRequestsArtifact('Link the entities mentioned in the 2026 annual report')).toBe(false);
  });

  it('honours an explicit refusal even when an artifact noun is present', () => {
    expect(promptExplicitlyRequestsArtifact('Map the edges — no report needed')).toBe(false);
    expect(promptExplicitlyRequestsArtifact('Propose relationships without a report')).toBe(false);
    expect(promptExplicitlyRequestsArtifact('Propose relationships but do not publish a report')).toBe(false);
    expect(promptExplicitlyRequestsArtifact('Propose relationships, skip the deck')).toBe(false);
  });
});

describe('resolveMissionDeliverable', () => {
  it('leaves report-deliverable agents byte-identical', () => {
    const resolution = resolveMissionDeliverable({
      agent: 'creator',
      prompt: 'Write a landscape report on agentic frameworks',
      slots: MAIN_SLOT,
    });
    expect(resolution.kind).toBe('report');
    expect(resolution.prompt).toBe('Write a landscape report on agentic frameworks');
    expect(resolution.slots).toEqual(MAIN_SLOT);
    expect(resolution.droppedSlots).toEqual([]);
    expect(resolution.contractApplied).toBe(false);
  });

  it('drops an unrequested report slot from a linker mission and records it', () => {
    const resolution = resolveMissionDeliverable({
      agent: 'linker',
      prompt: 'Research and find relationships for: Phasecraft (company)',
      slots: MAIN_SLOT,
    });
    expect(resolution.kind).toBe('proposal');
    expect(resolution.artifactRequested).toBe(false);
    expect(resolution.slots).toEqual([]);
    // Never silent: the caller logs exactly what was removed.
    expect(resolution.droppedSlots).toEqual(MAIN_SLOT);
  });

  it('appends the bundle contract to a linker prompt', () => {
    const resolution = resolveMissionDeliverable({
      agent: 'linker',
      prompt: 'Research and find relationships for: Phasecraft (company)',
      slots: [],
    });
    expect(resolution.contractApplied).toBe(true);
    expect(promptCarriesProposalContract(resolution.prompt)).toBe(true);
    expect(containsLinkerBundleMarker(resolution.prompt)).toBe(true);
    // The original request survives verbatim above the contract.
    expect(resolution.prompt.startsWith('Research and find relationships for: Phasecraft (company)')).toBe(true);
  });

  it('is idempotent — a chain step or replay never doubles the contract', () => {
    const once = resolveMissionDeliverable({ agent: 'linker', prompt: 'Link Acme to its stack', slots: [] });
    const twice = resolveMissionDeliverable({ agent: 'linker', prompt: once.prompt, slots: [] });
    expect(twice.prompt).toBe(once.prompt);
    expect(twice.contractApplied).toBe(false);
    const occurrences = twice.prompt.split(PROPOSAL_CONTRACT_SENTINEL).length - 1;
    expect(occurrences).toBe(1);
  });

  it('keeps the artifact slot when the request explicitly asked for one, and STILL requires the bundle', () => {
    const resolution = resolveMissionDeliverable({
      agent: 'linker',
      prompt: 'Map the supplier relationships and publish a report summarising them',
      slots: [{ name: 'supplier-map', intent: 'supplier relationship report' }],
    });
    expect(resolution.artifactRequested).toBe(true);
    expect(resolution.slots).toEqual([{ name: 'supplier-map', intent: 'supplier relationship report' }]);
    expect(resolution.droppedSlots).toEqual([]);
    // The artifact is ADDITIONAL — the structured bundle is never optional.
    expect(promptCarriesProposalContract(resolution.prompt)).toBe(true);
  });
});
