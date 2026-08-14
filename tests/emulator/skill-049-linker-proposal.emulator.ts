/**
 * SKILL-049 — the Linker profile's relation-proposal journey, against a REAL
 * Firestore emulator and the REAL `impulse-entities` MCP server the profile
 * mounts.
 *
 * Before this row, `proposeVerifiedRelation` / `listPendingProposedRelations`
 * mounted only on `impulse-reports`, which only the creator profile carries — so
 * the profile whose whole job is discovering relationships could not propose one,
 * and six served skills instructed it to.
 *
 * The safety half is the point of the fix, not a footnote: the proposal must stay
 * PENDING, no `relations` document may appear, an agent must not be able to
 * approve its own proposal, and the triage DECISION tools must not have followed
 * the pair onto the universal server.
 *
 * Runs via `npm run test:emulator`, or standalone through
 * `firebase emulators:exec --only firestore,auth`.
 *
 * @jest-environment node
 */

import { db as adminDb } from '@/lib/firebase-admin';
import { executeApproveProposedRelation } from '@/lib/ai/tools/linker-tools';
import { getProposedRelationById } from '@/lib/proposed-relations-admin';
import { createEntitiesServer } from '@/lib/mcp/servers/entities-server';
import { PAID_CHAT_TOOL_NAMES } from '@/lib/ai/destructive-confirmation';
import { getToolPermissions } from '@/lib/mcp/permissions';

const LINKER_AGENT_USER = 'agent:linker-emu';
const OTHER_OWNER = 'bob-skill049-emu';

const SOURCE = { id: 'co-skill049-acme', type: 'company', name: 'Acme Robotics' } as const;
const TARGET = { id: 'tech-skill049-slam', type: 'technology', name: 'Visual SLAM' } as const;

/** The exact tool surface the linker profile reaches through this server. */
const entitiesServer = createEntitiesServer();
const entitiesToolNames = entitiesServer.getTools().map((tool) => tool.name);

/** Unwrap the MCP text envelope every domain server returns. */
function readMcpJson(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }) {
  const text = result.content.find((block) => block.type === 'text')?.text ?? '{}';
  return JSON.parse(text) as { success: boolean; data?: Record<string, unknown>; error?: string };
}

async function seedEntities(): Promise<void> {
  await adminDb
    .collection('companies')
    .doc(SOURCE.id)
    .set({ id: SOURCE.id, name: SOURCE.name, description: 'Robotics integrator.', createdAt: 1, updatedAt: 1 });
  await adminDb
    .collection('technologies')
    .doc(TARGET.id)
    .set({
      id: TARGET.id,
      name: TARGET.name,
      description: 'Visual simultaneous localization and mapping.',
      createdAt: 1,
      updatedAt: 1,
    });
}

async function clearAll(): Promise<void> {
  const proposals = await adminDb.collection('proposedRelations').get();
  await Promise.all(proposals.docs.map((doc) => doc.ref.delete()));
  const relations = await adminDb.collection('relations').get();
  await Promise.all(relations.docs.map((doc) => doc.ref.delete()));
  await adminDb
    .collection('companies')
    .doc(SOURCE.id)
    .delete()
    .catch(() => undefined);
  await adminDb
    .collection('technologies')
    .doc(TARGET.id)
    .delete()
    .catch(() => undefined);
}

async function proposeThroughLinkerSurface(overrides: Record<string, unknown> = {}) {
  return readMcpJson(
    await entitiesServer.callTool(
      'proposeVerifiedRelation',
      {
        sourceId: SOURCE.id,
        sourceType: SOURCE.type,
        targetId: TARGET.id,
        targetType: TARGET.type,
        relationType: 'uses',
        confidence: 82,
        evidence: 'Acme Robotics product page states its navigation stack is built on visual SLAM.',
        ...overrides,
      },
      { userId: LINKER_AGENT_USER }
    )
  );
}

beforeEach(async () => {
  await clearAll();
  await seedEntities();
});

afterAll(async () => {
  await clearAll();
  await adminDb.terminate();
});

