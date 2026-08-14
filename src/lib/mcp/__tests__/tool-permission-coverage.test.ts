/**
 * Tool permission coverage guard — closes the read-only-key escalation class.
 *
 * `getToolPermissions` falls through to the default `['read']` for any tool
 * NOT explicitly keyed in TOOL_PERMISSIONS (permissions.ts). When a *mutating*
 * tool is exposed in CORE_AI_TOOLS but unmapped, a `permissions: ['read']` MCP
 * API key passes the `tools/call` gate (server.ts: canExecuteTool) and can
 * mutate data or spend tokens. Mutating tools include updateEntity,
 * bulkResearchCompanies, expandSignal, dispatchTechnologyEvaluation,
 * refreshInterestFromActivity, discoverNetNewTechnologies, recommendArtifact).
 *
 * CLASS CLOSURE (this guard): every CORE_AI_TOOL must carry an EXPLICIT
 * TOOL_PERMISSIONS entry, so the read default never silently decides a security
 * outcome. The moment a new tool is added to CORE_AI_TOOLS without classifying
 * it, this test fails in CI and forces an explicit read/write decision.
 *
 * @jest-environment node
 */

// Break the Firebase init chain so importing the tool registry is safe.
jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));
jest.mock('@/lib/entity-factory', () => ({ createEntity: jest.fn() }));
jest.mock('firebase/firestore', () => ({
  getFirestore: jest.fn(),
  collection: jest.fn(),
  doc: jest.fn(),
  getDoc: jest.fn(),
  getDocs: jest.fn(),
  setDoc: jest.fn(),
  updateDoc: jest.fn(),
  deleteDoc: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
  limit: jest.fn(),
  Timestamp: { now: jest.fn(() => ({ toDate: () => new Date() })) },
}));
jest.mock('firebase/auth', () => ({ getAuth: jest.fn() }));

import { CORE_AI_TOOLS } from '@/lib/ai/tools';
import { TOOL_PERMISSIONS, canExecuteTool, getToolPermissions } from '../permissions';
import type { ApiKeyPermission } from '../types';

const READ_ONLY: ApiKeyPermission[] = ['read'];

/**
 * Tools confirmed to mutate data / spend tokens / write records. A read-only
 * key must NEVER reach these. (The original 6 from the adversarial pass plus
 * bulkResearchCompanies, which "creates multiple companies" yet was mapped read.)
 */
const KNOWN_MUTATING_TOOLS = [
  'updateEntity',
  'bulkResearchCompanies',
  'expandSignal',
  'dispatchTechnologyEvaluation',
  'dispatchBuildMission',
  // BUILD-005: approveAssessment approves a proposed Assessment and applies
  // its radar placement + TRL-if-unset — proposal/placement/technology writes.
  'approveAssessment',
  'refreshInterestFromActivity',
  'discoverNetNewTechnologies',
  'recommendArtifact',
  // B4: recordAgentObservation WRITES an :AgentObservation node (+ ABOUT
  // edge) into the graph — same ambient-substrate write class as the tools
  // above; a read-only key must never reach it.
  'recordAgentObservation',
  // AI-007: saveWorkingStylePreference WRITES a note to chatPreferences/{uid};
  // clearWorkingStylePreferences DELETES the stored notes. Both mutate user
  // state — a read-only key must never reach them.
  'saveWorkingStylePreference',
  'clearWorkingStylePreferences',
  // Second instance of the class: mapped, but mapped WRONG. researchCompany
  // was classified ['read'] while its executor writes the research back onto
  // the company document by default (saveToCompany !== false → adminUpdateCompany).
  'researchCompany',
];

/**
 * Same escalation class, but exposed on the DOMAIN MCP servers (graph-server →
 * CYPHER_TOOLS) rather than CORE_AI_TOOLS — so it is NOT covered by the SANITY
 * check below. executeCypher now uses a default-deny policy, EXPLAIN read
 * classification, and explicit resource caps; READ routing is not the
 * authorization boundary. It remains deliberately non-read so a read-only key
 * cannot receive the general caller-supplied query surface if those controls
 * regress.
 */
const DOMAIN_ONLY_MUTATING_TOOLS = ['executeCypher', 'draftDocument'];

describe('CORE_AI_TOOLS permission coverage (read-only-key escalation guard)', () => {
  it('CLASS GUARD: every CORE_AI_TOOL has an explicit TOOL_PERMISSIONS entry (no read-default reliance)', () => {
    const unmapped = CORE_AI_TOOLS.map((t) => t.name).filter((name) => !(name in TOOL_PERMISSIONS));
    // Any unmapped tool silently inherits ['read']. New tools MUST be classified.
    expect(unmapped).toEqual([]);
  });

  it.each(KNOWN_MUTATING_TOOLS)('REGRESSION: read-only key is denied the mutating tool "%s"', (toolName) => {
    // The exact check server.ts runs before executing a tool.
    expect(canExecuteTool(READ_ONLY, toolName)).toBe(false);
    // And it must not resolve to the read-only default.
    expect(getToolPermissions(toolName)).not.toEqual(['read']);
  });

  it('SANITY: the leaking tools are actually exposed on the MCP surface (CORE_AI_TOOLS)', () => {
    const exposed = new Set(CORE_AI_TOOLS.map((t) => t.name));
    for (const name of KNOWN_MUTATING_TOOLS) {
      expect(exposed.has(name)).toBe(true);
    }
  });

  it('permits a read-only key to call the now non-persisting comprehensive company research tool', () => {
    expect(getToolPermissions('researchCompanyComprehensive')).toEqual(['read']);
    expect(canExecuteTool(READ_ONLY, 'researchCompanyComprehensive')).toBe(true);
  });

  it.each(DOMAIN_ONLY_MUTATING_TOOLS)(
    'REGRESSION: read-only key is denied the domain-server mutating tool "%s"',
    (toolName) => {
      expect(canExecuteTool(READ_ONLY, toolName)).toBe(false);
      expect(getToolPermissions(toolName)).not.toEqual(['read']);
    }
  );
});
