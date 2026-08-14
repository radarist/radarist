/**
 * @file scripts/demo-narrative/evaluate.ts
 * @description SKILL-002 — pure evaluator that scores a demo dataset against the
 * demo-narrative contract and returns a structured quality receipt.
 *
 * Pure and deterministic: same dataset in → byte-identical receipt out (no
 * timestamps, no randomness). It imports the contract data only, never the seed,
 * so it is cheap to unit-test with hand-built datasets and the anti-fixture.
 */

import { DEMO_NARRATIVE_CONTRACT, type DemoNarrativeContract } from './contract';
import type { CheckResult, DecisionChainNode, DemoNarrativeDataset, DemoNarrativeReceipt } from './types';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every human-visible primary label (names/titles) with its owner id. */
function primaryLabels(dataset: DemoNarrativeDataset): Array<{ ownerId: string; text: string }> {
  return [
    { ownerId: dataset.radar.id, text: dataset.radar.name },
    ...dataset.technologies.map((t) => ({ ownerId: t.id, text: t.name })),
    ...dataset.companies.map((c) => ({ ownerId: c.id, text: c.name })),
    ...dataset.signals.map((s) => ({ ownerId: s.id, text: s.title })),
    ...dataset.strategies.map((s) => ({ ownerId: s.id, text: s.name })),
    ...dataset.reports.map((r) => ({ ownerId: r.id, text: r.title })),
  ];
}

/** Every description-bearing entity (whether or not it actually has one). */
function describedEntities(dataset: DemoNarrativeDataset): Array<{ ownerId: string; description?: string }> {
  return [
    ...dataset.technologies.map((t) => ({ ownerId: t.id, description: t.description })),
    ...dataset.companies.map((c) => ({ ownerId: c.id, description: c.description })),
    ...dataset.signals.map((s) => ({ ownerId: s.id, description: s.description })),
    ...dataset.reports.map((r) => ({ ownerId: r.id, description: r.description })),
  ];
}

/** All free-text the banned-token scan should cover: labels + descriptions + run actions. */
function allNarrativeText(dataset: DemoNarrativeDataset): Array<{ ownerId: string; text: string }> {
  const texts: Array<{ ownerId: string; text: string }> = [
    ...primaryLabels(dataset),
    ...dataset.radar.quadrants.map((q) => ({ ownerId: dataset.radar.id, text: q.name })),
    ...dataset.agentRuns.map((r) => ({ ownerId: r.id, text: r.action })),
  ];
  for (const owner of describedEntities(dataset)) {
    if (owner.description) texts.push({ ownerId: owner.ownerId, text: owner.description });
  }
  return texts;
}

/** Match each banned token. Word-boundary tokens match only as whole words. */
function scanBannedTokens(text: string, contract: DemoNarrativeContract): string[] {
  const scan = text.toLowerCase();
  const hits: string[] = [];
  for (const banned of contract.bannedTokens) {
    const escaped = escapeRegExp(banned.token.toLowerCase());
    const pattern = banned.boundary ? `\\b${escaped}\\b` : escaped;
    if (new RegExp(pattern, 'i').test(scan)) hits.push(banned.id);
  }
  return hits;
}

/** Distinctive = long enough AND (multi-word OR carries an uppercase letter/digit). */
function isDistinctiveLabel(label: string, minChars: number): boolean {
  const trimmed = label.trim();
  if (trimmed.length < minChars) return false;
  const multiWord = trimmed.split(/\s+/).filter(Boolean).length >= 2;
  return multiWord || /[A-Z0-9]/.test(trimmed);
}

/**
 * Distinct EXISTING technologies placed on a radar. A placement whose
 * technologyId does not resolve to a real technology (a renamed/deleted/typo id)
 * is a dangling reference that renders as a broken blip, so it must not inflate
 * the hero's linked-entity count — the exact drift this contract exists to catch.
 */
function placedTechnologyIds(dataset: DemoNarrativeDataset, radarId: string): string[] {
  const realTechIds = new Set(dataset.technologies.map((t) => t.id));
  const placed = dataset.radarPlacements
    .filter((p) => p.radarId === radarId && realTechIds.has(p.technologyId))
    .map((p) => p.technologyId);
  return Array.from(new Set(placed));
}

/** Technologies placed on the hero radar — the hero's linked-entity anchor set. */
function heroLinkedTechnologyIds(dataset: DemoNarrativeDataset): string[] {
  return placedTechnologyIds(dataset, dataset.manifest.hero.id);
}