describe('SKILL-049 — Linker proposal journey (live Firestore)', () => {
  it('mounts the review-preserving pair, and nothing that decides or spends', () => {
    expect(entitiesToolNames).toEqual(
      expect.arrayContaining(['proposeVerifiedRelation', 'listPendingProposedRelations'])
    );
    // Triage DECISION tools (permission class `signals`) must not be here.
    const decisionTools = entitiesToolNames.filter((name) => getToolPermissions(name).includes('signals'));
    expect(decisionTools).toEqual([]);
    // Spend/confirmation boundary unchanged: no paid orchestration tool followed.
    expect(entitiesToolNames.filter((name) => (PAID_CHAT_TOOL_NAMES as readonly string[]).includes(name))).toEqual([]);
  });

  it('creates a proposal that stays PENDING, with no relation and no assertion written', async () => {
    const created = await proposeThroughLinkerSurface();
    expect(created.success).toBe(true);

    const proposalId = (created.data as { proposalId: string }).proposalId;
    expect(proposalId).toBeTruthy();

    const stored = await getProposedRelationById(proposalId);
    expect(stored?.status).toBe('pending');
    expect(stored?.relationType).toBe('uses');
    expect(stored?.confidence).toBe(82);

    // The whole point of proposing rather than writing: no relation exists yet,
    // so no Inngest sync and no `:Assertion` can have been triggered either.
    const relations = await adminDb.collection('relations').get();
    expect(relations.size).toBe(0);
  });

  it('lists its own pending proposal back through the same profile surface', async () => {
    const created = await proposeThroughLinkerSurface();
    const proposalId = (created.data as { proposalId: string }).proposalId;

    const listed = readMcpJson(
      await entitiesServer.callTool(
        'listPendingProposedRelations',
        { status: 'pending' },
        { userId: LINKER_AGENT_USER }
      )
    );
    expect(listed.success).toBe(true);
    const proposals = (listed.data as { proposals: Array<{ id: string }> }).proposals;
    expect(proposals.map((p) => p.id)).toContain(proposalId);
  });

  it('refuses to let the proposing agent approve its own proposal', async () => {
    const created = await proposeThroughLinkerSurface();
    const proposalId = (created.data as { proposalId: string }).proposalId;

    // Two independent refusals, both required.
    // 1. The tool is not on the profile's server at all.
    expect(entitiesToolNames).not.toContain('approveProposedRelation');
    await expect(
      entitiesServer.callTool('approveProposedRelation', { proposalId }, { userId: LINKER_AGENT_USER })
    ).rejects.toThrow(/not registered on the impulse-entities server/);

    // 2. Even reached directly, the executor refuses every machine principal
    //    BEFORE reading the proposal, and proves nothing was written.
    const approved = await executeApproveProposedRelation(
      { proposalId },
      { principal: 'machine', userId: LINKER_AGENT_USER }
    );
    expect(approved.success).toBe(false);
    expect(approved.noMutation).toEqual({ mutationAttempted: false, stage: 'principal' });
    expect(approved.error).toMatch(/agent cannot self-approve/i);

    // Still pending, still no relation.
    expect((await getProposedRelationById(proposalId))?.status).toBe('pending');
    expect((await adminDb.collection('relations').get()).size).toBe(0);
  });

  it('refuses a cross-owner approval attempt from a different authenticated human turn', async () => {
    const created = await proposeThroughLinkerSurface();
    const proposalId = (created.data as { proposalId: string }).proposalId;

    // A human whose CURRENT message does not name this exact proposal cannot
    // approve it, whoever they are — the turn, not the identity, is the grant.
    const refused = await executeApproveProposedRelation(
      { proposalId },
      {
        principal: 'human',
        userId: OTHER_OWNER,
        requestId: 'other-owner-turn',
        confirmationText: 'approve everything pending',
      }
    );
    expect(refused.success).toBe(false);
    expect(refused.noMutation).toEqual({ mutationAttempted: false, stage: 'authorization' });
    expect((await getProposedRelationById(proposalId))?.status).toBe('pending');
    expect((await adminDb.collection('relations').get()).size).toBe(0);
  });

  it('rejects an out-of-contract proposal without writing anything', async () => {
    // The MCP boundary's 0-100 integer contract is unchanged by the new mount.
    const decimal = await proposeThroughLinkerSurface({ confidence: 0.82 });
    expect(decimal.success).toBe(false);
    expect(decimal.error).toMatch(/integer from 0 to 100/i);

    const hyphenated = await proposeThroughLinkerSurface({ relationType: 'competes-with' });
    expect(hyphenated.success).toBe(false);
    expect(hyphenated.error).toMatch(/lowercase snake_case/i);

    expect((await adminDb.collection('proposedRelations').get()).size).toBe(0);
    expect((await adminDb.collection('relations').get()).size).toBe(0);
  });
});
