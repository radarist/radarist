/**
 * SKILL-049 — the Linker profile must be able to PROPOSE a relation, and
 * nothing else may gain decision authority in the process.
 *
 * The 2026-08-01 derived reachability matrix found that `proposeVerifiedRelation`,
 * `listPendingProposedRelations` and `approveProposedRelation` are grouped as
 * `LINKER_TOOLS` but mount only on `impulse-reports` — a server ONLY the creator
 * profile carries. Six served skills instruct the agent to propose a relation for
 * review; the profile whose entire job is discovering relationships could not.
 *
 * Every assertion here is DERIVED from the live registries (`buildToolToServers`,
 * `buildProfileToServers`, `TOOL_PERMISSIONS`, `PAID_CHAT_TOOL_NAMES`, the real
 * SKILL.md files). There is no hand-maintained profile/tool matrix to fall out of
 * date: moving a tool between servers, adding a profile, or naming a new tool in
 * a skill re-derives all of it.
 */

jest.mock('@/lib/firebase', () => ({ db: {}, auth: {}, storage: {} }));
jest.mock('@/lib/firebase-admin', () => ({ db: {}, auth: {}, storage: {}, adminApp: {} }));

import fs from 'node:fs';
import path from 'node:path';

import {
  PLATFORM_SERVERS,
  SKILLS_DIR,
  buildProfileToServers,
  buildProfileToTools,
  buildToolToServers,
  profilesReaching,
} from '@/lib/__tests__/helpers/mcp-reachability-matrix';
import { PAID_CHAT_TOOL_NAMES } from '@/lib/ai/destructive-confirmation';
import { LINKER_TOOLS } from '@/lib/ai/tools/linker-tools';
import { getAccessibleTools, getToolPermissions } from '@/lib/mcp/permissions';

const TOOL_TO_SERVERS = buildToolToServers();
const PROFILE_TO_SERVERS = buildProfileToServers();
const PROFILE_TO_TOOLS = buildProfileToTools();

/** The review-preserving pair the six proposal-bearing skills actually need. */
const REVIEW_PRESERVING_TOOLS = ['proposeVerifiedRelation', 'listPendingProposedRelations'] as const;

/**
 * Triage DECISION tools. Derived, not listed by hand: a LINKER tool whose
 * permission class includes `signals` decides a proposal's fate (approve /
 * reject / dismiss / bulk-approve). Those must never become universal.
 */
const TRIAGE_DECISION_TOOLS = LINKER_TOOLS.map((tool) => tool.name).filter((name) =>
  getToolPermissions(name).includes('signals')
);

