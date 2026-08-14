/**
 * @file lib/__tests__/linker-proposal-deliverable.test.ts
 * @description MISSION-011 acceptance — a Linker mission stays on its
 * evidence-backed edge-proposal deliverable end to end.
 *
 * A Linker can research correctly, then delegate an unrequested report and loop
 * on report-tool discovery without producing proposals. Four separate stages
 * can push it there, and each one is pinned here:
 *
 *   1. DISPATCH   — an unrequested report slot is dropped and the bundle
 *                   contract is bound to the mission kind.
 *   2. L1 GATE    — the bundle checks fire because the mission is a linker, not
 *                   because someone remembered to write a marker in the prompt.
 *   3. REVISION   — the correction turn asks for a bundle, never report HTML.
 *   4. TERMINAL   — a missing bundle fails loudly; a zero-report Linker mission
 *                   with a valid bundle is a clean success.
 *
 * Zero provider spend and zero Firestore: every stage is a pure rule.
 */

import { evaluateMissionQuality, resolveMissionOutcome, PROPOSAL_DELIVERABLE_CHECK } from '../mission-quality';
import type { QualityCheck } from '../mission-quality';
import { buildMissionDocument } from '../missions';
import { buildRevisionFeedback } from '../skill-prelude/build-feedback';
import { promptCarriesProposalContract } from '../mission-deliverable';
import { MISSION_PROMPT_MAX_CHARS } from '../schemas/mission';
import { containsLinkerBundleMarker } from '../mission-quality/analyzers/linker-bundle-parser';

jest.mock('@/lib/firebase-admin', () => ({ db: {}, auth: {} }));

/** The exact shape the sweep cron dispatches for an orphan entity. */
const SWEEP_LINKER_PROMPT = 'Research and find relationships for: Phasecraft (company)';

const VALID_BUNDLE = {
  edges: [
    {
      sourceEntityName: 'Phasecraft',
      targetEntityName: 'Quantum Simulation',
      relationType: 'uses',
      evidence: 'Phasecraft builds algorithms for Quantum Simulation on near-term hardware.',
      confidence: 0.8,
      sourceUrl: 'https://phasecraft.io/research',
    },
  ],
};

function withBundle(bundle: unknown, prose = 'Linker findings. '): string {
  return `${prose}${'x'.repeat(200)}\n\n\`\`\`json\n${JSON.stringify(bundle)}\n\`\`\``;
}

function check(name: string, pass: boolean, critical = false): QualityCheck {
  return { name, pass, critical, detail: `${name} detail` };
}

// ---------------------------------------------------------------------------
// 1. DISPATCH
// ---------------------------------------------------------------------------

describe('dispatch binds the mission kind to the proposal deliverable', () => {
  it('drops the classifier report slot the sweep prompt never asked for', () => {
    // Before MISSION-011 this manifest made `missionPromisedReportDeliverable`
    // TRUE, so the mission was required to publish a report it was never asked
    // for — and failed as `no-deliverable` when it did not.
    const { mission } = buildMissionDocument(
      'user-1',
      { agent: 'linker', prompt: SWEEP_LINKER_PROMPT },
      {
        slots: [{ name: 'main', intent: 'relationship discovery report' }],
        classifierMetadata: {
          latencyMs: 12,
          costUsd: 0.0001,
          fallback: false,
          model: 'gemini-test',
        },
      }
    );

    expect(mission.slots).toEqual([]);
    expect(mission.prompt.startsWith(SWEEP_LINKER_PROMPT)).toBe(true);
    expect(promptCarriesProposalContract(mission.prompt)).toBe(true);
    expect(containsLinkerBundleMarker(mission.prompt)).toBe(true);
  });

  it('keeps an explicitly requested artifact slot and still requires the bundle', () => {
    const { mission } = buildMissionDocument(
      'user-1',
      { agent: 'linker', prompt: 'Map the supplier relationships and publish a report on them' },
      { slots: [{ name: 'supplier-map', intent: 'supplier report' }] }
    );

    expect(mission.slots).toEqual([{ name: 'supplier-map', intent: 'supplier report' }]);
    expect(promptCarriesProposalContract(mission.prompt)).toBe(true);
  });

  it('refuses rather than persisting a mission whose prompt+contract exceeds the cap', () => {
    // The cap was validated against the CALLER's prompt, so appending the
    // contract can carry a near-cap prompt over it. Storing an over-cap prompt
    // would produce a document that violates its own schema and is unreadable to
    // every later reader — strictly worse than a dispatch-time refusal.
    const nearCap = 'x'.repeat(MISSION_PROMPT_MAX_CHARS - 10);
    expect(() => buildMissionDocument('user-1', { agent: 'linker', prompt: nearCap }, { slots: [] })).toThrow(
      /over the \d+ limit\. Shorten the prompt by \d+ characters/
    );

    // A report agent at the same length is unaffected — nothing is appended.
    expect(() => buildMissionDocument('user-1', { agent: 'creator', prompt: nearCap }, { slots: [] })).not.toThrow();
  });

  it('leaves a report agent manifest and prompt untouched', () => {
    const prompt = 'Write a landscape report on agentic frameworks';
    const { mission } = buildMissionDocument(
      'user-1',
      { agent: 'creator', prompt },
      { slots: [{ name: 'main', intent: 'landscape report' }] }
    );

    expect(mission.prompt).toBe(prompt);
    expect(mission.slots).toEqual([{ name: 'main', intent: 'landscape report' }]);
  });
});

