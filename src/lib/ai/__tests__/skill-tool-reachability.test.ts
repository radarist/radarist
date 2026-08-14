/**
 * SKILL-045 — every platform tool a SKILL.md names must be reachable by a
 * profile that can actually invoke that skill, or be explicitly marked as a
 * handoff.
 *
 * A skill body is a prompt. When it says "call `captureEvidence`" and the
 * invoking agent's MCP servers never mount that tool, the agent either
 * hallucinates a call that fails or silently drops the step — and the skill
 * degrades into prose with no way to notice. This gate covers creator-only
 * report tools named by skills available to other profiles.
 *
 * The matrix is derived, never hand-maintained:
 *   tool  -> MCP servers   from each domain server's own getTools()
 *   server-> profiles      from agent/agents/<profile>/config.yaml + UNIVERSAL
 *   skill -> tools         from backticked identifiers in agent/runtime-plugin/skills/<s>/SKILL.md
 *
 * Adding a profile, moving a tool between servers, or naming a new tool in a
 * skill re-derives all three. A binding that becomes unreachable fails here.
 */

// The domain servers are imported for their real `getTools()` output. Their
// transitive execution paths reach the Firebase SDKs, which this suite never
// calls — only the declaration arrays matter, so the SDK entry points are
// stubbed to keep the import graph inert (and ESM-only `jose` out of Jest).
jest.mock('@/lib/firebase', () => ({ db: {}, auth: {}, storage: {} }));
jest.mock('@/lib/firebase-admin', () => ({ db: {}, auth: {}, storage: {}, adminApp: {} }));

import fs from 'node:fs';
import path from 'node:path';

// SKILL-049 — the derivation itself now lives in ONE shared helper, because the
// SKILL-049 profile-authority regression needs the same matrix to answer "did a
// mount change hand some other profile new authority". Two hand-rolled copies of
// a security-relevant derivation is exactly how the two answers drift apart.
import {
  REPO_ROOT,
  SKILLS_DIR,
  UNIVERSAL_INTERNAL_SERVERS,
  buildProfileToServers,
  buildToolToServers,
} from '@/lib/__tests__/helpers/mcp-reachability-matrix';

const TOOL_TO_SERVERS = buildToolToServers();
const PROFILE_TO_SERVERS = buildProfileToServers();
const PLATFORM_TOOL_NAMES = new Set(TOOL_TO_SERVERS.keys());

/** Backticked `camelCase` identifiers — the shape every tool reference uses. */
const BACKTICKED_IDENTIFIER = /`([a-z][A-Za-z0-9_]{3,})`/g;

/**
 * A skill may deliberately name a tool it cannot itself call, when the mention
 * is a handoff (someone else runs it) or an explicit exclusion (do NOT run it).
 * The mention must say so **in its own paragraph**, using one of these phrases,
 * so the agent reads "hand this off" rather than "call this now".
 *
 * Paragraph-scoped, not line-scoped: markdown wraps, and `cheapest-experiment`'s
 * exclusion note already spans two lines.
 */
const HANDOFF_MARKERS =
  /\b(hand[- ]?off|handoff|hand (?:it|this) (?:off|to)|NOT part of this skill|not part of this skill|creator[- ]only|creator profile|operator|a human|out of reach|not reachable|another profile|explicit dispatch|confirms?\b)/i;

interface Binding {
  skill: string;
  tool: string;
  servers: string[];
  reachableBy: string[];
  markedHandoff: boolean;
}

/** Split a SKILL.md into blank-line-separated paragraphs, preserving order. */
function paragraphsOf(body: string): string[] {
  return body.split(/\n\s*\n/);
}

function toolsIn(text: string): string[] {
  return [...text.matchAll(BACKTICKED_IDENTIFIER)].map((m) => m[1]).filter((t) => PLATFORM_TOOL_NAMES.has(t));
}

