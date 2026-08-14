/**
 * @jest-environment node
 */
import { getDiscoveryConfig } from '../discovery-config';

const ENV_KEYS = [
  'DISCOVERY_SWEEP_ENABLED',
  'DISCOVERY_FEEDBACK_ENABLED',
  'DISCOVERY_DERIVE_INTEREST',
  'DISCOVERY_NETNEW_ENABLED',
  'DISCOVERY_MAX_NETNEW_PER_CYCLE',
  'DISCOVERY_NETNEW_DIMENSIONS',
  'DISCOVERY_VERTICAL',
  'DISCOVERY_MAX_DISPATCH_PER_CYCLE',
  'DISCOVERY_PENDING_PROPOSALS_CAP',
  'DISCOVERY_SCOUT_DEBOUNCE_MS',
  'DISCOVERY_MAX_SOURCE_SHARE',
  'DISCOVERY_MAX_ENTITY_TYPE_SHARE',
  'DISCOVERY_MMR_LAMBDA',
  'DISCOVERY_DEDUP_SIMILARITY_THRESHOLD',
  'DISCOVERY_EXPLORATION_RATE',
  'DISCOVERY_TWO_HOP_CONFIDENCE_FLOOR',
  'DISCOVERY_RADAR_ID',
  'DISCOVERY_MAX_USECASE_DISPATCH_PER_CYCLE',
  'ASSERTER_RELIABILITY_ENABLED',
];

describe('discovery-config', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('returns conservative defaults — sweep AND feedback OFF (BIAS-FIX-1)', () => {
    const c = getDiscoveryConfig();
    expect(c.enabled).toBe(false);
    expect(c.feedbackEnabled).toBe(false);
    expect(c.deriveInterestEnabled).toBe(false);
    expect(c.netNewEnabled).toBe(false);
    expect(c.maxNetNewPerCycle).toBe(3);
    expect(c.netNewDimensions).toEqual(['technology', 'useCase', 'painPoint', 'company']);
    expect(c.vertical).toBe('ai-ml-infra');
    expect(c.maxDispatchPerCycle).toBe(2);
    expect(c.maxUseCaseDispatchPerCycle).toBe(1);
    expect(c.pendingProposalsCap).toBe(30);
    expect(c.scoutDebounceMs).toBe(4 * 60 * 60 * 1000);
    expect(c.maxSourceShare).toBe(0.4);
    expect(c.maxEntityTypeShare).toBe(0.4);
    expect(c.mmrLambda).toBe(0.7);
    expect(c.dedupSimilarityThreshold).toBe(0.85);
    expect(c.explorationRate).toBe(0.15);
    expect(c.twoHopConfidenceFloor).toBe(0.6);
    expect(c.radarId).toBe('');
    expect(c.asserterReliabilityEnabled).toBe(false);
  });

  it('reads ASSERTER_RELIABILITY_ENABLED from the truthy-token set', () => {
    process.env.ASSERTER_RELIABILITY_ENABLED = 'true';
    expect(getDiscoveryConfig().asserterReliabilityEnabled).toBe(true);
    process.env.ASSERTER_RELIABILITY_ENABLED = 'false';
    expect(getDiscoveryConfig().asserterReliabilityEnabled).toBe(false);
  });

  it('reads the discovery radar from DISCOVERY_RADAR_ID', () => {
    process.env.DISCOVERY_RADAR_ID = 'agentic-ai-radar-1782234764199';
    expect(getDiscoveryConfig().radarId).toBe('agentic-ai-radar-1782234764199');
  });

  it('parses booleans from the truthy-token set (1/true/yes/on)', () => {
    process.env.DISCOVERY_SWEEP_ENABLED = 'true';
    process.env.DISCOVERY_FEEDBACK_ENABLED = 'on';
    expect(getDiscoveryConfig().enabled).toBe(true);
    expect(getDiscoveryConfig().feedbackEnabled).toBe(true);

    process.env.DISCOVERY_SWEEP_ENABLED = 'false';
    process.env.DISCOVERY_FEEDBACK_ENABLED = '0';
    expect(getDiscoveryConfig().enabled).toBe(false);
    expect(getDiscoveryConfig().feedbackEnabled).toBe(false);
  });

  it('overrides strings/ints from env', () => {
    process.env.DISCOVERY_MAX_DISPATCH_PER_CYCLE = '5';
    process.env.DISCOVERY_VERTICAL = 'fintech';
    const c = getDiscoveryConfig();
    expect(c.maxDispatchPerCycle).toBe(5);
    expect(c.vertical).toBe('fintech');
  });

  it('guards non-positive / non-numeric ints back to the default', () => {
    process.env.DISCOVERY_MAX_DISPATCH_PER_CYCLE = '0';
    expect(getDiscoveryConfig().maxDispatchPerCycle).toBe(2);
    process.env.DISCOVERY_MAX_DISPATCH_PER_CYCLE = 'abc';
    expect(getDiscoveryConfig().maxDispatchPerCycle).toBe(2);
  });

  it('clamps floats into [0,1]', () => {
    process.env.DISCOVERY_EXPLORATION_RATE = '2';
    expect(getDiscoveryConfig().explorationRate).toBe(1);
    process.env.DISCOVERY_MMR_LAMBDA = '-1';
    expect(getDiscoveryConfig().mmrLambda).toBe(0);
    process.env.DISCOVERY_DEDUP_SIMILARITY_THRESHOLD = '0.5';
    expect(getDiscoveryConfig().dedupSimilarityThreshold).toBe(0.5);
  });
});