// ---------------------------------------------------------------------------
// 2. L1 GATE
// ---------------------------------------------------------------------------

describe('the L1 gate keys the bundle requirement on the mission kind', () => {
  it('runs the critical bundle checks on a bare sweep prompt with no marker', () => {
    // A bare prompt has no marker, so the mission kind must still activate the
    // proposal checks: `containsLinkerBundleMarker('Research and find relationships
    // for: X')` is false, so every critical linker check returned null.
    expect(containsLinkerBundleMarker(SWEEP_LINKER_PROMPT)).toBe(false);

    const report = evaluateMissionQuality({
      agent: 'linker',
      prompt: SWEEP_LINKER_PROMPT,
      result: `researched thoroughly ${'x'.repeat(300)}`,
    });

    const bundleCheck = report.checks.find((c) => c.name === 'linker-bundle-parseable');
    expect(bundleCheck).toBeDefined();
    expect(bundleCheck!.pass).toBe(false);
    expect(bundleCheck!.critical).toBe(true);
    expect(report.verdict).toBe('FAIL');
  });

  it('passes a linker mission that emitted a valid bundle', () => {
    const report = evaluateMissionQuality({
      agent: 'linker',
      prompt: SWEEP_LINKER_PROMPT,
      result: withBundle(VALID_BUNDLE),
    });

    expect(report.checks.find((c) => c.name === 'linker-bundle-parseable')!.pass).toBe(true);
    expect(report.checks.find((c) => c.name === 'linker-no-fabricated-evidence')!.pass).toBe(true);
    expect(report.checks.find((c) => c.name === 'linker-proposals-present')!.pass).toBe(true);
  });

  it('reports an honest empty bundle as a soft partial, not a critical failure', () => {
    const report = evaluateMissionQuality({
      agent: 'linker',
      prompt: SWEEP_LINKER_PROMPT,
      result: withBundle({ edges: [] }, 'No defensible edge found for this entity. '),
    });

    const bundleCheck = report.checks.find((c) => c.name === 'linker-bundle-parseable')!;
    const presence = report.checks.find((c) => c.name === 'linker-proposals-present')!;
    expect(bundleCheck.pass).toBe(true);
    expect(presence.pass).toBe(false);
    expect(presence.critical).toBe(false);
    expect(presence.detail).toMatch(/honest empty result/i);
    // Soft-only failure → REVISE, never FAIL. Forcing FAIL on "I found nothing"
    // is a direct incentive to invent an edge.
    expect(report.verdict).toBe('REVISE');
  });

  it('never charges a non-linker agent with a linker bundle failure', () => {
    // The old marker `/\bedges\b.*\bevidence\b/i` matched plausible creator
    // briefs, handing them a CRITICAL check they could not possibly satisfy.
    const report = evaluateMissionQuality({
      agent: 'creator',
      prompt: 'Diagram the graph edges and cite the evidence behind each one in the report',
      result: `<h1>Report</h1><p>${'x'.repeat(400)}</p>`,
    });

    expect(report.checks.find((c) => c.name === 'linker-bundle-parseable')).toBeUndefined();
    expect(report.checks.find((c) => c.name === 'linker-no-fabricated-evidence')).toBeUndefined();
    expect(report.checks.find((c) => c.name === 'linker-proposals-present')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. REVISION
// ---------------------------------------------------------------------------

describe('the revision brief asks for the deliverable the mission owes', () => {
  const failing = [check('linker-bundle-parseable', false, true)];

  it('asks a proposal mission to re-emit the bundle and forbids an artifact', () => {
    const feedback = buildRevisionFeedback({ failingChecks: failing, deliverableKind: 'proposal' });

    expect(feedback).toMatch(/fenced ```json block/);
    expect(feedback).toMatch(/sourceEntityName/);
    expect(feedback).toMatch(/Do NOT produce a report/i);
    // The exact re-injection the platform used to perform on its own.
    expect(feedback).not.toMatch(/revised report HTML/i);
  });

  it('still asks a report mission for revised report HTML', () => {
    const feedback = buildRevisionFeedback({ failingChecks: [check('creator-jtbd-presence', false)] });
    expect(feedback).toMatch(/revised report HTML/i);
  });

  it('defaults to the report brief when no deliverable kind is supplied', () => {
    const withDefault = buildRevisionFeedback({ failingChecks: [check('citations-present', false)] });
    const explicit = buildRevisionFeedback({
      failingChecks: [check('citations-present', false)],
      deliverableKind: 'report',
    });
    expect(withDefault).toBe(explicit);
  });
});

// ---------------------------------------------------------------------------
// 4. TERMINAL TRUTH
// ---------------------------------------------------------------------------

describe('terminal truth for a proposal-deliverable mission', () => {
  it('completes a zero-report Linker mission that emitted a valid bundle', () => {
    const outcome = resolveMissionOutcome({
      sdkSuccess: true,
      hadReportSlots: false,
      reports: [],
      qualityReport: {
        verdict: 'PASS',
        checks: [check('result-exists', true, true), check(PROPOSAL_DELIVERABLE_CHECK, true, true)],
      },
    });

    expect(outcome.kind).toBe('delivered');
    expect(outcome.status).toBe('completed');
    expect(outcome.progressMessage).toBe('Mission completed');
    expect(outcome.resultAppendix).toBe('');
  });

  it('fails loudly when the structured proposal deliverable never parsed', () => {
    const outcome = resolveMissionOutcome({
      sdkSuccess: true,
      hadReportSlots: false,
      reports: [],
      qualityReport: {
        verdict: 'FAIL',
        checks: [
          check('result-exists', true, true),
          {
            name: PROPOSAL_DELIVERABLE_CHECK,
            pass: false,
            critical: true,
            detail: 'no fenced ```json block in linker output',
          },
        ],
      },
    });

    expect(outcome.kind).toBe('no-deliverable');
    expect(outcome.status).toBe('failed');
    expect(outcome.progressMessage).toBe('Mission finished without its structured proposal deliverable');
    if (outcome.kind !== 'no-deliverable') throw new Error('narrowing failed');
    expect(outcome.error).toMatch(/no valid structured relation-proposal bundle/i);
    expect(outcome.error).toMatch(/no fenced ```json block/);
    expect(outcome.failingChecks.map((c) => c.name)).toEqual([PROPOSAL_DELIVERABLE_CHECK]);
  });

  it('an honest empty bundle completes rather than failing', () => {
    // Soft `linker-proposals-present` failure with no report → the mission
    // completes and the operator sees the soft finding. "Found nothing" is a
    // result, not a broken run.
    const outcome = resolveMissionOutcome({
      sdkSuccess: true,
      hadReportSlots: false,
      reports: [],
      qualityReport: {
        verdict: 'REVISE',
        checks: [check(PROPOSAL_DELIVERABLE_CHECK, true, true), check('linker-proposals-present', false)],
      },
    });

    expect(outcome.kind).toBe('delivered');
    expect(outcome.status).toBe('completed');
  });

  it('leaves report-mission outcomes unchanged', () => {
    const delivered = resolveMissionOutcome({
      sdkSuccess: true,
      hadReportSlots: true,
      reports: [{ id: 'report-9', title: 'Landscape' }],
      qualityReport: { verdict: 'PASS', checks: [check('result-exists', true, true)] },
    });
    expect(delivered.kind).toBe('delivered');
    expect(delivered.resultAppendix).toContain('/reports/report-9');

    const missing = resolveMissionOutcome({
      sdkSuccess: true,
      hadReportSlots: true,
      reports: [],
      qualityReport: { verdict: 'REVISE', checks: [check('result-exists', true, true)] },
    });
    expect(missing.kind).toBe('no-deliverable');
    expect(missing.progressMessage).toBe('Mission finished without publishing its report deliverable');
  });
});