describe('SKILL-049 — Linker relation-proposal reachability', () => {
  it('derives a live matrix with every mission profile present', () => {
    expect(Object.keys(PROFILE_TO_SERVERS).sort()).toEqual([
      'creator',
      'curator',
      'defense-minister',
      'evaluator',
      'linker',
      'scout',
      'strategist',
    ]);
    expect(TOOL_TO_SERVERS.size).toBeGreaterThan(50);
    // Guard the derivation itself: `signals`-class LINKER tools must exist, or
    // the "no decision authority went universal" assertion below is vacuous.
    expect(TRIAGE_DECISION_TOOLS.length).toBeGreaterThanOrEqual(4);
  });

  it('lets the Linker profile list and propose pending relations', () => {
    for (const tool of REVIEW_PRESERVING_TOOLS) {
      expect({ tool, reachableBy: profilesReaching(tool, TOOL_TO_SERVERS) }).toEqual({
        tool,
        reachableBy: expect.arrayContaining(['linker']),
      });
    }
  });

  it('lets every profile that can run a proposal-bearing skill actually propose', () => {
    // Skills are mission-wide: any profile may invoke any served skill, so a
    // skill that instructs "propose it for review" is a dead instruction on any
    // profile that cannot reach the tool.
    const proposalSkills = fs
      .readdirSync(SKILLS_DIR)
      .sort()
      .filter((skill) => {
        const file = path.join(SKILLS_DIR, skill, 'SKILL.md');
        return fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('proposeVerifiedRelation');
      });

    expect(proposalSkills.length).toBeGreaterThanOrEqual(6);
    expect(profilesReaching('proposeVerifiedRelation', TOOL_TO_SERVERS).sort()).toEqual(
      Object.keys(PROFILE_TO_SERVERS).sort()
    );
  });

  it('keeps proposal approval where existing authorization permits it — creator-only, and machine-refused there too', () => {
    // `approveProposedRelation` materializes the edge a proposal was holding
    // back. `executeApproveProposedRelation` refuses every `principal !== 'human'`
    // caller before it even reads the proposal, and no MCP or mission surface can
    // set `principal: 'human'` — so existing authorization permits machine
    // approval NOWHERE. Mounting it on a universal server would publish a tool
    // that can only ever refuse. It stays exactly where it was.
    expect(profilesReaching('approveProposedRelation', TOOL_TO_SERVERS)).toEqual(['creator']);
  });

  it('lets no triage DECISION tool become universally reachable', () => {
    const universalDecisionTools = TRIAGE_DECISION_TOOLS.filter(
      (name) => profilesReaching(name, TOOL_TO_SERVERS).length > 1
    );
    expect(universalDecisionTools).toEqual([]);
  });

  it('does not substitute createRelationWithEvidence, which writes rather than proposes', () => {
    // MEASURED, not assumed: `createRelationWithEvidence` is in ASSERTIONS_TOOLS,
    // which `impulse-graph` mounts — so it was ALREADY reachable by every
    // profile before this row, and this row did not move it. That is precisely
    // why the skills must forbid substituting it: the writer is reachable, so
    // "propose it for review" is a discipline the prompt has to enforce, not
    // something the mount can enforce for it.
    expect(profilesReaching('createRelationWithEvidence', TOOL_TO_SERVERS).sort()).toEqual(
      Object.keys(PROFILE_TO_SERVERS).sort()
    );
    expect(TOOL_TO_SERVERS.get('createRelationWithEvidence')).toEqual(
      expect.arrayContaining(['impulse-graph', 'impulse-reports'])
    );
    for (const skill of fs.readdirSync(SKILLS_DIR).sort()) {
      const file = path.join(SKILLS_DIR, skill, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const body = fs.readFileSync(file, 'utf8');
      if (!body.includes('proposeVerifiedRelation')) continue;
      // Where a proposal skill mentions the writer at all, it must forbid it.
      // Markdown emphasis is stripped first: "Do **not** substitute" is the same
      // prohibition as "do not substitute" and must not read as absent.
      const plain = body.replace(/[*_`]/g, '');
      if (body.includes('createRelationWithEvidence')) {
        expect({ skill, forbids: /(never|do not|don't)[^.]{0,120}createRelationWithEvidence/i.test(plain) }).toEqual({
          skill,
          forbids: true,
        });
      }
    }
  });

  it('gives no profile a paid or orchestration tool it did not already carry', () => {
    // Spend/confirmation boundary: the paid chat tools mount on `impulse-reports`
    // (+ mission tools), which only `creator` carries. Any profile picking one up
    // would be a spend-boundary regression, not a reachability fix.
    for (const [profile, tools] of Object.entries(PROFILE_TO_TOOLS)) {
      const paid = PAID_CHAT_TOOL_NAMES.filter((name) => tools.has(name));
      expect({ profile, paid }).toEqual({ profile, paid: profile === 'creator' ? [...PAID_CHAT_TOOL_NAMES] : [] });
    }
  });

  it('keeps the external MCP permission boundary intact for the newly mounted pair', () => {
    // The entities server is also reachable at `/api/mcp/entities` by API-key
    // holders. A READ-only key must gain the read and NOT the write; the gate is
    // the same `TOOL_PERMISSIONS` map, so this proves the new mount did not
    // arrive unclassified (which would fail closed to `admin`, not open).
    const entitiesTools = PLATFORM_SERVERS['impulse-entities']()
      .getTools()
      .map((t) => t.name);
    const readOnly = getAccessibleTools(['read'], entitiesTools);
    expect(readOnly).toContain('listPendingProposedRelations');
    expect(readOnly).not.toContain('proposeVerifiedRelation');
    expect(getAccessibleTools(['read', 'write'], entitiesTools)).toContain('proposeVerifiedRelation');
    // Neither tool fell through to the fail-closed `admin` default.
    for (const tool of REVIEW_PRESERVING_TOOLS) {
      expect(getToolPermissions(tool)).not.toContain('admin');
    }
  });

  it('mounts impulse-reports on the creator profile only', () => {
    const reportProfiles = Object.entries(PROFILE_TO_SERVERS)
      .filter(([, servers]) => servers.includes('impulse-reports'))
      .map(([profile]) => profile);
    expect(reportProfiles).toEqual(['creator']);
  });

  it('adds exactly the two review-preserving tools to the universal entities server', () => {
    // The delta is derived by asking the universal server which LINKER tools it
    // mounts, and comparing against the relation writers it ALREADY mounted.
    // `createRelation` predates this row; the two new names are the review path.
    const entitiesTools = new Set(
      PLATFORM_SERVERS['impulse-entities']()
        .getTools()
        .map((t) => t.name)
    );
    const linkerToolsOnEntities = LINKER_TOOLS.map((t) => t.name)
      .filter((name) => entitiesTools.has(name))
      .sort();
    expect(linkerToolsOnEntities).toEqual([
      'createRelation',
      'listPendingProposedRelations',
      'proposeVerifiedRelation',
    ]);
  });

  it('reaches no state a mission profile could not already reach — the proposal path is strictly weaker', () => {
    // The honest form of "no authority widened". Every mission profile ALREADY
    // holds ungated, direct relation-creation writes on the same universal
    // server (`bulkCreateRelations` / `createRelationsByName` /
    // `findAndLinkRelatedEntities` take no principal and write the real edge).
    // `proposeVerifiedRelation` can only reach a PENDING proposal, which still
    // needs a separate human decision — a strictly weaker terminal state.
    const alreadyUngatedRelationWriters = [
      'bulkCreateRelations',
      'createRelationsByName',
      'findAndLinkRelatedEntities',
    ];
    for (const writer of alreadyUngatedRelationWriters) {
      expect({ writer, reachableBy: profilesReaching(writer, TOOL_TO_SERVERS).sort() }).toEqual({
        writer,
        reachableBy: Object.keys(PROFILE_TO_SERVERS).sort(),
      });
      expect(getToolPermissions(writer)).toEqual(['write']);
    }
    expect(getToolPermissions('proposeVerifiedRelation')).toEqual(['write']);
    expect(getToolPermissions('listPendingProposedRelations')).toEqual(['read']);
  });
});
