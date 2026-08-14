/**
 * @file permissions-coverage.test.ts
 * @description AUDIT-002 — every MCP-exposed tool must have a REVIEWED permission.
 *
 * The defect this exists to prevent, concretely: `recordKnowledgeGap` writes a
 * `:CuriosityGap` node into Neo4j. Nobody added it to TOOL_PERMISSIONS. The map
 * defaulted unmapped tools to `['read']`, and the dispatch route's backup
 * verb-prefix inference had no rule for "record" — so it fell through both nets
 * and a READ-ONLY api key could write to the graph.
 *
 * Note what the old defences could not do. A verb regex guesses intent from a
 * name; it cannot know that `recordKnowledgeGap` persists and `researchTechnology`
 * does not. Only a human reading the implementation knows that. So the guard is
 * not a smarter regex — it is a build failure that forces the human to look.
 *
 * When this test fails you have added an MCP tool. Add it to TOOL_PERMISSIONS,
 * choosing by what the tool DOES:
 *   read    — queries only; no persistence, no meaningful spend
 *   write   — persists anything, OR spends real money on the operator's key
 *   delete  — destroys data
 *   signals — signal triage (approve/reject)
 * Do not reach for the loosest one that makes the test pass.
 */

jest.mock('@/lib/firebase-admin', () => ({ db: {}, adminAuth: {}, adminDb: {}, getAdminDb: () => ({}) }));
jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));

import { TOOL_PERMISSIONS, getToolPermissions, canExecuteTool } from '../permissions';

/** Every in-tree MCP server factory. Mirrors the dispatch route's registry. */
const SERVER_MODULES = [
  'entities-server',
  'graph-server',
  'signals-server',
  'research-server',
  'radar-server',
  'reports-server',
  'super-graph-server',
  'gemini-servers',
] as const;

async function collectExposedTools(): Promise<string[]> {
  const names = new Set<string>();

  for (const moduleName of SERVER_MODULES) {
    const mod = (await import(`@/lib/mcp/servers/${moduleName}`)) as Record<string, unknown>;

    for (const [exportName, factory] of Object.entries(mod)) {
      if (typeof factory !== 'function' || !exportName.startsWith('create')) continue;

      const server = (factory as () => { getTools?: () => Array<{ name: string }> })();
      for (const tool of server?.getTools?.() ?? []) {
        names.add(tool.name);
      }
    }
  }

  return [...names].sort();
}

describe('MCP permission coverage (AUDIT-002)', () => {
  it('maps every tool exposed by every in-tree MCP server', async () => {
    const exposed = await collectExposedTools();
    const unmapped = exposed.filter((name) => !(name in TOOL_PERMISSIONS));

    // Sanity-check the enumeration itself: an empty list would make this test
    // pass vacuously and prove nothing.
    expect(exposed.length).toBeGreaterThan(150);
    expect(unmapped).toEqual([]);
  });

  it('fails CLOSED for a tool nobody mapped', () => {
    // The backstop for the window between adding a tool and this suite running.
    // An omission must produce a locked door, never a read-only grant.
    expect(getToolPermissions('someToolAddedNextTuesday')).toEqual(['admin']);
    expect(canExecuteTool(['read'], 'someToolAddedNextTuesday')).toBe(false);
    expect(canExecuteTool(['write'], 'someToolAddedNextTuesday')).toBe(false);
    expect(canExecuteTool(['admin'], 'someToolAddedNextTuesday')).toBe(true);
  });

  it('keeps a read-only key out of recordKnowledgeGap — the tool that was escalated', () => {
    // The regression itself: this writes to Neo4j via recordCuriosityGap.
    expect(getToolPermissions('recordKnowledgeGap')).toEqual(['write']);
    expect(canExecuteTool(['read'], 'recordKnowledgeGap')).toBe(false);
    expect(canExecuteTool(['write'], 'recordKnowledgeGap')).toBe(true);
  });

  it('does not grant a read-only key any tool that persists or spends', () => {
    // A blunt cross-check of the map itself, independent of the servers: no
    // entry whose name says it mutates may resolve to a bare read.
    const mutatingByName = Object.keys(TOOL_PERMISSIONS).filter((name) =>
      /^(create|update|delete|remove|add|save|record|import|bulk|enrich|approve|reject|publish|draft)/i.test(name)
    );

    const readableMutators = mutatingByName.filter((name) => canExecuteTool(['read'], name));

    expect(readableMutators).toEqual([]);
  });
});