function readSkillBindings(): Binding[] {
  const bindings: Binding[] = [];
  for (const skill of fs.readdirSync(SKILLS_DIR).sort()) {
    const file = path.join(SKILLS_DIR, skill, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const paragraphs = paragraphsOf(fs.readFileSync(file, 'utf8'));

    // A tool counts as marked when it is named anywhere in the file inside a
    // paragraph that states the handoff. That lets a skill carry ONE
    // reachability note rather than repeating a caveat at every mention —
    // including mentions in the frontmatter description, which cannot carry one.
    const marked = new Set(paragraphs.filter((p) => HANDOFF_MARKERS.test(p)).flatMap(toolsIn));

    const seen = new Set<string>();
    for (const tool of paragraphs.flatMap(toolsIn)) {
      if (seen.has(tool)) continue;
      seen.add(tool);
      const servers = TOOL_TO_SERVERS.get(tool)!;
      bindings.push({
        skill,
        tool,
        servers,
        reachableBy: Object.entries(PROFILE_TO_SERVERS)
          .filter(([, mounted]) => servers.some((s) => mounted.includes(s)))
          .map(([profile]) => profile),
        markedHandoff: marked.has(tool),
      });
    }
  }
  return bindings;
}

const BINDINGS = readSkillBindings();

describe('skill → tool reachability (SKILL-045)', () => {
  it('derives a non-empty matrix from the real servers, profiles and skills', () => {
    expect(TOOL_TO_SERVERS.size).toBeGreaterThan(50);
    expect(Object.keys(PROFILE_TO_SERVERS).length).toBeGreaterThanOrEqual(6);
    expect(BINDINGS.length).toBeGreaterThan(20);
  });

  it('mounts the universal servers on every mission profile', () => {
    for (const [profile, servers] of Object.entries(PROFILE_TO_SERVERS)) {
      expect({ profile, servers }).toEqual({
        profile,
        servers: expect.arrayContaining(UNIVERSAL_INTERNAL_SERVERS),
      });
    }
  });

  it('cites no phantom tool — every call-shaped name resolves to a declared tool', () => {
    // The failure this guards is a skill instructing the agent to call a
    // plausible-sounding tool that does not exist (`searchAcademicMulti`,
    // `researchPatents`). The agent then either hallucinates a call that errors
    // or silently drops the step, and nothing surfaces either.
    //
    // Universe = every declared tool, not just the MCP-mounted ones, so a skill
    // may legitimately name a chat-only tool. Call-shaped = a backticked
    // camelCase identifier opening with an action verb.
    const declared = new Set<string>([
      ...(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'src/lib/ai/tool-surface.generated.json'), 'utf8'))
        .all as string[]),
      ...PLATFORM_TOOL_NAMES,
    ]);
    const CALL_SHAPED =
      /^(get|list|search|create|update|delete|approve|reject|record|propose|capture|link|draft|publish|dispatch|iterate|resolve|import|render|generate|query|ask|score|check|compare|analyze|bulk|expand|verify|explain|find|add|set|clear|save|curate|confirm|start|refresh|discover|recommend|enrich|validate|execute|format|prepare|dismiss|assess)[A-Z]/;

    const phantoms: string[] = [];
    for (const skill of fs.readdirSync(SKILLS_DIR).sort()) {
      const file = path.join(SKILLS_DIR, skill, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      for (const match of fs.readFileSync(file, 'utf8').matchAll(BACKTICKED_IDENTIFIER)) {
        const token = match[1];
        if (declared.has(token) || !CALL_SHAPED.test(token)) continue;
        const entry = `${skill} → ${token}`;
        if (!phantoms.includes(entry)) phantoms.push(entry);
      }
    }

    expect(phantoms).toEqual([]);
  });

  it('leaves every named binding reachable by at least one profile', () => {
    const unreachable = BINDINGS.filter((b) => b.reachableBy.length === 0).map((b) => `${b.skill} → ${b.tool}`);
    expect(unreachable).toEqual([]);
  });

  it('marks every creator-only binding as an explicit handoff', () => {
    // `impulse-reports` mounts only on the creator profile. A skill that scout /
    // evaluator / strategist runs cannot call those tools, so naming one as a
    // plain step is a dead instruction. Naming it as a handoff is fine.
    const creatorOnly = BINDINGS.filter(
      (b) => b.reachableBy.length === 1 && b.reachableBy[0] === 'creator' && !b.markedHandoff
    ).map((b) => `${b.skill} → ${b.tool} (creator-only via ${b.servers.join(', ')})`);

    expect(creatorOnly).toEqual([]);
  });
});