/** Does one decision-chain hop resolve against real seed foreign keys? */
function resolveHop(
  previous: DecisionChainNode | undefined,
  node: DecisionChainNode,
  dataset: DemoNarrativeDataset
): boolean {
  if (node.via === 'root' || !previous) return true;
  switch (node.via) {
    case 'relation':
      return dataset.relations.some((r) => r.sourceId === previous.id && r.targetId === node.id);
    case 'placement':
      return dataset.radarPlacements.some((p) => p.technologyId === previous.id && p.radarId === node.id);
    case 'report-covers-radar-tech': {
      // `node` is a report; `previous` is the radar. The report must cover ≥1
      // EXISTING technology actually placed on that radar.
      const report = dataset.reports.find((r) => r.id === node.id);
      if (!report) return false;
      const placedOnRadar = new Set(placedTechnologyIds(dataset, previous.id));
      return report.entityIds.some((entityId) => placedOnRadar.has(entityId));
    }
    case 'mission': {
      const report = dataset.reports.find((r) => r.id === previous.id);
      const run = dataset.agentRuns.find((a) => a.id === node.id);
      return Boolean(report?.missionId && run?.missionId && report.missionId === run.missionId);
    }
    default:
      return false;
  }
}

/** Does a chain node's id exist in the collection its `kind` names? */
function nodeExists(node: DecisionChainNode, dataset: DemoNarrativeDataset): boolean {
  switch (node.kind) {
    case 'radar':
      return dataset.radar.id === node.id;
    case 'technology':
      return dataset.technologies.some((t) => t.id === node.id);
    case 'company':
      return dataset.companies.some((c) => c.id === node.id);
    case 'signal':
      return dataset.signals.some((s) => s.id === node.id);
    case 'strategy':
      return dataset.strategies.some((s) => s.id === node.id);
    case 'report':
      return dataset.reports.some((r) => r.id === node.id);
    case 'agentRun':
      return dataset.agentRuns.some((a) => a.id === node.id);
    default:
      return false;
  }
}

/**
 * Evaluate a demo dataset against the contract and produce a quality receipt.
 * `passed` requires every hard rule to pass AND the weighted score ≥ threshold.
 */
