/**
 * @file scripts/demo-narrative/types.ts
 * @description SKILL-002 — shared shapes for the demo-narrative contract.
 *
 * The dataset is a deliberately narrow, structural view of the seed (ids +
 * human-visible labels + the link fields the decision chain needs), so the
 * evaluator stays pure and importable without pulling in the full seed module.
 */

export type NarrativeEntityKind = 'radar' | 'technology' | 'company' | 'signal' | 'strategy' | 'report' | 'agentRun';

export interface DemoRadarLike {
  id: string;
  name: string;
  quadrants: Array<{ id: string; name: string }>;
}
export interface DemoTechnologyLike {
  id: string;
  name: string;
  description?: string;
}
export interface DemoCompanyLike {
  id: string;
  name: string;
  description?: string;
}
export interface DemoSignalLike {
  id: string;
  title: string;
  description?: string;
}
export interface DemoStrategyLike {
  id: string;
  name: string;
}
export interface DemoRelationLike {
  id: string;
  sourceId: string;
  targetId: string;
  relationType: string;
}
export interface DemoRadarPlacementLike {
  technologyId: string;
  radarId: string;
}
export interface DemoReportLike {
  id: string;
  title: string;
  missionId?: string;
  entityIds: string[];
  description?: string;
}
export interface DemoAgentRunLike {
  id: string;
  missionId?: string;
  action: string;
}

/**
 * How each decision-chain hop links to the previous node. Every value resolves
 * against real seed foreign keys — no thematic hand-waving:
 * - `root`        — the first node; nothing to resolve.
 * - `relation`    — a Relation with sourceId=prev, targetId=this exists.
 * - `placement`   — a RadarPlacement with technologyId=prev, radarId=this exists.
 * - `report-covers-radar-tech` — the report's entityIds include ≥1 technology
 *   placed on the previous radar node (the report demonstrably covers the radar).
 * - `mission`     — this node shares the previous node's missionId.
 */
export type DecisionHopVia = 'root' | 'relation' | 'placement' | 'report-covers-radar-tech' | 'mission';

export interface DecisionChainNode {
  kind: NarrativeEntityKind;
  id: string;
  label: string;
  via: DecisionHopVia;
}

export interface DemoNarrativeManifest {
  hero: { kind: NarrativeEntityKind; id: string; label: string };
  canonicalScreenshotRoute: string;
  decisionChain: DecisionChainNode[];
}

export interface DemoNarrativeDataset {
  radar: DemoRadarLike;
  technologies: DemoTechnologyLike[];
  companies: DemoCompanyLike[];
  signals: DemoSignalLike[];
  strategies: DemoStrategyLike[];
  relations: DemoRelationLike[];
  radarPlacements: DemoRadarPlacementLike[];
  reports: DemoReportLike[];
  agentRuns: DemoAgentRunLike[];
  manifest: DemoNarrativeManifest;
}

export type CheckKind = 'hard' | 'scored';
export type CheckStatus = 'pass' | 'fail';

export interface CheckResult {
  /** Stable rule id, e.g. `hero-present`, `no-banned-tokens`, `narrative-linkage`. */
  id: string;
  kind: CheckKind;
  status: CheckStatus;
  /** 0..1 for scored dimensions; omitted for hard rules. */
  score?: number;
  /** Contribution weight for scored dimensions (points out of 100). */
  weight?: number;
  detail: string;
  /** Concrete offenders (banned-token hits, dangling ids, generic labels). */
  offenders?: string[];
}

export interface DemoNarrativeReceipt {
  contractVersion: string;
  /** All hard rules pass AND score ≥ threshold. */
  passed: boolean;
  /** 0..100 weighted score. Deterministic — no timestamps in the core receipt. */
  score: number;
  threshold: number;
  hardRulesPassed: boolean;
  checks: CheckResult[];
  hero: { id: string; label: string; linkedEntityCount: number };
  canonicalScreenshotRoute: string;
}