export function evaluateDemoNarrative(
  dataset: DemoNarrativeDataset,
  contract: DemoNarrativeContract = DEMO_NARRATIVE_CONTRACT
): DemoNarrativeReceipt {
  const checks: CheckResult[] = [];
  const { weights, realism, coverageFloor } = contract;

  // ── Hard rule: hero present & rich ──────────────────────────────────────────
  const heroTechIds = heroLinkedTechnologyIds(dataset);
  const heroIsRadar = dataset.radar.id === dataset.manifest.hero.id;
  const heroRichEnough = heroIsRadar && heroTechIds.length >= contract.heroMinLinkedEntities;
  checks.push({
    id: 'hero-present',
    kind: 'hard',
    status: heroRichEnough ? 'pass' : 'fail',
    detail: heroIsRadar
      ? `Hero radar "${dataset.manifest.hero.label}" anchors ${heroTechIds.length}/${contract.heroMinLinkedEntities} placed technologies.`
      : `Declared hero id "${dataset.manifest.hero.id}" is not the seeded radar.`,
  });

  // ── Hard rule: canonical screenshot route declared & well-formed ─────────────
  const route = dataset.manifest.canonicalScreenshotRoute;
  const routeOk = typeof route === 'string' && route.startsWith('/') && route.length > 1;
  checks.push({
    id: 'canonical-route',
    kind: 'hard',
    status: routeOk ? 'pass' : 'fail',
    detail: routeOk
      ? `Canonical screenshot route: ${route}`
      : `Missing or malformed canonical screenshot route: ${String(route)}`,
  });

  // ── Hard rule: linked decision chain complete ────────────────────────────────
  const chain = dataset.manifest.decisionChain;
  const danglingIds: string[] = [];
  const brokenHops: string[] = [];
  chain.forEach((node, index) => {
    if (!nodeExists(node, dataset)) danglingIds.push(`${node.kind}:${node.id}`);
    if (!resolveHop(chain[index - 1], node, dataset)) {
      brokenHops.push(`${chain[index - 1]?.id ?? 'root'}→${node.id}`);
    }
  });
  const chainComplete = chain.length >= 2 && danglingIds.length === 0 && brokenHops.length === 0;
  const resolvedHops = chain.filter((node, index) => resolveHop(chain[index - 1], node, dataset)).length;
  checks.push({
    id: 'chain-complete',
    kind: 'hard',
    status: chainComplete ? 'pass' : 'fail',
    detail: chainComplete
      ? `All ${chain.length} decision-chain nodes exist and every hop resolves.`
      : `Decision chain incomplete (${resolvedHops}/${chain.length} hops resolve).`,
    offenders: [...danglingIds, ...brokenHops],
  });

  // ── Hard rule: no banned generic tokens ──────────────────────────────────────
  const bannedOffenders: string[] = [];
  for (const { ownerId, text } of allNarrativeText(dataset)) {
    for (const hit of scanBannedTokens(text, contract)) {
      bannedOffenders.push(`${ownerId}:${hit}`);
    }
  }
  checks.push({
    id: 'no-banned-tokens',
    kind: 'hard',
    status: bannedOffenders.length === 0 ? 'pass' : 'fail',
    detail:
      bannedOffenders.length === 0
        ? 'No generic fixture tokens found.'
        : `${bannedOffenders.length} generic-token hit(s).`,
    offenders: bannedOffenders,
  });

  // ── Hard rule: coverage floor ────────────────────────────────────────────────
  const coverage: Record<string, [number, number]> = {
    technologies: [dataset.technologies.length, coverageFloor.technologies],
    companies: [dataset.companies.length, coverageFloor.companies],
    signals: [dataset.signals.length, coverageFloor.signals],
    reports: [dataset.reports.length, coverageFloor.reports],
    agentRuns: [dataset.agentRuns.length, coverageFloor.agentRuns],
    radarQuadrants: [dataset.radar.quadrants.length, coverageFloor.radarQuadrants],
  };
  const coverageShortfalls = Object.entries(coverage)
    .filter(([, [actual, floor]]) => actual < floor)
    .map(([name, [actual, floor]]) => `${name}:${actual}<${floor}`);
  checks.push({
    id: 'coverage-floor',
    kind: 'hard',
    status: coverageShortfalls.length === 0 ? 'pass' : 'fail',
    detail:
      coverageShortfalls.length === 0
        ? 'All entity types meet the coverage floor.'
        : `Below floor: ${coverageShortfalls.join(', ')}`,
    offenders: coverageShortfalls,
  });

  // ── Scored: hero richness ────────────────────────────────────────────────────
  const heroScore = Math.min(1, heroTechIds.length / contract.heroMinLinkedEntities);
  checks.push({
    id: 'hero-richness',
    kind: 'scored',
    status: heroScore > 0 ? 'pass' : 'fail',
    score: heroScore,
    weight: weights.heroRichness,
    detail: `${heroTechIds.length} technologies linked to the hero radar.`,
  });

  // ── Scored: label realism ────────────────────────────────────────────────────
  const labels = primaryLabels(dataset);
  const distinctive = labels.filter((l) => isDistinctiveLabel(l.text, realism.minLabelChars));
  const labelScore = labels.length === 0 ? 0 : distinctive.length / labels.length;
  checks.push({
    id: 'label-realism',
    kind: 'scored',
    status: labelScore > 0 ? 'pass' : 'fail',
    score: labelScore,
    weight: weights.labelRealism,
    detail: `${distinctive.length}/${labels.length} primary labels are distinctive.`,
    offenders: labels
      .filter((l) => !isDistinctiveLabel(l.text, realism.minLabelChars))
      .map((l) => `${l.ownerId}:"${l.text}"`),
  });

  // ── Scored: description depth ────────────────────────────────────────────────
  const described = describedEntities(dataset);
  const deep = described.filter((d) => (d.description ?? '').trim().length >= realism.minDescriptionChars);
  const descriptionScore = described.length === 0 ? 0 : deep.length / described.length;
  checks.push({
    id: 'description-depth',
    kind: 'scored',
    status: descriptionScore > 0 ? 'pass' : 'fail',
    score: descriptionScore,
    weight: weights.descriptionDepth,
    detail: `${deep.length}/${described.length} entities carry a real description.`,
  });

  // ── Scored: narrative linkage ────────────────────────────────────────────────
  const linkageScore = chain.length === 0 ? 0 : resolvedHops / chain.length;
  checks.push({
    id: 'narrative-linkage',
    kind: 'scored',
    status: linkageScore > 0 ? 'pass' : 'fail',
    score: linkageScore,
    weight: weights.narrativeLinkage,
    detail: `${resolvedHops}/${chain.length} decision-chain hops resolve.`,
  });

  // ── Scored: anti-generic cleanliness ─────────────────────────────────────────
  const antiGenericScore = bannedOffenders.length === 0 ? 1 : 0;
  checks.push({
    id: 'anti-generic',
    kind: 'scored',
    status: antiGenericScore > 0 ? 'pass' : 'fail',
    score: antiGenericScore,
    weight: weights.antiGeneric,
    detail:
      bannedOffenders.length === 0
        ? 'Clean of generic tokens.'
        : `${bannedOffenders.length} generic hit(s) zero this dimension.`,
  });

  // Floor (not round) so the reported score never overstates the true weighted
  // sum and the pass gate is exactly `scoreThreshold`, not `threshold − 0.5`: a
  // raw 84.6 must read as 84 and FAIL 85, not round up to 85 and pass.
  const rawScore = checks
    .filter((c) => c.kind === 'scored')
    .reduce((total, c) => total + (c.score ?? 0) * (c.weight ?? 0), 0);
  const score = Math.floor(rawScore);
  const hardRulesPassed = checks.filter((c) => c.kind === 'hard').every((c) => c.status === 'pass');
  const passed = hardRulesPassed && score >= contract.scoreThreshold;

  return {
    contractVersion: contract.version,
    passed,
    score,
    threshold: contract.scoreThreshold,
    hardRulesPassed,
    checks,
    hero: {
      id: dataset.manifest.hero.id,
      label: dataset.manifest.hero.label,
      linkedEntityCount: heroTechIds.length,
    },
    canonicalScreenshotRoute: route,
  };
}
